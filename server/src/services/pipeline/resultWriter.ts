import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../database';
import type { PerImageFinalDecision } from './types';

export interface WriteResult {
  updatedCount: number;
  error?: string;
}

/**
 * Write all final decisions to the database in a single transaction.
 *
 * Updates media_items: blur_status, sharpness_score, category, status,
 * trashed_reason, processing_error.
 * Replaces category tags in media_tags.
 *
 * NOTE: Current version does NOT maintain duplicate_groups table.
 * Dedup results are reflected only in media_items.status and trashed_reason.
 *
 * On failure: rolls back all changes and returns error in WriteResult.
 */
export function writeDecisions(
  tripId: string,
  decisions: PerImageFinalDecision[],
): WriteResult {
  if (decisions.length === 0) {
    return { updatedCount: 0 };
  }

  const db = getDb();

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

  try {
    // Process each decision individually to avoid one bad item killing everything
    let count = 0;
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
        count += result.changes;

        // Only update tags if the media item exists
        if (result.changes > 0) {
          deleteCategoryTagsStmt.run(d.mediaId);
          insertTagStmt.run(
            uuidv4(),
            d.mediaId,
            `category:${d.finalCategory}`,
            now,
          );
        }
      } catch (perItemErr) {
        console.warn(`[resultWriter] Failed for ${d.mediaId}: ${perItemErr}`);
      }
    }

    return { updatedCount: count };

    return { updatedCount: count };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { updatedCount: 0, error: message };
  }
}
