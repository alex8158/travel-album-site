import sharp from 'sharp';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';
import { deleteMediaItemFromDb } from '../helpers/deleteMediaItem';

/**
 * Laplacian convolution kernel for sharpness detection.
 * Higher variance of the convolved result = sharper image.
 */
const LAPLACIAN_KERNEL = {
  width: 3,
  height: 3,
  kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
};

const DEFAULT_THRESHOLD = 100;

export type BlurStatus = 'clear' | 'suspect' | 'blurry';

export interface BlurDetectOptions {
  threshold?: number;  // default 50 — sharpnessScore < threshold = blurry
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
 * Applies brightness normalization first to prevent dark/bright images
 * from being falsely classified as blurry.
 */
export async function computeSharpness(imagePath: string): Promise<number> {
  const { data, info } = await sharp(imagePath, { failOn: 'none' })
    .grayscale()
    .normalise()  // Stretch histogram to full 0-255 range — eliminates brightness bias
    .convolve(LAPLACIAN_KERNEL)
    .raw()
    .toBuffer({ resolveWithObject: true });

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
 * Classify blur status based on sharpness variance and a single threshold.
 * sharpnessScore < threshold → blurry
 * sharpnessScore >= threshold → clear
 */
export function classifyBlur(
  variance: number,
  threshold: number
): BlurStatus {
  if (variance < threshold) return 'blurry';
  return 'clear';
}

interface MediaItemRow {
  id: string;
  file_path: string;
  original_filename: string;
  processing_error: string | null;
}

/**
 * Detect blurry images in a trip using single-threshold binary classification.
 *
 * - variance < threshold → blurry (permanently deleted from DB + storage)
 * - variance >= threshold → clear
 *
 * On computation error: blur_status = 'suspect', processing_error appended.
 */
export async function detectBlurry(
  tripId: string,
  options?: BlurDetectOptions
): Promise<BlurDetectResult> {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;

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
      sharpnessScore = await computeSharpness(localPath);
      blurStatus = classifyBlur(sharpnessScore, threshold);

      if (blurStatus === 'blurry') {
        // Move to trash instead of permanent delete — allows user to review
        db.prepare(
          "UPDATE media_items SET status = 'trashed', trashed_reason = 'blur', sharpness_score = ?, blur_status = ? WHERE id = ?"
        ).run(sharpnessScore, blurStatus, row.id);

        deleteLogs.push({
          mediaId: row.id,
          filename: row.original_filename,
          sharpnessScore,
          reason: `sharpness score ${sharpnessScore} below threshold ${threshold}`,
          deletedAt: new Date().toISOString(),
        });
        blurryCount++;
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
