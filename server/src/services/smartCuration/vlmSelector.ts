/**
 * VLM Selector
 *
 * Calls the configured Vision Language Model (Anthropic Claude or DashScope
 * qwen-vl-max) to select the best photo(s) from a near-duplicate
 * Curation_Group. The provider is chosen at runtime by the unified
 * `vlmClient` module — this file only owns the prompt, response parsing,
 * and per-call image preparation.
 *
 * The caller (smartCurationEngine) is responsible for handling fallback when
 * `selectBestByVLM` throws or `parseVLMResponse` returns null.
 */

import { getStorageProvider } from '../../storage/factory';
import { resizeForAnalysis } from '../bedrockClient';
import { callVLM, isVLMAvailable } from './vlmClient';
import type { CurationCandidate, TrashReason } from './smartCurationEngine';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** VLM response for a single group evaluation. */
export interface VLMSelectionResponse {
  keep: number[];
  trash: Array<{
    index: number;
    reason: TrashReason;
  }>;
}

/** Keep quota based on group size. */
export interface KeepQuota {
  min: number;
  max: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The set of trash reasons the VLM is allowed to emit for near-duplicate groups.
 * `exact_duplicate` is intentionally excluded — that is decided without the VLM.
 */
const VLM_VALID_TRASH_REASONS: ReadonlySet<TrashReason> = new Set<TrashReason>([
  'near_duplicate_worse',
  'scene_redundant',
  'blurry',
  'low_subject_quality',
  'low_aesthetic_quality',
  'low_video_value',
]);

// ---------------------------------------------------------------------------
// Keep quota
// ---------------------------------------------------------------------------

/**
 * Determines the keep quota for a group based on its size.
 *  - 1 photo:    keep 1 (min=1, max=1) — caller normally handles singletons without VLM
 *  - 2-3 photos: keep exactly 1 (min=1, max=1)
 *  - 4-8 photos: keep 1 to 2 (min=1, max=2)
 *  - 9+ photos:  keep 2 to 3 (min=2, max=3)
 */
export function getKeepQuota(groupSize: number): KeepQuota {
  if (groupSize <= 3) {
    return { min: 1, max: 1 };
  }
  if (groupSize <= 8) {
    return { min: 1, max: 2 };
  }
  return { min: 2, max: 3 };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Builds the VLM prompt for selecting the best photo(s) from a candidate group.
 *
 * The prompt is taken verbatim from the design document. It includes explicit
 * underwater-photo handling instructions so blue-tinted dive shots aren't
 * unfairly penalized.
 */
export function buildCurationPrompt(candidateCount: number, keepQuota: KeepQuota): string {
  const keepText = keepQuota.min === keepQuota.max
    ? `exactly ${keepQuota.min}`
    : `${keepQuota.min} to ${keepQuota.max}`;

  return `You are a professional travel photo curator selecting the best photos for a travel slideshow video.

You are shown ${candidateCount} photos from the same scene or subject. These may be underwater/diving photos with blue tint and low contrast - this is NORMAL for underwater photography and should NOT be treated as a defect.

Select the ${keepText} best photo(s) for a travel slideshow video.

SELECTION CRITERIA (in priority order):
1. Subject size and completeness - the main subject should be large, fully visible, not cut off
2. Subject sharpness and clarity - the subject should be in focus
3. Pose and gesture quality - natural, dynamic, or interesting poses preferred
4. Composition suitability for video - rule of thirds, visual balance, works at 16:9
5. Color naturalness - for non-underwater: vivid natural colors; for underwater: good visibility through blue tint
6. Occlusion level - subject not blocked by other objects
7. Background cleanliness - minimal distracting elements
8. Information content - the photo tells a story or captures a moment

FOR UNDERWATER PHOTOS:
- Blue/green color cast is NORMAL, do not penalize
- Evaluate based on subject visibility and composition
- Prefer shots where marine life is most complete and clearly visible

RESPOND IN THIS EXACT JSON FORMAT:
{
  "keep": [<indices of photos to keep, 0-based>],
  "trash": [
    {"index": <0-based index>, "reason": "<one of: near_duplicate_worse, scene_redundant, blurry, low_subject_quality, low_aesthetic_quality, low_video_value>"}
  ]
}

IMPORTANT:
- Indices are 0-based (first photo is 0)
- Every photo must appear in either "keep" or "trash"
- Each trashed photo must have exactly one reason
- You must keep ${keepText} photo(s)`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Extracts a JSON object substring from raw VLM text. Handles three cases:
 *   1. Plain JSON
 *   2. JSON wrapped in a markdown ```json ... ``` (or ``` ... ```) fence
 *   3. JSON embedded in surrounding prose (first `{` to its matching `}`)
 *
 * Returns null if no balanced JSON object can be located.
 */
function extractJsonObjectString(text: string): string | null {
  // Strategy 1: markdown code fence (```json ... ``` or ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith('{')) {
      return inner;
    }
  }

  // Strategy 2: full-string parse
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return trimmed;
  }

  // Strategy 3: scan for first balanced `{...}` block
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) {
    return null;
  }
  let depth = 0;
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(firstBrace, i + 1);
      }
    }
  }
  return null;
}

/**
 * Parses the VLM text response into a structured `VLMSelectionResponse`.
 *
 * Validation rules:
 *  - Response must contain `keep` (array of numbers) and `trash` (array of
 *    objects with `index` and `reason`).
 *  - Every index in [0, candidateCount) must appear in exactly one of `keep`
 *    or `trash` (no duplicates, no missing, no out-of-range entries).
 *  - Every trash entry's `reason` must be a valid VLM-allowed `TrashReason`.
 *  - The size of `keep` must be within `[keepQuota.min, keepQuota.max]`.
 *
 * Returns null if any validation rule fails.
 */
export function parseVLMResponse(
  responseText: string,
  candidateCount: number,
  keepQuota: KeepQuota
): VLMSelectionResponse | null {
  const jsonStr = extractJsonObjectString(responseText);
  if (!jsonStr) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const rawKeep = obj.keep;
  const rawTrash = obj.trash;

  if (!Array.isArray(rawKeep) || !Array.isArray(rawTrash)) {
    return null;
  }

  // --- Validate keep array: integers in range, no duplicates ---
  const keep: number[] = [];
  const seen = new Set<number>();
  for (const v of rawKeep) {
    if (typeof v !== 'number' || !Number.isInteger(v)) return null;
    if (v < 0 || v >= candidateCount) return null;
    if (seen.has(v)) return null;
    seen.add(v);
    keep.push(v);
  }

  // --- Validate trash array: well-formed entries, valid reason, no duplicates ---
  const trash: Array<{ index: number; reason: TrashReason }> = [];
  for (const entry of rawTrash) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    const idx = e.index;
    const reason = e.reason;
    if (typeof idx !== 'number' || !Number.isInteger(idx)) return null;
    if (idx < 0 || idx >= candidateCount) return null;
    if (seen.has(idx)) return null;
    if (typeof reason !== 'string') return null;
    if (!VLM_VALID_TRASH_REASONS.has(reason as TrashReason)) return null;
    seen.add(idx);
    trash.push({ index: idx, reason: reason as TrashReason });
  }

  // --- Coverage: every candidate index must appear exactly once ---
  if (seen.size !== candidateCount) return null;

  // --- Quota check ---
  if (keep.length < keepQuota.min || keep.length > keepQuota.max) {
    return null;
  }

  return { keep, trash };
}

// ---------------------------------------------------------------------------
// Per-call helpers
// ---------------------------------------------------------------------------

/**
 * Maximum number of in-flight image download/resize operations within a
 * single VLM call. Each VLM call sees at most VLM_MAX_CANDIDATES (5), so a
 * concurrency of 5 fully parallelizes the per-call I/O.
 */
const PER_CALL_IMAGE_CONCURRENCY = 5;

/**
 * Run an async mapper over `items` with at most `concurrency` in-flight calls.
 * Order is preserved: `results[i]` corresponds to `items[i]`. Used to
 * parallelize the per-candidate download+resize within a single VLM call.
 */
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

// ---------------------------------------------------------------------------
// Main selection function
// ---------------------------------------------------------------------------

/**
 * Calls the VLM (qwen-vl-max) to select the best photo(s) from a near-duplicate
 * candidate group.
 *
 * Steps:
 *  1. Download each candidate to a local temp path via the storage provider.
 *  2. Resize each to 768px and base64-encode using `resizeForAnalysis`.
 *  3. Build the curation prompt for the configured keep quota.
 *  4. Call qwen-vl-max with the multi-image content.
 *  5. Parse and validate the response.
 *
 * Throws if:
 *  - DASHSCOPE_API_KEY is not configured
 *  - Image download / resize fails for any candidate
 *  - The VLM response cannot be parsed or fails validation
 *
 * The caller is responsible for catching these errors and applying the quality-
 * scoring fallback.
 */
export async function selectBestByVLM(
  candidates: CurationCandidate[],
  keepQuota: KeepQuota
): Promise<VLMSelectionResponse> {
  if (candidates.length === 0) {
    throw new Error('selectBestByVLM: no candidates provided');
  }
  if (!isVLMAvailable()) {
    throw new Error('selectBestByVLM: no VLM provider configured');
  }

  const storageProvider = getStorageProvider();

  // Download + resize each candidate in parallel.
  const images = await mapInParallel(
    candidates,
    PER_CALL_IMAGE_CONCURRENCY,
    async (c) => {
      const localPath = await storageProvider.downloadToTemp(c.filePath);
      const base64 = await resizeForAnalysis(localPath);
      return { base64, mediaType: 'image/jpeg' as const };
    }
  );

  const prompt = buildCurationPrompt(candidates.length, keepQuota);

  const response = await callVLM({ images, prompt, maxTokens: 1024 });

  const parsed = parseVLMResponse(response.text, candidates.length, keepQuota);
  if (!parsed) {
    throw new Error(
      `selectBestByVLM: failed to parse VLM response (provider=${response.provider} model=${response.model} ` +
      `candidateCount=${candidates.length} keepQuota=${keepQuota.min}-${keepQuota.max}): ${response.text.slice(0, 200)}`
    );
  }

  return parsed;
}
