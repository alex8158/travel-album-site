import sharp from 'sharp';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';
import { deleteMediaItemFromDb } from '../helpers/deleteMediaItem';
import { computeMLQuality, isMLServiceAvailable } from './mlQualityService';
import { PROCESS_THRESHOLDS } from './dedupThresholds';
import type { BlurAssessment } from './pipeline/types';

/**
 * Laplacian convolution kernel for sharpness detection.
 * Higher variance of the convolved result = sharper image.
 */
const LAPLACIAN_KERNEL = {
  width: 3,
  height: 3,
  kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
};

export const DEFAULT_BLUR_THRESHOLD = 15;   // < 15 → blurry (明显糊)
export const DEFAULT_CLEAR_THRESHOLD = 50;  // >= 50 → clear, 15~50 → suspect

export type BlurStatus = 'clear' | 'suspect' | 'blurry';

export interface BlurDetectOptions {
  blurThreshold?: number;   // default 15 — sharpnessScore < blurThreshold = blurry
  clearThreshold?: number;  // default 50 — sharpnessScore >= clearThreshold = clear
}

export interface BlurResult {
  mediaId: string;
  sharpnessScore: number;
  blurStatus: BlurStatus;
}

export interface BlurDeleteLog {
  mediaId: string;
  filename: string;
  sharpnessScore: number;
  reason: string;
  deletedAt: string;
}

export interface BlurDetectResult {
  blurryCount: number;
  suspectCount: number;
  deleteLogs: BlurDeleteLog[];
  results: BlurResult[];
}

/**
 * Compute the sharpness score of an image using Laplacian variance.
 * Tries CLAHE brightness normalization first to prevent dark/bright images
 * from being falsely classified as blurry. Falls back to plain Laplacian
 * if CLAHE is not supported by the current libvips/sharp version.
 */
export async function computeSharpness(imagePath: string): Promise<number> {
  let data: Buffer;
  let info: { width: number; height: number };

  try {
    // Try with CLAHE normalization (preferred — matches Python analyze.py)
    const result = await sharp(imagePath, { failOn: 'none' })
      .grayscale()
      .clahe({ width: 3, height: 3, maxSlope: 3 })
      .convolve(LAPLACIAN_KERNEL)
      .raw()
      .toBuffer({ resolveWithObject: true });
    data = result.data;
    info = result.info;
  } catch {
    // CLAHE not supported — fall back to plain grayscale Laplacian
    const result = await sharp(imagePath, { failOn: 'none' })
      .grayscale()
      .convolve(LAPLACIAN_KERNEL)
      .raw()
      .toBuffer({ resolveWithObject: true });
    data = result.data;
    info = result.info;
  }

  const pixelCount = info.width * info.height;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < pixelCount; i++) {
    const v = data[i];
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / pixelCount;
  return sumSq / pixelCount - mean * mean;
}

/**
 * Classify blur status based on sharpness variance and dual thresholds.
 * sharpnessScore < blurThreshold → blurry
 * sharpnessScore >= clearThreshold → clear
 * in between → suspect
 */
export function classifyBlur(
  variance: number,
  blurThreshold: number,
  clearThreshold?: number
): BlurStatus {
  if (variance < blurThreshold) return 'blurry';
  if (clearThreshold !== undefined && variance < clearThreshold) return 'suspect';
  return 'clear';
}

/**
 * Dual-condition blur classification using Laplacian + MUSIQ IQA.
 * Only marks as blurry when BOTH conditions are met:
 * - Laplacian variance < blurThreshold (traditional blur indicator)
 * - MUSIQ score < musiqBlurThreshold (ML quality indicator)
 *
 * This prevents dark/night/underwater images from being falsely classified as blurry.
 * Falls back to single-condition (Laplacian only) when ML service is unavailable.
 */
export async function classifyBlurDual(
  imagePath: string,
  blurThreshold: number,
  clearThreshold: number,
  musiqBlurThreshold = 30  // MUSIQ score below 30 = likely genuinely bad quality
): Promise<{ blurStatus: BlurStatus; sharpnessScore: number; musiqScore: number | null }> {
  const sharpnessScore = await computeSharpness(imagePath);

  // If clearly sharp by Laplacian, no need for ML check
  if (sharpnessScore >= clearThreshold) {
    return { blurStatus: 'clear', sharpnessScore, musiqScore: null };
  }

  // If Laplacian says suspect or blurry, try ML confirmation
  const mlAvailable = await isMLServiceAvailable();
  const effectiveMusiqThreshold = parseFloat(process.env.MUSIQ_BLUR_THRESHOLD ?? String(musiqBlurThreshold));
  if (mlAvailable && sharpnessScore < blurThreshold) {
    try {
      const mlResult = await computeMLQuality(imagePath);
      const musiqScore = mlResult.musiq_score;

      if (musiqScore != null) {
        // Dual condition: both Laplacian AND MUSIQ must agree it's bad
        if (musiqScore < effectiveMusiqThreshold) {
          return { blurStatus: 'blurry', sharpnessScore, musiqScore };
        } else {
          // Laplacian says blurry but MUSIQ says acceptable — mark as suspect, not blurry
          return { blurStatus: 'suspect', sharpnessScore, musiqScore };
        }
      }
    } catch (err) {
      console.warn(`[blurDetector] ML quality check failed, using Laplacian only: ${err}`);
    }
  }

  // Fallback: single-condition classification
  const blurStatus = classifyBlur(sharpnessScore, blurThreshold, clearThreshold);
  return { blurStatus, sharpnessScore, musiqScore: null };
}

/**
 * Pure assessment function for Node.js blur detection.
 * Returns a BlurAssessment without any DB writes or side effects.
 *
 * Uses dual-condition detection when ML service is available:
 * - Laplacian < blurThreshold AND MUSIQ < musiqThreshold → blurry
 * - Laplacian in suspect zone AND MUSIQ very low (< 20) → blurry
 * - Otherwise falls back to single-condition Laplacian classification
 *
 * This is the Node fallback called by the orchestrator's runBlurStage
 * when Python blur detection fails. It is NOT the fallback chain owner.
 */
export async function assessBlur(imagePath: string): Promise<BlurAssessment> {
  try {
    const dualResult = await classifyBlurDual(
      imagePath,
      PROCESS_THRESHOLDS.blurThreshold,
      PROCESS_THRESHOLDS.clearThreshold,
      PROCESS_THRESHOLDS.musiqBlurThreshold,
    );

    // Extra check: if Laplacian says suspect but MUSIQ says very bad quality,
    // upgrade to blurry. This catches blurry underwater/low-contrast photos
    // where Laplacian variance is inflated by noise/grain.
    let finalStatus = dualResult.blurStatus;
    if (
      finalStatus === 'suspect' &&
      dualResult.musiqScore != null &&
      dualResult.musiqScore < 20
    ) {
      finalStatus = 'blurry';
    }

    return {
      sharpnessScore: dualResult.sharpnessScore,
      blurStatus: finalStatus,
      musiqScore: dualResult.musiqScore,
      source: 'node',
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      blurStatus: 'suspect',
      sharpnessScore: null,
      source: 'node',
      error: errorMessage,
    };
  }
}

interface MediaItemRow {
  id: string;
  file_path: string;
  original_filename: string;
  processing_error: string | null;
}

/**
 * Detect blurry images in a trip using dual-threshold three-tier classification.
 *
 * - variance < blurThreshold (15) → blurry → trashed
 * - blurThreshold <= variance < clearThreshold (50) → suspect → active, marked
 * - variance >= clearThreshold (50) → clear
 *
 * On computation error: blur_status = 'suspect', processing_error appended.
 */
export async function detectBlurry(
  tripId: string,
  options?: BlurDetectOptions
): Promise<BlurDetectResult> {
  const blurThreshold = options?.blurThreshold ?? DEFAULT_BLUR_THRESHOLD;
  const clearThreshold = options?.clearThreshold ?? DEFAULT_CLEAR_THRESHOLD;

  const db = getDb();
  const storageProvider = getStorageProvider();

  const rows = db.prepare(
    "SELECT id, file_path, original_filename, processing_error FROM media_items WHERE trip_id = ? AND status = 'active' AND media_type = 'image'"
  ).all(tripId) as MediaItemRow[];

  const deleteTagsStmt = db.prepare('DELETE FROM media_tags WHERE media_id = ?');
  const updateStmt = db.prepare(
    'UPDATE media_items SET sharpness_score = ?, blur_status = ? WHERE id = ?'
  );
  const errorStmt = db.prepare(
    'UPDATE media_items SET sharpness_score = NULL, blur_status = ?, processing_error = ? WHERE id = ?'
  );

  const results: BlurResult[] = [];
  const deleteLogs: BlurDeleteLog[] = [];
  let blurryCount = 0;
  let suspectCount = 0;

  for (const row of rows) {
    let sharpnessScore: number;
    let blurStatus: BlurStatus;

    try {
      const localPath = await storageProvider.downloadToTemp(row.file_path);

      // Use dual-condition blur detection (Laplacian + MUSIQ) when ML available
      const dualResult = await classifyBlurDual(localPath, blurThreshold, clearThreshold);
      sharpnessScore = dualResult.sharpnessScore;
      blurStatus = dualResult.blurStatus;

      if (blurStatus === 'blurry') {
        // Only trash clearly blurry images
        db.prepare(
          "UPDATE media_items SET status = 'trashed', trashed_reason = 'blur', sharpness_score = ?, blur_status = ? WHERE id = ?"
        ).run(sharpnessScore, blurStatus, row.id);

        deleteLogs.push({
          mediaId: row.id,
          filename: row.original_filename,
          sharpnessScore,
          reason: `sharpness score ${sharpnessScore} below blur threshold ${blurThreshold}`,
          deletedAt: new Date().toISOString(),
        });
        blurryCount++;
      } else if (blurStatus === 'suspect') {
        // Suspect: keep active, just mark
        updateStmt.run(sharpnessScore, blurStatus, row.id);
        suspectCount++;
      } else {
        updateStmt.run(sharpnessScore, blurStatus, row.id);
      }
    } catch (err) {
      // On error: classify as suspect, append to processing_error
      blurStatus = 'suspect';
      sharpnessScore = 0;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const prefixedError = `[blurDetect] ${errorMsg}`;

      // Append to existing processing_error with newline separator
      const existingError = row.processing_error;
      const newError = existingError
        ? `${existingError}\n${prefixedError}`
        : prefixedError;

      errorStmt.run('suspect', newError, row.id);
      suspectCount++;
    }

    results.push({
      mediaId: row.id,
      sharpnessScore,
      blurStatus,
    });
  }

  return { blurryCount, suspectCount, deleteLogs, results };
}

// ---------------------------------------------------------------------------
// Apply Bedrock blur result to database
// ---------------------------------------------------------------------------

/**
 * Update a media item's blur status based on Bedrock analysis result.
 * - blurry → status='trashed', trashed_reason='blur', blur_status='blurry'
 * - clear  → blur_status='clear' (status remains unchanged)
 */
export function applyBlurResult(mediaId: string, blurStatus: 'clear' | 'blurry'): void {
  const db = getDb();
  if (blurStatus === 'blurry') {
    db.prepare(
      "UPDATE media_items SET status = 'trashed', trashed_reason = 'blur', blur_status = 'blurry' WHERE id = ?"
    ).run(mediaId);
  } else {
    db.prepare(
      "UPDATE media_items SET blur_status = 'clear' WHERE id = ?"
    ).run(mediaId);
  }
}
