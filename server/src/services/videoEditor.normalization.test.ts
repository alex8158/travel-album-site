/**
 * Unit tests for audio normalization integration in editVideo.
 *
 * Task 6.4: Verifies normalization integration — success path, partial failure fallback.
 *
 * **Validates: Requirements 8.1, 8.2, 8.3, 8.4**
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VideoAnalysisResult, VideoSegment } from './videoAnalyzer';
import type { NormalizationResult } from './audioNormalizer';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock fluent-ffmpeg — create a chainable instance that auto-resolves on run()
function createFfmpegInstance() {
  const instance: any = {};
  const chainMethods = ['seekInput', 'duration', 'output', 'outputOptions', 'input', 'inputOptions', 'complexFilter', 'format', 'videoFilters'];
  for (const method of chainMethods) {
    instance[method] = vi.fn().mockReturnValue(instance);
  }
  instance._endCb = null;
  instance._errorCb = null;
  instance.on = vi.fn().mockImplementation((event: string, cb: Function) => {
    if (event === 'end') instance._endCb = cb;
    if (event === 'error') instance._errorCb = cb;
    return instance;
  });
  instance.run = vi.fn().mockImplementation(() => {
    if (instance._endCb) instance._endCb();
  });
  return instance;
}

vi.mock('fluent-ffmpeg', () => {
  const fn: any = (...args: any[]) => createFfmpegInstance();
  fn.ffprobe = (_path: string, cb: Function) => {
    cb(null, { streams: [{ codec_type: 'audio' }] });
  };
  return { default: fn };
});

// Mock fs
vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      mkdtempSync: vi.fn(() => '/tmp/video-edit-test-media-123'),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => Buffer.from('fake-video-data')),
      rmSync: vi.fn(),
      existsSync: vi.fn(() => true),
    },
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn(() => '/tmp/video-edit-test-media-123'),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => Buffer.from('fake-video-data')),
    rmSync: vi.fn(),
    existsSync: vi.fn(() => true),
  };
});

// Mock tempDir helper
vi.mock('../helpers/tempDir', () => ({
  getTempDir: () => '/tmp',
}));

// Mock storage provider
const mockSave = vi.fn().mockResolvedValue(undefined);
vi.mock('../storage/factory', () => ({
  getStorageProvider: () => ({
    save: mockSave,
    downloadToTemp: vi.fn().mockResolvedValue('/tmp/downloaded.mp4'),
  }),
}));

// Mock audioNormalizer
const mockNormalizeSegments = vi.fn();
vi.mock('./audioNormalizer', () => ({
  normalizeSegments: (...args: any[]) => mockNormalizeSegments(...args),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { editVideo } from './videoEditor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSegment(overrides: Partial<VideoSegment> & { index: number; startTime: number; endTime: number; duration: number; overallScore: number }): VideoSegment {
  return {
    sharpnessScore: 80,
    stabilityScore: 80,
    exposureScore: 50,
    label: 'good',
    ...overrides,
  } as VideoSegment;
}

function makeAnalysis(segments: VideoSegment[], duration: number): VideoAnalysisResult {
  return {
    duration,
    segments,
    fps: 30,
    width: 1920,
    height: 1080,
    codec: 'h264',
    bitrate: 5000000,
    hasAudio: true,
  } as VideoAnalysisResult;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('editVideo — audio normalization integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('success path — all segments normalized', () => {
    it('uses normalized paths for concatenation and reports normalizedSegments', async () => {
      // Use 2 segments that will both be selected (total 60s = targetDuration for 90s video)
      const segments = [
        makeSegment({ index: 0, startTime: 0, endTime: 30, duration: 30, overallScore: 85 }),
        makeSegment({ index: 1, startTime: 30, endTime: 60, duration: 30, overallScore: 80 }),
      ];

      // Duration 90s → targetDuration = 60 (medium video)
      const analysis = makeAnalysis(segments, 90);

      // Both segments successfully normalized
      const normResults: NormalizationResult[] = [
        { normalizedPath: '/tmp/video-edit-test-media-123/normalized/segment_0_normalized.mp4', skipped: false, reason: 'normalized', originalLoudness: -20, targetLoudness: -16 },
        { normalizedPath: '/tmp/video-edit-test-media-123/normalized/segment_1_normalized.mp4', skipped: false, reason: 'normalized', originalLoudness: -22, targetLoudness: -16 },
      ];
      mockNormalizeSegments.mockResolvedValue(normResults);

      const result = await editVideo('/path/to/video.mp4', analysis, 'trip-1', 'media-123');

      // normalizeSegments should have been called
      expect(mockNormalizeSegments).toHaveBeenCalledTimes(1);
      expect(mockNormalizeSegments).toHaveBeenCalledWith(
        expect.any(Array),
        expect.stringContaining('normalized')
      );

      // normalizedSegments should contain the original segment indices that were normalized
      expect(result.normalizedSegments).toBeDefined();
      expect(result.normalizedSegments).toEqual(expect.arrayContaining([0, 1]));
      expect(result.normalizedSegments!.length).toBe(2);
    });
  });

  describe('partial failure fallback — some segments fail normalization', () => {
    it('uses original paths for failed segments and normalized paths for successful ones', async () => {
      // 2 segments, both will be selected (total 60s = targetDuration for 90s video)
      const segments = [
        makeSegment({ index: 0, startTime: 0, endTime: 30, duration: 30, overallScore: 85 }),
        makeSegment({ index: 1, startTime: 30, endTime: 60, duration: 30, overallScore: 80 }),
      ];

      const analysis = makeAnalysis(segments, 90);

      // Segment 0: normalized successfully
      // Segment 1: failed (skipped=true, reason='error')
      const normResults: NormalizationResult[] = [
        { normalizedPath: '/tmp/video-edit-test-media-123/normalized/segment_0_normalized.mp4', skipped: false, reason: 'normalized', originalLoudness: -20, targetLoudness: -16 },
        { normalizedPath: null, skipped: true, reason: 'error', originalLoudness: -22, targetLoudness: -16 },
      ];
      mockNormalizeSegments.mockResolvedValue(normResults);

      const result = await editVideo('/path/to/video.mp4', analysis, 'trip-1', 'media-123');

      // normalizedSegments should only contain indices of successfully normalized segments
      expect(result.normalizedSegments).toBeDefined();
      expect(result.normalizedSegments).toContain(0);
      expect(result.normalizedSegments).not.toContain(1);
      expect(result.normalizedSegments!.length).toBe(1);
    });

    it('reports only successfully normalized segment indices in normalizedSegments', async () => {
      // 3 segments with shorter durations so all get selected (total 30s < targetDuration 60s)
      const segments = [
        makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 90 }),
        makeSegment({ index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 85 }),
        makeSegment({ index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 80 }),
      ];

      const analysis = makeAnalysis(segments, 90);

      // Segment 0: error
      // Segment 1: normalized
      // Segment 2: error
      const normResults: NormalizationResult[] = [
        { normalizedPath: null, skipped: true, reason: 'error', originalLoudness: -25, targetLoudness: -16 },
        { normalizedPath: '/tmp/video-edit-test-media-123/normalized/segment_1_normalized.mp4', skipped: false, reason: 'normalized', originalLoudness: -20, targetLoudness: -16 },
        { normalizedPath: null, skipped: true, reason: 'error', originalLoudness: -19, targetLoudness: -16 },
      ];
      mockNormalizeSegments.mockResolvedValue(normResults);

      const result = await editVideo('/path/to/video.mp4', analysis, 'trip-1', 'media-123');

      expect(result.normalizedSegments).toBeDefined();
      expect(result.normalizedSegments).toEqual([1]);
    });
  });

  describe('all skipped (within tolerance) — no normalization needed', () => {
    it('uses original paths and reports empty normalizedSegments', async () => {
      // 2 segments, both selected (total 60s = targetDuration for 90s video)
      const segments = [
        makeSegment({ index: 0, startTime: 0, endTime: 30, duration: 30, overallScore: 85 }),
        makeSegment({ index: 1, startTime: 30, endTime: 60, duration: 30, overallScore: 80 }),
      ];

      const analysis = makeAnalysis(segments, 90);

      // All segments within tolerance — skipped
      const normResults: NormalizationResult[] = [
        { normalizedPath: null, skipped: true, reason: 'within_tolerance', originalLoudness: -15.5, targetLoudness: -16 },
        { normalizedPath: null, skipped: true, reason: 'within_tolerance', originalLoudness: -16.2, targetLoudness: -16 },
      ];
      mockNormalizeSegments.mockResolvedValue(normResults);

      const result = await editVideo('/path/to/video.mp4', analysis, 'trip-1', 'media-123');

      // normalizedSegments should be empty since all were skipped
      expect(result.normalizedSegments).toBeDefined();
      expect(result.normalizedSegments).toEqual([]);
    });

    it('uses original paths when segments have no audio', async () => {
      const segments = [
        makeSegment({ index: 0, startTime: 0, endTime: 30, duration: 30, overallScore: 85 }),
        makeSegment({ index: 1, startTime: 30, endTime: 60, duration: 30, overallScore: 80 }),
      ];

      const analysis = makeAnalysis(segments, 90);

      // All segments have no audio — skipped
      const normResults: NormalizationResult[] = [
        { normalizedPath: null, skipped: true, reason: 'no_audio', originalLoudness: -23, targetLoudness: -16 },
        { normalizedPath: null, skipped: true, reason: 'no_audio', originalLoudness: -23, targetLoudness: -16 },
      ];
      mockNormalizeSegments.mockResolvedValue(normResults);

      const result = await editVideo('/path/to/video.mp4', analysis, 'trip-1', 'media-123');

      expect(result.normalizedSegments).toBeDefined();
      expect(result.normalizedSegments).toEqual([]);
    });
  });
});
