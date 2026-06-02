import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { getTempDir } from '../helpers/tempDir';
import { getStorageProvider } from '../storage/factory';
import { getDb } from '../database';
import { resizeForAnalysis } from './bedrockClient';
import { callVLM, isVLMAvailable, getActiveProvider, getActiveModel } from './smartCuration/vlmClient';
import type { TrashReason } from './smartCuration/smartCurationEngine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdjustmentParams {
  brightness: number;  // 0~2, 1.0 = 不调整
  contrast: number;    // 0~2, 1.0 = 不调整
  saturation: number;  // 0~2, 1.0 = 不调整
  sharpness: number;   // 0~2, 1.0 = 不调整
  clarity: number;     // 0~2, 1.0 = 不调整 (局部对比度增强)
  temperature: number; // -1~1, 0 = 不调整 (负值偏冷/蓝，正值偏暖/黄)
}

/**
 * Trash reasons the refinement stage is allowed to emit. The VLM is looking
 * at one photo at a time here, so it cannot make redundancy decisions —
 * only intrinsic quality problems that the previous stages may have missed.
 */
const VALID_REFINEMENT_TRASH_REASONS: ReadonlySet<TrashReason> = new Set<TrashReason>([
  'blurry',
  'low_subject_quality',
  'low_aesthetic_quality',
]);

export interface RefinementVerdict {
  decision: 'keep' | 'trash';
  trashReason: TrashReason | null;
  /** Adjustments are only meaningful when decision === 'keep'. */
  params: AdjustmentParams | null;
}

export interface AiOptimizeResult {
  mediaId: string;
  optimizedPath: string | null;
  params: AdjustmentParams | null;
  skipped: boolean;
  /** True when the VLM rejected this photo and it was soft-deleted. */
  trashed?: boolean;
  trashReason?: TrashReason | null;
  error?: string;
}

export interface AiOptimizeBatchResult {
  totalProcessed: number;
  optimizedCount: number;
  skippedCount: number;
  /** Photos the refinement VLM rejected (soft-deleted on the spot). */
  trashedCount: number;
  errorCount: number;
  results: AiOptimizeResult[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Refinement prompt with a combined verdict + adjustments contract.
 *
 * The VLM gets one photo at a time and is asked to do TWO things in one
 * response:
 *
 *   1. Decide whether the photo deserves to stay in the album.
 *   2. If it stays, give us per-channel adjustment numbers for sharp.
 *
 * Combining both decisions into one VLM call is cheap — refinement was
 * already running per-photo for adjustments, and the model has the photo
 * loaded anyway. This is the last chance to catch something the earlier
 * stages let through (subject overexposure that cannot be saved by tone
 * tweaks, severe blur, broken composition).
 *
 * It cannot detect cross-photo redundancy here — the VLM only sees one
 * photo per call. That work belongs to sceneDedup.
 */
export const REFINEMENT_PROMPT = `你是一位专业的旅行摄影后期处理专家。请对这张照片做两件事：

1. 判断这张照片是否值得放进游记相册（保留或丢弃）
2. 如果保留，给出精确的调整建议供后期处理

请返回 JSON 格式：
{
  "decision": "keep",
  "trashReason": null,
  "brightness": 1.0,
  "contrast": 1.0,
  "saturation": 1.0,
  "sharpness": 1.0,
  "clarity": 1.0,
  "temperature": 0
}

【关于 decision/trashReason】
默认 decision = "keep"。只有以下情况才 decision = "trash"：
- 主体严重模糊或失焦（即使能认出主体，但细节糊到不能用）→ trashReason: "blurry"
- 主体严重过曝或欠曝且后期救不回来（高光烧白成片、暗部黑成剪影看不清细节）→ trashReason: "low_subject_quality"
- 构图严重破碎、没有清晰的主体、画面混乱 → trashReason: "low_aesthetic_quality"

如果 decision = "trash"，调色参数仍要返回（用默认值 1.0/0），但不会被使用。
水下蓝色背景是正常的，不要因此 trash。如果只是色调偏冷/暖，那是调色能解决的问题，不是 trash 的理由。

【关于调色参数（仅 decision="keep" 时生效）】
- brightness: 范围 0~2，1.0 表示不调整。偏暗照片适当提亮（1.1~1.4）。但如果照片中主体或大面积区域已经有高光/过曝（白色溢出、细节丢失），绝对不要提亮，甚至可以适当降低（0.85~0.95）
- contrast: 范围 0~2，1.0 表示不调整。低对比度照片适当增强（1.1~1.3）。如果已有过曝区域，不要增加对比度
- saturation: 范围 0~2，1.0 表示不调整。色彩暗淡时适当增强（1.1~1.5）
- sharpness: 范围 0~2，1.0 表示不调整。轻微锐化改善清晰度（1.0~1.3）
- clarity: 范围 0~2，1.0 表示不调整。增强局部对比度让细节更突出（1.1~1.4）
- temperature: 范围 -1~1，0 表示不调整。负值偏冷（蓝调），正值偏暖（黄调）。水下照片通常偏蓝需要加暖（0.1~0.3），日落照片可能需要微调
- 重要：如果照片已经有过曝/高光溢出的区域，优先保护高光细节，不要让情况更糟
- 如果照片已经很好，返回全部默认值
- 不要过度调整，宁可保守`;

// ---------------------------------------------------------------------------
// Parsing & Validation
// ---------------------------------------------------------------------------

const ADJUSTMENT_FIELDS: (keyof AdjustmentParams)[] = [
  'brightness', 'contrast', 'saturation', 'sharpness', 'clarity', 'temperature',
];

/**
 * Validate and clamp a raw object into a valid AdjustmentParams.
 * - Missing, non-numeric, or NaN fields default to their neutral value
 * - brightness/contrast/saturation/sharpness/clarity: clamped to [0, 2], default 1.0
 * - temperature: clamped to [-1, 1], default 0
 */
export function validateAndClamp(raw: Record<string, unknown>): AdjustmentParams {
  const result: AdjustmentParams = {
    brightness: 1.0, contrast: 1.0, saturation: 1.0,
    sharpness: 1.0, clarity: 1.0, temperature: 0,
  };

  for (const field of ADJUSTMENT_FIELDS) {
    const value = raw[field];
    if (typeof value !== 'number' || Number.isNaN(value)) {
      // keep default
      continue;
    }
    if (field === 'temperature') {
      result[field] = Math.min(1, Math.max(-1, value));
    } else if (field === 'brightness') {
      // Tighter brightness range to prevent highlight clipping on flash photography
      result[field] = Math.min(1.3, Math.max(0.7, value));
    } else if (field === 'contrast') {
      // Moderate contrast range to prevent crushing shadows/blowing highlights
      result[field] = Math.min(1.4, Math.max(0.7, value));
    } else {
      result[field] = Math.min(2, Math.max(0, value));
    }
  }

  return result;
}

/**
 * Parse AI response text into AdjustmentParams.
 * Extraction strategy (in order):
 * 1. Direct JSON.parse of the entire text
 * 2. Extract from markdown code block (```json ... ``` or ``` ... ```)
 * 3. Find first `{` to its matching `}` in the text
 * If extraction succeeds, pass to validateAndClamp.
 * If all attempts fail, return null.
 */
export function parseAdjustmentParams(responseText: string): AdjustmentParams | null {
  // Strategy 1: Direct JSON.parse
  try {
    const parsed = JSON.parse(responseText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return validateAndClamp(parsed as Record<string, unknown>);
    }
  } catch {
    // Not valid JSON, try next strategy
  }

  // Strategy 2: Markdown code block (```json ... ``` or ``` ... ```)
  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;
  const codeBlockMatch = responseText.match(codeBlockRegex);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return validateAndClamp(parsed as Record<string, unknown>);
      }
    } catch {
      // Code block content is not valid JSON, try next strategy
    }
  }

  // Strategy 3: Find first `{` to matching `}`
  const firstBrace = responseText.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0;
    for (let i = firstBrace; i < responseText.length; i++) {
      if (responseText[i] === '{') depth++;
      else if (responseText[i] === '}') {
        depth--;
        if (depth === 0) {
          const jsonCandidate = responseText.slice(firstBrace, i + 1);
          try {
            const parsed = JSON.parse(jsonCandidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              return validateAndClamp(parsed as Record<string, unknown>);
            }
          } catch {
            // Not valid JSON even with brace matching
          }
          break;
        }
      }
    }
  }

  // All strategies failed
  return null;
}

/**
 * Parse the AI response into a full RefinementVerdict (decision +
 * adjustments). Re-uses the existing parameter extraction strategies, then
 * additionally pulls out `decision` / `trashReason` if present.
 *
 * Backwards-compatible default: when the response contains no `decision`
 * field at all, behave like the old prompt — keep the photo and use the
 * parsed adjustments. This means deployments still pointed at the legacy
 * provider/model fall back to the old behaviour rather than crashing.
 *
 * Conservative on invalid input:
 *   - decision is anything other than "trash" (incl. missing) → keep
 *   - decision is "trash" but trashReason is missing or not a valid
 *     refinement-tier reason → keep (we never delete a photo we cannot
 *     justify in the audit log)
 */
export function parseRefinementVerdict(responseText: string): RefinementVerdict | null {
  // Try to extract the raw JSON object first (re-uses the same three
  // strategies as parseAdjustmentParams).
  let raw: Record<string, unknown> | null = null;

  try {
    const direct = JSON.parse(responseText);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      raw = direct as Record<string, unknown>;
    }
  } catch {
    // try other strategies below
  }

  if (!raw) {
    const fenceMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      try {
        const parsed = JSON.parse(fenceMatch[1].trim());
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          raw = parsed as Record<string, unknown>;
        }
      } catch {
        // fall through
      }
    }
  }

  if (!raw) {
    const firstBrace = responseText.indexOf('{');
    if (firstBrace !== -1) {
      let depth = 0;
      for (let i = firstBrace; i < responseText.length; i++) {
        if (responseText[i] === '{') depth++;
        else if (responseText[i] === '}') {
          depth--;
          if (depth === 0) {
            try {
              const parsed = JSON.parse(responseText.slice(firstBrace, i + 1));
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                raw = parsed as Record<string, unknown>;
              }
            } catch {
              // give up
            }
            break;
          }
        }
      }
    }
  }

  if (!raw) return null;

  // Always derive adjustments — even on a 'trash' verdict we keep the
  // numbers around for the audit trail.
  const params = validateAndClamp(raw);

  const rawDecision = raw.decision;
  if (rawDecision !== 'trash') {
    // Default and explicit "keep" path. Anything other than the literal
    // string 'trash' is treated as keep — generous to malformed responses.
    return { decision: 'keep', trashReason: null, params };
  }

  // decision === 'trash'. Validate the reason; if missing or not in our
  // allowed set, fall back to keep so we never delete on an unrecognised
  // tag.
  const rawReason = raw.trashReason ?? raw.reason;
  if (typeof rawReason !== 'string') {
    return { decision: 'keep', trashReason: null, params };
  }
  if (!VALID_REFINEMENT_TRASH_REASONS.has(rawReason as TrashReason)) {
    return { decision: 'keep', trashReason: null, params };
  }

  return {
    decision: 'trash',
    trashReason: rawReason as TrashReason,
    params,
  };
}


// ---------------------------------------------------------------------------
// Sharp Adjustments
// ---------------------------------------------------------------------------

/**
 * Apply image adjustments using sharp based on AdjustmentParams.
 *
 * Mapping:
 * - brightness → modulate({ brightness })
 * - contrast  → linear(contrast, -(128 * (contrast - 1)))
 * - saturation → modulate({ saturation })
 * - sharpness → sharpen({ sigma: (sharpness - 1) * 2 }) only when > 1.0
 * - clarity   → sharpen with larger sigma for local contrast (sigma: 3, flat: clarity-1)
 * - temperature → tint adjustment via raw color channel manipulation
 *
 * If ALL params are at their neutral values, returns null (no processing needed).
 * Only applies operations for fields that differ from neutral.
 * brightness and saturation are combined in a single modulate() call when both differ from 1.0.
 */
export async function applyAdjustments(
  imagePath: string,
  params: AdjustmentParams,
  tripId: string,
  mediaId: string
): Promise<string | null> {
  // If all params are neutral, skip processing entirely
  if (
    params.brightness === 1.0 &&
    params.contrast === 1.0 &&
    params.saturation === 1.0 &&
    params.sharpness === 1.0 &&
    params.clarity === 1.0 &&
    params.temperature === 0
  ) {
    return null;
  }

  const outputFilename = `${mediaId}_ai_opt.jpg`;
  const outputRelativePath = `${tripId}/optimized/${outputFilename}`;
  const tempPath = path.join(getTempDir(), outputFilename);

  try {
    let pipeline = sharp(imagePath, { failOn: 'none' });

    // Combine brightness and saturation in a single modulate() call
    const modulateOptions: { brightness?: number; saturation?: number } = {};
    if (params.brightness !== 1.0) {
      modulateOptions.brightness = params.brightness;
    }
    if (params.saturation !== 1.0) {
      modulateOptions.saturation = params.saturation;
    }
    if (Object.keys(modulateOptions).length > 0) {
      pipeline = pipeline.modulate(modulateOptions);
    }

    // Contrast: linear(contrast, -(128 * (contrast - 1)))
    if (params.contrast !== 1.0) {
      pipeline = pipeline.linear(params.contrast, -(128 * (params.contrast - 1)));
    }

    // Clarity: local contrast enhancement using unsharp mask with larger radius
    // This is different from sharpness — clarity affects mid-tone contrast
    if (params.clarity > 1.0) {
      pipeline = pipeline.sharpen({
        sigma: 3,
        m1: (params.clarity - 1) * 2,  // flat areas enhancement
        m2: (params.clarity - 1),       // jagged areas (less aggressive)
      });
    }

    // Sharpness: fine detail sharpening with smaller radius
    if (params.sharpness > 1.0) {
      pipeline = pipeline.sharpen({ sigma: (params.sharpness - 1) * 2 });
    }

    // Temperature: shift color balance by adjusting red/blue channels
    // Positive = warmer (more red/yellow), Negative = cooler (more blue)
    if (params.temperature !== 0) {
      const t = params.temperature;
      // Use linear per-channel: warm adds red & reduces blue, cool does opposite
      // We apply a subtle tint via recomb matrix
      const warmShift = t * 0.15; // max 15% shift at temperature=1
      pipeline = pipeline.recomb([
        [1 + warmShift, 0, 0],           // Red channel boost for warm
        [0, 1, 0],                        // Green unchanged
        [0, 0, 1 - warmShift],           // Blue channel reduction for warm
      ]);
    }

    // Preserve EXIF metadata
    pipeline = pipeline.withMetadata();

    // Output as JPEG (consistent with existing optimize stage)
    pipeline = pipeline.jpeg({ quality: 88 });

    await pipeline.toFile(tempPath);

    // Save to storage
    const storageProvider = getStorageProvider();
    const buffer = fs.readFileSync(tempPath);
    await storageProvider.save(outputRelativePath, buffer);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
  }

  return outputRelativePath;
}


// ---------------------------------------------------------------------------
// Main AI Refinement Function
// ---------------------------------------------------------------------------

/**
 * Run AI refinement on all active images for a trip.
 *
 * For each photo:
 *   1. Send it to the configured VLM with the combined verdict + adjustments prompt.
 *   2. If the VLM returns a "trash" verdict with a valid refinement-tier reason
 *      (blurry / low_subject_quality / low_aesthetic_quality), soft-delete the
 *      photo (status='trashed', trashed_reason=<reason>) and skip optimisation.
 *   3. Otherwise apply sharp adjustments based on the returned params and
 *      update `optimized_path`.
 *
 * Provider is whatever `vlmClient.getActiveProvider()` resolves to from env
 * (anthropic / dashscope / bedrock). When no VLM is configured the stage
 * is a no-op — every photo stays as-is with no optimisation.
 *
 * Single-image errors are isolated (one photo failing does not affect the
 * rest of the batch). Concurrency is bounded at 3 in-flight requests to
 * stay under per-minute rate limits.
 */
export async function runAiRefinement(tripId: string): Promise<AiOptimizeBatchResult> {
  const db = getDb();
  const storageProvider = getStorageProvider();

  // Query active images for this trip
  const activeImages = db.prepare(
    `SELECT id, file_path FROM media_items
     WHERE trip_id = ? AND status = 'active' AND media_type = 'image'`
  ).all(tripId) as Array<{ id: string; file_path: string }>;

  const result: AiOptimizeBatchResult = {
    totalProcessed: activeImages.length,
    optimizedCount: 0,
    skippedCount: 0,
    trashedCount: 0,
    errorCount: 0,
    results: [],
  };

  if (activeImages.length === 0) {
    return result;
  }

  if (!isVLMAvailable()) {
    console.warn('[pipeline] aiRefinement: no VLM provider configured — skipping');
    result.skippedCount = activeImages.length;
    for (const image of activeImages) {
      result.results.push({
        mediaId: image.id,
        optimizedPath: null,
        params: null,
        skipped: true,
      });
    }
    return result;
  }

  console.log(
    `[pipeline] aiRefinement: VLM provider=${getActiveProvider()} model=${getActiveModel()}`
  );

  const updateOptimizedStmt = db.prepare(
    `UPDATE media_items SET optimized_path = ? WHERE id = ?`
  );
  const trashStmt = db.prepare(
    `UPDATE media_items SET status = 'trashed', trashed_reason = ? WHERE id = ?`
  );

  const CONCURRENCY = 3; // Process 3 images in parallel

  // Process images with concurrency
  for (let startIdx = 0; startIdx < activeImages.length; startIdx += CONCURRENCY) {
    const chunk = activeImages.slice(startIdx, startIdx + CONCURRENCY);
    const promises = chunk.map(async (image) => {
      try {
        // Download image and resize for analysis
        const localPath = await storageProvider.downloadToTemp(image.file_path);
        const base64 = await resizeForAnalysis(localPath);

        // Provider-agnostic VLM call.
        const response = await callVLM({
          images: [{ base64, mediaType: 'image/jpeg' }],
          prompt: REFINEMENT_PROMPT,
          maxTokens: 512,
        });

        const verdict = parseRefinementVerdict(response.text);

        if (!verdict) {
          // Could not parse anything — skip this image, do not delete.
          console.warn(
            `[pipeline] aiRefinement: failed to parse verdict for image ${image.id} ` +
            `(provider=${response.provider} model=${response.model})`
          );
          result.skippedCount++;
          result.results.push({
            mediaId: image.id,
            optimizedPath: null,
            params: null,
            skipped: true,
            error: 'Failed to parse refinement verdict from AI response',
          });
          return;
        }

        // Trash verdict — soft-delete and skip optimisation.
        if (verdict.decision === 'trash' && verdict.trashReason) {
          trashStmt.run(verdict.trashReason, image.id);
          result.trashedCount++;
          result.results.push({
            mediaId: image.id,
            optimizedPath: null,
            params: verdict.params,
            skipped: true,
            trashed: true,
            trashReason: verdict.trashReason,
          });
          console.log(
            `[pipeline] aiRefinement: trashed image ${image.id} (reason=${verdict.trashReason})`
          );
          return;
        }

        // Keep verdict — proceed with adjustments.
        const params = verdict.params;
        if (!params) {
          // Should not happen because validateAndClamp always returns a value,
          // but guard anyway.
          result.skippedCount++;
          result.results.push({
            mediaId: image.id,
            optimizedPath: null,
            params: null,
            skipped: true,
          });
          return;
        }

        const optimizedPath = await applyAdjustments(localPath, params, tripId, image.id);

        if (optimizedPath) {
          updateOptimizedStmt.run(optimizedPath, image.id);
          result.optimizedCount++;
          result.results.push({
            mediaId: image.id,
            optimizedPath,
            params,
            skipped: false,
          });
          console.log(`[pipeline] aiRefinement: optimized image ${image.id}`);
        } else {
          // All params were neutral — nothing to do.
          result.skippedCount++;
          result.results.push({
            mediaId: image.id,
            optimizedPath: null,
            params,
            skipped: true,
          });
          console.log(`[pipeline] aiRefinement: skipped image ${image.id} (no adjustment needed)`);
        }
      } catch (err) {
        // Error isolation: log and continue to next image
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[pipeline] aiRefinement: error processing image ${image.id}: ${msg}`);
        result.errorCount++;
        result.results.push({
          mediaId: image.id,
          optimizedPath: null,
          params: null,
          skipped: false,
          error: msg,
        });
      }
    });

    await Promise.all(promises);
  }

  return result;
}
