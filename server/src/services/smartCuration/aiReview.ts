/**
 * AI Final Review (smart-curation Phase 2)
 *
 * Runs after `runSmartCuration` (Phase 1). Phase 1 collapses similarity-based
 * burst/duplicate groups; this stage then asks the VLM to make a per-photo
 * keep/trash decision on **every** still-active photo. This is what catches:
 *
 *   - Blurry / out-of-focus shots that the rule-based blur stage missed
 *   - Subjects severely cut off, occluded, or back-turned
 *   - Severely over- or under-exposed shots (subject-level, not the global
 *     average the rule-based overexposure stage looks at)
 *   - Photos with no narrative or visual value for a slideshow
 *
 * Pipeline order:
 *   ... → smartCuration (Phase 1) → aiReview (Phase 2) → analyze → optimize → ...
 *
 * Failure / fallback policy
 * -------------------------
 * The user has explicitly asked for the **conservative** policy: when a batch
 * of N photos cannot be evaluated (VLM error, unparseable response, partial
 * download failure) the entire batch is **kept** rather than trashed. This
 * avoids ever deleting a photo we couldn't actually look at.
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

export interface AIReviewResult {
  totalProcessed: number;
  totalKept: number;
  totalTrashed: number;
  vlmCallsMade: number;
  vlmCallsFailed: number;
  debugReportPath: string;
}

export interface AIReviewOptions {
  onProgress?: (
    stage: string,
    status: 'start' | 'progress' | 'complete',
    detail?: string
  ) => void;
}

/** Trash reasons the VLM is allowed to emit during the review pass. */
const VALID_REVIEW_TRASH_REASONS: ReadonlySet<TrashReason> = new Set<TrashReason>([
  'blurry',
  'low_subject_quality',
  'low_aesthetic_quality',
  'low_video_value',
]);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Photos per VLM batch. */
const BATCH_SIZE = 5;

/** How many review batches to run in parallel against the VLM. */
const VLM_CONCURRENCY = 3;

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
  /** Original index of the photo within `candidates` for traceability. */
  candidateIndex: number;
  decision: 'keep' | 'trash';
  reason: TrashReason | null;
}

// ---------------------------------------------------------------------------
// DB / candidates loading
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

/**
 * Apply trash decisions to the database in a single transaction. Mirrors
 * smartCurationEngine — only `status` and `trashed_reason` are touched so the
 * soft-delete invariant (file_path preserved) is honoured.
 */
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
// Concurrency helper (kept local so the module is self-contained)
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
// Prompt
// ---------------------------------------------------------------------------

/**
 * Build the per-photo review prompt. Each photo in the batch is judged
 * **independently** — there is no notion of "best of group" at this stage.
 *
 * The prompt explicitly preserves the underwater-photo handling instructions
 * so blue-tinted dive shots aren't penalised for color cast.
 */
export function buildReviewPrompt(batchSize: number): string {
  return `You are a professional travel photo curator preparing a slideshow video.

You are shown ${batchSize} photos. **Judge each photo INDEPENDENTLY** — these are not a series, and they do NOT have to be ranked against each other. For each photo, decide whether it deserves a place in a polished travel slideshow.

These may include underwater/diving photos with blue tint and low contrast — this is NORMAL for underwater photography and is NOT a defect. Do not trash a photo just for blue cast.

TRASH the photo if any of these are clearly true:
- The main subject is severely blurry / out of focus (camera shake or missed focus)
- The main subject is severely over- or under-exposed so detail is lost
- The composition is broken: subject heavily cut off, dominant occlusion, or no discernible subject
- The image is uninteresting filler (empty water/sand/sky with nothing of note)

KEEP the photo otherwise. When in doubt, KEEP. It is much worse to delete a good photo than to keep a mediocre one.

Trash reasons (pick exactly one per trashed photo):
- "blurry"               — out of focus / camera shake on the main subject
- "low_subject_quality"  — subject heavily cut off, occluded, exposure ruined
- "low_aesthetic_quality"— composition broken / distracting clutter / no clear subject
- "low_video_value"      — technically OK but boring filler unsuitable for a slideshow

RESPOND IN THIS EXACT JSON FORMAT (one entry per photo, ordered to match the input):
{
  "results": [
    {"index": 0, "decision": "keep"},
    {"index": 1, "decision": "trash", "reason": "blurry"},
    ...
  ]
}

IMPORTANT:
- Indices are 0-based.
- Provide EXACTLY ${batchSize} entries, one per photo, in input order.
- "decision" MUST be either "keep" or "trash".
- "reason" is required when decision="trash" and must be one of the four values above; omit it for "keep".`;
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

/**
 * Parse the VLM response into one decision per photo in the batch.
 *
 * Validation rules:
 *   - Top-level shape must be `{ "results": [...] }` with `batchSize` entries.
 *   - Every index in [0, batchSize) must appear exactly once.
 *   - decision is either "keep" or "trash"; "trash" requires a valid review-tier reason.
 *
 * Returns null on any validation failure so the caller applies the conservative
 * "keep entire batch" fallback.
 */
export function parseReviewResponse(
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
  const list = obj.results;
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
      if (!VALID_REVIEW_TRASH_REASONS.has(reason as TrashReason)) return null;
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

/**
 * Evaluate a single batch of candidates. On any failure (download, VLM call,
 * unparseable response) the function throws — the caller turns that into the
 * conservative "keep all in this batch" outcome.
 */
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
    prompt: buildReviewPrompt(batch.length),
    maxTokens: 2048,
  });

  const parsed = parseReviewResponse(response.text, batch.length);
  if (!parsed) {
    throw new Error(
      `aiReview: failed to parse VLM response (provider=${response.provider} ` +
        `model=${response.model} batchSize=${batch.length}): ${response.text.slice(0, 200)}`
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the AI final-review pass on every active photo for the trip.
 *
 * Behaviour:
 *   - When DASHSCOPE_API_KEY is missing, the stage is a no-op (every photo
 *     stays as-is).
 *   - Photos are split into fixed-size batches; up to VLM_CONCURRENCY batches
 *     run in parallel.
 *   - On any per-batch failure, the conservative fallback keeps every photo
 *     in that batch (no trash decisions emitted) and increments
 *     `vlmCallsFailed` for observability.
 *   - Every successful trash decision is persisted as `status='trashed'` plus
 *     the VLM-supplied trash reason. `file_path` is preserved.
 *   - A debug report (same shape as Phase 1's) is written to
 *     `data/debug/ai-review-{tripId}-{ts}.json`.
 */
export async function runAIReview(
  tripId: string,
  options?: AIReviewOptions
): Promise<AIReviewResult> {
  const onProgress = options?.onProgress ?? (() => {});

  onProgress('aiReview', 'start');

  const candidates = loadActiveCandidates(tripId);

  if (candidates.length === 0) {
    onProgress('aiReview', 'complete', '0 photos');
    return {
      totalProcessed: 0,
      totalKept: 0,
      totalTrashed: 0,
      vlmCallsMade: 0,
      vlmCallsFailed: 0,
      debugReportPath: '',
    };
  }

  // No-op when no VLM provider is configured — the user explicitly asked for
  // the conservative policy and we cannot evaluate without a model.
  if (!isVLMAvailable()) {
    console.warn('[aiReview] No VLM provider configured — skipping AI review');
    onProgress('aiReview', 'complete', 'skipped: no VLM provider');
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

  // Partition candidates into fixed-size batches.
  const batches: CurationCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batches.push(candidates.slice(i, i + BATCH_SIZE));
  }

  let vlmCallsMade = 0;
  let vlmCallsFailed = 0;
  let processedBatches = 0;
  const totalBatches = batches.length;

  // Run the batches with concurrency limit. Each settled result is either a
  // BatchDecision[] (success) or an error reason (fallback to keep all).
  const settled = await processInBatches(batches, VLM_CONCURRENCY, async (batch) => {
    const result = await evaluateBatch(batch);
    return result;
  });

  // Build CurationDecisions per photo. The decisions array stays ordered to
  // match `candidates`.
  const decisions: CurationDecision[] = [];

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const baseIndex = b * BATCH_SIZE;
    const result = settled[b];

    let batchDecisions: BatchDecision[];
    if (result.status === 'fulfilled') {
      vlmCallsMade++;
      batchDecisions = result.value;
    } else {
      vlmCallsFailed++;
      const msg =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.warn(
        `[aiReview] Batch ${b + 1}/${totalBatches} failed, keeping all ${batch.length} photos: ${msg}`
      );
      // Conservative fallback — keep every photo in the batch.
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
        // The review pass does not work on similarity groups; populate the
        // group fields with sentinel values that match the existing
        // CurationDecision contract.
        groupId: `review-batch-${b + 1}`,
        groupType: 'ungrouped',
        similaritySource: null,
        similarityScore: null,
      });
    }

    processedBatches++;
    onProgress(
      'aiReview',
      'progress',
      `${processedBatches}/${totalBatches} batches (idx ${baseIndex}-${baseIndex + batch.length - 1})`
    );
  }

  // Persist the trash decisions atomically — same pattern as Phase 1.
  applyDecisions(decisions);

  // Debug report (uses the same writer as Phase 1; the
  // `groupId='review-batch-N'` lets you tell them apart in the report).
  const groupSummaries: DebugReportGroupInput[] = batches.map((b, i) => ({
    groupId: `review-batch-${i + 1}`,
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
      'ai-review'
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[aiReview] Failed to write debug report: ${msg}`);
  }

  const totalProcessed = decisions.length;
  const totalKept = decisions.filter((d) => d.decision === 'keep').length;
  const totalTrashed = totalProcessed - totalKept;

  onProgress(
    'aiReview',
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
