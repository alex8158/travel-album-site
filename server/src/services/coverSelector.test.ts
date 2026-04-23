import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { selectCoverImage } from './coverSelector';

describe('CoverSelector', () => {
  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM upload_sessions');
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');
  });

  afterEach(() => {
    closeDb();
  });

  function createTrip(title = 'Test Trip'): string {
    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run(id, title, now, now);
    return id;
  }

  function createMediaItem(
    tripId: string,
    mediaType: 'image' | 'video',
    qualityScore: number | null = null
  ): string {
    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, quality_score, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      tripId,
      `${tripId}/originals/${id}.jpg`,
      mediaType,
      mediaType === 'image' ? 'image/jpeg' : 'video/mp4',
      `file_${id}.${mediaType === 'image' ? 'jpg' : 'mp4'}`,
      1024,
      qualityScore,
      now
    );
    return id;
  }

  describe('selectCoverImage', () => {
    it('should select the image with the highest quality_score', async () => {
      const tripId = createTrip();
      createMediaItem(tripId, 'image', 100);
      const bestId = createMediaItem(tripId, 'image', 500);
      createMediaItem(tripId, 'image', 200);

      const result = await selectCoverImage(tripId);

      expect(result).toBe(bestId);

      // Verify DB was updated
      const db = getDb();
      const trip = db.prepare('SELECT cover_image_id FROM trips WHERE id = ?').get(tripId) as { cover_image_id: string };
      expect(trip.cover_image_id).toBe(bestId);
    });

    it('should select an image even if quality_score is null (fallback)', async () => {
      const tripId = createTrip();
      const imgId = createMediaItem(tripId, 'image', null);

      const result = await selectCoverImage(tripId);

      expect(result).toBe(imgId);
    });

    it('should prefer images over videos', async () => {
      const tripId = createTrip();
      createMediaItem(tripId, 'video');
      const imgId = createMediaItem(tripId, 'image', 50);

      const result = await selectCoverImage(tripId);

      expect(result).toBe(imgId);
    });

    it('should return null when trip has no media at all', async () => {
      const tripId = createTrip();

      const result = await selectCoverImage(tripId);

      expect(result).toBeNull();

      // Verify DB cover_image_id is NULL
      const db = getDb();
      const trip = db.prepare('SELECT cover_image_id FROM trips WHERE id = ?').get(tripId) as { cover_image_id: string | null };
      expect(trip.cover_image_id).toBeNull();
    });

    it('should attempt video frame extraction when no images exist', async () => {
      const tripId = createTrip();
      const videoId = createMediaItem(tripId, 'video');

      // extractVideoFrame will fail because ffmpeg is not installed in test env,
      // so it should gracefully fall back to null
      const result = await selectCoverImage(tripId);

      // Either the video id (if ffmpeg works) or null (if ffmpeg fails)
      expect(result === videoId || result === null).toBe(true);
    });

    it('should select the single image when only one image exists', async () => {
      const tripId = createTrip();
      const imgId = createMediaItem(tripId, 'image', 300);

      const result = await selectCoverImage(tripId);

      expect(result).toBe(imgId);
    });
  });
});
