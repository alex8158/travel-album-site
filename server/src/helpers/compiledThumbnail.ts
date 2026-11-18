/**
 * Compiled-derived video thumbnails (known-issues 12g, ruled 2026-11-17; version
 * stamps since round32).
 *
 * A thumbnail that a non-owner can see for an ordinary video must show only footage
 * the current compiled file keeps (multi-user-system 需求 9 AC 18). The same
 * compiled path can hold several versions over time (re-edit writes
 * `{trip}/merged/{id}_merged.mp4` again), so neither the path nor a cleared pointer
 * identifies a version. The project has no publish-version column; the equivalent
 * used here is a version stamp kept in `media_items.thumbnail_path` itself:
 *
 * - Every statement that writes `compiled_path` sets, in the same UPDATE,
 *   `thumbnail_path` to a fresh key `{trip}/thumbnails/{id}_cver_{16 random hex}.webp`
 *   (`NEW_COMPILED_VERSION_SQL`). Publishing a version and choosing its thumbnail
 *   key are one atomic step.
 * - A row whose pointer is not such a key (legacy rows, rows where another writer put
 *   an original-derived thumbnail) gets one by compare-and-set
 *   (`MINT_COMPILED_VERSION_SQL`): only while both `compiled_path` and the old
 *   pointer are unchanged.
 * - The image for a key is generated from the compiled file into exactly that key and
 *   the pointer is never written afterwards. A generation that started on an earlier
 *   version can only write its own, no longer referenced, key; and the route serves a
 *   key only after re-checking that it is still the row's pointer.
 */
const MARKER = '_cver_';

/** SET-clause fragment for every statement that writes `compiled_path`. */
export const NEW_COMPILED_VERSION_SQL =
  `thumbnail_path = trip_id || '/thumbnails/' || id || '${MARKER}' || lower(hex(randomblob(8))) || '.webp'`;

/** Stamp a row that has no version key yet; a no-op if compiled_path or the pointer changed meanwhile. */
export const MINT_COMPILED_VERSION_SQL =
  `UPDATE media_items SET ${NEW_COMPILED_VERSION_SQL} WHERE id = ? AND compiled_path = ? AND thumbnail_path IS ?`;

function normalize(p: string): string {
  return p.startsWith('uploads/') ? p.slice('uploads/'.length) : p;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The row's compiled-version thumbnail key, or null when the pointer is not one (or there is no compiled file). */
export function compiledVersionKey(row: {
  trip_id: string;
  id: string;
  compiled_path: string | null;
  thumbnail_path: string | null;
}): string | null {
  if (!row.compiled_path || !row.thumbnail_path) return null;
  const stored = normalize(row.thumbnail_path);
  const re = new RegExp(`^${escapeRegExp(row.trip_id)}/thumbnails/${escapeRegExp(row.id)}${MARKER}[0-9a-f]{16}\\.webp$`);
  return re.test(stored) ? stored : null;
}

/** True when `thumbnail_path` is the version stamp of the row's current compiled file. */
export function isCurrentCompiledThumbnail(row: {
  trip_id: string;
  id: string;
  compiled_path: string | null;
  thumbnail_path: string | null;
}): boolean {
  return compiledVersionKey(row) !== null;
}
