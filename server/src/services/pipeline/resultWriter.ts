import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../database';
import type { PerImageFinalDecision } from './types';

export interface WriteResult {
  updatedCount: number;
  skippedCount: number;
  error?: string;
}

/**
 * Write final decisions to the database.
 *
 * Processes each decision individually — one bad row doesn't block the rest.
 * Only inserts category tags when UPDATE actually hit a row (changes > 0).
 * Clears orphan duplicate_group_id before writing to avoid FK constraint errors.
 */
export function writeDecisions(
  tripId: string,
  decisions: PerImageFinalDecision[],
): WriteResult {
  if (decisions.length === 0) {
    return { updatedCount: 0, skippedCount: 0 };
  }

  const db = getDb();

  // Clean orphan duplicate_group_id for this trip to avoid FK constraint errors
  try {
    db.prepare(
      `UPDATE media_items SET duplicate_group_id = NULL
       WHERE trip_id = ? AND duplicate_group_id IS NOT NULL
       AND duplicate_group_id NOT IN (SELECT id FROM duplicate_groups)`
    ).run(tripId);
  } catch (cleanErr) {
    console.warn(`[resultWriter] Failed to clean orphan duplicate_group_id: ${cleanErr}`);
  }

  const updateMediaStmt = db.prepare(`
    UPDATE media_items
    SET blur_status = ?,
        sharpness_score = ?,
        category = ?,
        status = ?,
        trashed_reason = ?,
        processing_error = ?
    WHERE id = ? AND trip_id = ?
  `);

  const deleteCategoryTagsStmt = db.prepare(
    "DELETE FROM media_tags WHERE media_id = ? AND tag_name LIKE 'category:%'"
  );

  const insertTagStmt = db.prepare(
    'INSERT INTO media_tags (id, media_id, tag_name, created_at) VALUES (?, ?, ?, ?)'
  );

  let count = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const d of decisions) {
    const trashedReason =
      d.trashedReasons.length > 0
        ? d.trashedReasons.join(',')
        : null;

    try {
      const result = updateMediaStmt.run(
        d.finalBlurStatus,
        d.sharpnessScore,
        d.finalCategory,
        d.finalStatus,
        trashedReason,
        d.processingError,
        d.mediaId,
        tripId,
      );

      if (result.changes === 0) {
        // Row not found or trip mismatch — skip tag update
        skipped++;
        continue;
      }

      count += result.changes;

      // Safe to update tags — we know the media_item exists
      deleteCategoryTagsStmt.run(d.mediaId);
      insertTagStmt.run(
        uuidv4(),
        d.mediaId,
        `category:${d.finalCategory}`,
        now,
      );
    } catch (perItemErr) {
      console.warn(`[resultWriter] Failed for ${d.mediaId}: ${perItemErr}`);
      skipped++;
    }
  }

  if (skipped > 0) {
    console.warn(`[resultWriter] ${skipped}/${decisions.length} decisions skipped (row not found or FK error)`);
  }

  return { updatedCount: count, skippedCount: skipped };
}
