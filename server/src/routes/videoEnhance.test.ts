import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Use vi.hoisted to ensure mock functions are available when vi.mock factory runs
const { mockGenerateVersions, mockIsGenerating, mockDetectBlackFrames, mockDetectJunkClip } = vi.hoisted(() => ({
  mockGenerateVersions: vi.fn(),
  mockIsGenerating: vi.fn(),
  mockDetectBlackFrames: vi.fn(),
  mockDetectJunkClip: vi.fn(),
}));

// Mock the multiVersionGenerator service
vi.mock('../services/multiVersionGenerator', () => ({
  generateVersions: mockGenerateVersions,
  isGenerating: mockIsGenerating,
  DEFAULT_PROFILES: {
    highlight: { name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' },
    summary: { name: 'summary', targetDuration: 60, selectionStrategy: 'balanced' },
    full_edit: { name: 'full_edit', targetDuration: 300, selectionStrategy: 'comprehensive' },
  },
}));

// Mock the blackFrameDetector service
vi.mock('../services/blackFrameDetector', () => ({
  detectBlackFrames: mockDetectBlackFrames,
}));

// Mock the junkClipDetector service
vi.mock('../services/junkClipDetector', () => ({
  detectJunkClip: mockDetectJunkClip,
}));

import { getDb, closeDb } from '../database';
import videoEnhanceRouter, { tripVideoEnhanceRouter } from './videoEnhance';

// Create a minimal Express app for testing
const app = express();
app.use(express.json());
app.use('/api/media', videoEnhanceRouter);
app.use('/api/trips', tripVideoEnhanceRouter);

// Helper: insert a trip into the database
function createTrip(id: string, title: string = 'Test Trip'): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
  ).run(id, title, now, now);
}

// Helper: insert a media item into the database
function createMediaItem(id: string, tripId: string, mimeType: string = 'video/mp4'): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, tripId, `${tripId}/originals/${id}.mp4`, mimeType.startsWith('video/') ? 'video' : 'image', mimeType, 'test.mp4', 1024, now);
}

// Helper: insert video segments for a media item
function createVideoSegments(mediaId: string, count: number = 3): void {
  const db = getDb();
  const now = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT INTO video_segments (id, media_id, segment_index, start_time, end_time, duration, sharpness_score, stability_score, exposure_score, overall_score, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(`seg-${mediaId}-${i}`, mediaId, i, i * 10, (i + 1) * 10, 10, 70, 80, 75, 75, 'good', now);
  }
}

describe('Video Enhancement API Routes', () => {
  beforeEach(() => {
    const db = getDb();
    // Disable FK constraints for cleanup, then re-enable
    db.pragma('foreign_keys = OFF');
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM trips');
    db.pragma('foreign_keys = ON');

    mockGenerateVersions.mockReset();
    mockIsGenerating.mockReset();
    mockDetectBlackFrames.mockReset();
    mockDetectJunkClip.mockReset();

    // Default: not generating
    mockIsGenerating.mockReturnValue(false);
  });

  describe('POST /api/media/:mediaId/versions', () => {
    it('should return 404 when media not found', async () => {
      const res = await request(app)
        .post('/api/media/non-existent-id/versions')
        .send();

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('MEDIA_NOT_FOUND');
      expect(res.body.error.message).toBe('Media item not found');
    });

    it('should return 400 when media is not a video', async () => {
      createTrip('trip-1');
      createMediaItem('media-img', 'trip-1', 'image/jpeg');

      const res = await request(app)
        .post('/api/media/media-img/versions')
        .send();

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_MEDIA_TYPE');
      expect(res.body.error.message).toBe('Media item is not a video');
    });

    it('should return 409 when generation is already in progress', async () => {
      createTrip('trip-1');
      createMediaItem('media-busy', 'trip-1', 'video/mp4');
      mockIsGenerating.mockReturnValue(true);

      const res = await request(app)
        .post('/api/media/media-busy/versions')
        .send();

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('GENERATION_IN_PROGRESS');
    });

    it('should return 200 with result on successful generation', async () => {
      createTrip('trip-1');
      createMediaItem('media-ok', 'trip-1', 'video/mp4');
      createVideoSegments('media-ok', 3);

      const mockResult = {
        mediaId: 'media-ok',
        versions: [
          {
            versionId: 'v-1',
            profile: { name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' },
            filePath: 'trip-1/versions/media-ok_highlight.mp4',
            duration: 28,
            segmentCount: 3,
            fileSize: 5000000,
          },
        ],
        errors: [],
      };
      mockGenerateVersions.mockResolvedValue(mockResult);

      const res = await request(app)
        .post('/api/media/media-ok/versions')
        .send({ profiles: ['highlight'] });

      expect(res.status).toBe(200);
      expect(res.body.result).toEqual(mockResult);
      expect(mockGenerateVersions).toHaveBeenCalled();
    });

    it('should return 400 when no valid profiles specified', async () => {
      createTrip('trip-1');
      createMediaItem('media-ok', 'trip-1', 'video/mp4');
      createVideoSegments('media-ok', 3);

      const res = await request(app)
        .post('/api/media/media-ok/versions')
        .send({ profiles: ['nonexistent_profile', 'another_bad'] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PROFILES');
      expect(res.body.error.message).toBe('No valid profiles specified');
    });

    it('should use default profiles when none specified', async () => {
      createTrip('trip-1');
      createMediaItem('media-ok', 'trip-1', 'video/mp4');
      createVideoSegments('media-ok', 3);

      const mockResult = {
        mediaId: 'media-ok',
        versions: [],
        errors: [],
      };
      mockGenerateVersions.mockResolvedValue(mockResult);

      const res = await request(app)
        .post('/api/media/media-ok/versions')
        .send();

      expect(res.status).toBe(200);
      // Should have been called with all 3 default profiles
      const callArgs = mockGenerateVersions.mock.calls[0];
      expect(callArgs[4]).toHaveLength(3); // profiles array
    });
  });

  describe('POST /api/trips/:tripId/video-enhance', () => {
    it('should return 404 when trip not found', async () => {
      const res = await request(app)
        .post('/api/trips/non-existent-trip/video-enhance')
        .send();

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TRIP_NOT_FOUND');
      expect(res.body.error.message).toBe('Trip not found');
    });

    it('should return 200 with summary on successful batch processing', async () => {
      createTrip('trip-1');
      createMediaItem('video-1', 'trip-1', 'video/mp4');
      createMediaItem('video-2', 'trip-1', 'video/mp4');
      createVideoSegments('video-1', 2);
      createVideoSegments('video-2', 2);

      // Mock detection results
      mockDetectBlackFrames.mockResolvedValue({
        blackFrameRatio: 0.0,
        blackFrameScore: 1.0,
        isBlackFrameSegment: false,
        sampledFrameCount: 5,
        blackFrameCount: 0,
        thresholdUsed: 10,
      });
      mockDetectJunkClip.mockResolvedValue({
        isJunk: false,
        reason: null,
        confidence: 0.0,
        details: { duration: 10, motionMagnitude: 20, pitchAngle: 10, hasAccidentalPattern: false },
      });
      mockGenerateVersions.mockResolvedValue({
        mediaId: 'video-1',
        versions: [
          { versionId: 'v-1', profile: { name: 'highlight' }, filePath: 'path/v1.mp4', duration: 30, segmentCount: 2, fileSize: 5000000 },
        ],
        errors: [],
      });

      const res = await request(app)
        .post('/api/trips/trip-1/video-enhance')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.summary).toBeDefined();
      expect(res.body.summary.totalVideos).toBe(2);
      expect(res.body.summary.processed).toBe(2);
      expect(res.body.summary.errors).toHaveLength(0);
    });

    it('should return 200 with partial failures when one video fails', async () => {
      createTrip('trip-1');
      createMediaItem('video-ok', 'trip-1', 'video/mp4');
      createMediaItem('video-fail', 'trip-1', 'video/mp4');
      createVideoSegments('video-ok', 2);
      createVideoSegments('video-fail', 2);

      // Mock detection results - succeed for all
      mockDetectBlackFrames.mockResolvedValue({
        blackFrameRatio: 0.0,
        blackFrameScore: 1.0,
        isBlackFrameSegment: false,
        sampledFrameCount: 5,
        blackFrameCount: 0,
        thresholdUsed: 10,
      });
      mockDetectJunkClip.mockResolvedValue({
        isJunk: false,
        reason: null,
        confidence: 0.0,
        details: { duration: 10, motionMagnitude: 20, pitchAngle: 10, hasAccidentalPattern: false },
      });

      // First call succeeds, second call fails
      mockGenerateVersions
        .mockResolvedValueOnce({
          mediaId: 'video-ok',
          versions: [
            { versionId: 'v-1', profile: { name: 'highlight' }, filePath: 'path/v1.mp4', duration: 30, segmentCount: 2, fileSize: 5000000 },
          ],
          errors: [],
        })
        .mockRejectedValueOnce(new Error('FFmpeg encoding failed'));

      const res = await request(app)
        .post('/api/trips/trip-1/video-enhance')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.summary.totalVideos).toBe(2);
      expect(res.body.summary.processed).toBe(1);
      expect(res.body.summary.errors).toHaveLength(1);
      expect(res.body.summary.errors[0].error).toBe('FFmpeg encoding failed');
    });

    it('should not include non-video media items in processing', async () => {
      createTrip('trip-1');
      createMediaItem('video-1', 'trip-1', 'video/mp4');
      createMediaItem('image-1', 'trip-1', 'image/jpeg');

      createVideoSegments('video-1', 2);

      mockDetectBlackFrames.mockResolvedValue({
        blackFrameRatio: 0.0,
        blackFrameScore: 1.0,
        isBlackFrameSegment: false,
        sampledFrameCount: 5,
        blackFrameCount: 0,
        thresholdUsed: 10,
      });
      mockDetectJunkClip.mockResolvedValue({
        isJunk: false,
        reason: null,
        confidence: 0.0,
        details: { duration: 10, motionMagnitude: 20, pitchAngle: 10, hasAccidentalPattern: false },
      });
      mockGenerateVersions.mockResolvedValue({
        mediaId: 'video-1',
        versions: [{ versionId: 'v-1', profile: { name: 'highlight' }, filePath: 'path/v1.mp4', duration: 30, segmentCount: 2, fileSize: 5000000 }],
        errors: [],
      });

      const res = await request(app)
        .post('/api/trips/trip-1/video-enhance')
        .send();

      expect(res.status).toBe(200);
      // Only 1 video should be processed, not the image
      expect(res.body.summary.totalVideos).toBe(1);
      expect(res.body.summary.processed).toBe(1);
    });
  });
});
