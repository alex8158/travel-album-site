/**
 * VLM Selector
 *
 * Calls DashScope qwen-vl-max (OpenAI-compatible) to select the best photo(s)
 * from a near-duplicate Curation_Group.
 *
 * Pattern mirrors `aiImageOptimizer.ts` and `aiImageScreener.ts`:
 *  - Resizes images to 768px via `resizeForAnalysis` from bedrockClient
 *  - Sends base64 thumbnails plus a structured prompt to qwen-vl-max
 *  - Parses the JSON response and validates structure / quotas / indices
 *
 * The caller (smartCurationEngine) is responsible for handling fallback when
 * `selectBestByVLM` throws or `parseVLMResponse` returns null.
 */

import OpenAI from 'openai';
import { getStorageProvider } from '../../storage/factory';
import { resizeForAnalysis } from '../bedrockClient';
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
// DashScope client (qwen-vl-max via OpenAI-compatible endpoint)
// ---------------------------------------------------------------------------

function createCurationClient(): OpenAI {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY environment variable is required');

  const baseURL = process.env.DASHSCOPE_BASE_URL ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1';
  return new OpenAI({ apiKey, baseURL, timeout: 30000 });
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

  const storageProvider = getStorageProvider();
  const client = createCurationClient();
  const model = process.env.DASHSCOPE_MODEL || 'qwen-vl-max';

  // 1 + 2: download & resize each candidate
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const localPath = await storageProvider.downloadToTemp(c.filePath);
    const base64 = await resizeForAnalysis(localPath);
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' },
    });
  }

  // 3: append the prompt
  const prompt = buildCurationPrompt(candidates.length, keepQuota);
  content.push({ type: 'text', text: prompt });

  // 4: call the VLM
  const response = await client.chat.completions.create({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content }],
  });

  const responseText = response.choices[0]?.message?.content ?? '';

  // 5: parse & validate
  const parsed = parseVLMResponse(responseText, candidates.length, keepQuota);
  if (!parsed) {
    throw new Error(
      `selectBestByVLM: failed to parse VLM response (candidateCount=${candidates.length}, ` +
      `keepQuota=${keepQuota.min}-${keepQuota.max}): ${responseText.slice(0, 200)}`
    );
  }

  return parsed;
}
