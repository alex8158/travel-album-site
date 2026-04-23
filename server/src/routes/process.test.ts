import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import { authMiddleware } from '../middleware/auth';
import tripsRouter from './trips';
import processRouter from './process';
import type { PipelineResult } from '../services/pipeline/types';

const app = express();
app.use(express.json());
app.use(authMiddleware);
app.use('/api/trips', tripsRouter);
app.use('/api/trips', processRouter);

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

// Mock the pipeline orchestrator — process.ts now delegates everything to it
vi.mock('../services/pipeline/runTripProcessingPipeline', () => ({
  runTripProcessingPipeline: vi.fn(),
}));

// Still need storage mock since other routes may use it
vi.mock('../storage/factory', () => ({
  getStorageProvider: vi.fn().mockReturnValue({
    downloadToTemp: vi.fn().mockResolvedValue('/tmp/fake-image.jpg'),
    uploadFromPath: vi.fn().mockResolvedValue('uploaded/path'),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    getSignedUrl: vi.fn().mockResolvedValue('https://example.com/signed'),
  }),
}));

import { runTripProcessingPipeline } from '../services/pipeline/runTripProcessingPipeline';

const mockRunPipeline = vi.mocked(runTripProcessingPipeline);

function makeEmptyResult(tripId: string): PipelineResult {
  return {
    tripId,
    totalImages: 0,
    totalVideos: 0,
    blurryDeletedCount: 0,
    dedupDeletedCount: 0,
    analyzedCount: 0,
    optimizedCount: 0,
    classifiedCount: 0,
    categoryStats: { people: 0, animal: 0, landscape: 0, other: 0 },
    compiledCount: 0,
    failedCount: 0,
    skippedCount: 0,
    partialFailureCount: 0,
    downloadFailedCount: 0,
    coverImageId: null,
  };
}

describe('POST /api/trips/:id/process', () => {
  let authToken: string;
  let testUserId: string;

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM processing_job_events');
    db.exec('DELETE FROM processing_jobs');
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM upload_sessions');
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');
    mockRunPipeline.mockReset();
    const user = createTestUser('regular');
    authToken = user.token;
    testUserId = user.userId;
  });

  afterEach(() => {
    closeDb();
  });

  it('should return 404 for non-existent trip', async () => {
    const res = await request(app).post('/api/trips/non-existent/process');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return empty summary when trip has no images', async () => {
    const trip = await request(app)
      .post('/api/trips')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ title: 'Empty Trip' });

    const tripId = trip.body.id;
    mockRunPipeline.mockResolvedValue(makeEmptyResult(tripId));

    const res = await request(app).post(`/api/trips/${tripId}/process`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tripId,
      totalImages: 0,
      totalVideos: 0,
      blurryDeletedCount: 0,
      dedupDeletedCount: 0,
      analyzedCount: 0,
      optimizedCount: 0,
      classifiedCount: 0,
      categoryStats: { people: 0, animal: 0, landscape: 0, other: 0 },
      compiledCount: 0,
      failedCount: 0,
      coverImageId: null,
    });
  });

  it('should return summary with correct counts for images', async () => {
    // Create trip
    const trip = await request(app)
      .post('/api/trips')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ title: 'Photo Trip' });
    const tripId = trip.body.id;

    // Insert image media_items directly into DB
    const db = getDb();
    const now = new Date().toISOString();
    const insertMedia = db.prepare(
      `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, user_id, visibility, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertMedia.run('img-1', tripId, `${tripId}/originals/a.jpg`, 'image', 'image/jpeg', 'a.jpg', 1000, testUserId, 'public', now);
    insertMedia.run('img-2', tripId, `${tripId}/originals/b.jpg`, 'image', 'image/jpeg', 'b.jpg', 2000, testUserId, 'public', now);
    insertMedia.run('img-3', tripId, `${tripId}/originals/c.jpg`, 'image', 'image/jpeg', 'c.jpg', 3000, testUserId, 'public', now);
    insertMedia.run('vid-1', tripId, `${tripId}/originals/v.mp4`, 'video', 'video/mp4', 'v.mp4', 5000, testUserId, 'public', now);

    mockRunPipeline.mockResolvedValue({
      ...makeEmptyResult(tripId),
      totalImages: 3,
      totalVideos: 1,
      dedupDeletedCount: 1,
    });

    const res = await request(app).post(`/api/trips/${tripId}/process`);
    expect(res.status).toBe(200);
    expect(res.body.tripId).toBe(tripId);
    expect(res.body.totalImages).toBe(3);
    expect(res.body.totalVideos).toBe(1);
    expect(res.body.dedupDeletedCount).toBe(1);

    // Verify pipeline was called with tripId
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    expect(mockRunPipeline.mock.calls[0][0]).toBe(tripId);
  });

  it('should call pipeline with tripId string', async () => {
    const trip = await request(app)
      .post('/api/trips')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ title: 'Path Trip' });
    const tripId = trip.body.id;

    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, user_id, visibility, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('img-a', tripId, `${tripId}/originals/photo.jpg`, 'image', 'image/jpeg', 'photo.jpg', 1000, testUserId, 'public', now);

    mockRunPipeline.mockResolvedValue(makeEmptyResult(tripId));

    await request(app).post(`/api/trips/${tripId}/process`);

    // pipeline receives tripId as first arg
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    expect(typeof mockRunPipeline.mock.calls[0][0]).toBe('string');
    expect(mockRunPipeline.mock.calls[0][0]).toBe(tripId);
  });

  it('should return 409 when trip has an active job in the database', async () => {
    const trip = await request(app)
      .post('/api/trips')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ title: 'Concurrent Trip' });
    const tripId = trip.body.id;

    // Insert an active processing job directly in the DB
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO processing_jobs (id, trip_id, status, created_at) VALUES (?, ?, 'running', ?)`
    ).run('existing-job-id', tripId, now);

    mockRunPipeline.mockResolvedValue(makeEmptyResult(tripId));

    // POST should detect the active job and return 409
    const res = await request(app).post(`/api/trips/${tripId}/process`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_PROCESSING');
  });

  it('should pass videoResolution option to pipeline', async () => {
    const trip = await request(app)
      .post('/api/trips')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ title: 'Video Trip' });
    const tripId = trip.body.id;

    mockRunPipeline.mockResolvedValue(makeEmptyResult(tripId));

    await request(app).post(`/api/trips/${tripId}/process?videoResolution=720`);

    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    expect(mockRunPipeline.mock.calls[0][1]).toEqual({ videoResolution: 720 });
  });
});
