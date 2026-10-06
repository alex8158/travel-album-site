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
  getTierPhotos,
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

  // The server lists tier slideshow URLs only for the trip owner or an admin, and
  // only reads the JWT from the Authorization header. These tests route the mocked
  // authFetch through the real implementation so the header that reaches fetch is
  // what gets asserted.
  describe('getTierPhotos', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;
    let store: Map<string, string>;

    beforeEach(async () => {
      const actual = await vi.importActual<typeof import('./contexts/AuthContext')>('./contexts/AuthContext');
      mockAuthFetch.mockImplementation((...args: unknown[]) =>
        actual.authFetch(...(args as Parameters<typeof actual.authFetch>)),
      );
      fetchSpy = vi.fn().mockImplementation(() =>
        Promise.resolve(jsonResponse({ photos: [], slideshowUrls: { animal: '/x.mp4' } })),
      );
      vi.stubGlobal('fetch', fetchSpy);
      store = new Map();
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function sentHeaders(): Headers {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      return new Headers((fetchSpy.mock.calls[0][1] as RequestInit | undefined)?.headers);
    }

    it('sends the stored bearer token so owner/admin get slideshowUrls', async () => {
      store.set('auth_token', 'owner-token');
      const result = await getTierPhotos('trip-1');
      expect(String(fetchSpy.mock.calls[0][0])).toBe('/api/trips/trip-1/tier-photos');
      expect(sentHeaders().get('Authorization')).toBe('Bearer owner-token');
      expect(result).toEqual({ photos: [], slideshowUrls: { animal: '/x.mp4' } });
    });

    it('sends no Authorization header for anonymous visitors and still returns data', async () => {
      const result = await getTierPhotos('trip-1');
      expect(sentHeaders().has('Authorization')).toBe(false);
      expect(result.photos).toEqual([]);
    });

    it('throws HighlightsApiError with the server message on non-2xx', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(jsonResponse({ error: { code: 'NOT_FOUND', message: '旅行不存在' } }, 404)),
      );
      const err = await getTierPhotos('trip-1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HighlightsApiError);
      expect(err).toMatchObject({ status: 404, code: 'NOT_FOUND', message: '旅行不存在' });
    });
  });
});
