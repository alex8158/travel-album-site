// Color Cast Detector - Type Definitions and Core Functions
// Part of v2-image-processing spec

import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';

/** Color cast type classification */
export type ColorCastType = 'warm' | 'cool' | 'green' | 'magenta' | 'neutral';

/** Severity level of color cast */
export type SeverityLevel = 'none' | 'mild' | 'moderate' | 'severe';

/** Result of color cast detection for a single image */
export interface ColorCastResult {
  type: ColorCastType;
  severity: SeverityLevel;
  colorScore: number;          // [0, 1], 1.0 = no color cast
  channelDeviations: {
    r: number;
    g: number;
    b: number;
  };
  maxDeviation: number;        // max absolute deviation
}

/** Result of batch color cast detection across multiple images */
export interface BatchColorCastResult {
  totalProcessed: number;
  severityCounts: Record<SeverityLevel, number>;
  errors: Array<{ mediaId: string; error: string }>;
}

/**
 * Detect color cast from RGB channel means.
 * Pure function — no side effects, no I/O.
 *
 * Algorithm:
 * 1. Compute overall brightness mean: (r + g + b) / 3
 * 2. Compute channel deviations: channelMean - brightness
 * 3. Get max absolute deviation
 * 4. Classify severity based on maxDev thresholds
 * 5. Classify type based on deviation direction
 * 6. Compute colorScore: 1.0 - clamp(maxDev / 50, 0, 1)
 */
export function detectColorCast(channelMeans: { r: number; g: number; b: number }): ColorCastResult {
  const { r, g, b } = channelMeans;

  // Step 1: Compute overall brightness mean
  const brightness = (r + g + b) / 3;

  // Step 2: Compute channel deviations
  const devR = r - brightness;
  const devG = g - brightness;
  const devB = b - brightness;

  // Step 3: Get max absolute deviation
  const maxDeviation = Math.max(Math.abs(devR), Math.abs(devG), Math.abs(devB));

  // Step 4: Classify severity
  const severity = classifySeverity(maxDeviation);

  // Step 5: Classify type
  const type = classifyType(devR, devG, devB, severity);

  // Step 6: Compute colorScore
  const colorScore = 1.0 - clamp(maxDeviation / 50, 0, 1);

  return {
    type,
    severity,
    colorScore,
    channelDeviations: { r: devR, g: devG, b: devB },
    maxDeviation,
  };
}

function classifySeverity(maxDev: number): SeverityLevel {
  if (maxDev < 5) return 'none';
  if (maxDev < 15) return 'mild';
  if (maxDev < 30) return 'moderate';
  return 'severe';
}

function classifyType(devR: number, devG: number, devB: number, severity: SeverityLevel): ColorCastType {
  if (severity === 'none') return 'neutral';

  const absR = Math.abs(devR);
  const absG = Math.abs(devG);
  const absB = Math.abs(devB);

  // Check for magenta: R and B both high positive, G low (negative)
  if (devR > 0 && devB > 0 && devG < 0) {
    return 'magenta';
  }

  // Classify based on which channel has the highest absolute deviation
  if (absR >= absG && absR >= absB) {
    return 'warm';
  }
  if (absB >= absR && absB >= absG) {
    return 'cool';
  }
  return 'green';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Detect color cast from an image file on disk.
 * Uses sharp.stats() to extract per-channel means, then delegates to the pure detectColorCast function.
 *
 * @throws If the file cannot be read or sharp cannot compute stats
 */
export async function detectColorCastFromFile(imagePath: string): Promise<ColorCastResult> {
  const stats = await sharp(imagePath).stats();
  const channelMeans = {
    r: stats.channels[0].mean,
    g: stats.channels[1].mean,
    b: stats.channels[2].mean,
  };
  return detectColorCast(channelMeans);
}

/**
 * Persist a color cast detection result to the media_analysis table.
 * Uses upsert behavior: if a record already exists for the given mediaId, it updates
 * the color_score and reason fields; otherwise it inserts a new record.
 *
 * The reason column stores structured JSON: { castType, severity, channelDeviations }
 */
export function persistColorCastResult(mediaId: string, result: ColorCastResult): void {
  const db = getDb();

  const reason = JSON.stringify({
    castType: result.type,
    severity: result.severity,
    channelDeviations: result.channelDeviations,
  });

  // Check if a media_analysis record already exists for this media item
  const existing = db.prepare(
    'SELECT id FROM media_analysis WHERE media_id = ?'
  ).get(mediaId) as { id: string } | undefined;

  if (existing) {
    // Update existing record
    db.prepare(
      `UPDATE media_analysis SET color_score = ?, reason = ? WHERE id = ?`
    ).run(result.colorScore, reason, existing.id);
  } else {
    // Insert new record
    const id = uuidv4();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO media_analysis (id, media_id, color_score, reason, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, mediaId, result.colorScore, reason, now);
  }
}

/**
 * Batch color cast detection for all active images in a trip.
 * Processes each image individually with error resilience — if one image fails,
 * the error is recorded and processing continues with remaining images.
 *
 * @returns Summary with total processed count, severity counts, and any errors
 */
export async function detectColorCastBatch(tripId: string): Promise<BatchColorCastResult> {
  const db = getDb();
  const storageProvider = getStorageProvider();

  const rows = db.prepare(
    "SELECT id, file_path FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active'"
  ).all(tripId) as Array<{ id: string; file_path: string }>;

  const severityCounts: Record<SeverityLevel, number> = {
    none: 0,
    mild: 0,
    moderate: 0,
    severe: 0,
  };
  const errors: Array<{ mediaId: string; error: string }> = [];
  let totalProcessed = 0;

  for (const row of rows) {
    try {
      const localPath = await storageProvider.downloadToTemp(row.file_path);
      const result = await detectColorCastFromFile(localPath);
      persistColorCastResult(row.id, result);
      severityCounts[result.severity]++;
      totalProcessed++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      errors.push({ mediaId: row.id, error: errorMsg });
    }
  }

  return {
    totalProcessed,
    severityCounts,
    errors,
  };
}
