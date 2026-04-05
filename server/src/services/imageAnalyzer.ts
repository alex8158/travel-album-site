import sharp from 'sharp';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';
import type { MediaItemRow } from '../helpers/mediaItemRow';

/**
 * Laplacian convolution kernel for noise estimation.
 */
const LAPLACIAN_KERNEL = {
  width: 3,
  height: 3,
  kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
};

export interface ImageAnalysis {
  avgBrightness: number;    // 0-255, average of R/G/B channel means
  contrastLevel: number;    // 0-128, average of R/G/B channel stdevs
  colorCastR: number;       // R channel mean minus overall average mean
  colorCastG: number;       // G channel mean minus overall average mean
  colorCastB: number;       // B channel mean minus overall average mean
  noiseLevel: number;       // high-frequency ratio, 0-1+
}

/**
 * Compute variance of a raw pixel buffer.
 */
function computeVariance(data: Buffer, pixelCount: number): number {
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
 * Estimate noise using Laplacian variance ratio method.
 * Resizes to 256x256 grayscale, computes Laplacian variance / (original variance + 1).
 */
async function estimateNoise(imagePath: string): Promise<number> {
  const { data: origData, info: origInfo } = await sharp(imagePath, { failOn: 'none' })
    .resize(256, 256, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const origPixelCount = origInfo.width * origInfo.height;
  const originalVariance = computeVariance(origData, origPixelCount);

  const { data: lapData, info: lapInfo } = await sharp(imagePath, { failOn: 'none' })
    .resize(256, 256, { fit: 'fill' })
    .grayscale()
    .convolve(LAPLACIAN_KERNEL)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const lapPixelCount = lapInfo.width * lapInfo.height;
  const laplacianVariance = computeVariance(lapData, lapPixelCount);

  return laplacianVariance / (originalVariance + 1);
}

/**
 * Analyze image characteristics: brightness, contrast, color cast, noise.
 */
export async function analyzeImage(imagePath: string): Promise<ImageAnalysis> {
  const stats = await sharp(imagePath, { failOn: 'none' }).stats();

  // Use first 3 channels (R, G, B)
  const channels = stats.channels.slice(0, 3);
  const rMean = channels[0].mean;
  const gMean = channels[1].mean;
  const bMean = channels[2].mean;

  const avgBrightness = (rMean + gMean + bMean) / 3;

  const rStdev = channels[0].stdev;
  const gStdev = channels[1].stdev;
  const bStdev = channels[2].stdev;

  const contrastLevel = (rStdev + gStdev + bStdev) / 3;

  const colorCastR = rMean - avgBrightness;
  const colorCastG = gMean - avgBrightness;
  const colorCastB = bMean - avgBrightness;

  const noiseLevel = await estimateNoise(imagePath);

  return {
    avgBrightness,
    contrastLevel,
    colorCastR,
    colorCastG,
    colorCastB,
    noiseLevel,
  };
}

/**
 * Analyze all active images for a trip and write results to DB.
 * On failure per image: appends to processing_error with prefix "[analyze]".
 */
export async function analyzeTrip(tripId: string): Promise<void> {
  const db = getDb();
  const storageProvider = getStorageProvider();

  const rows = db.prepare(
    "SELECT * FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active'"
  ).all(tripId) as MediaItemRow[];

  const updateStmt = db.prepare(
    `UPDATE media_items
     SET avg_brightness = ?, contrast_level = ?, color_cast_r = ?, color_cast_g = ?, color_cast_b = ?, noise_level = ?
     WHERE id = ?`
  );

  const appendErrorStmt = db.prepare(
    `UPDATE media_items
     SET processing_error = CASE
       WHEN processing_error IS NULL THEN ?
       ELSE processing_error || char(10) || ?
     END
     WHERE id = ?`
  );

  for (const row of rows) {
    try {
      const localPath = await storageProvider.downloadToTemp(row.file_path);
      const analysis = await analyzeImage(localPath);

      updateStmt.run(
        analysis.avgBrightness,
        analysis.contrastLevel,
        analysis.colorCastR,
        analysis.colorCastG,
        analysis.colorCastB,
        analysis.noiseLevel,
        row.id,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const errorText = `[analyze] ${message}`;
      appendErrorStmt.run(errorText, errorText, row.id);
    }
  }
}
