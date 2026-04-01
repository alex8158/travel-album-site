import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import os from 'os';
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
 * Extract the first frame from a video using fluent-ffmpeg, then resize
 * with sharp to 400x400 max (maintaining aspect ratio) and save as WebP.
 * Returns the relative path string (e.g. "uploads/{tripId}/thumbnails/{mediaId}_thumb.webp").
 */
export async function generateVideoThumbnail(
  videoPath: string,
  tripId: string,
  mediaId: string
): Promise<string> {
  const thumbDir = path.join(uploadsBase, tripId, 'thumbnails');
  fs.mkdirSync(thumbDir, { recursive: true });

  // Extract first frame to a temp JPEG file
  const tempFramePath = path.join(os.tmpdir(), `${mediaId}_frame.jpg`);
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
  const thumbFilename = `${mediaId}_thumb.webp`;
  const thumbAbsPath = path.join(thumbDir, thumbFilename);

  await sharp(tempFramePath)
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .webp()
    .toFile(thumbAbsPath);

  // Clean up temp frame
  try {
    fs.unlinkSync(tempFramePath);
  } catch {
    // ignore cleanup errors
  }

  return `uploads/${tripId}/thumbnails/${thumbFilename}`;
}

/**
 * Generate thumbnails for all image and video media_items in a trip and update DB.
 */
export async function generateThumbnailsForTrip(tripId: string): Promise<void> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, trip_id, file_path, thumbnail_path, media_type FROM media_items WHERE trip_id = ? AND media_type IN ('image', 'video')"
  ).all(tripId) as MediaItemRow[];

  for (const row of rows) {
    try {
      const absPath = path.resolve(serverRoot, row.file_path);
      let thumbRelPath: string;

      if (row.media_type === 'video') {
        thumbRelPath = await generateVideoThumbnail(absPath, tripId, row.id);
      } else {
        thumbRelPath = await generateThumbnail(absPath, tripId, row.id);
      }

      db.prepare('UPDATE media_items SET thumbnail_path = ? WHERE id = ?').run(thumbRelPath, row.id);
    } catch (err) {
      console.error(`[ThumbnailGenerator] Failed to generate thumbnail for ${row.id}:`, err);
      // Non-fatal — skip and continue with other files
    }
  }
}
