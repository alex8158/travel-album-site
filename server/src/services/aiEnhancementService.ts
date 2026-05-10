// AI Enhancement Service - Type Definitions and Service Class
// Part of v2-image-processing spec

import { v4 as uuid } from 'uuid';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';
import { getAIProviderRegistry } from './ai';
import { resizeForAnalysis } from './bedrockClient';
import { getTempDir } from '../helpers/tempDir';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

// Module-level concurrency lock: tracks media IDs currently being enhanced
const enhancingMediaIds = new Set<string>();

/** AI-recommended enhancement parameters */
export interface EnhancementParams {
  brightness: number;       // gamma adjustment, 0.5-2.0
  contrast: number;         // contrast adjustment coefficient
  saturation: number;       // saturation adjustment coefficient
  sharpenSigma: number;     // sharpening sigma, 0-3.0
  noiseReduction: number;   // median filter kernel size, 0-5
  colorCorrection?: {
    r: number;              // R channel adjustment
    g: number;              // G channel adjustment
    b: number;              // B channel adjustment
  };
}

/** Enhancement result for a single media item */
export interface EnhancementResult {
  mediaId: string;
  versionId: string;
  filePath: string;
  params: EnhancementParams;
  modelName: string;
}

/** Batch enhancement result */
export interface BatchEnhancementResult {
  totalProcessed: number;
  successful: number;
  failed: number;
  skipped: number;
  results: Array<EnhancementResult | { mediaId: string; error: string }>;
}

/** Clamp a number to [min, max] range */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Clamp to [min, max] range and ensure the result is an odd integer.
 * 0 is also acceptable (means no filtering).
 */
function clampOddInt(value: number, min: number, max: number): number {
  const clamped = clamp(value, min, max);
  const rounded = Math.round(clamped);
  if (rounded === 0) return 0;
  // Ensure odd: if even, pick nearest odd within bounds
  if (rounded % 2 === 0) {
    // Try both adjacent odd numbers and pick the closer one
    const lower = rounded - 1;
    const upper = rounded + 1;
    if (lower >= min && lower > 0) {
      if (upper <= max) {
        // Pick whichever is closer to the original clamped value
        return Math.abs(clamped - lower) <= Math.abs(clamped - upper) ? lower : upper;
      }
      return lower;
    }
    if (upper <= max) return upper;
    // Fallback: return 0 (no filtering) if no valid odd in range
    return 0;
  }
  return rounded;
}

/** AI Enhancement Service — coordinates AI analysis and sharp image processing */
export class AIEnhancementService {
  /**
   * Validate and clamp enhancement parameters to safe bounds.
   * gamma: [0.5, 2.0], sharpenSigma: [0, 3.0], noiseReduction: [0, 5],
   * saturation: [0.5, 2.0], contrast: [0.5, 2.0]
   */
  validateAndClampParams(params: EnhancementParams): EnhancementParams {
    return {
      brightness: clamp(params.brightness, 0.5, 2.0),
      contrast: clamp(params.contrast, 0.5, 2.0),
      saturation: clamp(params.saturation, 0.5, 2.0),
      sharpenSigma: clamp(params.sharpenSigma, 0, 3.0),
      noiseReduction: clampOddInt(params.noiseReduction, 0, 5),
      colorCorrection: params.colorCorrection,
    };
  }

  /**
   * Parse AI response text into structured EnhancementParams.
   * Tries multiple extraction strategies:
   * 1. JSON in markdown code blocks (```json ... ```)
   * 2. JSON object pattern {...} in the text
   * 3. Entire text as JSON
   * Returns null if parsing or validation fails.
   */
  parseAIResponse(responseText: string): EnhancementParams | null {
    const requiredFields: Array<keyof EnhancementParams> = [
      'brightness', 'contrast', 'saturation', 'sharpenSigma', 'noiseReduction',
    ];

    let parsed: unknown = null;

    // Strategy 1: Extract JSON from markdown code blocks
    const codeBlockMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeBlockMatch) {
      try {
        parsed = JSON.parse(codeBlockMatch[1].trim());
      } catch {
        // Continue to next strategy
      }
    }

    // Strategy 2: Find a JSON object pattern in the text
    if (!parsed) {
      const objectMatch = responseText.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        try {
          parsed = JSON.parse(objectMatch[0]);
        } catch {
          // Continue to next strategy
        }
      }
    }

    // Strategy 3: Try parsing the entire text as JSON
    if (!parsed) {
      try {
        parsed = JSON.parse(responseText.trim());
      } catch {
        return null;
      }
    }

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const obj = parsed as Record<string, unknown>;

    // Validate all required fields are present and are numbers
    for (const field of requiredFields) {
      if (typeof obj[field] !== 'number' || !isFinite(obj[field] as number)) {
        return null;
      }
    }

    // Build the params object
    const params: EnhancementParams = {
      brightness: obj.brightness as number,
      contrast: obj.contrast as number,
      saturation: obj.saturation as number,
      sharpenSigma: obj.sharpenSigma as number,
      noiseReduction: obj.noiseReduction as number,
    };

    // Include optional colorCorrection if present and valid
    if (obj.colorCorrection && typeof obj.colorCorrection === 'object') {
      const cc = obj.colorCorrection as Record<string, unknown>;
      if (typeof cc.r === 'number' && typeof cc.g === 'number' && typeof cc.b === 'number') {
        params.colorCorrection = { r: cc.r, g: cc.g, b: cc.b };
      }
    }

    // Apply safety bounds
    return this.validateAndClampParams(params);
  }

  /**
   * Send image to AI provider for analysis and return recommended enhancement parameters.
   * Falls back to conservative defaults if AI response cannot be parsed or AI call fails.
   */
  async analyzeForEnhancement(mediaId: string): Promise<EnhancementParams> {
    const ENHANCEMENT_PROMPT =
      'Analyze this image and recommend enhancement parameters as JSON with fields: ' +
      'brightness (gamma 0.5-2.0), contrast (0.5-2.0), saturation (0.5-2.0), ' +
      'sharpenSigma (0-3.0), noiseReduction (0-5, odd integer), and optional ' +
      'colorCorrection ({r, g, b} adjustments). Return ONLY the JSON object.';

    const CONSERVATIVE_DEFAULTS: EnhancementParams = {
      brightness: 1.0,
      contrast: 1.0,
      saturation: 1.0,
      sharpenSigma: 0.25,
      noiseReduction: 0,
    };

    // 1. Query the database for the media item's file_path
    const db = getDb();
    const row = db.prepare(
      'SELECT file_path FROM media_items WHERE id = ?'
    ).get(mediaId) as { file_path: string } | undefined;

    if (!row) {
      throw new Error(`Media item not found: ${mediaId}`);
    }

    // 2. Get a local path to the file via storage provider
    const storageProvider = getStorageProvider();
    let localPath: string;
    try {
      localPath = await storageProvider.downloadToTemp(row.file_path);
    } catch (err) {
      // If we can't access the file, fall back to conservative defaults
      return CONSERVATIVE_DEFAULTS;
    }

    try {
      // 3. Resize and convert to base64 for AI analysis
      const base64 = await resizeForAnalysis(localPath);

      // 4. Send to AI provider
      const registry = getAIProviderRegistry();
      const response = await registry.invokeImageAnalysis(
        [{ base64, mediaType: 'image/jpeg' }],
        ENHANCEMENT_PROMPT,
        { mediaId, taskType: 'image_enhancement' }
      );

      // 5. Parse the AI response
      const params = this.parseAIResponse(response.text);

      // 6. If parsing succeeds, return the clamped params
      if (params) {
        return params;
      }

      // 7. If parsing fails, fall back to conservative defaults
      return CONSERVATIVE_DEFAULTS;
    } catch {
      // AI call failed — fall back to conservative defaults
      return CONSERVATIVE_DEFAULTS;
    } finally {
      // Clean up temp file
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }
    }
  }

  /**
   * Apply enhancement parameters to a media item using sharp processing pipeline.
   * Pipeline order: median → gamma → sharpen → modulate → withMetadata → jpeg(q90).
   * Returns the relative storage path of the enhanced image.
   */
  async applyEnhancement(mediaId: string, params: EnhancementParams): Promise<string> {
    // 1. Query DB for media item file_path and trip_id
    const db = getDb();
    const row = db.prepare(
      'SELECT file_path, trip_id FROM media_items WHERE id = ?'
    ).get(mediaId) as { file_path: string; trip_id: string } | undefined;

    if (!row) {
      throw new Error(`Media item not found: ${mediaId}`);
    }

    const outputFilename = `${mediaId}_enhanced.jpg`;
    const outputRelativePath = `${row.trip_id}/enhanced/${outputFilename}`;
    const tempPath = path.join(getTempDir(), outputFilename);

    // 2. Download to temp via storage provider
    const storageProvider = getStorageProvider();
    const localPath = await storageProvider.downloadToTemp(row.file_path);

    try {
      // 3. Build sharp pipeline
      let pipeline = sharp(localPath, { failOn: 'none' });

      // Median filter (noise reduction) — apply first
      if (params.noiseReduction > 0) {
        pipeline = pipeline.median(params.noiseReduction);
      }

      // Gamma correction (brightness)
      if (params.brightness !== 1.0) {
        pipeline = pipeline.gamma(params.brightness);
      }

      // Sharpen
      if (params.sharpenSigma > 0) {
        pipeline = pipeline.sharpen({ sigma: params.sharpenSigma });
      }

      // Saturation adjustment via modulate
      if (params.saturation !== 1.0) {
        pipeline = pipeline.modulate({ saturation: params.saturation });
      }

      // Preserve EXIF metadata
      pipeline = pipeline.withMetadata();

      // Output format: JPEG quality 90
      pipeline = pipeline.jpeg({ quality: 90 });

      // 4. Write to temp output path
      await pipeline.toFile(tempPath);

      // 5. Upload via storage provider
      const buffer = fs.readFileSync(tempPath);
      await storageProvider.save(outputRelativePath, buffer);
    } catch (err) {
      // Log error and leave original media item unchanged
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[aiEnhancement] Failed to apply enhancement for ${mediaId}: ${errorMsg}`);
      throw err;
    } finally {
      // Clean up temp files
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }

    // 6. Return the relative storage path
    return outputRelativePath;
  }

  /**
   * Full enhancement workflow: analyze → apply → save media_versions record.
   * Includes concurrency lock to prevent duplicate processing.
   */
  async enhanceMedia(mediaId: string): Promise<EnhancementResult> {
    // 1. Check concurrency lock
    if (enhancingMediaIds.has(mediaId)) {
      throw new Error('ENHANCEMENT_IN_PROGRESS');
    }

    // 2. Validate media item exists and is an image
    const db = getDb();
    const mediaItem = db.prepare(
      'SELECT id, media_type FROM media_items WHERE id = ?'
    ).get(mediaId) as { id: string; media_type: string } | undefined;

    if (!mediaItem) {
      throw new Error('MEDIA_NOT_FOUND');
    }
    if (mediaItem.media_type !== 'image') {
      throw new Error('INVALID_MEDIA_TYPE');
    }

    // 3. Acquire lock
    enhancingMediaIds.add(mediaId);

    try {
      // 4. Analyze for enhancement
      const params = await this.analyzeForEnhancement(mediaId);

      // 5. Apply enhancement
      const filePath = await this.applyEnhancement(mediaId, params);

      // 6. Get model name from registry
      const registry = getAIProviderRegistry();
      const modelName = registry.getDefault().metadata.model;

      // 7. Upsert media_versions record (replace existing ai_refined if exists)
      const existingVersion = db.prepare(
        "SELECT id FROM media_versions WHERE media_id = ? AND version_type = 'ai_refined'"
      ).get(mediaId) as { id: string } | undefined;

      let versionId: string;
      if (existingVersion) {
        versionId = existingVersion.id;
        db.prepare(
          "UPDATE media_versions SET file_path = ?, model_name = ?, params = ?, status = 'ready', created_at = ? WHERE id = ?"
        ).run(filePath, modelName, JSON.stringify(params), new Date().toISOString(), versionId);
      } else {
        versionId = uuid();
        db.prepare(
          "INSERT INTO media_versions (id, media_id, version_type, file_path, model_name, params, status, created_at) VALUES (?, ?, 'ai_refined', ?, ?, ?, 'ready', ?)"
        ).run(versionId, mediaId, filePath, modelName, JSON.stringify(params), new Date().toISOString());
      }

      return { mediaId, versionId, filePath, params, modelName };
    } finally {
      // 8. Release lock
      enhancingMediaIds.delete(mediaId);
    }
  }

  /**
   * Determine if a media item is eligible for enhancement based on quality and color scores.
   * Eligible if quality_score < 0.7 OR color_score < 0.6.
   */
  isEligibleForEnhancement(qualityScore: number, colorScore: number): boolean {
    return qualityScore < 0.7 || colorScore < 0.6;
  }

  /**
   * Batch enhance eligible media items in a trip.
   * Processes sequentially to avoid overwhelming the AI provider.
   */
  async enhanceBatch(tripId: string, filters?: { maxQualityScore?: number; maxColorScore?: number }): Promise<BatchEnhancementResult> {
    const db = getDb();
    const maxQuality = filters?.maxQualityScore ?? 0.7;
    const maxColor = filters?.maxColorScore ?? 0.6;

    // Query active image media items with their analysis scores
    const rows = db.prepare(`
      SELECT mi.id, COALESCE(ma.quality_score, 0) as quality_score, COALESCE(ma.color_score, 0) as color_score
      FROM media_items mi
      LEFT JOIN media_analysis ma ON ma.media_id = mi.id
      WHERE mi.trip_id = ? AND mi.media_type = 'image' AND mi.status = 'active'
    `).all(tripId) as Array<{ id: string; quality_score: number; color_score: number }>;

    const result: BatchEnhancementResult = {
      totalProcessed: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
      results: [],
    };

    for (const row of rows) {
      // Check eligibility using configured thresholds
      if (row.quality_score >= maxQuality && row.color_score >= maxColor) {
        result.skipped++;
        result.totalProcessed++;
        continue;
      }

      try {
        const enhancementResult = await this.enhanceMedia(row.id);
        result.successful++;
        result.results.push(enhancementResult);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.failed++;
        result.results.push({ mediaId: row.id, error: errorMsg });
      }
      result.totalProcessed++;
    }

    return result;
  }
}
