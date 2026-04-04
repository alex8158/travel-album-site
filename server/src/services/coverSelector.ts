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
  media_type: string;
  quality_score: number | null;
}

/**
 * Extract the first frame from a video file using fluent-ffmpeg.
 * Saves as JPEG to the specified output path.
 */
export function extractVideoFrame(videoPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const outputDir = path.dirname(outputPath);
    fs.mkdirSync(outputDir, { recursive: true });

    ffmpeg(videoPath)
      .frames(1)
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}

/**
 * Automatically select the best cover image for a trip.
 *
 * Strategy:
 * 1. Pick the image with the highest quality_score
 * 2. If no images, extract first frame from a video
 * 3. If no videos either, return null (frontend uses placeholder)
 *
 * Updates trips.cover_image_id and returns the cover image id or null.
 */
export async function selectCoverImage(tripId: string): Promise<string | null> {
  const db = getDb();

  // 1. Try to find the highest quality image
  const bestImage = db.prepare(
    `SELECT id FROM media_items
     WHERE trip_id = ? AND media_type = 'image'
     ORDER BY quality_score DESC NULLS LAST, created_at ASC
     LIMIT 1`
  ).get(tripId) as MediaItemRow | undefined;

  if (bestImage) {
    db.prepare('UPDATE trips SET cover_image_id = ? WHERE id = ?').run(bestImage.id, tripId);
    return bestImage.id;
  }

  // 2. No images — try to extract first frame from a video
  const firstVideo = db.prepare(
    `SELECT id, file_path FROM media_items
     WHERE trip_id = ? AND media_type = 'video'
     ORDER BY created_at ASC
     LIMIT 1`
  ).get(tripId) as MediaItemRow | undefined;

  if (firstVideo) {
    try {
      const storageProvider = getStorageProvider();
      const videoLocalPath = await storageProvider.downloadToTemp(firstVideo.file_path);
      const frameFilename = `${firstVideo.id}_frame.jpg`;
      const frameTempPath = path.join(getTempDir(), frameFilename);

      try {
        await extractVideoFrame(videoLocalPath, frameTempPath);

        // Save frame to storage
        const frameRelativePath = `frames/${frameFilename}`;
        const buffer = fs.readFileSync(frameTempPath);
        await storageProvider.save(frameRelativePath, buffer);

        // Use the video's media_item id as cover reference
        db.prepare('UPDATE trips SET cover_image_id = ? WHERE id = ?').run(firstVideo.id, tripId);
        return firstVideo.id;
      } finally {
        try { fs.unlinkSync(frameTempPath); } catch { /* ignore */ }
      }
    } catch (err) {
      console.error(`[CoverSelector] Failed to extract video frame for ${firstVideo.id}:`, err);
      // Fall through to return null
    }
  }

  // 3. No images and no usable video frames — return null (placeholder)
  db.prepare('UPDATE trips SET cover_image_id = NULL WHERE id = ?').run(tripId);
  return null;
}
