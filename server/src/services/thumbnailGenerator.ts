import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { getDb } from '../database';

const serverRoot = path.join(__dirname, '..', '..');
const uploadsBase = path.join(serverRoot, 'uploads');

interface MediaItemRow {
  id: string;
  trip_id: string;
  file_path: string;
  thumbnail_path: string | null;
  media_type: string;
}

/**
 * Generate a WebP thumbnail for an image, fitting within 400x400 while maintaining aspect ratio.
 * Returns the relative path (e.g. "uploads/{tripId}/thumbnails/{mediaId}_thumb.webp").
 */
export async function generateThumbnail(
  imagePath: string,
  tripId: string,
  mediaId: string
): Promise<string> {
  const thumbDir = path.join(uploadsBase, tripId, 'thumbnails');
  fs.mkdirSync(thumbDir, { recursive: true });

  const thumbFilename = `${mediaId}_thumb.webp`;
  const thumbAbsPath = path.join(thumbDir, thumbFilename);

  await sharp(imagePath)
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .webp()
    .toFile(thumbAbsPath);

  return `uploads/${tripId}/thumbnails/${thumbFilename}`;
}

/**
 * Generate thumbnails for all image media_items in a trip and update DB.
 */
export async function generateThumbnailsForTrip(tripId: string): Promise<void> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, trip_id, file_path, thumbnail_path, media_type FROM media_items WHERE trip_id = ? AND media_type = 'image'"
  ).all(tripId) as MediaItemRow[];

  for (const row of rows) {
    try {
      const absPath = path.resolve(serverRoot, row.file_path);
      const thumbRelPath = await generateThumbnail(absPath, tripId, row.id);
      db.prepare('UPDATE media_items SET thumbnail_path = ? WHERE id = ?').run(thumbRelPath, row.id);
    } catch (err) {
      console.error(`[ThumbnailGenerator] Failed to generate thumbnail for ${row.id}:`, err);
      // Non-fatal — original image will be used as fallback
    }
  }
}
