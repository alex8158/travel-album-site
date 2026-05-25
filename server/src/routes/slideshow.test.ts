import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import { signToken } from '../services/authService';
import { authMiddleware } from '../middleware/auth';
import slideshowRouter from './slideshow';

const app = express();
app.use(express.json());
app.use('/api/slideshow', slideshowRouter);

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

function createTestTrip(userId: string): string {
  const db = getDb();
  const tripId = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO trips (id, title, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(tripId, 'Test Trip', userId, now, now);
  return tripId;
}

function createTestPhoto(tripId: string, userId: string): string {
  const db = getDb();
  const photoId = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items (id, trip_id, user_id, file_path, media_type, mime_type, original_filename, file_size, created_at)
     VALUES (?, ?, ?, ?, 'image', 'image/jpeg', 'photo.jpg', 1024, ?)`
  ).run(photoId, tripId, userId, `${tripId}/photos/${photoId}.jpg`, now);
  return photoId;
}

function createTestVideo(tripId: string, userId: string): string {
  const db = getDb();
  const videoId = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items (id, trip_id, user_id, file_path, media_type, mime_type, original_filename, file_size, created_at)
     VALUES (?, ?, ?, ?, 'video', 'video/mp4', 'video.mp4', 10240, ?)`
  ).run(videoId, tripId, userId, `${tripId}/videos/${videoId}.mp4`, now);
  return videoId;
}

function createTestAudioTrack(userId: string): string {
  const db = getDb();
  const audioId = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO audio_tracks (id, user_id, title, file_path, format, duration, file_size, created_at)
     VALUES (?, ?, 'Test Audio', 'audio/test.mp3', 'mp3', 120.0, 5000000, ?)`
  ).run(audioId, userId, now);
  return audioId;
}

describe('Slideshow API - POST /api/slideshow/generate', () => {
  let ownerUserId: string;
  let ownerToken: string;
  let tripId: string;

  beforeEach(() => {
    const db = getDb();
    // Disable FK during cleanup to avoid ordering issues with dependent tables
    db.pragma('foreign_keys = OFF');
    db.exec('DELETE FROM slideshow_jobs');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM audio_tracks');
    db.exec('DELETE FROM processing_jobs');
    db.exec('DELETE FROM merged_video_sources');
    db.exec('DELETE FROM trips');
    db.pragma('foreign_keys = ON');

    const owner = createTestUser('regular');
    ownerUserId = owner.userId;
    ownerToken = owner.token;
    tripId = createTestTrip(ownerUserId);
  });

  afterEach(() => {
    // Don't close DB between tests — let vitest handle cleanup
  });

  it('should return 401 without auth token', async () => {
    const res = await request(app)
      .post('/api/slideshow/generate')
      .send({ tripId: 'some-trip', photoIds: ['a', 'b'] });
    expect(res.status).toBe(401);
  });

  it('should return 400 when tripId is missing', async () => {
    const res = await request(app)
      .post('/api/slideshow/generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ photoIds: ['a', 'b'] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('should return 400 when photoIds is missing', async () => {
    const res = await request(app)
      .post('/api/slideshow/generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ tripId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('should return 400 when photoIds has fewer than 2 items', async () => {
    const photoId = createTestPhoto(tripId, ownerUserId);
    const res = await request(app)
      .post('/api/slideshow/generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ tripId, photoIds: [photoId] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('2');
  });

  it('should return 404 when trip does not exist', async () => {
    const res = await request(app)
      .post('/api/slideshow/generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ tripId: uuidv4(), photoIds: ['a', 'b'] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 403 when user does not own the trip', async () => {
    const other = createTestUser('regular');
    const res = await request(app)
      .post('/api/slideshow/generate')
      .set('Authorization', `Bearer ${other.token}`)
      .send({ tripId, photoIds: ['a', 'b'] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('should return 400 when photoIds contain non-existent IDs', async () => {
    const photo1 = createTestPhoto(tripId, ownerUserId);
    const fakeId = uuidv4();
    const res = await request(app)
      .post('/api/slideshow/generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ tripId, photoIds: [photo1, fakeId] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PHOTOS');
    expect(res.body.error.invalidIds).toContain(fakeId);
  });

  it('should return 400 when photoIds contain photos from another trip', async () => {
    const otherTrip = createTestTrip(ownerUserId);
    const photo1 = createTestPhoto(tripId, ownerUserId);
    const photo2 = createTestPhoto(otherTrip, ownerUserId);
    const res = await request(app)
      .post('/api/slideshow/generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ tripId, photoIds: [photo1, photo2] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PHOTOS');
    expect(res.body.error.invalidIds).toContain(photo2);
  });

  it('should return 400 when photoIds contain non-image media', async () => {
    const photo1 = createTestPhoto(tripId, ownerUserId);
    const video1 = createTestVideo(tripId, ownerUserId);
    const res = await request(app)
      .post('/api/slideshow/generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ tripId, photoIds: [photo1, video1] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PHOTOS');
    expect(res.body.error.invalidIds).toContain(video1);
  });

  it('should return 409 when a slideshow job is already running for the trip', async () => {
    const db = getDb();
    const photo1 = createTestPhoto(tripId, ownerUserId);
    const photo2 = createTestPhoto(tripId, ownerUserId);

    // Insert a running job
    db.prepare(
      `INSERT INTO slideshow_jobs (id, trip_id, user_id, status, photo_ids, created_at)
       VALUES (?, ?, ?, 'running', ?, ?)`
    ).run(uuidv4(), tripId, ownerUserId, JSON.stringify([photo1, photo2]), new Date().toISOString());

    const res = await request(app)
      .post('/api/slideshow/generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ tripId, photoIds: [photo1, photo2] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_PROCESSING');
  });

  it('should return 400 when audioTrackId does not exist', async () => {
    const photo1 = createTestPhoto(tripId, ownerUserId);
    const photo2 = createTestPhoto(tripId, ownerUserId);
    const res = await request(app)
      .post('/api/slideshow/generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ tripId, photoIds: [photo1, photo2], audioTrackId: uuidv4() });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('音频');
  });

  it('should return 403 when audioTrackId belongs to another user', async () => {
    const other = createTestUser('regular');
    const audioId = createTestAudioTrack(other.userId);
    const photo1 = createTestPhoto(tripId, ownerUserId);
    const photo2 = createTestPhoto(tripId, ownerUserId);
    const res = await request(app)
      .post('/api/slideshow/generate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ tripId, photoIds: [photo1, photo2], audioTrackId: audioId });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('should allow admin to access any trip (does not return 403)', async () => {
    const db = getDb();
    const admin = createTestUser('admin');
    const photo1 = createTestPhoto(tripId, ownerUserId);
    const photo2 = createTestPhoto(tripId, ownerUserId);

    // Pre-insert a running job for this trip so the admin request short-circuits
    // with 409 ALREADY_PROCESSING *before* hitting SSE flushHeaders. This keeps
    // the test fast and deterministic while still proving the admin bypass for
    // trip ownership succeeds (a non-admin would have been rejected with 403 first).
    db.prepare(
      `INSERT INTO slideshow_jobs (id, trip_id, user_id, status, photo_ids, created_at)
       VALUES (?, ?, ?, 'running', ?, ?)`
    ).run(uuidv4(), tripId, ownerUserId, JSON.stringify([photo1, photo2]), new Date().toISOString());

    const res = await request(app)
      .post('/api/slideshow/generate')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ tripId, photoIds: [photo1, photo2] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_PROCESSING');
  });
});
