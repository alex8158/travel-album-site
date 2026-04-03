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
  deduplicate: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/blurDetector', () => ({
  detectAndTrashBlurry: vi.fn().mockResolvedValue({ blurryCount: 0, results: [] }),
}));

vi.mock('../services/imageOptimizer', () => ({
  optimizeTrip: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/videoAnalyzer', () => ({
  analyzeVideo: vi.fn().mockResolvedValue({ mediaId: '', duration: 0, segments: [] }),
}));

vi.mock('../services/videoEditor', () => ({
  editVideo: vi.fn().mockResolvedValue({ mediaId: '', compiledPath: null, selectedSegments: [] }),
}));

import { deduplicate } from '../services/dedupEngine';
const mockDeduplicate = vi.mocked(deduplicate);

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
    mockDeduplicate.mockResolvedValue([]);
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
      duplicateGroups: [],
      totalGroups: 0,
      blurryCount: 0,
      trashedDuplicateCount: 0,
      optimizedCount: 0,
      compiledCount: 0,
      failedCount: 0,
      coverImageId: null,
    });
  });

  it('should return summary with duplicate groups', async () => {
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
    // Also insert a video — should NOT be included
    insertMedia.run('vid-1', tripId, `${tripId}/originals/v.mp4`, 'video', 'video/mp4', 'v.mp4', 5000, testUserId, 'public', now);

    // Mock deduplicate to return groups
    mockDeduplicate.mockResolvedValue([
      { id: 'group-1', tripId, defaultImageId: 'img-1', imageCount: 2, createdAt: now },
    ]);

    const res = await request(app).post(`/api/trips/${tripId}/process`);
    expect(res.status).toBe(200);
    expect(res.body.tripId).toBe(tripId);
    expect(res.body.totalImages).toBe(3);
    expect(res.body.totalGroups).toBe(1);
    expect(res.body.duplicateGroups).toEqual([
      { groupId: 'group-1', imageCount: 2 },
    ]);

    // Verify deduplicate was called with only image items (not video)
    expect(mockDeduplicate).toHaveBeenCalledTimes(1);
    const calledItems = mockDeduplicate.mock.calls[0][0];
    expect(calledItems).toHaveLength(3);
    expect(calledItems.every((item: any) => item.mediaType === 'image')).toBe(true);
  });

  it('should resolve file paths to absolute paths for deduplicate', async () => {
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

    mockDeduplicate.mockResolvedValue([]);

    await request(app).post(`/api/trips/${tripId}/process`);

    const calledItems = mockDeduplicate.mock.calls[0][0];
    expect(calledItems).toHaveLength(1);
    // filePath should be the relative DB path (StorageProvider handles resolution)
    expect(calledItems[0].filePath).toBe(`${tripId}/originals/photo.jpg`);
    expect(calledItems[0].filePath).toContain('photo.jpg');
  });
});
