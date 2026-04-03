import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { getDb, closeDb } from '../database';
import { generateThumbnail, generateVideoThumbnail, generateThumbnailsForTrip } from './thumbnailGenerator';
import { v4 as uuidv4 } from 'uuid';

const uploadsBase = path.join(__dirname, '..', '..', 'uploads');

function createTestImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 128, g: 64, b: 32 } },
  })
    .jpeg()
    .toBuffer();
}

describe('ThumbnailGenerator', () => {
  const tripId = 'thumb-test-trip';
  const tripDir = path.join(uploadsBase, tripId);

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');
    db.prepare("INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
      tripId, 'Thumb Test', new Date().toISOString(), new Date().toISOString()
    );
    fs.mkdirSync(path.join(tripDir, 'originals'), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tripDir)) {
      fs.rmSync(tripDir, { recursive: true, force: true });
    }
    closeDb();
  });

  describe('generateThumbnail', () => {
    it('should create a WebP thumbnail within 400x400', async () => {
      const mediaId = 'test-media-1';
      const imgBuf = await createTestImage(800, 600);
      const origPath = path.join(tripDir, 'originals', `${mediaId}.jpg`);
      fs.writeFileSync(origPath, imgBuf);

      const relPath = await generateThumbnail(origPath, tripId, mediaId);

      expect(relPath).toBe(`${tripId}/thumbnails/${mediaId}_thumb.webp`);

      const absPath = path.join(uploadsBase, relPath);
      expect(fs.existsSync(absPath)).toBe(true);

      const meta = await sharp(absPath).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBeLessThanOrEqual(400);
      expect(meta.height).toBeLessThanOrEqual(400);
    });

    it('should maintain aspect ratio', async () => {
      const mediaId = 'test-media-2';
      const imgBuf = await createTestImage(1000, 500);
      const origPath = path.join(tripDir, 'originals', `${mediaId}.jpg`);
      fs.writeFileSync(origPath, imgBuf);

      const relPath = await generateThumbnail(origPath, tripId, mediaId);
      const absPath = path.join(uploadsBase, relPath);
      const meta = await sharp(absPath).metadata();

      // 1000x500 scaled to fit 400x400 → 400x200
      expect(meta.width).toBe(400);
      expect(meta.height).toBe(200);
    });

    it('should not enlarge small images', async () => {
      const mediaId = 'test-media-3';
      const imgBuf = await createTestImage(200, 150);
      const origPath = path.join(tripDir, 'originals', `${mediaId}.jpg`);
      fs.writeFileSync(origPath, imgBuf);

      const relPath = await generateThumbnail(origPath, tripId, mediaId);
      const absPath = path.join(uploadsBase, relPath);
      const meta = await sharp(absPath).metadata();

      expect(meta.width).toBe(200);
      expect(meta.height).toBe(150);
    });
  });

  describe('generateThumbnailsForTrip', () => {
    it('should generate thumbnails for all images and update DB', async () => {
      const db = getDb();
      const ids: string[] = [];

      for (let i = 0; i < 3; i++) {
        const id = uuidv4();
        ids.push(id);
        const imgBuf = await createTestImage(600, 400);
        const filename = `${id}.jpg`;
        fs.writeFileSync(path.join(tripDir, 'originals', filename), imgBuf);

        db.prepare(
          `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, created_at)
           VALUES (?, ?, ?, 'image', 'image/jpeg', ?, ?, ?)`
        ).run(id, tripId, `${tripId}/originals/${filename}`, `photo${i}.jpg`, imgBuf.length, new Date().toISOString());
      }

      await generateThumbnailsForTrip(tripId);

      for (const id of ids) {
        const row = db.prepare('SELECT thumbnail_path FROM media_items WHERE id = ?').get(id) as any;
        expect(row.thumbnail_path).toBe(`${tripId}/thumbnails/${id}_thumb.webp`);

        const absPath = path.resolve(uploadsBase, row.thumbnail_path);
        expect(fs.existsSync(absPath)).toBe(true);
      }
    });

    it('should skip non-image and non-video media items', async () => {
      const db = getDb();
      const unknownId = uuidv4();
      db.prepare(
        `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, created_at)
         VALUES (?, ?, ?, 'unknown', 'application/octet-stream', ?, ?, ?)`
      ).run(unknownId, tripId, `${tripId}/originals/${unknownId}.bin`, 'file.bin', 1000, new Date().toISOString());

      await generateThumbnailsForTrip(tripId);

      const row = db.prepare('SELECT thumbnail_path FROM media_items WHERE id = ?').get(unknownId) as any;
      expect(row.thumbnail_path).toBeNull();
    });
  });
});
