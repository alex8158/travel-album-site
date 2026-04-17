import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { getTempDir } from '../helpers/tempDir';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';
import type { ImageAnalysis } from './imageAnalyzer';
import { analyzeImage } from './imageAnalyzer';
import type { MediaItemRow } from '../helpers/mediaItemRow';

export interface OptimizeParams {
  gammaCorrection?: number;
  claheEnabled?: boolean;
  claheOptions?: { width: number; height: number; maxSlope: number };
  tintCorrection?: { r: number; g: number; b: number };
  sharpenSigma?: number;
  medianFilter?: number;
}

export interface OptimizeResult {
  mediaId: string;
  optimizedPath: string | null;
  error?: string;
}

/**
 * Pure function: compute optimization parameters from image analysis.
 *
 * Conservative rules — "宁可提升少一点，也不要做坏":
 * - Brightness < 80: gentle gamma 1.08
 * - Brightness > 180: gentle gamma 0.92
 * - CLAHE: DISABLED by default (too aggressive for automated use)
 * - Color cast: DISABLED (scene-dependent)
 * - Noise >= 0.6: median(3), no sharpen
 * - Noise >= 0.4: median(3), sharpenSigma 0.2
 * - Noise < 0.4: sharpenSigma 0.25
 */
export function computeOptimizeParams(analysis: ImageAnalysis): OptimizeParams {
  const params: OptimizeParams = {};

  // --- Brightness: very gentle gamma only for clearly dark/bright images ---
  if (analysis.avgBrightness < 80) {
    params.gammaCorrection = 1.08;
  } else if (analysis.avgBrightness > 180) {
    params.gammaCorrection = 0.92;
  }

  // --- CLAHE: DISABLED by default ---
  // Too aggressive for automated use. Underwater, sunset, fog scenes get destroyed.
  // Revisit in V2 with scene-aware classification.

  // --- Color cast: DISABLED ---

  // --- Noise / Sharpen: conservative ---
  if (analysis.noiseLevel >= 0.6) {
    params.medianFilter = 3;
    // no sharpen — noisy images get worse with sharpening
  } else if (analysis.noiseLevel >= 0.4) {
    params.medianFilter = 3;
    params.sharpenSigma = 0.2;
  } else {
    // clean image: very light sharpen
    params.sharpenSigma = 0.25;
  }

  return params;
}

/**
 * Optimize a single image using sharp based on OptimizeParams.
 * Maps: gammaCorrection → sharp.gamma(), clahe → sharp.clahe(),
 *       tintCorrection → sharp.tint(), medianFilter → sharp.median(),
 *       sharpenSigma → sharp.sharpen({sigma})
 * Always: .withMetadata() for EXIF preservation.
 * No resize (preserve original resolution).
 */
export async function optimizeImage(
  imagePath: string,
  tripId: string,
  mediaId: string,
  params: OptimizeParams,
): Promise<string> {
  const outputFilename = `${mediaId}_opt.jpg`;
  const outputRelativePath = `${tripId}/optimized/${outputFilename}`;

  const tempPath = path.join(getTempDir(), outputFilename);

  try {
    let pipeline = sharp(imagePath, { failOn: 'none' });

    // Median filter (noise reduction) — apply early before sharpening
    if (params.medianFilter != null) {
      pipeline = pipeline.median(params.medianFilter);
    }

    // Gamma correction
    if (params.gammaCorrection != null) {
      pipeline = pipeline.gamma(params.gammaCorrection);
    }

    // CLAHE
    if (params.claheEnabled && params.claheOptions) {
      pipeline = pipeline.clahe({
        width: params.claheOptions.width,
        height: params.claheOptions.height,
        maxSlope: params.claheOptions.maxSlope,
      });
    }

    // Tint correction
    if (params.tintCorrection) {
      pipeline = pipeline.tint(params.tintCorrection);
    }

    // Sharpen
    if (params.sharpenSigma != null) {
      pipeline = pipeline.sharpen({ sigma: params.sharpenSigma });
    }

    // Preserve original resolution — no resize for optimized output
    // (thumbnails handle web display sizing separately)

    // Preserve EXIF metadata
    pipeline = pipeline.withMetadata();

    // Output format: always JPEG for web display (consistent, smaller, compatible)
    pipeline = pipeline.jpeg({ quality: 88 });

    await pipeline.toFile(tempPath);

    // Validate output: ensure the optimized file is a valid image
    const meta = await sharp(tempPath).metadata();
    if (!meta.width || !meta.height) {
      throw new Error('Optimized image has no dimensions — output corrupted');
    }

    const storageProvider = getStorageProvider();
    const buffer = fs.readFileSync(tempPath);
    await storageProvider.save(outputRelativePath, buffer);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
  }

  return outputRelativePath;
}

/**
 * Batch optimize all active images for a trip.
 * For each image: read analysis fields from DB; if null, run analyzeImage first.
 * Call computeOptimizeParams → optimizeImage.
 * On failure: append "[optimize] error" to processing_error.
 */
export async function optimizeTrip(tripId: string): Promise<OptimizeResult[]> {
  const db = getDb();
  const storageProvider = getStorageProvider();

  const rows = db.prepare(
    "SELECT * FROM media_items WHERE trip_id = ? AND status = 'active' AND media_type = 'image'"
  ).all(tripId) as MediaItemRow[];

  const updateOptimizedStmt = db.prepare(
    'UPDATE media_items SET optimized_path = ? WHERE id = ?'
  );

  const appendErrorStmt = db.prepare(
    `UPDATE media_items
     SET processing_error = CASE
       WHEN processing_error IS NULL THEN ?
       ELSE processing_error || char(10) || ?
     END
     WHERE id = ?`
  );

  const updateAnalysisStmt = db.prepare(
    `UPDATE media_items
     SET avg_brightness = ?, contrast_level = ?, color_cast_r = ?, color_cast_g = ?, color_cast_b = ?, noise_level = ?
     WHERE id = ?`
  );

  const results: OptimizeResult[] = [];

  for (const row of rows) {
    try {
      const localPath = await storageProvider.downloadToTemp(row.file_path);

      // Build analysis from DB fields, or run analyzeImage if missing
      let analysis: ImageAnalysis;
      if (
        row.avg_brightness != null &&
        row.contrast_level != null &&
        row.color_cast_r != null &&
        row.color_cast_g != null &&
        row.color_cast_b != null &&
        row.noise_level != null
      ) {
        analysis = {
          avgBrightness: row.avg_brightness,
          contrastLevel: row.contrast_level,
          colorCastR: row.color_cast_r,
          colorCastG: row.color_cast_g,
          colorCastB: row.color_cast_b,
          noiseLevel: row.noise_level,
        };
      } else {
        analysis = await analyzeImage(localPath);
        // Persist analysis results
        updateAnalysisStmt.run(
          analysis.avgBrightness,
          analysis.contrastLevel,
          analysis.colorCastR,
          analysis.colorCastG,
          analysis.colorCastB,
          analysis.noiseLevel,
          row.id,
        );
      }

      const params = computeOptimizeParams(analysis);
      const optimizedPath = await optimizeImage(localPath, tripId, row.id, params);
      updateOptimizedStmt.run(optimizedPath, row.id);
      results.push({ mediaId: row.id, optimizedPath });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorText = `[optimize] ${errorMsg}`;
      appendErrorStmt.run(errorText, errorText, row.id);
      results.push({ mediaId: row.id, optimizedPath: null, error: errorMsg });
    }
  }

  return results;
}
