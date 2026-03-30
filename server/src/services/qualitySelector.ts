import sharp from 'sharp';
import fs from 'fs';
import { getDb } from '../database';
import type { MediaItem, QualityScore } from '../types';

/**
 * Laplacian convolution kernel for sharpness detection.
 * Higher variance of the convolved result = sharper image.
 */
const LAPLACIAN_KERNEL = {
  width: 3,
  height: 3,
  kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
};

/**
 * Compute quality scores for a single image.
 * - resolution: width × height
 * - sharpness: variance of Laplacian-convolved grayscale image
 * - fileSize: file size in bytes
 * - overall: resolution (primary), sharpness as tiebreaker
 */
export async function computeQualityScore(imagePath: string): Promise<QualityScore> {
  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const resolution = width * height;

  const stats = await fs.promises.stat(imagePath);
  const fileSize = stats.size;

  // Compute sharpness via Laplacian variance
  let sharpness = 0;
  try {
    const { data, info } = await sharp(imagePath)
      .grayscale()
      .convolve(LAPLACIAN_KERNEL)
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Compute variance of pixel values
    const pixelCount = info.width * info.height;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < pixelCount; i++) {
      const v = data[i];
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / pixelCount;
    sharpness = sumSq / pixelCount - mean * mean;
  } catch {
    // If sharpness computation fails, default to 0
    sharpness = 0;
  }

  return {
    resolution,
    fileSize,
    sharpness,
    overall: resolution,
  };
}


interface MediaItemRow {
  id: string;
  trip_id: string;
  file_path: string;
  thumbnail_path: string | null;
  media_type: string;
  mime_type: string;
  original_filename: string;
  file_size: number;
  width: number | null;
  height: number | null;
  perceptual_hash: string | null;
  quality_score: number | null;
  sharpness_score: number | null;
  duplicate_group_id: string | null;
  created_at: string;
}

import path from 'path';

const serverRoot = path.join(__dirname, '..', '..');

function rowToMediaItem(row: MediaItemRow): MediaItem {
  return {
    id: row.id,
    tripId: row.trip_id,
    filePath: path.resolve(serverRoot, row.file_path),
    thumbnailPath: row.thumbnail_path ?? undefined,
    mediaType: row.media_type as MediaItem['mediaType'],
    mimeType: row.mime_type,
    originalFilename: row.original_filename,
    fileSize: row.file_size,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    perceptualHash: row.perceptual_hash ?? undefined,
    qualityScore: row.quality_score ?? undefined,
    sharpnessScore: row.sharpness_score ?? undefined,
    duplicateGroupId: row.duplicate_group_id ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * Compare two images by quality: highest resolution → highest sharpness → largest file size.
 * Returns negative if a is better, positive if b is better.
 */
function compareQuality(a: QualityScore, b: QualityScore): number {
  if (a.resolution !== b.resolution) return b.resolution - a.resolution;
  if (a.sharpness !== b.sharpness) return b.sharpness - a.sharpness;
  return b.fileSize - a.fileSize;
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

  // Compute quality scores for each item
  const scores: QualityScore[] = [];
  const updateStmt = db.prepare(
    'UPDATE media_items SET quality_score = ?, sharpness_score = ? WHERE id = ?'
  );

  for (const item of items) {
    try {
      const score = await computeQualityScore(item.filePath);
      scores.push(score);
      updateStmt.run(score.overall, score.sharpness, item.id);
    } catch {
      // Default scores on failure
      const defaultScore: QualityScore = { resolution: 0, fileSize: 0, sharpness: 0, overall: 0 };
      scores.push(defaultScore);
      updateStmt.run(0, 0, item.id);
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

  return bestItem;
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
    'UPDATE media_items SET quality_score = ?, sharpness_score = ? WHERE id = ?'
  );

  for (const row of ungroupedRows) {
    const item = rowToMediaItem(row);
    try {
      const score = await computeQualityScore(item.filePath);
      updateStmt.run(score.overall, score.sharpness, item.id);
    } catch {
      updateStmt.run(0, 0, item.id);
    }
  }
}
