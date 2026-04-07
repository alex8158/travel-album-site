import { getDb } from '../database';

/**
 * Permanently delete a media item from the database, cleaning up all
 * foreign key references first (media_tags, duplicate_groups).
 */
export function deleteMediaItemFromDb(mediaId: string): void {
  const db = getDb();

  // 1. Delete media_tags referencing this media item
  db.prepare('DELETE FROM media_tags WHERE media_id = ?').run(mediaId);

  // 2. Clean up duplicate_groups: if this media is the default_image_id, clear it
  db.prepare('UPDATE duplicate_groups SET default_image_id = NULL WHERE default_image_id = ?').run(mediaId);

  // 3. Remove duplicate_group_id reference from this media item (in case FK is enforced)
  db.prepare('UPDATE media_items SET duplicate_group_id = NULL WHERE id = ?').run(mediaId);

  // 4. Delete the media item itself
  db.prepare('DELETE FROM media_items WHERE id = ?').run(mediaId);
}
