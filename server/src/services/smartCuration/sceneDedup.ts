/**
 * Scene Dedup (smart-curation final stage)
 *
 * Replaces the old aiFinalDedup with a smarter batching strategy. Instead of
 * fixed-size batches that can split a near-duplicate pair across the boundary,
 * sceneDedup looks at DINOv2 cosine similarity across the boundary and
 * **merges** photos into the current batch when they look like the same scene
 * as the last photo in the batch. Result: same-scene burst sequences stay
 * together no matter where the cut would have fallen.
 *
 * Pipeline order (after this refactor):
 *   ... → blur → overexposure → dedup → reduce → write
 *       → aiReview      (Phase 2: per-photo quality)
 *       → sceneDedup    (final: cross-photo redundancy with smart batching)
 *       → analyze → optimize → ...
 *
 * Failure / fallback policy
 * -------------------------
 * Same as the previous AI passes: when a batch's VLM call cannot produce a
 * parseable response (timeout, 4xx, malformed JSON, partial download
 * failure), every photo in that batch is **kept**. We never delete a photo
 * we did not actually evaluate.
 *
 * Boundary merging
 * ----------------
 * After aiReview the trip typically has 25-50 photos. We aim for ~25 per
 * VLM call to keep attention focused. At each boundary we look at:
 *
 *   sim(batch[end - 1], next[0])  // last of current vs first of next
 *   sim(batch[end - 1], next[1])  // last of current vs second of next
 *
 * If either is ≥ BOUNDARY_THRESHOLD (default 0.75), the next photo is
 * absorbed into the current batch and we re-test against the new boundary,
 * up to MAX_BATCH (default 30) photos. This keeps tight burst sequences
 * intact without ever producing a runaway batch.
 *
 * If the ML embedding service is unavailable, we degrade to fixed-size
 * batches without merging — all the rest of the pipeline behaves the same.
 */

import { getDb } from '../../database';
import { getStorageProvider } from '../../storage/factory';
import { resizeForAnalysis } from '../bedrockClient';
import { writeDebugReport, type DebugReportGroupInput } from './debugReportWriter';
import { callVLM, isVLMAvailable } from './vlmClient';
import {
  extractEmbeddings,
  isMLServiceAvailable,
} from '../mlQualityService';
import type {
  CurationCandidate,
  CurationDecision,
  TrashReason,
} from './smartCurationEngine';

/**
 * Mirrors the (non-exported) EmbeddingResult type from mlQualityService.
 * We use only `embedding` here, but keep the full shape for clarity at the
 * call site.
 */
interface EmbeddingResultShape {
  path: string;
  embedding: number[] | null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SceneDedupResult {
  totalProcessed: number;
  totalKept: number;
  totalTrashed: number;
  vlmCallsMade: number;
  vlmCallsFailed: number;
  /** Number of batches produced after boundary-merging. */
  batchesProcessed: number;
  /** True when ML embeddings were available; false means we ran without smart merging. */
  embeddingsUsed: boolean;
  debugReportPath: string;
}

export interface SceneDedupOptions {
  onProgress?: (
    stage: string,
    status: 'start' | 'progress' | 'complete',
    detail?: string
  ) => void;
}

/** Trash reasons accepted from the VLM in this stage. */
const VALID_DEDUP_TRASH_REASONS: ReadonlySet<TrashReason> = new Set<TrashReason>([
  'scene_redundant',
  'near_duplicate_worse',
]);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_BATCH = 30;
const DEFAULT_BOUNDARY_THRESHOLD = 0.75;

/** Max in-flight image download/resize ops within a single batch. */
const PER_BATCH_IMAGE_CONCURRENCY = 5;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface MediaRow {
  id: string;
  file_path: string;
  original_filename: string;
  file_size: number;
  width: number | null;
  height: number | null;
  sharpness_score: number | null;
}

interface BatchDecision {
  candidateIndex: number;
  decision: 'keep' | 'trash';
  reason: TrashReason | null;
}

// ---------------------------------------------------------------------------
// Config readers
// ---------------------------------------------------------------------------

function readPositiveIntEnv(name: string, defaultValue: number, min = 1, max = 100): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    console.warn(
      `[sceneDedup] ${name}="${raw}" is invalid (expected integer in [${min}..${max}]); ` +
      `using default ${defaultValue}`
    );
    return defaultValue;
  }
  return parsed;
}

function readThresholdEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    console.warn(
      `[sceneDedup] ${name}="${raw}" is not a valid similarity in [0,1]; ` +
      `using default ${defaultValue}`
    );
    return defaultValue;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

function loadActiveCandidates(tripId: string): CurationCandidate[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, file_path, original_filename, file_size, width, height, sharpness_score
         FROM media_items
        WHERE trip_id = ?
          AND media_type = 'image'
          AND status = 'active'
        ORDER BY created_at ASC`
    )
    .all(tripId) as MediaRow[];

  return rows.map((r) => ({
    mediaId: r.id,
    filePath: r.file_path,
    originalFilename: r.original_filename,
    fileSize: r.file_size,
    width: r.width,
    height: r.height,
    sharpnessScore: r.sharpness_score,
  }));
}

function applyDecisions(decisions: CurationDecision[]): void {
  const trashed = decisions.filter((d) => d.decision === 'trash');
  if (trashed.length === 0) return;

  const db = getDb();
  const stmt = db.prepare(
    `UPDATE media_items
        SET status = 'trashed',
            trashed_reason = ?
      WHERE id = ?`
  );

  const apply = db.transaction(() => {
    for (const d of trashed) {
      stmt.run(d.reason, d.mediaId);
    }
  });
  apply();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mapInParallel<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Cosine similarity for two equal-length numeric vectors. Returns 0 for
 * zero-length vectors or vector pairs with mismatched dimensions to keep
 * downstream comparisons stable on degenerate input.
 */
function cosineSimilarity(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Build batches with smart boundary merging.
 *
 * Walks the candidates left-to-right, target batch size = `batchSize`. At
 * each candidate batch boundary, checks similarity between the last photo
 * of the current batch and the next 1-2 photos. If either is at or above
 * `boundaryThreshold`, the next photo is absorbed into the current batch
 * (recursively, up to `maxBatch` photos) so a tight burst sequence cannot
 * be split across batches.
 *
 * When `embeddings` is null (ML service unavailable / per-candidate
 * extraction failed for some), boundary merging degrades to fixed-size
 * batches and a warning is emitted. The rest of the pipeline still works.
 */
export function buildSmartBatches(
  candidates: CurationCandidate[],
  embeddings: (number[] | null)[] | null,
  batchSize: number,
  maxBatch: number,
  boundaryThreshold: number
): CurationCandidate[][] {
  const batches: CurationCandidate[][] = [];
  if (candidates.length === 0) return batches;

  const useMerging = embeddings !== null;

  let i = 0;
  while (i < candidates.length) {
    let actualEnd = Math.min(i + batchSize, candidates.length);

    if (useMerging) {
      // Greedy absorption: while the photo *just past* the boundary looks
      // like the same scene as the last in the current batch, swallow it.
      // We probe up to two future photos at each step so a single odd
      // intermediate photo doesn't shut down the absorption.
      while (actualEnd < candidates.length && actualEnd - i < maxBatch) {
        const lastEmb = embeddings[actualEnd - 1];
        const nextEmb = embeddings[actualEnd];
        const next2Emb = actualEnd + 1 < candidates.length ? embeddings[actualEnd + 1] : null;

        const sim1 = cosineSimilarity(lastEmb, nextEmb);
        const sim2 = next2Emb ? cosineSimilarity(lastEmb, next2Emb) : 0;

        if (sim1 >= boundaryThreshold || sim2 >= boundaryThreshold) {
          actualEnd++;
        } else {
          break;
        }
      }
    }

    batches.push(candidates.slice(i, actualEnd));
    i = actualEnd;
  }

  return batches;
}

// ---------------------------------------------------------------------------
// Embeddings (best-effort)
// ---------------------------------------------------------------------------

/**
 * Try to obtain DINOv2 embeddings for every candidate, returning null when
 * the ML service is unavailable so the caller can degrade gracefully.
 *
 * Per-candidate failures (e.g. one image cannot be embedded) become null
 * entries in the returned array; the caller's cosine-similarity helper
 * already returns 0 for null inputs, which makes those candidates land
 * on standard batch boundaries.
 */
async function tryGetEmbeddings(
  candidates: CurationCandidate[]
): Promise<(number[] | null)[] | null> {
  const available = await isMLServiceAvailable();
  if (!available) {
    console.warn('[sceneDedup] ML service unavailable; falling back to fixed-size batches');
    return null;
  }

  const storage = getStorageProvider();

  // Download every candidate to a local path (extractEmbeddings expects local paths).
  const localPaths = await mapInParallel(candidates, PER_BATCH_IMAGE_CONCURRENCY, async (c) => {
    try {
      return await storage.downloadToTemp(c.filePath);
    } catch (err) {
      console.warn(
        `[sceneDedup] download failed for ${c.mediaId}, will skip merging at this position: ${err}`
      );
      return null;
    }
  });

  // We need a parallel array of paths for extractEmbeddings; entries that
  // failed to download will get a null embedding.
  const validPaths: string[] = [];
  const validIndex: number[] = [];
  for (let i = 0; i < localPaths.length; i++) {
    if (localPaths[i]) {
      validPaths.push(localPaths[i] as string);
      validIndex.push(i);
    }
  }

  let extracted: EmbeddingResultShape[] = [];
  try {
    extracted = (await extractEmbeddings(validPaths)) as EmbeddingResultShape[];
  } catch (err) {
    console.warn(`[sceneDedup] extractEmbeddings failed; falling back to fixed-size batches: ${err}`);
    return null;
  }

  const aligned: (number[] | null)[] = new Array(candidates.length).fill(null);
  for (let k = 0; k < extracted.length; k++) {
    aligned[validIndex[k]] = extracted[k].embedding ?? null;
  }
  return aligned;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export function buildSceneDedupPrompt(batchSize: number): string {
  return `You are an editor finalizing a travel slideshow video. Your job: identify near-duplicate photo CLUSTERS and trim each cluster down to one survivor.

You are shown ${batchSize} photos that have already passed quality screening (none are blurry, none have obvious technical defects). They are sorted by capture time, so visually similar shots tend to be neighbours.

CONTEXT FOR UNDERWATER/DIVING PHOTOS: Blue/green color cast on water is normal — never trash for that.

═══════════════════════════════════════════════════════════════
TWO-STEP PROCESS
═══════════════════════════════════════════════════════════════

STEP 1 — Mentally cluster the photos.
A "cluster" is 2 or more photos that show:
  • the SAME specific subject (same individual fish, same coral cluster, same person)
  • from VERY SIMILAR angle, distance, and framing
  • such that putting them back-to-back in a slideshow would feel repetitive

Photos with no peer in this batch (cluster size 1) are KEPT automatically.

STEP 2 — Within each cluster of size ≥ 2:
Pick the ONE strongest photo (sharpest, best composition, best moment).
Trash ALL the others with reason "scene_redundant".

═══════════════════════════════════════════════════════════════
CLUSTERING RULES
═══════════════════════════════════════════════════════════════

DO cluster (these ARE near-duplicates):
  ✓ 3 photos of the same scorpionfish on the same coral, similar angles
  ✓ 2 photos of the same lionfish, slight distance change, same scene
  ✓ 4 burst-shot photos of the same nudibranch crawling on the same sponge
  ✓ 2 wide shots of the same diver group near the same coral wall
  ✓ Same anemone with the same clownfish in nearly the same position

DO NOT cluster (KEEP both):
  ✗ Two different fish species, even photographed in similar coral
  ✗ Same general dive site but the focal subjects are different creatures
  ✗ Same subject but with TRULY DIFFERENT framing (close-up vs full
     environmental shot; head-on vs profile)
  ✗ Two photos with different storytelling moments (eating vs resting)

═══════════════════════════════════════════════════════════════
ANTI-LENIENCY GUARD
═══════════════════════════════════════════════════════════════

Travel and dive photographers OFTEN take 2-4 nearly identical shots of the
same subject "to be safe". A typical batch contains several such clusters.
**Be decisive about clear redundancy.**

When you see TWO photos clearly showing the same specific subject from
similar angles, trash one. Do NOT rationalize keeping both with "the
lighting is slightly different" — slideshow viewers cannot tell, and the
redundancy is what hurts pacing.

If you find ZERO trashes when there are obvious near-duplicate pairs in
front of you, you are being too lenient.

Do NOT use this stage to remove blurry/low-quality photos — that was the
previous stage's job. Only emit "scene_redundant".

═══════════════════════════════════════════════════════════════
OUTPUT
═══════════════════════════════════════════════════════════════

RESPOND IN THIS EXACT JSON FORMAT (one entry per photo, in input order):
{
  "decisions": [
    {"index": 0, "decision": "keep"},
    {"index": 1, "decision": "trash", "reason": "scene_redundant"},
    ...
  ]
}

IMPORTANT:
- Indices are 0-based.
- Provide EXACTLY ${batchSize} entries, one per photo, in input order.
- "decision" MUST be either "keep" or "trash".
- "reason" is required when decision="trash" and MUST be "scene_redundant"; omit it for "keep".`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function extractJsonObjectString(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith('{')) return inner;
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;

  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;
  let depth = 0;
  for (let i = firstBrace; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(firstBrace, i + 1);
    }
  }
  return null;
}

export function parseSceneDedupResponse(
  responseText: string,
  batchSize: number
): BatchDecision[] | null {
  const jsonStr = extractJsonObjectString(responseText);
  if (!jsonStr) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const list = obj.decisions;
  if (!Array.isArray(list) || list.length !== batchSize) return null;

  const decisions: BatchDecision[] = new Array(batchSize);
  const seen = new Set<number>();

  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    const idx = e.index;
    const decision = e.decision;
    if (typeof idx !== 'number' || !Number.isInteger(idx)) return null;
    if (idx < 0 || idx >= batchSize) return null;
    if (seen.has(idx)) return null;
    seen.add(idx);

    if (decision !== 'keep' && decision !== 'trash') return null;

    if (decision === 'keep') {
      decisions[idx] = { candidateIndex: idx, decision: 'keep', reason: null };
    } else {
      const reason = e.reason;
      if (typeof reason !== 'string') return null;
      if (!VALID_DEDUP_TRASH_REASONS.has(reason as TrashReason)) return null;
      decisions[idx] = {
        candidateIndex: idx,
        decision: 'trash',
        reason: reason as TrashReason,
      };
    }
  }

  if (seen.size !== batchSize) return null;
  return decisions;
}

// ---------------------------------------------------------------------------
// One-batch evaluation
// ---------------------------------------------------------------------------

async function evaluateBatch(batch: CurationCandidate[]): Promise<BatchDecision[]> {
  const storageProvider = getStorageProvider();

  const images = await mapInParallel(batch, PER_BATCH_IMAGE_CONCURRENCY, async (c) => {
    const localPath = await storageProvider.downloadToTemp(c.filePath);
    const base64 = await resizeForAnalysis(localPath);
    return { base64, mediaType: 'image/jpeg' as const };
  });

  const response = await callVLM({
    images,
    prompt: buildSceneDedupPrompt(batch.length),
    maxTokens: 4096,
  });

  const parsed = parseSceneDedupResponse(response.text, batch.length);
  if (!parsed) {
    throw new Error(
      `sceneDedup: failed to parse VLM response (provider=${response.provider} ` +
        `model=${response.model} batchSize=${batch.length}): ${response.text.slice(0, 200)}`
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the scene-dedup pass on every active photo for the trip.
 *
 * Sequential (not parallel) over batches to avoid hammering the VLM rate
 * limit — a typical trip is < 5 batches and each batch is ~25 images, so
 * sequential keeps total wall time reasonable while staying inside per-
 * minute token budgets.
 */
export async function runSceneDedup(
  tripId: string,
  options?: SceneDedupOptions
): Promise<SceneDedupResult> {
  const onProgress = options?.onProgress ?? (() => {});

  onProgress('sceneDedup', 'start');

  const candidates = loadActiveCandidates(tripId);

  if (candidates.length === 0) {
    onProgress('sceneDedup', 'complete', '0 photos');
    return {
      totalProcessed: 0,
      totalKept: 0,
      totalTrashed: 0,
      vlmCallsMade: 0,
      vlmCallsFailed: 0,
      batchesProcessed: 0,
      embeddingsUsed: false,
      debugReportPath: '',
    };
  }

  if (!isVLMAvailable()) {
    console.warn('[sceneDedup] No VLM provider configured — skipping scene dedup');
    onProgress('sceneDedup', 'complete', 'skipped: no VLM provider');
    return {
      totalProcessed: candidates.length,
      totalKept: candidates.length,
      totalTrashed: 0,
      vlmCallsMade: 0,
      vlmCallsFailed: 0,
      batchesProcessed: 0,
      embeddingsUsed: false,
      debugReportPath: '',
    };
  }

  if (candidates.length < 2) {
    onProgress('sceneDedup', 'complete', '1 photo, no dedup needed');
    return {
      totalProcessed: candidates.length,
      totalKept: candidates.length,
      totalTrashed: 0,
      vlmCallsMade: 0,
      vlmCallsFailed: 0,
      batchesProcessed: 0,
      embeddingsUsed: false,
      debugReportPath: '',
    };
  }

  // Read configuration.
  const batchSize = readPositiveIntEnv('SMART_CURATION_SCENE_DEDUP_BATCH_SIZE', DEFAULT_BATCH_SIZE, 2, 50);
  const maxBatch = readPositiveIntEnv('SMART_CURATION_SCENE_DEDUP_MAX_BATCH', DEFAULT_MAX_BATCH, batchSize, 60);
  const boundaryThreshold = readThresholdEnv(
    'SMART_CURATION_SCENE_DEDUP_BOUNDARY_THRESHOLD',
    DEFAULT_BOUNDARY_THRESHOLD
  );

  // Gather embeddings for boundary merging (best-effort).
  onProgress('sceneDedup', 'progress', 'computing embeddings');
  const embeddings = await tryGetEmbeddings(candidates);
  const embeddingsUsed = embeddings !== null;

  const batches = buildSmartBatches(
    candidates,
    embeddings,
    batchSize,
    maxBatch,
    boundaryThreshold
  );

  console.log(
    `[sceneDedup] ${candidates.length} candidates → ${batches.length} batches ` +
    `(merging=${embeddingsUsed ? 'on' : 'off'}, threshold=${boundaryThreshold}, ` +
    `target=${batchSize}, max=${maxBatch})`
  );

  // Filename map for the debug report.
  const filenameByMediaId = new Map<string, string>();
  for (const c of candidates) filenameByMediaId.set(c.mediaId, c.originalFilename);

  let vlmCallsMade = 0;
  let vlmCallsFailed = 0;
  const decisions: CurationDecision[] = [];

  // Sequential over batches — each batch is large, so parallelism would
  // exhaust the VLM rate limit fast. One at a time is safer.
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];

    let batchDecisions: BatchDecision[];
    if (batch.length < 2) {
      // Single-photo batch (degenerate) — auto-keep without spending a VLM call.
      batchDecisions = batch.map((_, i) => ({
        candidateIndex: i,
        decision: 'keep' as const,
        reason: null,
      }));
    } else {
      try {
        batchDecisions = await evaluateBatch(batch);
        vlmCallsMade++;
      } catch (err) {
        vlmCallsFailed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[sceneDedup] Batch ${b + 1}/${batches.length} failed (size=${batch.length}), ` +
          `keeping all photos: ${msg}`
        );
        batchDecisions = batch.map((_, i) => ({
          candidateIndex: i,
          decision: 'keep' as const,
          reason: null,
        }));
      }
    }

    for (const d of batchDecisions) {
      const candidate = batch[d.candidateIndex];
      decisions.push({
        mediaId: candidate.mediaId,
        decision: d.decision,
        reason: d.reason,
        groupId: `scene-batch-${b + 1}`,
        groupType: 'ungrouped',
        similaritySource: null,
        similarityScore: null,
      });
    }

    onProgress(
      'sceneDedup',
      'progress',
      `${b + 1}/${batches.length} batches (size=${batch.length})`
    );
  }

  applyDecisions(decisions);

  // Debug report.
  const groupSummaries: DebugReportGroupInput[] = batches.map((b, i) => ({
    groupId: `scene-batch-${i + 1}`,
    groupType: 'ungrouped',
    candidateCount: b.length,
  }));

  let debugReportPath = '';
  try {
    debugReportPath = await writeDebugReport(
      tripId,
      decisions,
      groupSummaries,
      filenameByMediaId,
      'scene-dedup'
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sceneDedup] Failed to write debug report: ${msg}`);
  }

  const totalProcessed = decisions.length;
  const totalKept = decisions.filter((d) => d.decision === 'keep').length;
  const totalTrashed = totalProcessed - totalKept;

  onProgress(
    'sceneDedup',
    'complete',
    `${totalTrashed} trashed / ${totalProcessed} processed`
  );

  return {
    totalProcessed,
    totalKept,
    totalTrashed,
    vlmCallsMade,
    vlmCallsFailed,
    batchesProcessed: batches.length,
    embeddingsUsed,
    debugReportPath,
  };
}
