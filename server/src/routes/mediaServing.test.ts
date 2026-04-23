import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import mediaServingRouter from './mediaServing';

const app = express();
app.use(express.json());
app.use('/api/media', mediaServingRouter);

const uploadsBase = path.join(__dirname, '..', '..', 'uploads');

function createTestImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .jpeg()
    .toBuffer();
}

describe('Media Serving API', () => {
  const tripId = 'serve-test-trip';
  const tripDir = path.join(uploadsBase, tripId);
  let mediaId: string;

  beforeEach(async () => {
    const db = getDb();
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM upload_sessions');
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');
    db.prepare("INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
      tripId, 'Serve Test', new Date().toISOString(), new Date().toISOString()
    );

    mediaId = uuidv4();
    const imgBuf = await createTestImage(800, 600);
    const origDir = path.join(tripDir, 'originals');
    fs.mkdirSync(origDir, { recursive: true });
    fs.writeFileSync(path.join(origDir, `${mediaId}.jpg`), imgBuf);

    db.prepare(
      `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, created_at)
       VALUES (?, ?, ?, 'image', 'image/jpeg', ?, ?, ?)`
    ).run(mediaId, tripId, `${tripId}/originals/${mediaId}.jpg`, 'photo.jpg', imgBuf.length, new Date().toISOString());
  });

  afterEach(() => {
    if (fs.existsSync(tripDir)) {
      fs.rmSync(tripDir, { recursive: true, force: true });
    }
    closeDb();
  });

  describe('GET /api/media/:id/original', () => {
    it('should serve the original file', async () => {
      const res = await request(app).get(`/api/media/${mediaId}/original`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/image\/jpeg|application\/octet-stream/);
    });

    it('should return 404 for non-existent media', async () => {
      const res = await request(app).get('/api/media/non-existent/original');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('should return 404 if file is missing from disk', async () => {
      // Remove the file from disk but keep DB record
      fs.unlinkSync(path.join(tripDir, 'originals', `${mediaId}.jpg`));
      const res = await request(app).get(`/api/media/${mediaId}/original`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('FILE_NOT_FOUND');
    });
  });

  describe('GET /api/media/:id/thumbnail', () => {
    it('should generate thumbnail on-the-fly if none exists', async () => {
      const res = await request(app).get(`/api/media/${mediaId}/thumbnail`);
      expect(res.status).toBe(200);

      // Verify thumbnail was created and DB updated
      const db = getDb();
      const row = db.prepare('SELECT thumbnail_path FROM media_items WHERE id = ?').get(mediaId) as any;
      expect(row.thumbnail_path).toBe(`${tripId}/thumbnails/${mediaId}_thumb.webp`);
    });

    it('should serve existing thumbnail without regenerating', async () => {
      // Pre-generate thumbnail
      const thumbDir = path.join(tripDir, 'thumbnails');
      fs.mkdirSync(thumbDir, { recursive: true });
      const thumbBuf = await sharp({
        create: { width: 200, height: 150, channels: 3, background: { r: 50, g: 50, b: 50 } },
      }).webp().toBuffer();
      const thumbPath = path.join(thumbDir, `${mediaId}_thumb.webp`);
      fs.writeFileSync(thumbPath, thumbBuf);

      // Set thumbnail_path in DB
      const db = getDb();
      db.prepare('UPDATE media_items SET thumbnail_path = ? WHERE id = ?').run(
        `${tripId}/thumbnails/${mediaId}_thumb.webp`, mediaId
      );

      const res = await request(app).get(`/api/media/${mediaId}/thumbnail`);
      expect(res.status).toBe(200);
    });

    it('should return 404 for non-existent media', async () => {
      const res = await request(app).get('/api/media/non-existent/thumbnail');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
