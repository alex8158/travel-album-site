import OpenAI from 'openai';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { getTempDir } from '../helpers/tempDir';
import { getStorageProvider } from '../storage/factory';
import { getDb } from '../database';
import { resizeForAnalysis } from './bedrockClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdjustmentParams {
  brightness: number;  // 0~2, 1.0 = 不调整
  contrast: number;    // 0~2, 1.0 = 不调整
  saturation: number;  // 0~2, 1.0 = 不调整
  sharpness: number;   // 0~2, 1.0 = 不调整
}

export interface AiOptimizeResult {
  mediaId: string;
  optimizedPath: string | null;
  params: AdjustmentParams | null;
  skipped: boolean;
  error?: string;
}

export interface AiOptimizeBatchResult {
  totalProcessed: number;
  optimizedCount: number;
  skippedCount: number;
  errorCount: number;
  results: AiOptimizeResult[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REFINEMENT_PROMPT = `你是一位专业的水下摄影后期处理专家。请分析这张水下照片，给出精确的调整建议。

请返回 JSON 格式：
{"brightness": 1.0, "contrast": 1.0, "saturation": 1.0, "sharpness": 1.0}

规则：
- 每个值范围 0~2，1.0 表示不调整
- brightness: 水下照片通常偏暗，适当提亮（1.1~1.4）
- contrast: 水下散射降低对比度，适当增强（1.1~1.3）
- saturation: 水下色彩衰减，适当增强（1.1~1.5）
- sharpness: 轻微锐化改善清晰度（1.0~1.3）
- 如果照片已经很好，返回全 1.0
- 不要过度调整，宁可保守`;

// ---------------------------------------------------------------------------
// DashScope client (reuses pattern from aiImageScreener)
// ---------------------------------------------------------------------------

export function createRefinementClient(): OpenAI {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY environment variable is required');

  const baseURL = process.env.DASHSCOPE_BASE_URL ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1';
  return new OpenAI({ apiKey, baseURL, timeout: 30000 });
}

// ---------------------------------------------------------------------------
// Parsing & Validation
// ---------------------------------------------------------------------------

const ADJUSTMENT_FIELDS: (keyof AdjustmentParams)[] = [
  'brightness', 'contrast', 'saturation', 'sharpness',
];

/**
 * Validate and clamp a raw object into a valid AdjustmentParams.
 * - Missing, non-numeric, or NaN fields default to 1.0
 * - Values outside [0, 2] are clamped to the boundary
 */
export function validateAndClamp(raw: Record<string, unknown>): AdjustmentParams {
  const result: AdjustmentParams = { brightness: 1.0, contrast: 1.0, saturation: 1.0, sharpness: 1.0 };

  for (const field of ADJUSTMENT_FIELDS) {
    const value = raw[field];
    if (typeof value !== 'number' || Number.isNaN(value)) {
      result[field] = 1.0;
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
 *
 * If ALL four params equal 1.0, returns null (no processing needed).
 * Only applies operations for fields that differ from 1.0.
 * brightness and saturation are combined in a single modulate() call when both differ from 1.0.
 */
export async function applyAdjustments(
  imagePath: string,
  params: AdjustmentParams,
  tripId: string,
  mediaId: string
): Promise<string | null> {
  // If all params are 1.0, skip processing entirely
  if (
    params.brightness === 1.0 &&
    params.contrast === 1.0 &&
    params.saturation === 1.0 &&
    params.sharpness === 1.0
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

    // Sharpness: only apply when > 1.0
    if (params.sharpness > 1.0) {
      pipeline = pipeline.sharpen({ sigma: (params.sharpness - 1) * 2 });
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
 * - Queries active images from the database
 * - Calls DashScope (qwen-vl-max) for each image to get adjustment params
 * - Applies sharp adjustments based on the params
 * - Updates media_items.optimized_path in the database
 * - Single image failure does not affect other images (error isolation)
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
    errorCount: 0,
    results: [],
  };

  if (activeImages.length === 0) {
    return result;
  }

  const client = createRefinementClient();
  const model = process.env.DASHSCOPE_MODEL || 'qwen-vl-max';

  const updateStmt = db.prepare(
    `UPDATE media_items SET optimized_path = ? WHERE id = ?`
  );

  const CONCURRENCY = 3; // Process 3 images in parallel

  // Process images with concurrency
  for (let startIdx = 0; startIdx < activeImages.length; startIdx += CONCURRENCY) {
    const chunk = activeImages.slice(startIdx, startIdx + CONCURRENCY);
    const promises = chunk.map(async (image) => {
      try {
        // Download image and convert to base64
        const localPath = await storageProvider.downloadToTemp(image.file_path);
        const base64 = await resizeForAnalysis(localPath);

        // Call DashScope with the image
        const response = await client.chat.completions.create({
          model,
          max_tokens: 256,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' },
                },
                { type: 'text', text: REFINEMENT_PROMPT },
              ],
            },
          ],
        });

        const responseText = response.choices[0]?.message?.content ?? '';

        // Parse the adjustment params
        const params = parseAdjustmentParams(responseText);

        if (!params) {
          // Could not parse valid params — skip this image
          console.warn(`[pipeline] aiRefinement: failed to parse params for image ${image.id}`);
          result.skippedCount++;
          result.results.push({
            mediaId: image.id,
            optimizedPath: null,
            params: null,
            skipped: true,
            error: 'Failed to parse adjustment params from AI response',
          });
          return;
        }

        // Apply adjustments (returns null if all params are 1.0)
        const optimizedPath = await applyAdjustments(localPath, params, tripId, image.id);

        if (optimizedPath) {
          // Update the database with the new optimized path
          updateStmt.run(optimizedPath, image.id);
          result.optimizedCount++;
          result.results.push({
            mediaId: image.id,
            optimizedPath,
            params,
            skipped: false,
          });
          console.log(`[pipeline] aiRefinement: optimized image ${image.id}`);
        } else {
          // All params were 1.0, no adjustment needed
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
