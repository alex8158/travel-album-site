import crypto from 'crypto';

/**
 * Compiled-derived video thumbnails (known-issues 12g, ruled 2026-11-17).
 *
 * A thumbnail that a non-owner can see for an ordinary video must show only footage
 * the compiled file keeps (multi-user-system 需求 9 AC 18). Such a thumbnail is stored
 * under a key derived from the current `compiled_path`, and `media_items.thumbnail_path`
 * pointing at exactly that key is the only proof that the stored thumbnail came from
 * the current compiled file. Any other stored thumbnail (generated from the original
 * upload by the upload pipeline, by on-demand owner requests, or for an earlier
 * compiled file) is never served to non-owners.
 *
 * Every statement that writes `compiled_path` also applies
 * `CLEAR_COMPILED_THUMBNAIL_SQL`, so a re-edit that writes new content to the same
 * compiled path drops the pointer; the next request regenerates from the new file.
 * Other thumbnail pointers (owner/original-derived) are left as they are.
 */
const MARKER = '_cthumb_';

export function compiledThumbnailKey(tripId: string, mediaId: string, compiledPath: string): string {
  const tag = crypto.createHash('sha256').update(compiledPath).digest('hex').slice(0, 16);
  return `${tripId}/thumbnails/${mediaId}${MARKER}${tag}.webp`;
}

/** True when `thumbnailPath` is the compiled-derived thumbnail of the row's current compiled file. */
export function isCurrentCompiledThumbnail(row: {
  trip_id: string;
  id: string;
  compiled_path: string | null;
  thumbnail_path: string | null;
}): boolean {
  if (!row.compiled_path || !row.thumbnail_path) return false;
  const stored = row.thumbnail_path.startsWith('uploads/') ? row.thumbnail_path.slice('uploads/'.length) : row.thumbnail_path;
  return stored === compiledThumbnailKey(row.trip_id, row.id, row.compiled_path);
}

/** SET-clause fragment for statements that write `compiled_path`: drops a compiled-derived thumbnail pointer. */
export const CLEAR_COMPILED_THUMBNAIL_SQL =
  `thumbnail_path = CASE WHEN thumbnail_path LIKE '%${MARKER.replace(/_/g, '\\_')}%' ESCAPE '\\' THEN NULL ELSE thumbnail_path END`;
