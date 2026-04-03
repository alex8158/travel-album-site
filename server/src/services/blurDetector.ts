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

const DEFAULT_BLUR_THRESHOLD = 100.0;

export interface BlurResult {
  mediaId: string;
  sharpnessScore: number;
  isBlurry: boolean;
}

/**
 * Compute the sharpness score of an image using Laplacian variance.
 * Extracted from qualitySelector.ts computeQualityScore.
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

interface MediaItemRow {
  id: string;
  file_path: string;
}

/**
 * Detect blurry images in a trip and trash them.
 * Queries all active image media items, computes sharpness for each,
 * and marks those below the threshold as trashed with reason 'blur'.
 */
export async function detectAndTrashBlurry(
  tripId: string,
  threshold: number = DEFAULT_BLUR_THRESHOLD
): Promise<{ blurryCount: number; results: BlurResult[] }> {
  const db = getDb();
  const storageProvider = getStorageProvider();

  const rows = db.prepare(
    "SELECT id, file_path FROM media_items WHERE trip_id = ? AND status = 'active' AND media_type = 'image'"
  ).all(tripId) as MediaItemRow[];

  const trashStmt = db.prepare(
    "UPDATE media_items SET status = 'trashed', trashed_reason = 'blur' WHERE id = ?"
  );
  const sharpnessStmt = db.prepare(
    'UPDATE media_items SET sharpness_score = ? WHERE id = ?'
  );

  const results: BlurResult[] = [];
  let blurryCount = 0;

  for (const row of rows) {
    let sharpnessScore = 0;
    try {
      const localPath = await storageProvider.downloadToTemp(row.file_path);
      sharpnessScore = await computeSharpness(localPath);
    } catch {
      // If sharpness computation fails, default to 0 (will be considered blurry)
      sharpnessScore = 0;
    }

    sharpnessStmt.run(sharpnessScore, row.id);

    const isBlurry = sharpnessScore < threshold;
    if (isBlurry) {
      trashStmt.run(row.id);
      blurryCount++;
    }

    results.push({
      mediaId: row.id,
      sharpnessScore,
      isBlurry,
    });
  }

  return { blurryCount, results };
}
