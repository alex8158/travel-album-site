import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import { authMiddleware } from '../middleware/auth';
import { globalErrorHandler } from '../middleware/errorHandler';
import trashRouter from './trash';

const app = express();
app.use(express.json());
app.use(authMiddleware);
app.use('/api', trashRouter);
app.use(globalErrorHandler);

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

function createMedia(tripId: string, userId: string, status = 'trashed'): string {
  const db = getDb();
  const mediaId = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, user_id, created_at)
     VALUES (?, ?, ?, 'image', 'image/jpeg', 'test.jpg', 1024, ?, ?, ?)`
  ).run(mediaId, tripId, `${tripId}/originals/${mediaId}.jpg`, status, userId, now);
  return mediaId;
}

describe('Trash API with auth', () => {
  let owner: { userId: string; token: string };
  let admin: { userId: string; token: string };
  let other: { userId: string; token: string };
  let tripId: string;

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM upload_sessions');
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');

    owner = createTestUser('regular');
    admin = createTestUser('admin');
    other = createTestUser('regular');
    tripId = createTrip(owner.userId);
  });

  afterEach(() => {
    closeDb();
  });

  describe('GET /api/trips/:id/trash', () => {
    it('should return 401 without auth token', async () => {
      const res = await request(app).get(`/api/trips/${tripId}/trash`);
      expect(res.status).toBe(401);
    });

    it('should return trashed items for authenticated user', async () => {
      createMedia(tripId, owner.userId, 'trashed');
      createMedia(tripId, owner.userId, 'active');

      const res = await request(app)
        .get(`/api/trips/${tripId}/trash`)
        .set('Authorization', `Bearer ${owner.token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].status).toBe('trashed');
    });

    it('should return empty array when no trashed items', async () => {
      const res = await request(app)
        .get(`/api/trips/${tripId}/trash`)
        .set('Authorization', `Bearer ${owner.token}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('DELETE /api/trips/:id/trash', () => {
    it('should return 401 without auth token', async () => {
      const res = await request(app).delete(`/api/trips/${tripId}/trash`);
      expect(res.status).toBe(401);
    });

    it('should return 403 when non-owner non-admin tries to batch delete', async () => {
      createMedia(tripId, owner.userId, 'trashed');

      const res = await request(app)
        .delete(`/api/trips/${tripId}/trash`)
        .set('Authorization', `Bearer ${other.token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('should allow owner to batch delete trashed items', async () => {
      const m1 = createMedia(tripId, owner.userId, 'trashed');
      const m2 = createMedia(tripId, owner.userId, 'trashed');

      const res = await request(app)
        .delete(`/api/trips/${tripId}/trash`)
        .set('Authorization', `Bearer ${owner.token}`);

      expect(res.status).toBe(200);
      expect(res.body.deletedCount).toBe(2);

      // Verify items are now 'deleted'
      const db = getDb();
      const row1 = db.prepare('SELECT status FROM media_items WHERE id = ?').get(m1) as { status: string };
      const row2 = db.prepare('SELECT status FROM media_items WHERE id = ?').get(m2) as { status: string };
      expect(row1.status).toBe('deleted');
      expect(row2.status).toBe('deleted');
    });

    it('should allow admin to batch delete trashed items of any trip', async () => {
      createMedia(tripId, owner.userId, 'trashed');

      const res = await request(app)
        .delete(`/api/trips/${tripId}/trash`)
        .set('Authorization', `Bearer ${admin.token}`);

      expect(res.status).toBe(200);
      expect(res.body.deletedCount).toBe(1);
    });

    it('should return 404 for non-existent trip', async () => {
      const res = await request(app)
        .delete('/api/trips/non-existent-id/trash')
        .set('Authorization', `Bearer ${owner.token}`);

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/trips/:id/media/trash', () => {
    it('should return 401 without auth token', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'active');
      const res = await request(app)
        .put(`/api/trips/${tripId}/media/trash`)
        .send({ mediaIds: [mediaId] });
      expect(res.status).toBe(401);
    });

    it('should return 400 when mediaIds is empty', async () => {
      const res = await request(app)
        .put(`/api/trips/${tripId}/media/trash`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ mediaIds: [] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });

    it('should return 400 when mediaIds is missing', async () => {
      const res = await request(app)
        .put(`/api/trips/${tripId}/media/trash`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });

    it('should return 400 when mediaIds is not an array', async () => {
      const res = await request(app)
        .put(`/api/trips/${tripId}/media/trash`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ mediaIds: 'not-an-array' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });

    it('should return 404 for non-existent trip', async () => {
      const res = await request(app)
        .put('/api/trips/non-existent-id/media/trash')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ mediaIds: ['some-id'] });
      expect(res.status).toBe(404);
    });

    it('should return 403 when non-owner non-admin tries to batch trash', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'active');
      const res = await request(app)
        .put(`/api/trips/${tripId}/media/trash`)
        .set('Authorization', `Bearer ${other.token}`)
        .send({ mediaIds: [mediaId] });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('should allow owner to batch trash active media items', async () => {
      const m1 = createMedia(tripId, owner.userId, 'active');
      const m2 = createMedia(tripId, owner.userId, 'active');

      const res = await request(app)
        .put(`/api/trips/${tripId}/media/trash`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ mediaIds: [m1, m2] });

      expect(res.status).toBe(200);
      expect(res.body.trashedCount).toBe(2);

      // Verify items are now trashed with correct reason
      const db = getDb();
      const row1 = db.prepare('SELECT status, trashed_reason FROM media_items WHERE id = ?').get(m1) as any;
      const row2 = db.prepare('SELECT status, trashed_reason FROM media_items WHERE id = ?').get(m2) as any;
      expect(row1.status).toBe('trashed');
      expect(row1.trashed_reason).toBe('manual');
      expect(row2.status).toBe('trashed');
      expect(row2.trashed_reason).toBe('manual');
    });

    it('should allow admin to batch trash media of any trip', async () => {
      const m1 = createMedia(tripId, owner.userId, 'active');

      const res = await request(app)
        .put(`/api/trips/${tripId}/media/trash`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ mediaIds: [m1] });

      expect(res.status).toBe(200);
      expect(res.body.trashedCount).toBe(1);
    });

    it('should only trash active items and skip already trashed ones', async () => {
      const m1 = createMedia(tripId, owner.userId, 'active');
      const m2 = createMedia(tripId, owner.userId, 'trashed');

      const res = await request(app)
        .put(`/api/trips/${tripId}/media/trash`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ mediaIds: [m1, m2] });

      expect(res.status).toBe(200);
      expect(res.body.trashedCount).toBe(1);
    });

    it('should skip mediaIds that do not belong to the trip', async () => {
      const otherTrip = createTrip(owner.userId);
      const m1 = createMedia(tripId, owner.userId, 'active');
      const m2 = createMedia(otherTrip, owner.userId, 'active');

      const res = await request(app)
        .put(`/api/trips/${tripId}/media/trash`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ mediaIds: [m1, m2] });

      expect(res.status).toBe(200);
      expect(res.body.trashedCount).toBe(1);

      // m2 should remain active (belongs to different trip)
      const db = getDb();
      const row = db.prepare('SELECT status FROM media_items WHERE id = ?').get(m2) as any;
      expect(row.status).toBe('active');
    });

    it('should return trashedCount 0 when no matching active items', async () => {
      const res = await request(app)
        .put(`/api/trips/${tripId}/media/trash`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ mediaIds: ['non-existent-id'] });

      expect(res.status).toBe(200);
      expect(res.body.trashedCount).toBe(0);
    });
  });

  describe('PUT /api/media/:id/restore', () => {
    it('should return 401 without auth token', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'trashed');
      const res = await request(app).put(`/api/media/${mediaId}/restore`);
      expect(res.status).toBe(401);
    });

    it('should return 403 when non-owner non-admin tries to restore', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'trashed');

      const res = await request(app)
        .put(`/api/media/${mediaId}/restore`)
        .set('Authorization', `Bearer ${other.token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('should allow media owner to restore', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'trashed');

      const res = await request(app)
        .put(`/api/media/${mediaId}/restore`)
        .set('Authorization', `Bearer ${owner.token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
    });

    it('should allow trip owner to restore media uploaded by another user', async () => {
      // Media uploaded by 'other' but in owner's trip
      const mediaId = createMedia(tripId, other.userId, 'trashed');

      const res = await request(app)
        .put(`/api/media/${mediaId}/restore`)
        .set('Authorization', `Bearer ${owner.token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
    });

    it('should allow admin to restore any media', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'trashed');

      const res = await request(app)
        .put(`/api/media/${mediaId}/restore`)
        .set('Authorization', `Bearer ${admin.token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
    });

    it('should return 404 for non-existent media', async () => {
      const res = await request(app)
        .put('/api/media/non-existent-id/restore')
        .set('Authorization', `Bearer ${owner.token}`);

      expect(res.status).toBe(404);
    });

    it('should return 400 when media is not trashed', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'active');

      const res = await request(app)
        .put(`/api/media/${mediaId}/restore`)
        .set('Authorization', `Bearer ${owner.token}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_STATUS');
    });
  });

  describe('PUT /api/media/:id/visibility', () => {
    it('should return 401 without auth token', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'active');
      const res = await request(app)
        .put(`/api/media/${mediaId}/visibility`)
        .send({ visibility: 'private' });
      expect(res.status).toBe(401);
    });

    it('should return 403 when non-owner non-admin tries to change visibility', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'active');

      const res = await request(app)
        .put(`/api/media/${mediaId}/visibility`)
        .set('Authorization', `Bearer ${other.token}`)
        .send({ visibility: 'private' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('should allow media owner to change visibility to private', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'active');

      const res = await request(app)
        .put(`/api/media/${mediaId}/visibility`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ visibility: 'private' });

      expect(res.status).toBe(200);
      expect(res.body.visibility).toBe('private');

      const db = getDb();
      const row = db.prepare('SELECT visibility FROM media_items WHERE id = ?').get(mediaId) as any;
      expect(row.visibility).toBe('private');
    });

    it('should allow media owner to change visibility to public', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'active');
      // Set to private first
      const db = getDb();
      db.prepare('UPDATE media_items SET visibility = ? WHERE id = ?').run('private', mediaId);

      const res = await request(app)
        .put(`/api/media/${mediaId}/visibility`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ visibility: 'public' });

      expect(res.status).toBe(200);
      expect(res.body.visibility).toBe('public');
    });

    it('should allow trip owner to change visibility of media uploaded by another user', async () => {
      const mediaId = createMedia(tripId, other.userId, 'active');

      const res = await request(app)
        .put(`/api/media/${mediaId}/visibility`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ visibility: 'private' });

      expect(res.status).toBe(200);
      expect(res.body.visibility).toBe('private');
    });

    it('should allow admin to change visibility of any media', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'active');

      const res = await request(app)
        .put(`/api/media/${mediaId}/visibility`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ visibility: 'private' });

      expect(res.status).toBe(200);
      expect(res.body.visibility).toBe('private');
    });

    it('should return 404 for non-existent media', async () => {
      const res = await request(app)
        .put('/api/media/non-existent-id/visibility')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ visibility: 'private' });

      expect(res.status).toBe(404);
    });

    it('should return 400 for invalid visibility value', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'active');

      const res = await request(app)
        .put(`/api/media/${mediaId}/visibility`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ visibility: 'unlisted' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_VISIBILITY');
    });
  });

  describe('DELETE /api/media/:id', () => {
    it('should return 401 without auth token', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'trashed');
      const res = await request(app).delete(`/api/media/${mediaId}`);
      expect(res.status).toBe(401);
    });

    it('should return 403 when non-owner non-admin tries to delete', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'trashed');

      const res = await request(app)
        .delete(`/api/media/${mediaId}`)
        .set('Authorization', `Bearer ${other.token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('should allow media owner to permanently delete', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'trashed');

      const res = await request(app)
        .delete(`/api/media/${mediaId}`)
        .set('Authorization', `Bearer ${owner.token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const db = getDb();
      const row = db.prepare('SELECT status FROM media_items WHERE id = ?').get(mediaId) as { status: string };
      expect(row.status).toBe('deleted');
    });

    it('should allow trip owner to delete media uploaded by another user', async () => {
      const mediaId = createMedia(tripId, other.userId, 'trashed');

      const res = await request(app)
        .delete(`/api/media/${mediaId}`)
        .set('Authorization', `Bearer ${owner.token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should allow admin to delete any media', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'trashed');

      const res = await request(app)
        .delete(`/api/media/${mediaId}`)
        .set('Authorization', `Bearer ${admin.token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 404 for non-existent media', async () => {
      const res = await request(app)
        .delete('/api/media/non-existent-id')
        .set('Authorization', `Bearer ${owner.token}`);

      expect(res.status).toBe(404);
    });

    it('should return 400 when media is not trashed', async () => {
      const mediaId = createMedia(tripId, owner.userId, 'active');

      const res = await request(app)
        .delete(`/api/media/${mediaId}`)
        .set('Authorization', `Bearer ${owner.token}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_STATUS');
    });
  });
});
