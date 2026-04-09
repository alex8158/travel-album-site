import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import { authMiddleware } from '../middleware/auth';
import tripsRouter from './trips';
import processRouter from './process';

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

// Mock services to avoid needing real image/video files
vi.mock('../services/dedupEngine', () => ({
  deduplicate: vi.fn().mockResolvedValue({ kept: [], removed: [], removedCount: 0 }),
}));

vi.mock('../services/dedupEngine', () => ({
  deduplicate: vi.fn().mockResolvedValue({ kept: [], removed: [], removedCount: 0 }),
}));

vi.mock('../services/bedrockClient', () => ({
  createAIClient: vi.fn().mockReturnValue({
    invokeModel: vi.fn().mockResolvedValue('{}'),
  }),
  analyzeImageWithBedrock: vi.fn().mockResolvedValue({ blur_status: 'clear', category: 'other' }),
}));

vi.mock('../services/blurDetector', () => ({
  applyBlurResult: vi.fn(),
  detectBlurry: vi.fn().mockResolvedValue({ blurryCount: 0, suspectCount: 0, deleteLogs: [], results: [] }),
}));

vi.mock('../services/imageAnalyzer', () => ({
  analyzeTrip: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/imageOptimizer', () => ({
  optimizeTrip: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/imageClassifier', () => ({
  applyClassifyResult: vi.fn(),
  classifyTrip: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/videoAnalyzer', () => ({
  analyzeVideo: vi.fn().mockResolvedValue({ mediaId: '', duration: 0, segments: [] }),
}));

vi.mock('../services/videoEditor', () => ({
  editVideo: vi.fn().mockResolvedValue({ mediaId: '', compiledPath: null, selectedSegments: [] }),
}));

vi.mock('../storage/factory', () => ({
  getStorageProvider: vi.fn().mockReturnValue({
    downloadToTemp: vi.fn().mockResolvedValue('/tmp/fake-image.jpg'),
    uploadFromPath: vi.fn().mockResolvedValue('uploaded/path'),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    getSignedUrl: vi.fn().mockResolvedValue('https://example.com/signed'),
  }),
}));

import { deduplicate } from '../services/dedupEngine';
import { analyzeImageWithBedrock } from '../services/bedrockClient';
import { optimizeTrip } from '../services/imageOptimizer';

const mockDeduplicate = vi.mocked(deduplicate);
const mockAnalyzeImage = vi.mocked(analyzeImageWithBedrock);
const mockOptimizeTrip = vi.mocked(optimizeTrip);

describe('POST /api/trips/:id/process', () => {
  let authToken: string;
  let testUserId: string;

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');
    mockDeduplicate.mockReset();
    mockDeduplicate.mockResolvedValue({ kept: [], removed: [], removedCount: 0 });
    mockAnalyzeImage.mockReset();
    mockAnalyzeImage.mockResolvedValue({ blur_status: 'clear', category: 'other' });
    mockOptimizeTrip.mockReset();
    mockOptimizeTrip.mockResolvedValue([]);
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

    const res = await request(app).post(`/api/trips/${trip.body.id}/process`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tripId: trip.body.id,
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
    // Also insert a video — should NOT be included in image count
    insertMedia.run('vid-1', tripId, `${tripId}/originals/v.mp4`, 'video', 'video/mp4', 'v.mp4', 5000, testUserId, 'public', now);

    // Mock deduplicate to return some removed
    mockDeduplicate.mockResolvedValue({ kept: ['img-1', 'img-2'], removed: ['img-3'], removedCount: 1 });

    const res = await request(app).post(`/api/trips/${tripId}/process`);
    expect(res.status).toBe(200);
    expect(res.body.tripId).toBe(tripId);
    expect(res.body.totalImages).toBe(3);
    expect(res.body.totalVideos).toBe(1);
    expect(res.body.dedupDeletedCount).toBe(1);

    // Verify deduplicate was called with tripId
    expect(mockDeduplicate).toHaveBeenCalledTimes(1);
    expect(mockDeduplicate.mock.calls[0][0]).toBe(tripId);
  });

  it('should call deduplicate with tripId string', async () => {
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

    mockDeduplicate.mockResolvedValue({ kept: ['img-a'], removed: [], removedCount: 0 });

    await request(app).post(`/api/trips/${tripId}/process`);

    // deduplicate receives tripId as first arg
    expect(mockDeduplicate).toHaveBeenCalledTimes(1);
    expect(typeof mockDeduplicate.mock.calls[0][0]).toBe('string');
    expect(mockDeduplicate.mock.calls[0][0]).toBe(tripId);
  });
});
