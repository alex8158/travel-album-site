import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock authFetch so we don't need to reach the real network or auth state.
const mockAuthFetch = vi.fn();
vi.mock('./contexts/AuthContext', () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

import {
  triggerHighlightEvaluation,
  getHighlights,
  getSimilarGroups,
  HighlightsApiError,
  type HighlightEvaluation,
  type HighlightPhoto,
  type SimilarGroup,
} from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('highlights API client', () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('triggerHighlightEvaluation', () => {
    it('POSTs to the trip highlights endpoint and returns the evaluation summary', async () => {
      const summary: HighlightEvaluation = {
        tripId: 'trip-1',
        totalPhotos: 12,
        highlightCount: 4,
        similarGroupCount: 2,
        batchesProcessed: 2,
        batchesFailed: 0,
        usedProvider: 'openai',
      };
      mockAuthFetch.mockResolvedValueOnce(jsonResponse(summary));

      const result = await triggerHighlightEvaluation('trip-1');

      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/api/trips/trip-1/highlights',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
      );
      expect(result).toEqual(summary);
    });

    it('throws HighlightsApiError with status 409 when an evaluation is already running', async () => {
      mockAuthFetch.mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 'ALREADY_RUNNING', message: '已有评审正在进行' } },
          409,
        ),
      );

      await expect(triggerHighlightEvaluation('trip-1')).rejects.toMatchObject({
        name: 'HighlightsApiError',
        status: 409,
        code: 'ALREADY_RUNNING',
        message: '已有评审正在进行',
      });
    });

    it('throws HighlightsApiError with a fallback message when the body is not JSON', async () => {
      mockAuthFetch.mockResolvedValueOnce(new Response('boom', { status: 500 }));

      await expect(triggerHighlightEvaluation('trip-1')).rejects.toBeInstanceOf(HighlightsApiError);
    });
  });

  describe('getHighlights', () => {
    const photos: HighlightPhoto[] = [
      {
        photoId: 'p1',
        tripId: 'trip-1',
        isHighlight: true,
        reason: 'Stunning composition',
        evaluatedAt: '2025-01-01T00:00:00Z',
      },
    ];

    it('GETs the trip highlights endpoint and returns a bare array', async () => {
      mockAuthFetch.mockResolvedValueOnce(jsonResponse(photos));

      const result = await getHighlights('trip-1');

      expect(mockAuthFetch).toHaveBeenCalledWith('/api/trips/trip-1/highlights');
      expect(result).toEqual(photos);
    });

    it('unwraps a { highlights: [...] } response shape', async () => {
      mockAuthFetch.mockResolvedValueOnce(jsonResponse({ highlights: photos }));

      const result = await getHighlights('trip-1');

      expect(result).toEqual(photos);
    });

    it('throws HighlightsApiError on non-2xx response', async () => {
      mockAuthFetch.mockResolvedValueOnce(
        jsonResponse({ error: { code: 'NOT_FOUND', message: '旅行不存在' } }, 404),
      );

      await expect(getHighlights('missing')).rejects.toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
      });
    });
  });

  describe('getSimilarGroups', () => {
    const groups: SimilarGroup[] = [
      {
        groupId: 'g1',
        tripId: 'trip-1',
        memberPhotoIds: ['p1', 'p2', 'p3'],
        bestPhotoId: 'p2',
        evaluatedAt: '2025-01-01T00:00:00Z',
      },
    ];

    it('GETs the trip similar-groups endpoint and returns a bare array', async () => {
      mockAuthFetch.mockResolvedValueOnce(jsonResponse(groups));

      const result = await getSimilarGroups('trip-1');

      expect(mockAuthFetch).toHaveBeenCalledWith('/api/trips/trip-1/similar-groups');
      expect(result).toEqual(groups);
    });

    it('unwraps a { groups: [...] } response shape', async () => {
      mockAuthFetch.mockResolvedValueOnce(jsonResponse({ groups }));

      const result = await getSimilarGroups('trip-1');

      expect(result).toEqual(groups);
    });

    it('throws HighlightsApiError when forbidden', async () => {
      mockAuthFetch.mockResolvedValueOnce(
        jsonResponse({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } }, 403),
      );

      await expect(getSimilarGroups('trip-1')).rejects.toMatchObject({
        status: 403,
        code: 'FORBIDDEN',
      });
    });
  });
});
