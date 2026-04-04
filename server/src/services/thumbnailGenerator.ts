import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { getTempDir } from '../helpers/tempDir';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';

interface MediaItemRow {
  id: string;
  trip_id: string;
  file_path: string;
  thumbnail_path: string | null;
  media_type: string;
}

/**
 * Generate a WebP thumbnail for an image, fitting within 400x400 while maintaining aspect ratio.
 * Returns the relative path (e.g. "{tripId}/thumbnails/{mediaId}_thumb.webp").
 */
export async function generateThumbnail(
  imagePath: string,
  tripId: string,
  mediaId: string
): Promise<string> {
  const thumbFilename = `${mediaId}_thumb.webp`;
  const thumbRelativePath = `${tripId}/thumbnails/${thumbFilename}`;

  // Generate thumbnail to a temp file, then save via StorageProvider
  const tempPath = path.join(getTempDir(), thumbFilename);
  try {
    await sharp(imagePath)
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .webp()
      .toFile(tempPath);

    const storageProvider = getStorageProvider();
    const buffer = fs.readFileSync(tempPath);
    await storageProvider.save(thumbRelativePath, buffer);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
  }

  return thumbRelativePath;
}

/**
 * Extract the first frame from a video using fluent-ffmpeg, then resize
 * with sharp to 400x400 max (maintaining aspect ratio) and save as WebP.
 * Returns the relative path string (e.g. "{tripId}/thumbnails/{mediaId}_thumb.webp").
 */
export async function generateVideoThumbnail(
  videoPath: string,
  tripId: string,
  mediaId: string
): Promise<string> {
  const thumbFilename = `${mediaId}_thumb.webp`;
  const thumbRelativePath = `${tripId}/thumbnails/${thumbFilename}`;

  // Extract first frame to a temp JPEG file
  const tempFramePath = path.join(getTempDir(), `${mediaId}_frame.jpg`);
  const tempThumbPath = path.join(getTempDir(), thumbFilename);

  try {
    await new Promise<void>((resolve, reject) => {
      const tempDir = path.dirname(tempFramePath);
      fs.mkdirSync(tempDir, { recursive: true });

      ffmpeg(videoPath)
        .frames(1)
        .output(tempFramePath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    });

    // Resize and convert to WebP using sharp
    await sharp(tempFramePath)
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .webp()
      .toFile(tempThumbPath);

    const storageProvider = getStorageProvider();
    const buffer = fs.readFileSync(tempThumbPath);
    await storageProvider.save(thumbRelativePath, buffer);
  } finally {
    // Clean up temp files
    try { fs.unlinkSync(tempFramePath); } catch { /* ignore */ }
    try { fs.unlinkSync(tempThumbPath); } catch { /* ignore */ }
  }

  return thumbRelativePath;
}

/**
 * Generate thumbnails for all image and video media_items in a trip and update DB.
 */
export async function generateThumbnailsForTrip(tripId: string): Promise<void> {
  const db = getDb();
  const storageProvider = getStorageProvider();
  const rows = db.prepare(
    "SELECT id, trip_id, file_path, thumbnail_path, media_type FROM media_items WHERE trip_id = ? AND media_type IN ('image', 'video')"
  ).all(tripId) as MediaItemRow[];

  for (const row of rows) {
    try {
      const localPath = await storageProvider.downloadToTemp(row.file_path);
      let thumbRelPath: string;

      if (row.media_type === 'video') {
        thumbRelPath = await generateVideoThumbnail(localPath, tripId, row.id);
      } else {
        thumbRelPath = await generateThumbnail(localPath, tripId, row.id);
      }

      db.prepare('UPDATE media_items SET thumbnail_path = ? WHERE id = ?').run(thumbRelPath, row.id);
    } catch (err) {
      console.error(`[ThumbnailGenerator] Failed to generate thumbnail for ${row.id}:`, err);
      // Non-fatal — skip and continue with other files
    }
  }
}
