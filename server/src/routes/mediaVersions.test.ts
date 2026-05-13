import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import mediaVersionsRouter from './mediaVersions';

const app = express();
app.use(express.json());
app.use('/api/media/:mediaId/versions', mediaVersionsRouter);

function createTestUser(): string {
  const db = getDb();
  const userId = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'regular', 'active', ?, ?)`
  ).run(userId, `user_${userId.slice(0, 8)}`, 'hash', now, now);
  return userId;
}

function createTrip(userId: string): string {
  const db = getDb();
  const tripId = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at)
     VALUES (?, ?, 'public', ?, ?, ?)`
  ).run(tripId, `Trip ${tripId.slice(0, 6)}`, userId, now, now);
  return tripId;
}

function createMedia(tripId: string, userId: string): string {
  const db = getDb();
  const mediaId = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, user_id, created_at)
     VALUES (?, ?, ?, 'image', 'image/jpeg', 'test.jpg', 1024, ?, ?)`
  ).run(mediaId, tripId, `${tripId}/originals/${mediaId}.jpg`, userId, now);
  return mediaId;
}

describe('Media Versions API', () => {
  let userId: string;
  let tripId: string;
  let mediaId: string;

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM media_versions');
    db.exec('DELETE FROM media_analysis');
    db.exec('DELETE FROM duplicate_group_items');
    db.exec('DELETE FROM ai_invocations');
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM upload_sessions');
    db.exec('DELETE FROM compile_jobs');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM processing_job_events');
    db.exec('DELETE FROM processing_jobs');
    db.exec('DELETE FROM trips');
    db.exec('DELETE FROM users');

    userId = createTestUser();
    tripId = createTrip(userId);
    mediaId = createMedia(tripId, userId);
  });

  afterEach(() => {
    closeDb();
  });

  describe('POST /api/media/:mediaId/versions', () => {
    it('should create a version record and return 201', async () => {
      const res = await request(app)
        .post(`/api/media/${mediaId}/versions`)
        .send({
          version_type: 'thumbnail',
          file_path: 'uploads/thumbnails/test.webp',
          file_size: 45000,
          width: 400,
          height: 300,
          processor_name: 'sharp',
          params: '{"quality": 80}',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.media_id).toBe(mediaId);
      expect(res.body.version_type).toBe('thumbnail');
      expect(res.body.file_path).toBe('uploads/thumbnails/test.webp');
      expect(res.body.file_size).toBe(45000);
      expect(res.body.width).toBe(400);
      expect(res.body.height).toBe(300);
      expect(res.body.processor_name).toBe('sharp');
      expect(res.body.params).toBe('{"quality": 80}');
      expect(res.body.status).toBe('ready');
      expect(res.body.created_at).toBeDefined();
    });

    it('should accept all valid version_type values', async () => {
      const validTypes = ['original', 'thumbnail', 'preview', 'enhanced', 'ai_refined', 'proxy', 'segment', 'final_output'];

      for (const vtype of validTypes) {
        const res = await request(app)
          .post(`/api/media/${mediaId}/versions`)
          .send({
            version_type: vtype,
            file_path: `uploads/${vtype}/test.webp`,
          });

        expect(res.status).toBe(201);
        expect(res.body.version_type).toBe(vtype);
      }
    });

    it('should return 400 for invalid version_type', async () => {
      const res = await request(app)
        .post(`/api/media/${mediaId}/versions`)
        .send({
          version_type: 'invalid_type',
          file_path: 'uploads/test.webp',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_VERSION_TYPE');
      expect(res.body.error.message).toContain('invalid_type');
      expect(res.body.error.message).toContain('original');
    });

    it('should return 400 when version_type is missing', async () => {
      const res = await request(app)
        .post(`/api/media/${mediaId}/versions`)
        .send({
          file_path: 'uploads/test.webp',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_VERSION_TYPE');
    });

    it('should return 400 when file_path is missing', async () => {
      const res = await request(app)
        .post(`/api/media/${mediaId}/versions`)
        .send({
          version_type: 'thumbnail',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should default status to ready when not provided', async () => {
      const res = await request(app)
        .post(`/api/media/${mediaId}/versions`)
        .send({
          version_type: 'original',
          file_path: 'uploads/originals/test.jpg',
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('ready');
    });

    it('should allow custom status value', async () => {
      const res = await request(app)
        .post(`/api/media/${mediaId}/versions`)
        .send({
          version_type: 'enhanced',
          file_path: 'uploads/enhanced/test.webp',
          status: 'processing',
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('processing');
    });
  });

  describe('GET /api/media/:mediaId/versions', () => {
    it('should return all versions for a media item', async () => {
      // Create two versions
      await request(app)
        .post(`/api/media/${mediaId}/versions`)
        .send({ version_type: 'thumbnail', file_path: 'uploads/thumb.webp' });
      await request(app)
        .post(`/api/media/${mediaId}/versions`)
        .send({ version_type: 'preview', file_path: 'uploads/preview.webp' });

      const res = await request(app).get(`/api/media/${mediaId}/versions`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('should return empty array when no versions exist', async () => {
      const res = await request(app).get(`/api/media/${mediaId}/versions`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('should only return versions for the specified media_id', async () => {
      const otherMediaId = createMedia(tripId, userId);

      await request(app)
        .post(`/api/media/${mediaId}/versions`)
        .send({ version_type: 'thumbnail', file_path: 'uploads/thumb1.webp' });
      await request(app)
        .post(`/api/media/${otherMediaId}/versions`)
        .send({ version_type: 'thumbnail', file_path: 'uploads/thumb2.webp' });

      const res = await request(app).get(`/api/media/${mediaId}/versions`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].media_id).toBe(mediaId);
    });
  });

  describe('GET /api/media/:mediaId/versions/:versionId', () => {
    it('should return a single version record', async () => {
      const createRes = await request(app)
        .post(`/api/media/${mediaId}/versions`)
        .send({ version_type: 'thumbnail', file_path: 'uploads/thumb.webp', file_size: 5000 });

      const versionId = createRes.body.id;

      const res = await request(app).get(`/api/media/${mediaId}/versions/${versionId}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(versionId);
      expect(res.body.version_type).toBe('thumbnail');
      expect(res.body.file_size).toBe(5000);
    });

    it('should return 404 for non-existent version', async () => {
      const res = await request(app).get(`/api/media/${mediaId}/versions/non-existent-id`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('DELETE /api/media/:mediaId/versions/:versionId', () => {
    it('should delete a version record and return 204', async () => {
      const createRes = await request(app)
        .post(`/api/media/${mediaId}/versions`)
        .send({ version_type: 'thumbnail', file_path: 'uploads/thumb.webp' });

      const versionId = createRes.body.id;

      const res = await request(app).delete(`/api/media/${mediaId}/versions/${versionId}`);
      expect(res.status).toBe(204);

      // Verify it's gone
      const getRes = await request(app).get(`/api/media/${mediaId}/versions/${versionId}`);
      expect(getRes.status).toBe(404);
    });

    it('should return 404 when deleting non-existent version', async () => {
      const res = await request(app).delete(`/api/media/${mediaId}/versions/non-existent-id`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
