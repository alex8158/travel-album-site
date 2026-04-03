import sharp from 'sharp';
import fs from 'fs';
import { getDb } from '../database';
import type { MediaItem, QualityScore } from '../types';
import { MediaItemRow, rowToMediaItem as baseRowToMediaItem } from '../helpers/mediaItemRow';
import { computeSharpness } from './blurDetector';
import { getStorageProvider } from '../storage/factory';

/**
 * Laplacian convolution kernel for noise estimation.
 */
const LAPLACIAN_KERNEL = {
  width: 3,
  height: 3,
  kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
};

/**
 * Dimension weights for overall quality score.
 */
export const WEIGHTS: Record<string, number> = {
  sharpness: 0.40,
  exposure: 0.10,
  contrast: 0.10,
  resolution: 0.20,
  noiseArtifact: 0.10,
  fileSize: 0.10,
};

// --- Pure normalization helpers (exported for testability) ---

/** Normalize sharpness: min(laplacianVariance / 500, 1.0) */
export function normalizeSharpness(variance: number): number {
  return Math.min(variance / 500, 1.0);
}

/** Normalize exposure: 1.0 - |mean - 128| / 128 */
export function normalizeExposure(channelMean: number): number {
  return 1.0 - Math.abs(channelMean - 128) / 128;
}

/** Normalize contrast: bell curve centered at 60, width 20 */
export function normalizeContrast(stddev: number): number {
  return Math.exp(-0.5 * ((stddev - 60) / 20) ** 2);
}

/** Normalize resolution: min(pixelCount / 12_000_000, 1.0) */
export function normalizeResolution(pixelCount: number): number {
  return Math.min(pixelCount / 12_000_000, 1.0);
}

/** Normalize noise: 1.0 - min(highFreqRatio, 1.0) */
export function normalizeNoise(highFreqRatio: number): number {
  return 1.0 - Math.min(highFreqRatio, 1.0);
}

/** Normalize file size: min(fileSize / 5_000_000, 1.0) */
export function normalizeFileSize(fileSizeBytes: number): number {
  return Math.min(fileSizeBytes / 5_000_000, 1.0);
}

/**
 * Compute overall weighted score from dimension scores, handling nulls
 * by re-normalizing remaining weights.
 */
export function computeOverall(scores: {
  sharpness: number | null;
  exposure: number | null;
  contrast: number | null;
  resolution: number | null;
  noiseArtifact: number | null;
  fileSize: number | null;
}): number {
  let weightedSum = 0;
  let totalWeight = 0;

  const entries: [string, number | null][] = [
    ['sharpness', scores.sharpness],
    ['exposure', scores.exposure],
    ['contrast', scores.contrast],
    ['resolution', scores.resolution],
    ['noiseArtifact', scores.noiseArtifact],
    ['fileSize', scores.fileSize],
  ];

  for (const [key, value] of entries) {
    if (value !== null) {
      totalWeight += WEIGHTS[key];
      weightedSum += WEIGHTS[key] * value;
    }
  }

  if (totalWeight === 0) return 0;
  return weightedSum / totalWeight;
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
 * Estimate noise by comparing Laplacian variance to original variance
 * on a 256×256 grayscale version of the image.
 */
async function estimateNoise(imagePath: string): Promise<number> {
  // Get original grayscale at 256×256
  const { data: origData, info: origInfo } = await sharp(imagePath)
    .resize(256, 256, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const origPixelCount = origInfo.width * origInfo.height;
  const originalVariance = computeVariance(origData, origPixelCount);

  // Get Laplacian-convolved version at same size
  const { data: lapData, info: lapInfo } = await sharp(imagePath)
    .resize(256, 256, { fit: 'fill' })
    .grayscale()
    .convolve(LAPLACIAN_KERNEL)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const lapPixelCount = lapInfo.width * lapInfo.height;
  const laplacianVariance = computeVariance(lapData, lapPixelCount);

  const highFreqRatio = laplacianVariance / (originalVariance + 1);
  return highFreqRatio;
}

/**
 * Compute six-dimension quality scores for a single image.
 *
 * Dimensions: sharpness, exposure, contrast, resolution, noiseArtifact, fileSize
 * Each dimension is normalized to [0.0, 1.0] or null on failure.
 * Overall = weighted sum with re-normalized weights for non-null dimensions.
 *
 * @param imagePath - Local file path to the image
 * @param mediaId - Optional media item ID to read sharpness_score from DB
 */
export async function computeQualityScore(
  imagePath: string,
  mediaId?: string
): Promise<QualityScore> {
  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  const fileStat = await fs.promises.stat(imagePath);
  const rawFileSize = fileStat.size;

  // --- Sharpness: reuse from DB or compute fresh ---
  let sharpnessNorm: number | null = null;
  try {
    let rawSharpness: number | null = null;

    if (mediaId) {
      const db = getDb();
      const row = db.prepare(
        'SELECT sharpness_score FROM media_items WHERE id = ?'
      ).get(mediaId) as { sharpness_score: number | null } | undefined;
      if (row && row.sharpness_score != null) {
        rawSharpness = row.sharpness_score;
      }
    }

    // Fallback: compute fresh
    if (rawSharpness == null) {
      rawSharpness = await computeSharpness(imagePath);
    }

    sharpnessNorm = normalizeSharpness(rawSharpness);
  } catch {
    sharpnessNorm = null;
  }

  // --- Exposure & Contrast: from sharp stats ---
  let exposureNorm: number | null = null;
  let contrastNorm: number | null = null;
  try {
    const stats = await sharp(imagePath).stats();
    const channelMeans = stats.channels.map((c) => c.mean);
    const avgMean = channelMeans.reduce((a, b) => a + b, 0) / channelMeans.length;
    exposureNorm = normalizeExposure(avgMean);

    const channelStddevs = stats.channels.map((c) => c.stdev);
    const avgStddev = channelStddevs.reduce((a, b) => a + b, 0) / channelStddevs.length;
    contrastNorm = normalizeContrast(avgStddev);
  } catch {
    // exposure and contrast both fail together since they share the stats call
    exposureNorm = null;
    contrastNorm = null;
  }

  // --- Resolution ---
  let resolutionNorm: number | null = null;
  try {
    resolutionNorm = normalizeResolution(width * height);
  } catch {
    resolutionNorm = null;
  }

  // --- Noise ---
  let noiseNorm: number | null = null;
  try {
    const highFreqRatio = await estimateNoise(imagePath);
    noiseNorm = normalizeNoise(highFreqRatio);
  } catch {
    noiseNorm = null;
  }

  // --- File Size ---
  let fileSizeNorm: number | null = null;
  try {
    fileSizeNorm = normalizeFileSize(rawFileSize);
  } catch {
    fileSizeNorm = null;
  }

  const scores = {
    sharpness: sharpnessNorm,
    exposure: exposureNorm,
    contrast: contrastNorm,
    resolution: resolutionNorm,
    noiseArtifact: noiseNorm,
    fileSize: fileSizeNorm,
  };

  const overall = computeOverall(scores);

  return { ...scores, overall };
}

function rowToMediaItem(row: MediaItemRow): MediaItem {
  return baseRowToMediaItem(row);
}

/**
 * Compare two images by overall quality score (higher is better).
 * Returns negative if a is better, positive if b is better.
 */
function compareQuality(a: QualityScore, b: QualityScore): number {
  return b.overall - a.overall;
}

/**
 * Select the best image from a duplicate group.
 * Computes quality scores for all members, updates DB, and sets default_image_id.
 */
export async function selectBest(groupId: string): Promise<MediaItem> {
  const db = getDb();

  const rows = db.prepare(
    'SELECT * FROM media_items WHERE duplicate_group_id = ?'
  ).all(groupId) as MediaItemRow[];

  if (rows.length === 0) {
    throw new Error(`No media items found for group ${groupId}`);
  }

  const items = rows.map(rowToMediaItem);

  const scores: QualityScore[] = [];
  const updateStmt = db.prepare(
    'UPDATE media_items SET quality_score = ?, sharpness_score = COALESCE(sharpness_score, ?), exposure_score = ?, contrast_score = ?, noise_score = ? WHERE id = ?'
  );
  const storageProvider = getStorageProvider();

  for (const item of items) {
    try {
      const localPath = await storageProvider.downloadToTemp(item.filePath);
      const score = await computeQualityScore(localPath, item.id);
      scores.push(score);
      updateStmt.run(
        score.overall,
        score.sharpness !== null ? score.sharpness * 500 : null, // store raw variance if computed fresh
        score.exposure,
        score.contrast,
        score.noiseArtifact,
        item.id
      );
    } catch {
      const defaultScore: QualityScore = {
        sharpness: null,
        exposure: null,
        contrast: null,
        resolution: null,
        noiseArtifact: null,
        fileSize: null,
        overall: 0,
      };
      scores.push(defaultScore);
      updateStmt.run(0, null, null, null, null, item.id);
    }
  }

  // Find the best image
  let bestIdx = 0;
  for (let i = 1; i < items.length; i++) {
    if (compareQuality(scores[i], scores[bestIdx]) < 0) {
      bestIdx = i;
    }
  }

  const bestItem = items[bestIdx];

  // Update duplicate_groups.default_image_id
  db.prepare(
    'UPDATE duplicate_groups SET default_image_id = ? WHERE id = ?'
  ).run(bestItem.id, groupId);

  // Trash all non-best images in the group
  db.prepare(
    "UPDATE media_items SET status = 'trashed', trashed_reason = 'duplicate' WHERE duplicate_group_id = ? AND id != ?"
  ).run(groupId, bestItem.id);

  return bestItem;
}

/**
 * Returns the count of items with status = 'trashed' AND trashed_reason = 'duplicate' for a given trip.
 */
export function getTrashedDuplicateCount(tripId: string): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM media_items WHERE trip_id = ? AND status = 'trashed' AND trashed_reason = 'duplicate'"
  ).get(tripId) as { count: number };
  return row.count;
}

/**
 * Process all duplicate groups for a trip: select best image for each group,
 * and compute quality scores for ungrouped images.
 */
export async function processTrip(tripId: string): Promise<void> {
  const db = getDb();

  // 1. Process all duplicate groups for this trip
  const groups = db.prepare(
    'SELECT id FROM duplicate_groups WHERE trip_id = ?'
  ).all(tripId) as { id: string }[];

  for (const group of groups) {
    await selectBest(group.id);
  }

  // 2. Compute quality scores for ungrouped images
  const ungroupedRows = db.prepare(
    "SELECT * FROM media_items WHERE trip_id = ? AND media_type = 'image' AND duplicate_group_id IS NULL"
  ).all(tripId) as MediaItemRow[];

  const updateStmt = db.prepare(
    'UPDATE media_items SET quality_score = ?, sharpness_score = COALESCE(sharpness_score, ?), exposure_score = ?, contrast_score = ?, noise_score = ? WHERE id = ?'
  );
  const storageProvider = getStorageProvider();

  for (const row of ungroupedRows) {
    const item = rowToMediaItem(row);
    try {
      const localPath = await storageProvider.downloadToTemp(item.filePath);
      const score = await computeQualityScore(localPath, item.id);
      updateStmt.run(
        score.overall,
        score.sharpness !== null ? score.sharpness * 500 : null,
        score.exposure,
        score.contrast,
        score.noiseArtifact,
        item.id
      );
    } catch {
      updateStmt.run(0, null, null, null, null, item.id);
    }
  }
}
