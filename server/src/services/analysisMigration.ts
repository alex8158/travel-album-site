import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';

export interface AnalysisMigrationResult {
  migratedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: Array<{ mediaId: string; error: string }>;
}

interface MediaItemAnalysisRow {
  id: string;
  quality_score: number | null;
  sharpness_score: number | null;
  exposure_score: number | null;
  noise_score: number | null;
  blur_status: string | null;
}

/**
 * Migrate analysis data from media_items to the dedicated media_analysis table.
 *
 * Reads all media_items that have at least one non-null analysis field
 * (quality_score, sharpness_score, exposure_score, noise_score, blur_status),
 * and creates corresponding media_analysis records with mapped fields.
 *
 * - Skips media_ids that already have a media_analysis record (idempotent).
 * - A single record failure does not interrupt the overall migration.
 */
export function migrateAnalysisData(): AnalysisMigrationResult {
  const db = getDb();

  const result: AnalysisMigrationResult = {
    migratedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    errors: [],
  };

  // Query media_items with at least one non-null analysis field
  const rows = db.prepare(
    `SELECT id, quality_score, sharpness_score, exposure_score, noise_score, blur_status
     FROM media_items
     WHERE quality_score IS NOT NULL
        OR sharpness_score IS NOT NULL
        OR exposure_score IS NOT NULL
        OR noise_score IS NOT NULL
        OR blur_status IS NOT NULL`
  ).all() as MediaItemAnalysisRow[];

  // Prepared statements for checking existing records and inserting new ones
  const checkExisting = db.prepare(
    'SELECT 1 FROM media_analysis WHERE media_id = ?'
  );

  const insertAnalysis = db.prepare(
    `INSERT INTO media_analysis (id, media_id, quality_score, sharpness_score, exposure_score, noise_score, is_blurry, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const row of rows) {
    try {
      // Skip if media_analysis record already exists for this media_id
      const existing = checkExisting.get(row.id);
      if (existing) {
        result.skippedCount++;
        continue;
      }

      // Map blur_status text to is_blurry integer: "blurry" → 1, anything else → 0
      const isBlurry = row.blur_status === 'blurry' ? 1 : 0;

      const id = uuidv4();
      const now = new Date().toISOString();

      insertAnalysis.run(
        id,
        row.id,
        row.quality_score ?? null,
        row.sharpness_score ?? null,
        row.exposure_score ?? null,
        row.noise_score ?? null,
        isBlurry,
        now,
      );

      result.migratedCount++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result.errorCount++;
      result.errors.push({ mediaId: row.id, error: message });
    }
  }

  return result;
}
