import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Use vi.hoisted to ensure mock functions are available when vi.mock factory runs
const { mockEnhanceMedia, mockEnhanceBatch } = vi.hoisted(() => ({
  mockEnhanceMedia: vi.fn(),
  mockEnhanceBatch: vi.fn(),
}));

// Mock the AIEnhancementService before importing the router
vi.mock('../services/aiEnhancementService', () => {
  return {
    AIEnhancementService: vi.fn().mockImplementation(() => ({
      enhanceMedia: mockEnhanceMedia,
      enhanceBatch: mockEnhanceBatch,
    })),
  };
});

import enhanceRouter, { tripEnhanceRouter } from './enhance';

// Create a minimal Express app for testing
const app = express();
app.use(express.json());
app.use('/api/media', enhanceRouter);
app.use('/api/trips', tripEnhanceRouter);

describe('Enhancement API Routes', () => {
  beforeEach(() => {
    mockEnhanceMedia.mockReset();
    mockEnhanceBatch.mockReset();
  });

  describe('POST /api/media/:mediaId/enhance', () => {
    it('should return 400 when media item does not exist', async () => {
      mockEnhanceMedia.mockRejectedValue(new Error('MEDIA_NOT_FOUND'));

      const res = await request(app)
        .post('/api/media/non-existent-id/enhance')
        .send();

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MEDIA_NOT_FOUND');
      expect(res.body.error.message).toBe('Media item does not exist');
    });

    it('should return 400 when media item is not an image', async () => {
      mockEnhanceMedia.mockRejectedValue(new Error('INVALID_MEDIA_TYPE'));

      const res = await request(app)
        .post('/api/media/video-media-id/enhance')
        .send();

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_MEDIA_TYPE');
      expect(res.body.error.message).toBe('Media item is not an image');
    });

    it('should return 409 when enhancement is already in progress', async () => {
      mockEnhanceMedia.mockRejectedValue(new Error('ENHANCEMENT_IN_PROGRESS'));

      const res = await request(app)
        .post('/api/media/busy-media-id/enhance')
        .send();

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ENHANCEMENT_IN_PROGRESS');
      expect(res.body.error.message).toBe('Enhancement is already in progress for this media item');
    });

    it('should return 200 with version record on successful enhancement', async () => {
      const mockResult = {
        mediaId: 'test-media-id',
        versionId: 'version-123',
        filePath: 'trip-1/enhanced/test-media-id_enhanced.jpg',
        params: {
          brightness: 1.2,
          contrast: 1.1,
          saturation: 1.0,
          sharpenSigma: 0.5,
          noiseReduction: 3,
        },
        modelName: 'anthropic.claude-3-haiku',
      };
      mockEnhanceMedia.mockResolvedValue(mockResult);

      const res = await request(app)
        .post('/api/media/test-media-id/enhance')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.version).toEqual(mockResult);
      expect(mockEnhanceMedia).toHaveBeenCalledWith('test-media-id');
    });

    it('should return 500 on unexpected errors', async () => {
      mockEnhanceMedia.mockRejectedValue(new Error('Something unexpected'));

      const res = await request(app)
        .post('/api/media/some-id/enhance')
        .send();

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('AI_PROVIDER_ERROR');
      expect(res.body.error.message).toBe('Enhancement failed');
      expect(res.body.error.details).toBe('Something unexpected');
    });
  });

  describe('POST /api/trips/:tripId/enhance', () => {
    it('should return 200 with empty summary when no eligible items exist', async () => {
      const emptySummary = {
        totalProcessed: 0,
        successful: 0,
        failed: 0,
        skipped: 0,
        results: [],
      };
      mockEnhanceBatch.mockResolvedValue(emptySummary);

      const res = await request(app)
        .post('/api/trips/trip-123/enhance')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.summary).toEqual(emptySummary);
      expect(res.body.message).toBe('No items need enhancement');
    });

    it('should return 200 with summary when eligible items are processed', async () => {
      const summary = {
        totalProcessed: 3,
        successful: 2,
        failed: 1,
        skipped: 0,
        results: [
          {
            mediaId: 'media-1',
            versionId: 'v-1',
            filePath: 'trip-1/enhanced/media-1_enhanced.jpg',
            params: { brightness: 1.1, contrast: 1.0, saturation: 1.0, sharpenSigma: 0.5, noiseReduction: 0 },
            modelName: 'anthropic.claude-3-haiku',
          },
          {
            mediaId: 'media-2',
            versionId: 'v-2',
            filePath: 'trip-1/enhanced/media-2_enhanced.jpg',
            params: { brightness: 1.0, contrast: 1.2, saturation: 1.1, sharpenSigma: 1.0, noiseReduction: 3 },
            modelName: 'anthropic.claude-3-haiku',
          },
          { mediaId: 'media-3', error: 'AI_PROVIDER_ERROR' },
        ],
      };
      mockEnhanceBatch.mockResolvedValue(summary);

      const res = await request(app)
        .post('/api/trips/trip-123/enhance')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.summary).toEqual(summary);
      expect(res.body.message).toBeUndefined();
      expect(mockEnhanceBatch).toHaveBeenCalledWith('trip-123', undefined);
    });

    it('should accept optional filter parameters in body', async () => {
      const summary = {
        totalProcessed: 1,
        successful: 1,
        failed: 0,
        skipped: 0,
        results: [
          {
            mediaId: 'media-1',
            versionId: 'v-1',
            filePath: 'trip-1/enhanced/media-1_enhanced.jpg',
            params: { brightness: 1.0, contrast: 1.0, saturation: 1.0, sharpenSigma: 0.25, noiseReduction: 0 },
            modelName: 'anthropic.claude-3-haiku',
          },
        ],
      };
      mockEnhanceBatch.mockResolvedValue(summary);

      const res = await request(app)
        .post('/api/trips/trip-456/enhance')
        .send({ maxQualityScore: 0.5, maxColorScore: 0.4 });

      expect(res.status).toBe(200);
      expect(res.body.summary).toEqual(summary);
      expect(mockEnhanceBatch).toHaveBeenCalledWith('trip-456', {
        maxQualityScore: 0.5,
        maxColorScore: 0.4,
      });
    });

    it('should return 500 on unexpected batch errors', async () => {
      mockEnhanceBatch.mockRejectedValue(new Error('Database connection lost'));

      const res = await request(app)
        .post('/api/trips/trip-789/enhance')
        .send();

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('BATCH_ENHANCEMENT_ERROR');
      expect(res.body.error.message).toBe('Batch enhancement failed');
      expect(res.body.error.details).toBe('Database connection lost');
    });
  });
});
