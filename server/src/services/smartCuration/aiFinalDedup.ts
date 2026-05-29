/**
 * AI Final Deduplication (smart-curation Phase 3)
 *
 * Runs after `runAIReview` (Phase 2). Phase 1 collapses similarity-grouped
 * bursts; Phase 2 throws out individual junk shots; **Phase 3 closes the
 * cross-photo blind spot** that Phase 2 has by design.
 *
 * The motivating case
 * -------------------
 * After Phase 2 the trip can still contain pairs/sets that depict the same
 * subject from very similar angles but landed in different similarity groups
 * (or no group at all) because DINOv2 rated them at 0.75–0.82 — below our
 * grouping threshold. Phase 2 evaluates each photo independently and keeps
 * both, because each photo on its own merits is fine.
 *
 * Phase 3 fixes this by asking the VLM: "given these N already-good photos,
 * are any of them redundant with each other? If so, keep one and trash the
 * rest." This adds semantic comparison on top of cosine similarity.
 *
 * Pipeline order:
 *   ... → smartCuration (Phase 1)
 *       → aiReview      (Phase 2: per-photo quality)
 *       → aiFinalDedup  (Phase 3: cross-photo redundancy)
 *       → analyze → optimize → ...
 *
 * Failure / fallback policy
 * -------------------------
 * Same as Phase 2: any batch that fails (VLM error, unparseable response,
 * download failure) keeps every photo in the batch. Worst case is we leave
 * a few extra photos, never that we delete a photo we couldn't look at.
 *
 * Cross-batch redundancy
 * ----------------------
 * Photos are batched in `created_at` order, which for camera output is
 * effectively timestamp / filename order. Burst shots and "I took two of
 * the same thing because the first might have been bad" patterns are
 * almost always temporally adjacent, so this batching captures the
 * dominant case without the cost of comparing every photo to every other.
 * Photos in different batches are never compared against each other; that
 * is an accepted limitation.
 *
 * Provider
 * --------
 * Uses the unified `vlmClient` module — the active VLM provider (Anthropic
 * Claude or DashScope qwen-vl-max) is selected via env at runtime and is
 * transparent to this stage.
 */

import { getDb } from '../../database';
import { getStorageProvider } from '../../storage/factory';
import { resizeForAnalysis } from '../bedrockClient';
import { writeDebugReport, type DebugReportGroupInput } from './debugReportWriter';
import { callVLM, isVLMAvailable } from './vlmClient';
import type {
  CurationCandidate,
  CurationDecision,
  TrashReason,
} from './smartCurationEngine';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AIFinalDedupResult {
  totalProcessed: number;
  totalKept: number;
  totalTrashed: number;
  vlmCallsMade: number;
  vlmCallsFailed: number;
  debugReportPath: string;
}

export interface AIFinalDedupOptions {
  onProgress?: (
    stage: string,
    status: 'start' | 'progress' | 'complete',
    detail?: string
  ) => void;
}

/**
 * Trash reasons the VLM is allowed to emit during Phase 3. Phase 3 looks for
 * cross-photo redundancy, so the only legitimate reason is `scene_redundant`.
 * Quality-based reasons (`blurry`, `low_*`) belong to Phase 2.
 */
const VALID_DEDUP_TRASH_REASONS: ReadonlySet<TrashReason> = new Set<TrashReason>([
  'scene_redundant',
  'near_duplicate_worse',
]);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Photos per VLM call. Larger = more cross-photo coverage, more tokens. */
const DEFAULT_BATCH_SIZE = 12;

/** Concurrent VLM calls. */
const VLM_CONCURRENCY = 3;

/** Image download/resize parallelism within a single batch. */
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
// DB helpers
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
// Concurrency helpers (kept local so the module is self-contained)
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

async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map((item, j) => fn(item, i + j))
    );
    results.push(...settled);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function readBatchSize(): number {
  const raw = process.env.SMART_CURATION_DEDUP_BATCH_SIZE;
  if (!raw) return DEFAULT_BATCH_SIZE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 2 || parsed > 12) {
    console.warn(
      `[aiFinalDedup] SMART_CURATION_DEDUP_BATCH_SIZE="${raw}" invalid (2..12); using default ${DEFAULT_BATCH_SIZE}`
    );
    return DEFAULT_BATCH_SIZE;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Phase 3 prompt: find cross-photo redundancy.
 *
 * Critical guard rails baked into the prompt:
 *   1. Only flag redundancy when the **subject AND framing** are nearly
 *      identical. Different subjects or different scenes are never redundant.
 *   2. When in doubt, KEEP. Phase 1 + Phase 2 already removed obvious cases;
 *      anything making it to Phase 3 is borderline and we'd rather over-keep.
 *   3. Underwater blue cast is normal — never a reason to trash.
 *   4. Only one trash reason allowed: `scene_redundant`. (`near_duplicate_worse`
 *      is also accepted by the parser for robustness, but not advertised.)
 */
export function buildDedupPrompt(batchSize: number): string {
  return `You are a travel photo curator finalizing a slideshow video.

You are shown ${batchSize} photos that have ALREADY passed quality screening (none are blurry, none are obviously bad). Your job now is to remove **redundant** photos — sets that show essentially the same subject from essentially the same angle.

These may include underwater/diving photos with blue tint and low contrast. Blue cast is NORMAL and is NEVER a reason to trash a photo.

Your job is ACTIVE redundancy removal. A travel slideshow loses its punch when 2-3 nearly-identical shots play in sequence. **Be decisive about clear redundancy.**

WHEN TO TRASH (reason: scene_redundant):
- Two or more photos show the SAME subject (same fish, same coral cluster, same person, same scene) with very similar framing and distance.
- Keep the ONE most visually compelling photo (cleanest composition, sharpest, best moment); trash all the others.
- If you see 3 photos of the same subject, keep 1, trash 2. If you see 2 photos of the same subject, keep 1, trash 1.

WHEN TO KEEP (do NOT trash):
- Different subjects (different fish species, different person, different scene) → ALWAYS KEEP both.
- Same subject but with **clearly different** angle / distance / pose / framing that adds storytelling variety → keep both.
- Same general environment but the photos focus on different subjects of interest → keep both.

CALIBRATION:
- Out of ${batchSize} photos in a typical travel batch, expect to find 0-${Math.max(2, Math.floor(batchSize / 4))} redundant shots.
- If you find yourself trashing more than half the batch, stop and reconsider — that is unusual.
- If you find ZERO trashes when there are obvious near-duplicate pairs in front of you, you are being too lenient. Trust your judgement: if two photos look like the same shot, trash one.

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
// Response parsing (mirrors aiReview's structure)
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

/**
 * Parse the VLM dedup response. Same "every index appears once" + "valid
 * trash reason" rules as Phase 2; returns null on any failure so the caller
 * applies the conservative keep-all fallback.
 */
export function parseDedupResponse(
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

  const images = await mapInParallel(
    batch,
    PER_BATCH_IMAGE_CONCURRENCY,
    async (c) => {
      const localPath = await storageProvider.downloadToTemp(c.filePath);
      const base64 = await resizeForAnalysis(localPath);
      return { base64, mediaType: 'image/jpeg' as const };
    }
  );

  const response = await callVLM({
    images,
    prompt: buildDedupPrompt(batch.length),
    maxTokens: 2048,
  });

  const parsed = parseDedupResponse(response.text, batch.length);
  if (!parsed) {
    throw new Error(
      `aiFinalDedup: failed to parse VLM response (provider=${response.provider} ` +
        `model=${response.model} batchSize=${batch.length}): ${response.text.slice(0, 200)}`
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 3 (cross-photo redundancy) on every still-active photo for the
 * trip. Mirrors `runAIReview` in shape — separate stage, conservative
 * fallback per batch, debug report under `data/debug/ai-final-dedup-*.json`.
 */
export async function runAIFinalDedup(
  tripId: string,
  options?: AIFinalDedupOptions
): Promise<AIFinalDedupResult> {
  const onProgress = options?.onProgress ?? (() => {});

  onProgress('aiFinalDedup', 'start');

  const candidates = loadActiveCandidates(tripId);

  if (candidates.length === 0) {
    onProgress('aiFinalDedup', 'complete', '0 photos');
    return {
      totalProcessed: 0,
      totalKept: 0,
      totalTrashed: 0,
      vlmCallsMade: 0,
      vlmCallsFailed: 0,
      debugReportPath: '',
    };
  }

  // Skip when no VLM provider available — same conservative posture as Phase 2.
  if (!isVLMAvailable()) {
    console.warn('[aiFinalDedup] No VLM provider configured — skipping final dedup');
    onProgress('aiFinalDedup', 'complete', 'skipped: no VLM provider');
    return {
      totalProcessed: candidates.length,
      totalKept: candidates.length,
      totalTrashed: 0,
      vlmCallsMade: 0,
      vlmCallsFailed: 0,
      debugReportPath: '',
    };
  }

  // Single-photo trip — nothing to dedupe.
  if (candidates.length < 2) {
    onProgress('aiFinalDedup', 'complete', `1 photo, no dedup needed`);
    return {
      totalProcessed: candidates.length,
      totalKept: candidates.length,
      totalTrashed: 0,
      vlmCallsMade: 0,
      vlmCallsFailed: 0,
      debugReportPath: '',
    };
  }

  const filenameByMediaId = new Map<string, string>();
  for (const c of candidates) filenameByMediaId.set(c.mediaId, c.originalFilename);

  const batchSize = readBatchSize();

  // Partition candidates into temporally-adjacent batches. Camera filename /
  // created_at order naturally clusters burst shots near each other, which
  // is exactly the population we want the VLM to compare side-by-side.
  const batches: CurationCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    batches.push(candidates.slice(i, i + batchSize));
  }

  let vlmCallsMade = 0;
  let vlmCallsFailed = 0;
  let processedBatches = 0;
  const totalBatches = batches.length;

  // Skip the trailing batch if it has only 1 photo — no peer to dedupe against.
  // It still contributes a "keep" decision so the totals stay correct.
  const settled = await processInBatches(batches, VLM_CONCURRENCY, async (batch) => {
    if (batch.length < 2) {
      // Trivial batch — every photo is auto-kept, no VLM call.
      return batch.map<BatchDecision>((_, i) => ({
        candidateIndex: i,
        decision: 'keep',
        reason: null,
      }));
    }
    return await evaluateBatch(batch);
  });

  // Build CurationDecisions ordered to match `candidates`.
  const decisions: CurationDecision[] = [];

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const baseIndex = b * batchSize;
    const result = settled[b];

    let batchDecisions: BatchDecision[];
    if (result.status === 'fulfilled') {
      // Only count "real" VLM calls, not the trivial single-photo batches.
      if (batch.length >= 2) vlmCallsMade++;
      batchDecisions = result.value;
    } else {
      vlmCallsFailed++;
      const msg =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.warn(
        `[aiFinalDedup] Batch ${b + 1}/${totalBatches} failed, keeping all ${batch.length} photos: ${msg}`
      );
      batchDecisions = batch.map((_, i) => ({
        candidateIndex: i,
        decision: 'keep' as const,
        reason: null,
      }));
    }

    for (const d of batchDecisions) {
      const candidate = batch[d.candidateIndex];
      decisions.push({
        mediaId: candidate.mediaId,
        decision: d.decision,
        reason: d.reason,
        groupId: `dedup-batch-${b + 1}`,
        groupType: 'ungrouped',
        similaritySource: null,
        similarityScore: null,
      });
    }

    processedBatches++;
    onProgress(
      'aiFinalDedup',
      'progress',
      `${processedBatches}/${totalBatches} batches (idx ${baseIndex}-${baseIndex + batch.length - 1})`
    );
  }

  applyDecisions(decisions);

  // Debug report — distinguishable filename prefix.
  const groupSummaries: DebugReportGroupInput[] = batches.map((b, i) => ({
    groupId: `dedup-batch-${i + 1}`,
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
      'ai-final-dedup'
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[aiFinalDedup] Failed to write debug report: ${msg}`);
  }

  const totalProcessed = decisions.length;
  const totalKept = decisions.filter((d) => d.decision === 'keep').length;
  const totalTrashed = totalProcessed - totalKept;

  onProgress(
    'aiFinalDedup',
    'complete',
    `${totalTrashed} trashed / ${totalProcessed} processed`
  );

  return {
    totalProcessed,
    totalKept,
    totalTrashed,
    vlmCallsMade,
    vlmCallsFailed,
    debugReportPath,
  };
}
