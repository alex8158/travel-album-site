import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import mediaAnalysisRouter from './mediaAnalysis';

const app = express();
app.use(express.json());
app.use('/api/media/:mediaId/analysis', mediaAnalysisRouter);

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

describe('Media Analysis API', () => {
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

  describe('POST /api/media/:mediaId/analysis', () => {
    it('should create an analysis record and return 201', async () => {
      const res = await request(app)
        .post(`/api/media/${mediaId}/analysis`)
        .send({
          blur_score: 0.85,
          sharpness_score: 0.9,
          exposure_score: 0.75,
          color_score: 0.6,
          noise_score: 0.3,
          aesthetic_score: 0.7,
          quality_score: 0.82,
          is_blurry: 0,
          is_overexposed: 0,
          is_underexposed: 0,
          is_duplicate: 0,
          is_recommended: 1,
          recommendation: 'keep',
          reason: '清晰度高，曝光正常',
          analysis_version: 'v1.0',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.media_id).toBe(mediaId);
      expect(res.body.blur_score).toBe(0.85);
      expect(res.body.sharpness_score).toBe(0.9);
      expect(res.body.exposure_score).toBe(0.75);
      expect(res.body.color_score).toBe(0.6);
      expect(res.body.noise_score).toBe(0.3);
      expect(res.body.aesthetic_score).toBe(0.7);
      expect(res.body.quality_score).toBe(0.82);
      expect(res.body.is_blurry).toBe(0);
      expect(res.body.is_overexposed).toBe(0);
      expect(res.body.is_underexposed).toBe(0);
      expect(res.body.is_duplicate).toBe(0);
      expect(res.body.is_recommended).toBe(1);
      expect(res.body.recommendation).toBe('keep');
      expect(res.body.reason).toBe('清晰度高，曝光正常');
      expect(res.body.analysis_version).toBe('v1.0');
      expect(res.body.created_at).toBeDefined();
    });

    it('should create a record with minimal data (all optional fields null)', async () => {
      const res = await request(app)
        .post(`/api/media/${mediaId}/analysis`)
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.media_id).toBe(mediaId);
      expect(res.body.blur_score).toBeNull();
      expect(res.body.quality_score).toBeNull();
      expect(res.body.is_blurry).toBe(0);
      expect(res.body.is_recommended).toBe(0);
    });
  });

  describe('GET /api/media/:mediaId/analysis', () => {
    it('should return the latest analysis record', async () => {
      // Create two analysis records with a small delay
      await request(app)
        .post(`/api/media/${mediaId}/analysis`)
        .send({ quality_score: 0.5, analysis_version: 'v1.0' });

      // Insert a second record directly with a later timestamp
      const db = getDb();
      const id2 = uuidv4();
      const laterTime = new Date(Date.now() + 1000).toISOString();
      db.prepare(
        `INSERT INTO media_analysis (id, media_id, quality_score, is_blurry, is_overexposed, is_underexposed, is_duplicate, is_recommended, analysis_version, created_at)
         VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?, ?)`
      ).run(id2, mediaId, 0.9, 'v2.0', laterTime);

      const res = await request(app).get(`/api/media/${mediaId}/analysis`);

      expect(res.status).toBe(200);
      expect(res.body.quality_score).toBe(0.9);
      expect(res.body.analysis_version).toBe('v2.0');
    });

    it('should return 404 when no analysis exists', async () => {
      const res = await request(app).get(`/api/media/${mediaId}/analysis`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/media/:mediaId/analysis?history=true', () => {
    it('should return all records ordered by created_at DESC', async () => {
      const db = getDb();

      // Insert records with explicit timestamps to control ordering
      const id1 = uuidv4();
      const id2 = uuidv4();
      const id3 = uuidv4();
      const t1 = '2025-01-01T00:00:00.000Z';
      const t2 = '2025-01-02T00:00:00.000Z';
      const t3 = '2025-01-03T00:00:00.000Z';

      db.prepare(
        `INSERT INTO media_analysis (id, media_id, quality_score, is_blurry, is_overexposed, is_underexposed, is_duplicate, is_recommended, analysis_version, created_at)
         VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?, ?)`
      ).run(id1, mediaId, 0.5, 'v1.0', t1);
      db.prepare(
        `INSERT INTO media_analysis (id, media_id, quality_score, is_blurry, is_overexposed, is_underexposed, is_duplicate, is_recommended, analysis_version, created_at)
         VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?, ?)`
      ).run(id2, mediaId, 0.7, 'v2.0', t2);
      db.prepare(
        `INSERT INTO media_analysis (id, media_id, quality_score, is_blurry, is_overexposed, is_underexposed, is_duplicate, is_recommended, analysis_version, created_at)
         VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?, ?)`
      ).run(id3, mediaId, 0.9, 'v3.0', t3);

      const res = await request(app).get(`/api/media/${mediaId}/analysis?history=true`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);
      // Ordered by created_at DESC: v3.0 first, v1.0 last
      expect(res.body[0].analysis_version).toBe('v3.0');
      expect(res.body[1].analysis_version).toBe('v2.0');
      expect(res.body[2].analysis_version).toBe('v1.0');
    });

    it('should return empty array when no analysis exists with history=true', async () => {
      const res = await request(app).get(`/api/media/${mediaId}/analysis?history=true`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('PUT /api/media/:mediaId/analysis/:analysisId', () => {
    it('should update an analysis record and return updated data', async () => {
      const createRes = await request(app)
        .post(`/api/media/${mediaId}/analysis`)
        .send({
          quality_score: 0.5,
          recommendation: 'review',
          reason: '需要人工审核',
          analysis_version: 'v1.0',
        });

      const analysisId = createRes.body.id;

      const res = await request(app)
        .put(`/api/media/${mediaId}/analysis/${analysisId}`)
        .send({
          quality_score: 0.9,
          recommendation: 'keep',
          reason: '重新分析后确认质量良好',
        });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(analysisId);
      expect(res.body.quality_score).toBe(0.9);
      expect(res.body.recommendation).toBe('keep');
      expect(res.body.reason).toBe('重新分析后确认质量良好');
      // Fields not in the update body should retain original values
      expect(res.body.analysis_version).toBe('v1.0');
    });

    it('should return 404 for non-existent analysisId', async () => {
      const res = await request(app)
        .put(`/api/media/${mediaId}/analysis/non-existent-id`)
        .send({ quality_score: 0.9 });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
