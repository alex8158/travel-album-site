import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import duplicateGroupItemsRouter from './duplicateGroupItems';

const app = express();
app.use(express.json());
app.use('/api/duplicate-groups/:groupId/items', duplicateGroupItemsRouter);

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

function createDuplicateGroup(tripId: string): string {
  const db = getDb();
  const groupId = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO duplicate_groups (id, trip_id, created_at)
     VALUES (?, ?, ?)`
  ).run(groupId, tripId, now);
  return groupId;
}

describe('Duplicate Group Items API', () => {
  let userId: string;
  let tripId: string;
  let mediaId: string;
  let groupId: string;

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
    groupId = createDuplicateGroup(tripId);
  });

  afterEach(() => {
    closeDb();
  });

  describe('POST /api/duplicate-groups/:groupId/items', () => {
    it('should create an item and return 201', async () => {
      const res = await request(app)
        .post(`/api/duplicate-groups/${groupId}/items`)
        .send({
          media_id: mediaId,
          similarity_score: 0.95,
          quality_score: 0.88,
          recommendation: 'keep',
          reason: '清晰度最高',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.group_id).toBe(groupId);
      expect(res.body.media_id).toBe(mediaId);
      expect(res.body.similarity_score).toBe(0.95);
      expect(res.body.quality_score).toBe(0.88);
      expect(res.body.recommendation).toBe('keep');
      expect(res.body.reason).toBe('清晰度最高');
      expect(res.body.created_at).toBeDefined();
    });

    it('should return 409 when (group_id, media_id) already exists', async () => {
      // First insert
      await request(app)
        .post(`/api/duplicate-groups/${groupId}/items`)
        .send({ media_id: mediaId, similarity_score: 0.95 });

      // Duplicate insert
      const res = await request(app)
        .post(`/api/duplicate-groups/${groupId}/items`)
        .send({ media_id: mediaId, similarity_score: 0.90 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE_ENTRY');
    });

    it('should return 400 when media_id is missing', async () => {
      const res = await request(app)
        .post(`/api/duplicate-groups/${groupId}/items`)
        .send({ similarity_score: 0.95 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/duplicate-groups/:groupId/items', () => {
    it('should return all items in the group', async () => {
      const mediaId2 = createMedia(tripId, userId);

      await request(app)
        .post(`/api/duplicate-groups/${groupId}/items`)
        .send({ media_id: mediaId, similarity_score: 0.95 });
      await request(app)
        .post(`/api/duplicate-groups/${groupId}/items`)
        .send({ media_id: mediaId2, similarity_score: 0.88 });

      const res = await request(app).get(`/api/duplicate-groups/${groupId}/items`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('should return empty array when no items exist', async () => {
      const res = await request(app).get(`/api/duplicate-groups/${groupId}/items`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('PUT /api/duplicate-groups/:groupId/items/:itemId', () => {
    it('should update recommendation and return updated record', async () => {
      const createRes = await request(app)
        .post(`/api/duplicate-groups/${groupId}/items`)
        .send({ media_id: mediaId, similarity_score: 0.95, recommendation: 'keep' });

      const itemId = createRes.body.id;

      const res = await request(app)
        .put(`/api/duplicate-groups/${groupId}/items/${itemId}`)
        .send({ recommendation: 'delete', reason: '质量较低' });

      expect(res.status).toBe(200);
      expect(res.body.recommendation).toBe('delete');
      expect(res.body.reason).toBe('质量较低');
      expect(res.body.similarity_score).toBe(0.95);
    });

    it('should return 404 for non-existent itemId', async () => {
      const res = await request(app)
        .put(`/api/duplicate-groups/${groupId}/items/non-existent-id`)
        .send({ recommendation: 'delete' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('DELETE /api/duplicate-groups/:groupId/items/:itemId', () => {
    it('should delete an item and return 204', async () => {
      const createRes = await request(app)
        .post(`/api/duplicate-groups/${groupId}/items`)
        .send({ media_id: mediaId, similarity_score: 0.95 });

      const itemId = createRes.body.id;

      const res = await request(app).delete(`/api/duplicate-groups/${groupId}/items/${itemId}`);
      expect(res.status).toBe(204);

      // Verify it's gone
      const getRes = await request(app).get(`/api/duplicate-groups/${groupId}/items`);
      expect(getRes.body).toHaveLength(0);
    });

    it('should return 404 for non-existent itemId', async () => {
      const res = await request(app).delete(`/api/duplicate-groups/${groupId}/items/non-existent-id`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
