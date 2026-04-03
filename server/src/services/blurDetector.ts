import sharp from 'sharp';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';

/**
 * Laplacian convolution kernel for sharpness detection.
 * Higher variance of the convolved result = sharper image.
 */
const LAPLACIAN_KERNEL = {
  width: 3,
  height: 3,
  kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
};

const DEFAULT_HARD_THRESHOLD = 50;
const DEFAULT_SOFT_THRESHOLD = 150;

export type BlurStatus = 'clear' | 'suspect' | 'blurry';

export interface BlurDetectOptions {
  hardThreshold?: number;  // default 50
  softThreshold?: number;  // default 150
}

export interface BlurResult {
  mediaId: string;
  sharpnessScore: number;
  blurStatus: BlurStatus;
}

export interface BlurDetectResult {
  blurryCount: number;
  suspectCount: number;
  results: BlurResult[];
}

/**
 * Compute the sharpness score of an image using Laplacian variance.
 */
export async function computeSharpness(imagePath: string): Promise<number> {
  const { data, info } = await sharp(imagePath)
    .grayscale()
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
 * Classify blur status based on sharpness variance and dual thresholds.
 */
export function classifyBlur(
  variance: number,
  hardThreshold: number,
  softThreshold: number
): BlurStatus {
  if (variance < hardThreshold) return 'blurry';
  if (variance < softThreshold) return 'suspect';
  return 'clear';
}

interface MediaItemRow {
  id: string;
  file_path: string;
}

/**
 * Detect blurry images in a trip using dual-threshold tri-state classification.
 *
 * - variance < hardThreshold → blurry (trashed with reason 'blur')
 * - hardThreshold ≤ variance < softThreshold → suspect (kept active)
 * - variance ≥ softThreshold → clear
 *
 * On computation error: blur_status = 'suspect', processing_error recorded.
 */
export async function detectBlurry(
  tripId: string,
  options?: BlurDetectOptions
): Promise<BlurDetectResult> {
  const hardThreshold = options?.hardThreshold ?? DEFAULT_HARD_THRESHOLD;
  const softThreshold = options?.softThreshold ?? DEFAULT_SOFT_THRESHOLD;

  if (hardThreshold >= softThreshold) {
    throw new Error('hardThreshold must be less than softThreshold');
  }

  const db = getDb();
  const storageProvider = getStorageProvider();

  const rows = db.prepare(
    "SELECT id, file_path FROM media_items WHERE trip_id = ? AND status = 'active' AND media_type = 'image'"
  ).all(tripId) as MediaItemRow[];

  const trashStmt = db.prepare(
    "UPDATE media_items SET status = 'trashed', trashed_reason = 'blur' WHERE id = ?"
  );
  const updateStmt = db.prepare(
    'UPDATE media_items SET sharpness_score = ?, blur_status = ? WHERE id = ?'
  );
  const errorStmt = db.prepare(
    'UPDATE media_items SET sharpness_score = NULL, blur_status = ?, processing_error = ? WHERE id = ?'
  );

  const results: BlurResult[] = [];
  let blurryCount = 0;
  let suspectCount = 0;

  for (const row of rows) {
    let sharpnessScore: number;
    let blurStatus: BlurStatus;

    try {
      const localPath = await storageProvider.downloadToTemp(row.file_path);
      sharpnessScore = await computeSharpness(localPath);
      blurStatus = classifyBlur(sharpnessScore, hardThreshold, softThreshold);

      updateStmt.run(sharpnessScore, blurStatus, row.id);

      if (blurStatus === 'blurry') {
        trashStmt.run(row.id);
        blurryCount++;
      } else if (blurStatus === 'suspect') {
        suspectCount++;
      }
    } catch (err) {
      // On error: classify as suspect, record processing error
      blurStatus = 'suspect';
      sharpnessScore = 0;
      const errorMsg = err instanceof Error ? err.message : String(err);
      errorStmt.run('suspect', errorMsg, row.id);
      suspectCount++;
    }

    results.push({
      mediaId: row.id,
      sharpnessScore,
      blurStatus,
    });
  }

  return { blurryCount, suspectCount, results };
}
