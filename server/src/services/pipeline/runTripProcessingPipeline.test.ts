import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PipelineStage } from './types';

// ---- Hoisted mock functions ----
const {
  mockDownloadToTemp,
  mockSave,
  mockAnalyzeVideo,
  mockEditVideo,
  mockDetectBlackFrames,
  mockDetectJunkClip,
  mockGenerateVersions,
  mockAnalyzeTrip,
  mockOptimizeTrip,
  mockGenerateThumbnailsForTrip,
  mockSelectCoverImage,
  mockIsPythonAvailable,
  mockAnalyzeImages,
  mockAssessClassification,
  mockComputeSharpness,
  mockAssessBlur,
  mockAssessDedup,
} = vi.hoisted(() => ({
  mockDownloadToTemp: vi.fn(),
  mockSave: vi.fn(),
  mockAnalyzeVideo: vi.fn(),
  mockEditVideo: vi.fn(),
  mockDetectBlackFrames: vi.fn(),
  mockDetectJunkClip: vi.fn(),
  mockGenerateVersions: vi.fn(),
  mockAnalyzeTrip: vi.fn(),
  mockOptimizeTrip: vi.fn(),
  mockGenerateThumbnailsForTrip: vi.fn(),
  mockSelectCoverImage: vi.fn(),
  mockIsPythonAvailable: vi.fn(),
  mockAnalyzeImages: vi.fn(),
  mockAssessClassification: vi.fn(),
  mockComputeSharpness: vi.fn(),
  mockAssessBlur: vi.fn(),
  mockAssessDedup: vi.fn(),
}));

// ---- Mock external dependencies ----

vi.mock('../../storage/factory', () => ({
  getStorageProvider: () => ({
    downloadToTemp: mockDownloadToTemp,
    save: mockSave,
  }),
}));

vi.mock('../videoAnalyzer', () => ({
  analyzeVideo: mockAnalyzeVideo,
  VideoSegment: {},
}));

vi.mock('../videoEditor', () => ({
  editVideo: mockEditVideo,
}));

vi.mock('../blackFrameDetector', () => ({
  detectBlackFrames: mockDetectBlackFrames,
}));

vi.mock('../junkClipDetector', () => ({
  detectJunkClip: mockDetectJunkClip,
}));

vi.mock('../multiVersionGenerator', () => ({
  generateVersions: mockGenerateVersions,
  DEFAULT_PROFILES: {
    highlight: { name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' },
    summary: { name: 'summary', targetDuration: 60, selectionStrategy: 'balanced' },
    full_edit: { name: 'full_edit', targetDuration: 300, selectionStrategy: 'comprehensive' },
  },
}));

vi.mock('../imageAnalyzer', () => ({
  analyzeTrip: mockAnalyzeTrip,
}));

vi.mock('../imageOptimizer', () => ({
  optimizeTrip: mockOptimizeTrip,
}));

vi.mock('../thumbnailGenerator', () => ({
  generateThumbnailsForTrip: mockGenerateThumbnailsForTrip,
}));

vi.mock('../coverSelector', () => ({
  selectCoverImage: mockSelectCoverImage,
}));

vi.mock('../pythonAnalyzer', () => ({
  isPythonAvailable: mockIsPythonAvailable,
  analyzeImages: mockAnalyzeImages,
}));

vi.mock('../imageClassifier', () => ({
  assessClassification: mockAssessClassification,
}));

vi.mock('../blurDetector', () => ({
  computeSharpness: mockComputeSharpness,
  assessBlur: mockAssessBlur,
}));

vi.mock('../hybridDedupEngine', () => ({
  assessDedup: mockAssessDedup,
  PROCESS_THRESHOLDS: { minImagesForDedup: 2 },
}));

vi.mock('../dedupThresholds', () => ({
  PROCESS_THRESHOLDS: { minImagesForDedup: 2 },
}));

// Mock fs to avoid real file system operations in collectInputs
vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn().mockReturnValue(Buffer.from('fake')),
      existsSync: vi.fn().mockReturnValue(true),
      mkdtempSync: vi.fn().mockReturnValue('/tmp/test'),
      mkdirSync: vi.fn(),
      rmSync: vi.fn(),
      unlinkSync: vi.fn(),
      accessSync: vi.fn(),
    },
  };
});

import { getDb, closeDb } from '../../database';
import { runTripProcessingPipeline } from './runTripProcessingPipeline';

// ---- Test helpers ----

function setupTestData(tripId: string, videoCount: number, imageCount: number = 0) {
  const db = getDb();
  const now = new Date().toISOString();

  // Create trip
  db.prepare(
    `INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
  ).run(tripId, 'Test Trip', now, now);

  // Create video media items
  for (let i = 0; i < videoCount; i++) {
    const mediaId = `video-${i}`;
    db.prepare(
      `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, created_at)
       VALUES (?, ?, ?, 'video', 'video/mp4', ?, 1024, 'active', ?)`
    ).run(mediaId, tripId, `${tripId}/originals/${mediaId}.mp4`, `video_${i}.mp4`, now);

    // Create video segments for each video
    for (let s = 0; s < 3; s++) {
      db.prepare(
        `INSERT INTO video_segments (id, media_id, segment_index, start_time, end_time, duration, sharpness_score, stability_score, exposure_score, overall_score, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 70, 80, 75, 75, 'good', ?)`
      ).run(`seg-${mediaId}-${s}`, mediaId, s, s * 10, (s + 1) * 10, 10, now);
    }
  }

  // Create image media items
  for (let i = 0; i < imageCount; i++) {
    const mediaId = `image-${i}`;
    db.prepare(
      `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, created_at)
       VALUES (?, ?, ?, 'image', 'image/jpeg', ?, 2048, 'active', ?)`
    ).run(mediaId, tripId, `${tripId}/originals/${mediaId}.jpg`, `image_${i}.jpg`, now);
  }
}

function setupDefaultMocks() {
  // Storage
  mockDownloadToTemp.mockResolvedValue('/tmp/fake-video.mp4');
  mockSave.mockResolvedValue(undefined);

  // Python / classification / blur — not needed for video-focused tests but pipeline calls them
  mockIsPythonAvailable.mockReturnValue(false);
  mockAssessClassification.mockResolvedValue({
    category: 'landscape',
    categoryScores: null,
    source: 'fallback',
  });
  mockAssessBlur.mockResolvedValue({
    sharpnessScore: 80,
    blurStatus: 'clear',
    musiqScore: null,
    source: 'node',
  });
  mockAssessDedup.mockResolvedValue({
    confirmedPairs: [],
    groups: [],
    kept: [],
    removed: [],
    skippedIndices: [],
    skippedReasons: {},
    capabilitiesUsed: { hash: false, clip: false, dinov2: false, llm: false },
    evidenceByPair: [],
  });

  // Image post-processing stages
  mockAnalyzeTrip.mockResolvedValue(undefined);
  mockOptimizeTrip.mockResolvedValue([]);
  mockGenerateThumbnailsForTrip.mockResolvedValue(undefined);
  mockSelectCoverImage.mockResolvedValue('cover-id');

  // Video analysis + editing
  mockAnalyzeVideo.mockResolvedValue({
    mediaId: 'video-0',
    duration: 30,
    segments: [
      { index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 75, sharpnessScore: 70, stabilityScore: 80, exposureScore: 75, label: 'good' },
      { index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 75, sharpnessScore: 70, stabilityScore: 80, exposureScore: 75, label: 'good' },
      { index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 75, sharpnessScore: 70, stabilityScore: 80, exposureScore: 75, label: 'good' },
    ],
  });
  mockEditVideo.mockResolvedValue({
    mediaId: 'video-0',
    compiledPath: 'trip-1/compiled/video-0_compiled.mp4',
    selectedSegments: [0, 1, 2],
    segmentDetails: [],
  });

  // Video enhancement
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
    mediaId: 'video-0',
    versions: [
      { versionId: 'v-1', profile: { name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' }, filePath: 'path/v1.mp4', duration: 28, segmentCount: 3, fileSize: 5000000 },
    ],
    errors: [],
  });
}

describe('runTripProcessingPipeline integration', () => {
  beforeEach(() => {
    const db = getDb();
    db.pragma('foreign_keys = OFF');
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM media_analysis');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM trips');
    db.pragma('foreign_keys = ON');

    setupDefaultMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Stage ordering', () => {
    it('should run videoEnhance stage (with sub-stages) after videoEdit and before cover', async () => {
      setupTestData('trip-1', 1);

      const stageLog: Array<{ stage: PipelineStage; status: string }> = [];
      const onProgress = (stage: PipelineStage, status: 'start' | 'complete' | 'progress', detail?: string) => {
        stageLog.push({ stage, status });
      };

      await runTripProcessingPipeline('trip-1', { onProgress });

      // Extract stage names in order of 'start' events
      const startedStages = stageLog
        .filter(e => e.status === 'start')
        .map(e => e.stage);

      // Verify videoEdit comes before videoEnhance
      const videoEditIdx = startedStages.indexOf('videoEdit');
      const videoEnhanceIdx = startedStages.indexOf('videoEnhance');
      expect(videoEditIdx).toBeGreaterThanOrEqual(0);
      expect(videoEnhanceIdx).toBeGreaterThan(videoEditIdx);

      // Verify sub-stages appear after videoEnhance start
      const blackFrameIdx = startedStages.indexOf('blackFrameDetect');
      const junkDetectIdx = startedStages.indexOf('junkDetect');
      const versionGenerateIdx = startedStages.indexOf('versionGenerate');
      expect(blackFrameIdx).toBeGreaterThan(videoEnhanceIdx);
      expect(junkDetectIdx).toBeGreaterThan(blackFrameIdx);
      expect(versionGenerateIdx).toBeGreaterThan(junkDetectIdx);

      // Verify cover comes after videoEnhance completes
      const videoEnhanceCompleteIdx = stageLog.findIndex(
        e => e.stage === 'videoEnhance' && e.status === 'complete'
      );
      const coverStartIdx = stageLog.findIndex(
        e => e.stage === 'cover' && e.status === 'start'
      );
      expect(coverStartIdx).toBeGreaterThan(videoEnhanceCompleteIdx);
    });

    it('should include the full expected stage sequence in onProgress calls', async () => {
      setupTestData('trip-1', 1);

      const stageLog: Array<{ stage: PipelineStage; status: string }> = [];
      const onProgress = (stage: PipelineStage, status: 'start' | 'complete' | 'progress', detail?: string) => {
        stageLog.push({ stage, status });
      };

      await runTripProcessingPipeline('trip-1', { onProgress });

      const startedStages = stageLog
        .filter(e => e.status === 'start')
        .map(e => e.stage);

      // The expected order of stages that must appear
      const expectedOrder: PipelineStage[] = [
        'collectInputs',
        'classify',
        'blur',
        'dedup',
        'reduce',
        'write',
        'analyze',
        'optimize',
        'thumbnail',
        'videoAnalysis',
        'videoEdit',
        'videoEnhance',
        'blackFrameDetect',
        'junkDetect',
        'versionGenerate',
        'cover',
      ];

      // Verify all expected stages appear in order
      let lastIdx = -1;
      for (const stage of expectedOrder) {
        const idx = startedStages.indexOf(stage, lastIdx + 1);
        expect(idx, `Expected stage '${stage}' to appear after index ${lastIdx}`).toBeGreaterThan(lastIdx);
        lastIdx = idx;
      }
    });
  });

  describe('Error resilience', () => {
    it('should continue processing other videos when one video enhancement fails', async () => {
      setupTestData('trip-1', 2);

      // Make detectBlackFrames throw for the first video only
      let callCount = 0;
      mockDetectBlackFrames.mockImplementation(async () => {
        callCount++;
        // First 3 calls are for video-0 (3 segments), throw on all of them
        if (callCount <= 3) {
          throw new Error('FFmpeg black frame detection failed');
        }
        return {
          blackFrameRatio: 0.0,
          blackFrameScore: 1.0,
          isBlackFrameSegment: false,
          sampledFrameCount: 5,
          blackFrameCount: 0,
          thresholdUsed: 10,
        };
      });

      // Make generateVersions succeed for both (the pipeline catches per-video errors)
      mockGenerateVersions
        .mockRejectedValueOnce(new Error('Enhancement failed for video-0'))
        .mockResolvedValueOnce({
          mediaId: 'video-1',
          versions: [{ versionId: 'v-2', profile: { name: 'highlight' }, filePath: 'path/v2.mp4', duration: 28, segmentCount: 3, fileSize: 5000000 }],
          errors: [],
        });

      const stageLog: Array<{ stage: PipelineStage; status: string }> = [];
      const onProgress = (stage: PipelineStage, status: 'start' | 'complete' | 'progress', detail?: string) => {
        stageLog.push({ stage, status });
      };

      // Pipeline should NOT throw
      const result = await runTripProcessingPipeline('trip-1', { onProgress });

      // Pipeline completes and returns a result
      expect(result).toBeDefined();
      expect(result.tripId).toBe('trip-1');
      expect(result.totalVideos).toBe(2);

      // videoEnhance stage still completes
      const videoEnhanceComplete = stageLog.find(
        e => e.stage === 'videoEnhance' && e.status === 'complete'
      );
      expect(videoEnhanceComplete).toBeDefined();

      // cover stage still runs after videoEnhance
      const coverStart = stageLog.find(e => e.stage === 'cover' && e.status === 'start');
      expect(coverStart).toBeDefined();
    });

    it('should not throw when all video enhancements fail', async () => {
      setupTestData('trip-1', 2);

      // Make generateVersions throw for all videos
      mockGenerateVersions.mockRejectedValue(new Error('All enhancements failed'));

      const stageLog: Array<{ stage: PipelineStage; status: string }> = [];
      const onProgress = (stage: PipelineStage, status: 'start' | 'complete' | 'progress', detail?: string) => {
        stageLog.push({ stage, status });
      };

      // Pipeline should NOT throw even when all enhancements fail
      const result = await runTripProcessingPipeline('trip-1', { onProgress });

      expect(result).toBeDefined();
      expect(result.tripId).toBe('trip-1');

      // videoEnhance stage still completes
      const videoEnhanceComplete = stageLog.find(
        e => e.stage === 'videoEnhance' && e.status === 'complete'
      );
      expect(videoEnhanceComplete).toBeDefined();

      // cover stage still runs
      const coverStart = stageLog.find(e => e.stage === 'cover' && e.status === 'start');
      expect(coverStart).toBeDefined();
    });

    it('should still complete subsequent stages when detectBlackFrames throws for individual segments', async () => {
      setupTestData('trip-1', 1);

      // Make detectBlackFrames throw for some segments
      mockDetectBlackFrames
        .mockRejectedValueOnce(new Error('Frame extraction failed'))
        .mockResolvedValueOnce({
          blackFrameRatio: 0.0,
          blackFrameScore: 1.0,
          isBlackFrameSegment: false,
          sampledFrameCount: 5,
          blackFrameCount: 0,
          thresholdUsed: 10,
        })
        .mockRejectedValueOnce(new Error('Frame extraction failed'));

      const stageLog: Array<{ stage: PipelineStage; status: string }> = [];
      const onProgress = (stage: PipelineStage, status: 'start' | 'complete' | 'progress', detail?: string) => {
        stageLog.push({ stage, status });
      };

      const result = await runTripProcessingPipeline('trip-1', { onProgress });

      expect(result).toBeDefined();

      // junkDetect should still run after blackFrameDetect
      const junkStart = stageLog.find(e => e.stage === 'junkDetect' && e.status === 'start');
      expect(junkStart).toBeDefined();

      // versionGenerate should still run
      const versionStart = stageLog.find(e => e.stage === 'versionGenerate' && e.status === 'start');
      expect(versionStart).toBeDefined();

      // cover should still run
      const coverStart = stageLog.find(e => e.stage === 'cover' && e.status === 'start');
      expect(coverStart).toBeDefined();
    });
  });
});
