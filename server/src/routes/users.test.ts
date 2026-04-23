import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import usersRouter from './users';
import adminRouter from './admin';
import { globalErrorHandler } from '../middleware/errorHandler';
import { signToken } from '../services/authService';

const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);
app.use('/api/admin', adminRouter);
app.use(globalErrorHandler);

function seedUser(overrides: Partial<{ username: string; role: string; status: string }> = {}) {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const username = overrides.username ?? `user_${id.slice(0, 8)}`;
  const passwordHash = bcrypt.hashSync('password123', 10);
  const role = overrides.role ?? 'regular';
  const status = overrides.status ?? 'active';

  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, username, passwordHash, role, status, now, now);

  return { id, username, role, status };
}

function seedTrip(userId: string, overrides: Partial<{ title: string; visibility: string }> = {}) {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const title = overrides.title ?? `Trip ${id.slice(0, 6)}`;
  const visibility = overrides.visibility ?? 'public';

  db.prepare(
    `INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, title, visibility, userId, now, now);

  return { id, title, visibility };
}

function seedMedia(tripId: string, userId: string, overrides: Partial<{ visibility: string; mediaType: string }> = {}) {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const visibility = overrides.visibility ?? 'public';
  const mediaType = overrides.mediaType ?? 'image';

  db.prepare(
    `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, user_id, visibility, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  ).run(id, tripId, `${id}/file.jpg`, mediaType, 'image/jpeg', 'photo.jpg', 1024, userId, visibility, now);

  return { id, visibility, mediaType };
}

describe('User Space Routes', () => {
  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM upload_sessions');
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');
    db.exec('DELETE FROM users');
  });

  afterEach(() => {
    closeDb();
  });

  describe('GET /api/users/me/trips', () => {
    it('should return all trips for the current user', async () => {
      const user = seedUser({ username: 'alice' });
      const trip1 = seedTrip(user.id, { title: 'Public Trip', visibility: 'public' });
      const trip2 = seedTrip(user.id, { title: 'Unlisted Trip', visibility: 'unlisted' });
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await request(app)
        .get('/api/users/me/trips')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.trips).toHaveLength(2);
      const titles = res.body.trips.map((t: any) => t.title);
      expect(titles).toContain('Public Trip');
      expect(titles).toContain('Unlisted Trip');
    });

    it('should not return other users trips', async () => {
      const alice = seedUser({ username: 'alice' });
      const bob = seedUser({ username: 'bob' });
      seedTrip(alice.id, { title: 'Alice Trip' });
      seedTrip(bob.id, { title: 'Bob Trip' });
      const token = signToken({ userId: alice.id, role: 'regular' });

      const res = await request(app)
        .get('/api/users/me/trips')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.trips).toHaveLength(1);
      expect(res.body.trips[0].title).toBe('Alice Trip');
    });

    it('should return trips ordered by created_at DESC', async () => {
      const user = seedUser({ username: 'alice' });
      const db = getDb();
      const id1 = uuidv4();
      const id2 = uuidv4();
      db.prepare(
        `INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at) VALUES (?, ?, 'public', ?, ?, ?)`
      ).run(id1, 'Older Trip', user.id, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
      db.prepare(
        `INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at) VALUES (?, ?, 'public', ?, ?, ?)`
      ).run(id2, 'Newer Trip', user.id, '2024-06-01T00:00:00.000Z', '2024-06-01T00:00:00.000Z');

      const token = signToken({ userId: user.id, role: 'regular' });
      const res = await request(app)
        .get('/api/users/me/trips')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.trips[0].title).toBe('Newer Trip');
      expect(res.body.trips[1].title).toBe('Older Trip');
    });

    it('should return 401 without auth token', async () => {
      const res = await request(app).get('/api/users/me/trips');
      expect(res.status).toBe(401);
    });

    it('should return empty array when user has no trips', async () => {
      const user = seedUser({ username: 'empty' });
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await request(app)
        .get('/api/users/me/trips')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.trips).toHaveLength(0);
    });
  });

  describe('GET /api/users/me/trips/:id/gallery', () => {
    it('should return all media (public + private) for own trip', async () => {
      const user = seedUser({ username: 'alice' });
      const trip = seedTrip(user.id);
      seedMedia(trip.id, user.id, { visibility: 'public' });
      seedMedia(trip.id, user.id, { visibility: 'private' });
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await request(app)
        .get(`/api/users/me/trips/${trip.id}/gallery`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.images).toHaveLength(2);
      expect(res.body.trip.id).toBe(trip.id);
    });

    it('should return 403 when accessing another users trip', async () => {
      const alice = seedUser({ username: 'alice' });
      const bob = seedUser({ username: 'bob' });
      const trip = seedTrip(bob.id);
      const token = signToken({ userId: alice.id, role: 'regular' });

      const res = await request(app)
        .get(`/api/users/me/trips/${trip.id}/gallery`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('should allow admin to access any users trip gallery', async () => {
      const admin = seedUser({ username: 'admin', role: 'admin' });
      const bob = seedUser({ username: 'bob' });
      const trip = seedTrip(bob.id);
      seedMedia(trip.id, bob.id, { visibility: 'private' });
      const token = signToken({ userId: admin.id, role: 'admin' });

      const res = await request(app)
        .get(`/api/users/me/trips/${trip.id}/gallery`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.images).toHaveLength(1);
    });

    it('should return 404 for non-existent trip', async () => {
      const user = seedUser({ username: 'alice' });
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await request(app)
        .get(`/api/users/me/trips/${uuidv4()}/gallery`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('should return 401 without auth token', async () => {
      const res = await request(app).get(`/api/users/me/trips/${uuidv4()}/gallery`);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/admin/users/:id/trips', () => {
    it('should return all trips for specified user when admin', async () => {
      const admin = seedUser({ username: 'admin', role: 'admin' });
      const bob = seedUser({ username: 'bob' });
      seedTrip(bob.id, { title: 'Bob Public', visibility: 'public' });
      seedTrip(bob.id, { title: 'Bob Unlisted', visibility: 'unlisted' });
      const token = signToken({ userId: admin.id, role: 'admin' });

      const res = await request(app)
        .get(`/api/admin/users/${bob.id}/trips`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.trips).toHaveLength(2);
    });

    it('should return 403 for non-admin user', async () => {
      const regular = seedUser({ username: 'regular' });
      const bob = seedUser({ username: 'bob' });
      seedTrip(bob.id);
      const token = signToken({ userId: regular.id, role: 'regular' });

      const res = await request(app)
        .get(`/api/admin/users/${bob.id}/trips`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('should return 401 without auth token', async () => {
      const res = await request(app).get(`/api/admin/users/${uuidv4()}/trips`);
      expect(res.status).toBe(401);
    });

    it('should return empty array for user with no trips', async () => {
      const admin = seedUser({ username: 'admin', role: 'admin' });
      const bob = seedUser({ username: 'bob' });
      const token = signToken({ userId: admin.id, role: 'admin' });

      const res = await request(app)
        .get(`/api/admin/users/${bob.id}/trips`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.trips).toHaveLength(0);
    });
  });
});
