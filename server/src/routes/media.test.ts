import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import { authMiddleware } from '../middleware/auth';
import tripsRouter from './trips';
import mediaRouter from './media';

const app = express();
app.use(express.json());
app.use(authMiddleware);
app.use('/api/trips', tripsRouter);
app.use('/api/trips', mediaRouter);

const uploadsBase = path.join(__dirname, '..', '..', 'uploads');

// Helper: create a user directly in the DB and return a JWT for them
function createTestUser(role: 'admin' | 'regular' = 'regular'): { userId: string; token: string } {
  const db = getDb();
  const userId = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`
  ).run(userId, `user_${userId.slice(0, 8)}`, 'hash', role, now, now);
  const token = signToken({ userId, role });
  return { userId, token };
}

describe('Media Upload API', () => {
  let tripId: string;
  let ownerToken: string;
  let ownerUserId: string;

  beforeEach(async () => {
    const db = getDb();
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');

    const owner = createTestUser('regular');
    ownerToken = owner.token;
    ownerUserId = owner.userId;

    const res = await request(app)
      .post('/api/trips')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Test Trip' });
    tripId = res.body.id;
  });

  afterEach(() => {
    // Clean up uploaded files for test trip
    const tripDir = path.join(uploadsBase, tripId);
    if (fs.existsSync(tripDir)) {
      fs.rmSync(tripDir, { recursive: true, force: true });
    }
    closeDb();
  });

  describe('POST /api/trips/:id/media', () => {
    it('should return 401 without auth token', async () => {
      const buf = Buffer.from('fake jpeg content');
      const res = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .attach('file', buf, { filename: 'photo.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(401);
    });

    it('should return 403 when non-owner tries to upload', async () => {
      const other = createTestUser('regular');
      const buf = Buffer.from('fake jpeg content');
      const res = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${other.token}`)
        .attach('file', buf, { filename: 'photo.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('should allow admin to upload to any trip', async () => {
      const admin = createTestUser('admin');
      const buf = Buffer.from('fake jpeg content');
      const res = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${admin.token}`)
        .attach('file', buf, { filename: 'photo.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(201);
      expect(res.body.userId).toBe(admin.userId);
    });

    it('should upload a JPEG file successfully', async () => {
      const buf = Buffer.from('fake jpeg content');
      const res = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'photo.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.tripId).toBe(tripId);
      expect(res.body.mimeType).toBe('image/jpeg');
      expect(res.body.originalFilename).toBe('photo.jpg');
      expect(res.body.mediaType).toBe('image');
      expect(res.body.fileSize).toBe(buf.length);
      expect(res.body.filePath).toContain(`${tripId}/originals/`);
      expect(res.body.filePath).toMatch(/\.jpg$/);
    });

    it('should record user_id and default visibility=public', async () => {
      const buf = Buffer.from('fake jpeg content');
      const res = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'photo.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(201);
      expect(res.body.userId).toBe(ownerUserId);
      expect(res.body.visibility).toBe('public');

      // Also verify in DB
      const db = getDb();
      const row = db.prepare('SELECT user_id, visibility FROM media_items WHERE id = ?').get(res.body.id) as any;
      expect(row.user_id).toBe(ownerUserId);
      expect(row.visibility).toBe('public');
    });

    it('should upload a PNG file successfully', async () => {
      const buf = Buffer.from('fake png content');
      const res = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'image.png', contentType: 'image/png' });

      expect(res.status).toBe(201);
      expect(res.body.mimeType).toBe('image/png');
      expect(res.body.filePath).toMatch(/\.png$/);
    });

    it('should upload a WebP file successfully', async () => {
      const buf = Buffer.from('fake webp content');
      const res = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'image.webp', contentType: 'image/webp' });

      expect(res.status).toBe(201);
      expect(res.body.mimeType).toBe('image/webp');
    });

    it('should upload an MP4 video successfully', async () => {
      const buf = Buffer.from('fake mp4 content');
      const res = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'video.mp4', contentType: 'video/mp4' });

      expect(res.status).toBe(201);
      expect(res.body.mimeType).toBe('video/mp4');
      expect(res.body.filePath).toMatch(/\.mp4$/);
    });

    it('should upload a MOV video successfully', async () => {
      const buf = Buffer.from('fake mov content');
      const res = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'video.mov', contentType: 'video/quicktime' });

      expect(res.status).toBe(201);
      expect(res.body.mimeType).toBe('video/quicktime');
    });

    it('should accept file by extension even with generic mimetype', async () => {
      const buf = Buffer.from('fake heic content');
      const res = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'photo.heic', contentType: 'application/octet-stream' });

      expect(res.status).toBe(201);
      expect(res.body.mimeType).toBe('image/heic');
      expect(res.body.filePath).toMatch(/\.heic$/);
    });

    it('should accept .mkv file by extension', async () => {
      const buf = Buffer.from('fake mkv content');
      const res = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'video.mkv', contentType: 'application/octet-stream' });

      expect(res.status).toBe(201);
      expect(res.body.mimeType).toBe('video/x-matroska');
    });

    it('should reject unsupported file format with 400', async () => {
      const buf = Buffer.from('fake pdf content');
      const res = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'doc.pdf', contentType: 'application/pdf' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('UNSUPPORTED_FORMAT');
      expect(res.body.error.message).toContain('不支持的文件格式');
    });

    it('should reject .txt file', async () => {
      const buf = Buffer.from('hello world');
      const res = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'notes.txt', contentType: 'text/plain' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('UNSUPPORTED_FORMAT');
    });

    it('should return 404 for non-existent trip', async () => {
      const buf = Buffer.from('fake jpeg content');
      const res = await request(app)
        .post('/api/trips/non-existent-id/media')
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'photo.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('should return 400 when no file is provided', async () => {
      const res = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NO_FILE');
    });

    it('should store file to uploads/{trip_id}/originals/ directory', async () => {
      const buf = Buffer.from('test file content');
      const res = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'photo.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(201);

      // Verify file exists on disk
      const fullPath = path.join(uploadsBase, res.body.filePath);
      expect(fs.existsSync(fullPath)).toBe(true);

      const content = fs.readFileSync(fullPath);
      expect(content.length).toBe(buf.length);
    });

    it('should create a media_items record in the database', async () => {
      const buf = Buffer.from('db test content');
      const res = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'photo.jpg', contentType: 'image/jpeg' });

      const db = getDb();
      const row = db.prepare('SELECT * FROM media_items WHERE id = ?').get(res.body.id) as any;
      expect(row).toBeDefined();
      expect(row.trip_id).toBe(tripId);
      expect(row.media_type).toBe('image');
      expect(row.mime_type).toBe('image/jpeg');
      expect(row.original_filename).toBe('photo.jpg');
      expect(row.file_size).toBe(buf.length);
      expect(row.user_id).toBe(ownerUserId);
      expect(row.visibility).toBe('public');
    });
  });

  describe('PUT /api/trips/:id/media/visibility', () => {
    it('should return 401 without auth token', async () => {
      const res = await request(app)
        .put(`/api/trips/${tripId}/media/visibility`)
        .send({ visibility: 'private' });
      expect(res.status).toBe(401);
    });

    it('should return 403 when non-owner tries to batch change visibility', async () => {
      const other = createTestUser('regular');
      const res = await request(app)
        .put(`/api/trips/${tripId}/media/visibility`)
        .set('Authorization', `Bearer ${other.token}`)
        .send({ visibility: 'private' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('should allow owner to batch change all media to private', async () => {
      const buf = Buffer.from('fake jpeg content');
      await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'photo1.jpg', contentType: 'image/jpeg' });
      await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'photo2.jpg', contentType: 'image/jpeg' });

      const res = await request(app)
        .put(`/api/trips/${tripId}/media/visibility`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ visibility: 'private' });

      expect(res.status).toBe(200);
      expect(res.body.updatedCount).toBe(2);

      const db = getDb();
      const rows = db.prepare(
        'SELECT visibility FROM media_items WHERE trip_id = ?'
      ).all(tripId) as { visibility: string }[];
      for (const row of rows) {
        expect(row.visibility).toBe('private');
      }
    });

    it('should allow admin to batch change visibility of any trip', async () => {
      const admin = createTestUser('admin');
      const buf = Buffer.from('fake jpeg content');
      await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'photo.jpg', contentType: 'image/jpeg' });

      const res = await request(app)
        .put(`/api/trips/${tripId}/media/visibility`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ visibility: 'private' });

      expect(res.status).toBe(200);
      expect(res.body.updatedCount).toBe(1);
    });

    it('should return 404 for non-existent trip', async () => {
      const res = await request(app)
        .put('/api/trips/non-existent-id/media/visibility')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ visibility: 'private' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('should return 400 for invalid visibility value', async () => {
      const res = await request(app)
        .put(`/api/trips/${tripId}/media/visibility`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ visibility: 'unlisted' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_VISIBILITY');
    });

    it('should only update active media items, not trashed ones', async () => {
      const buf = Buffer.from('fake jpeg content');
      const uploadRes = await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'photo.jpg', contentType: 'image/jpeg' });

      const db = getDb();
      db.prepare("UPDATE media_items SET status = 'trashed' WHERE id = ?").run(uploadRes.body.id);

      await request(app)
        .post(`/api/trips/${tripId}/media`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', buf, { filename: 'photo2.jpg', contentType: 'image/jpeg' });

      const res = await request(app)
        .put(`/api/trips/${tripId}/media/visibility`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ visibility: 'private' });

      expect(res.status).toBe(200);
      expect(res.body.updatedCount).toBe(1);
    });
  });
});
