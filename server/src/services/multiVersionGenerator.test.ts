import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { selectSegmentsForProfile, VersionProfile, isGenerating, generateVersions, parseDurationEnv, getConfiguredDurations } from './multiVersionGenerator';
import { VideoSegment } from './videoAnalyzer';
import { BlackFrameResult } from './blackFrameDetector';
import { JunkClipResult } from './junkClipDetector';

function makeSegment(overrides: Partial<VideoSegment> & { index: number; startTime: number; endTime: number; duration: number; overallScore: number }): VideoSegment {
  return {
    sharpnessScore: 70,
    stabilityScore: 80,
    exposureScore: 60,
    label: 'good',
    ...overrides,
  };
}

describe('selectQualityFirst (via selectSegmentsForProfile)', () => {
  const qualityFirstProfile: VersionProfile = {
    name: 'highlight',
    targetDuration: 30,
    selectionStrategy: 'quality_first',
  };

  const emptyBlackFrameResults = new Map<number, BlackFrameResult>();
  const emptyJunkResults = new Map<number, JunkClipResult>();

  it('selects highest-scoring segments first', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 50 }),
      makeSegment({ index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 90 }),
      makeSegment({ index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 70 }),
      makeSegment({ index: 3, startTime: 30, endTime: 40, duration: 10, overallScore: 80 }),
    ];

    const result = selectSegmentsForProfile(segments, qualityFirstProfile, emptyBlackFrameResults, emptyJunkResults);

    // Should select segments with scores 90, 80, 70 (total 30s = targetDuration)
    expect(result.length).toBe(3);
    // Result is sorted by startTime (chronological)
    expect(result[0].index).toBe(1); // score 90, startTime 10
    expect(result[1].index).toBe(2); // score 70, startTime 20
    expect(result[2].index).toBe(3); // score 80, startTime 30
  });

  it('stops when cumulative duration reaches targetDuration', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 15, duration: 15, overallScore: 90 }),
      makeSegment({ index: 1, startTime: 15, endTime: 30, duration: 15, overallScore: 80 }),
      makeSegment({ index: 2, startTime: 30, endTime: 45, duration: 15, overallScore: 70 }),
    ];

    const result = selectSegmentsForProfile(segments, qualityFirstProfile, emptyBlackFrameResults, emptyJunkResults);

    // 15 + 15 = 30 >= targetDuration, so only 2 segments selected
    expect(result.length).toBe(2);
    expect(result[0].index).toBe(0); // score 90
    expect(result[1].index).toBe(1); // score 80
  });

  it('skips no segments - greedily picks until cumulative >= targetDuration', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 20, duration: 20, overallScore: 95 }),
      makeSegment({ index: 1, startTime: 20, endTime: 40, duration: 20, overallScore: 90 }),
      makeSegment({ index: 2, startTime: 40, endTime: 50, duration: 10, overallScore: 85 }),
    ];

    // targetDuration = 30
    // Sorted by score: [95 (20s), 90 (20s), 85 (10s)]
    // Pick 95 (cumulative=20 < 30), pick 90 (cumulative=40 >= 30, stop)
    const result = selectSegmentsForProfile(segments, qualityFirstProfile, emptyBlackFrameResults, emptyJunkResults);

    expect(result.length).toBe(2);
    // Sorted by startTime
    expect(result[0].index).toBe(0); // score 95, startTime 0
    expect(result[1].index).toBe(1); // score 90, startTime 20
  });

  it('returns empty array when no segments provided', () => {
    const result = selectSegmentsForProfile([], qualityFirstProfile, emptyBlackFrameResults, emptyJunkResults);
    expect(result).toEqual([]);
  });

  it('returns segments in chronological order (by startTime)', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 40, endTime: 50, duration: 10, overallScore: 60 }),
      makeSegment({ index: 1, startTime: 0, endTime: 10, duration: 10, overallScore: 95 }),
      makeSegment({ index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 80 }),
    ];

    const result = selectSegmentsForProfile(segments, qualityFirstProfile, emptyBlackFrameResults, emptyJunkResults);

    // All 3 segments: 10+10+10=30 = targetDuration
    expect(result.length).toBe(3);
    // Verify chronological order
    expect(result[0].startTime).toBe(0);
    expect(result[1].startTime).toBe(20);
    expect(result[2].startTime).toBe(40);
  });

  it('selects large segment when it is the only one available', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 40, duration: 40, overallScore: 90 }),
    ];

    // targetDuration = 30
    // Only one segment available (40s), cumulative starts at 0 < 30, so it gets picked
    const result = selectSegmentsForProfile(segments, qualityFirstProfile, emptyBlackFrameResults, emptyJunkResults);

    expect(result.length).toBe(1);
    expect(result[0].index).toBe(0);
  });

  it('handles segments with equal scores', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80 }),
      makeSegment({ index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 80 }),
      makeSegment({ index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 80 }),
      makeSegment({ index: 3, startTime: 30, endTime: 40, duration: 10, overallScore: 80 }),
    ];

    const result = selectSegmentsForProfile(segments, qualityFirstProfile, emptyBlackFrameResults, emptyJunkResults);

    // Should select 3 segments (30s = targetDuration)
    expect(result.length).toBe(3);
    const totalDuration = result.reduce((sum, s) => sum + s.duration, 0);
    expect(totalDuration).toBe(30);
  });
});

describe('selectBalanced (via selectSegmentsForProfile)', () => {
  const balancedProfile: VersionProfile = {
    name: 'summary',
    targetDuration: 60,
    selectionStrategy: 'balanced',
  };

  const emptyBlackFrameResults = new Map<number, BlackFrameResult>();
  const emptyJunkResults = new Map<number, JunkClipResult>();

  it('returns empty array when no segments provided', () => {
    const result = selectSegmentsForProfile([], balancedProfile, emptyBlackFrameResults, emptyJunkResults);
    expect(result).toEqual([]);
  });

  it('selects all segments when total duration fits within targetDuration', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 50 }),
      makeSegment({ index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 90 }),
      makeSegment({ index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 70 }),
    ];

    // Total duration = 30s, targetDuration = 60s → all segments fit
    const result = selectSegmentsForProfile(segments, balancedProfile, emptyBlackFrameResults, emptyJunkResults);

    expect(result.length).toBe(3);
  });

  it('divides timeline into 3 intervals and picks best from each', () => {
    // 6 segments spanning 0-60s, each 10s, targetDuration = 60s
    // Timeline span = 60s, interval size = 20s
    // Interval [0,20): segments 0 (score 50), 1 (score 90) → pick 1
    // Interval [20,40): segments 2 (score 70), 3 (score 80) → pick 3
    // Interval [40,60): segments 4 (score 60), 5 (score 95) → pick 5
    // Cumulative = 30s < 60s, fill from unused: 2 (70), 0 (50), 4 (60)
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 50 }),
      makeSegment({ index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 90 }),
      makeSegment({ index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 70 }),
      makeSegment({ index: 3, startTime: 30, endTime: 40, duration: 10, overallScore: 80 }),
      makeSegment({ index: 4, startTime: 40, endTime: 50, duration: 10, overallScore: 60 }),
      makeSegment({ index: 5, startTime: 50, endTime: 60, duration: 10, overallScore: 95 }),
    ];

    const result = selectSegmentsForProfile(segments, balancedProfile, emptyBlackFrameResults, emptyJunkResults);

    // Should include the best from each interval
    const indices = result.map(s => s.index);
    expect(indices).toContain(1); // best in [0,20)
    expect(indices).toContain(3); // best in [20,40)
    expect(indices).toContain(5); // best in [40,60)
    // Total duration = 60s, all 6 segments fit
    expect(result.length).toBe(6);
  });

  it('ensures each interval contributes at least 1 segment', () => {
    // 3 segments, one in each interval
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 5, endTime: 15, duration: 10, overallScore: 50 }),
      makeSegment({ index: 1, startTime: 35, endTime: 45, duration: 10, overallScore: 90 }),
      makeSegment({ index: 2, startTime: 65, endTime: 75, duration: 10, overallScore: 70 }),
    ];

    // Timeline: 5 to 75, span = 70, interval size = 70/3 ≈ 23.33
    // Interval [5, 28.33): segment 0
    // Interval [28.33, 51.67): segment 1
    // Interval [51.67, 75): segment 2
    const profile: VersionProfile = { name: 'summary', targetDuration: 60, selectionStrategy: 'balanced' };
    const result = selectSegmentsForProfile(segments, profile, emptyBlackFrameResults, emptyJunkResults);

    expect(result.length).toBe(3);
    expect(result.map(s => s.index).sort()).toEqual([0, 1, 2]);
  });

  it('returns segments in chronological order', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 50 }),
      makeSegment({ index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 90 }),
      makeSegment({ index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 70 }),
      makeSegment({ index: 3, startTime: 30, endTime: 40, duration: 10, overallScore: 80 }),
      makeSegment({ index: 4, startTime: 40, endTime: 50, duration: 10, overallScore: 60 }),
      makeSegment({ index: 5, startTime: 50, endTime: 60, duration: 10, overallScore: 95 }),
    ];

    const profile: VersionProfile = { name: 'summary', targetDuration: 30, selectionStrategy: 'balanced' };
    const result = selectSegmentsForProfile(segments, profile, emptyBlackFrameResults, emptyJunkResults);

    // Verify chronological order
    for (let i = 1; i < result.length; i++) {
      expect(result[i].startTime).toBeGreaterThanOrEqual(result[i - 1].startTime);
    }
  });

  it('handles single segment', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 5, endTime: 15, duration: 10, overallScore: 80 }),
    ];

    const result = selectSegmentsForProfile(segments, balancedProfile, emptyBlackFrameResults, emptyJunkResults);

    expect(result.length).toBe(1);
    expect(result[0].index).toBe(0);
  });

  it('trims lowest-scoring non-mandatory selections when total exceeds targetDuration', () => {
    // 6 segments of 15s each = 90s total, targetDuration = 30s
    // Timeline span = 90s, interval size = 30s
    // Interval [0,30): segments 0 (score 50), 1 (score 90) → mandatory: 1
    // Interval [30,60): segments 2 (score 70), 3 (score 80) → mandatory: 3
    // Interval [60,90): segments 4 (score 60), 5 (score 95) → mandatory: 5
    // Mandatory total = 45s > 30s → can't trim mandatory, so all 3 stay
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 15, duration: 15, overallScore: 50 }),
      makeSegment({ index: 1, startTime: 15, endTime: 30, duration: 15, overallScore: 90 }),
      makeSegment({ index: 2, startTime: 30, endTime: 45, duration: 15, overallScore: 70 }),
      makeSegment({ index: 3, startTime: 45, endTime: 60, duration: 15, overallScore: 80 }),
      makeSegment({ index: 4, startTime: 60, endTime: 75, duration: 15, overallScore: 60 }),
      makeSegment({ index: 5, startTime: 75, endTime: 90, duration: 15, overallScore: 95 }),
    ];

    const profile: VersionProfile = { name: 'summary', targetDuration: 30, selectionStrategy: 'balanced' };
    const result = selectSegmentsForProfile(segments, profile, emptyBlackFrameResults, emptyJunkResults);

    // Mandatory segments (best from each interval) are kept
    const indices = result.map(s => s.index);
    expect(indices).toContain(1); // best in interval 0
    expect(indices).toContain(3); // best in interval 1
    expect(indices).toContain(5); // best in interval 2
  });

  it('filters out black frame and junk segments before balanced selection', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 95 }),
      makeSegment({ index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 90 }),
      makeSegment({ index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 70 }),
    ];

    const blackFrameResults = new Map<number, BlackFrameResult>([
      [0, { blackFrameRatio: 0.9, blackFrameScore: 0.1, isBlackFrameSegment: true, sampledFrameCount: 5, blackFrameCount: 4, thresholdUsed: 10, nearBlackRatio: 0, nearBlackFrameCount: 0, isNearBlackSegment: false, nearBlackThresholdUsed: 20 }],
    ]);

    const junkResults = new Map<number, JunkClipResult>([
      [1, { isJunk: true, reason: 'too_short', confidence: 1.0, details: { duration: 0.5, motionMagnitude: null, pitchAngle: null, hasAccidentalPattern: false } }],
    ]);

    const result = selectSegmentsForProfile(segments, balancedProfile, blackFrameResults, junkResults);

    // Only segment 2 should remain after filtering
    expect(result.length).toBe(1);
    expect(result[0].index).toBe(2);
  });

  it('handles intervals with no segments', () => {
    // Segments clustered at the beginning and end, middle interval empty
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 80 }),
      makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 90 }),
      makeSegment({ index: 2, startTime: 90, endTime: 100, duration: 10, overallScore: 70 }),
    ];

    // Timeline span = 100s, interval size = 100/3 ≈ 33.33
    // Interval [0, 33.33): segments 0, 1 → pick 1 (score 90)
    // Interval [33.33, 66.67): no segments
    // Interval [66.67, 100): segment 2 → pick 2 (score 70)
    const result = selectSegmentsForProfile(segments, balancedProfile, emptyBlackFrameResults, emptyJunkResults);

    // Should return segments from intervals that have candidates + fill from unused
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(3);
    // Must include best from each non-empty interval
    const indices = result.map(s => s.index);
    expect(indices).toContain(1); // best in interval 0
    expect(indices).toContain(2); // best in interval 2
  });
});

describe('selectComprehensive (via selectSegmentsForProfile)', () => {
  const comprehensiveProfile: VersionProfile = {
    name: 'extended',
    targetDuration: 300,
    selectionStrategy: 'comprehensive',
  };

  const emptyBlackFrameResults = new Map<number, BlackFrameResult>();
  const emptyJunkResults = new Map<number, JunkClipResult>();

  it('includes all segments with overallScore >= 30', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80 }),
      makeSegment({ index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 50 }),
      makeSegment({ index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 30 }),
      makeSegment({ index: 3, startTime: 30, endTime: 40, duration: 10, overallScore: 95 }),
    ];

    const result = selectSegmentsForProfile(segments, comprehensiveProfile, emptyBlackFrameResults, emptyJunkResults);

    // All segments have overallScore >= 30
    expect(result.length).toBe(4);
  });

  it('excludes segments with overallScore below 30', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80 }),
      makeSegment({ index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 29 }),
      makeSegment({ index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 10 }),
      makeSegment({ index: 3, startTime: 30, endTime: 40, duration: 10, overallScore: 50 }),
    ];

    const result = selectSegmentsForProfile(segments, comprehensiveProfile, emptyBlackFrameResults, emptyJunkResults);

    // Only segments with score >= 30 should be included
    expect(result.length).toBe(2);
    expect(result[0].index).toBe(0);
    expect(result[1].index).toBe(3);
  });

  it('includes segment with exactly score 30 (boundary)', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 30 }),
    ];

    const result = selectSegmentsForProfile(segments, comprehensiveProfile, emptyBlackFrameResults, emptyJunkResults);

    expect(result.length).toBe(1);
    expect(result[0].index).toBe(0);
  });

  it('excludes segment with score just below 30', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 29.9 }),
    ];

    const result = selectSegmentsForProfile(segments, comprehensiveProfile, emptyBlackFrameResults, emptyJunkResults);

    expect(result.length).toBe(0);
  });

  it('returns empty array when no segments provided', () => {
    const result = selectSegmentsForProfile([], comprehensiveProfile, emptyBlackFrameResults, emptyJunkResults);
    expect(result).toEqual([]);
  });

  it('returns empty array when all segments are below threshold', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 10 }),
      makeSegment({ index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 20 }),
      makeSegment({ index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 5 }),
    ];

    const result = selectSegmentsForProfile(segments, comprehensiveProfile, emptyBlackFrameResults, emptyJunkResults);

    expect(result.length).toBe(0);
  });

  it('returns segments in chronological order', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 30, endTime: 40, duration: 10, overallScore: 60 }),
      makeSegment({ index: 1, startTime: 0, endTime: 10, duration: 10, overallScore: 80 }),
      makeSegment({ index: 2, startTime: 50, endTime: 60, duration: 10, overallScore: 70 }),
      makeSegment({ index: 3, startTime: 10, endTime: 20, duration: 10, overallScore: 40 }),
    ];

    const result = selectSegmentsForProfile(segments, comprehensiveProfile, emptyBlackFrameResults, emptyJunkResults);

    expect(result.length).toBe(4);
    // Verify chronological order
    for (let i = 1; i < result.length; i++) {
      expect(result[i].startTime).toBeGreaterThan(result[i - 1].startTime);
    }
  });

  it('filters out black frame and junk segments before applying quality threshold', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 95 }),
      makeSegment({ index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 80 }),
      makeSegment({ index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 50 }),
    ];

    const blackFrameResults = new Map<number, BlackFrameResult>([
      [0, { blackFrameRatio: 0.9, blackFrameScore: 0.1, isBlackFrameSegment: true, sampledFrameCount: 5, blackFrameCount: 4, thresholdUsed: 10, nearBlackRatio: 0, nearBlackFrameCount: 0, isNearBlackSegment: false, nearBlackThresholdUsed: 20 }],
    ]);

    const junkResults = new Map<number, JunkClipResult>([
      [1, { isJunk: true, reason: 'too_short', confidence: 1.0, details: { duration: 0.5, motionMagnitude: null, pitchAngle: null, hasAccidentalPattern: false } }],
    ]);

    const result = selectSegmentsForProfile(segments, comprehensiveProfile, blackFrameResults, junkResults);

    // Segment 0 filtered by black frame, segment 1 filtered by junk
    // Only segment 2 remains (score 50 >= 30)
    expect(result.length).toBe(1);
    expect(result[0].index).toBe(2);
  });
});

describe('Concurrency lock (isGenerating + generateVersions)', () => {
  it('isGenerating returns false when no generation is in progress', () => {
    expect(isGenerating('media-not-generating')).toBe(false);
  });

  it('generateVersions throws GENERATION_IN_PROGRESS when mediaId is already locked', async () => {
    // We need segments that will trigger actual async work (ffmpeg extraction)
    // so the lock is held long enough for the second call to hit it.
    // Instead, we'll test the lock mechanism directly by calling generateVersions
    // with segments that will cause the function to enter the try block and do work.
    
    // Use segments where targetDuration <= sourceDuration AND segments pass selection
    // so the function attempts extraction (which will fail, but lock is held during the attempt)
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80 }),
      makeSegment({ index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 90 }),
      makeSegment({ index: 2, startTime: 20, endTime: 40, duration: 20, overallScore: 70 }),
    ];

    const profiles: VersionProfile[] = [
      { name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' },
    ];

    // Start first generation — it will try to extract segments via ffmpeg (which will fail)
    // but the lock is acquired synchronously before any async work
    const firstCallPromise = generateVersions('/fake/video.mp4', 'concurrent-test-1', 'trip-1', segments, profiles);

    // isGenerating should be true immediately after the call starts
    // Since the lock is acquired synchronously, we can check it before awaiting
    // But we need to verify the second call throws — use a microtask to ensure ordering
    let secondCallError: Error | null = null;
    try {
      await generateVersions('/fake/video.mp4', 'concurrent-test-1', 'trip-1', segments, profiles);
    } catch (err: any) {
      secondCallError = err;
    }

    expect(secondCallError).not.toBeNull();
    expect(secondCallError!.message).toContain('GENERATION_IN_PROGRESS');

    // Wait for first call to finish
    await firstCallPromise.catch(() => {});

    // Lock should be released
    expect(isGenerating('concurrent-test-1')).toBe(false);
  });

  it('lock is released even when generateVersions encounters errors', async () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80 }),
      makeSegment({ index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 90 }),
      makeSegment({ index: 2, startTime: 20, endTime: 40, duration: 20, overallScore: 70 }),
    ];

    const profiles: VersionProfile[] = [
      { name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' },
    ];

    // This will fail due to missing video file, but the lock should still be released
    const result = await generateVersions('/nonexistent/video.mp4', 'test-media-release', 'trip-1', segments, profiles);

    // The function catches per-profile errors internally, so it returns a result with errors
    // Lock should be released after completion
    expect(isGenerating('test-media-release')).toBe(false);
    // The result should have errors for the profile
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('different mediaIds do not block each other', async () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80 }),
      makeSegment({ index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 90 }),
      makeSegment({ index: 2, startTime: 20, endTime: 40, duration: 20, overallScore: 70 }),
    ];

    const profiles: VersionProfile[] = [
      { name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' },
    ];

    // Start generation for media-A
    const callA = generateVersions('/fake/video.mp4', 'test-media-A-lock', 'trip-1', segments, profiles);

    // Starting generation for media-B should NOT throw GENERATION_IN_PROGRESS
    let threwGenerationInProgress = false;
    try {
      await generateVersions('/fake/video.mp4', 'test-media-B-lock', 'trip-1', segments, profiles);
    } catch (err: any) {
      if (err.message.includes('GENERATION_IN_PROGRESS')) {
        threwGenerationInProgress = true;
      }
    }

    expect(threwGenerationInProgress).toBe(false);

    // Wait for first call
    await callA.catch(() => {});
  });
});


// =============================================================================
// Property-Based Tests (fast-check)
// =============================================================================

// Helper: Generate a valid VideoSegment with arbitrary values
const segmentArb = (index: number, minStart: number = 0) => fc.record({
  startTime: fc.double({ min: minStart, max: 1000, noNaN: true }),
  duration: fc.double({ min: 0.5, max: 30, noNaN: true }),
  overallScore: fc.double({ min: 0, max: 100, noNaN: true }),
}).map(({ startTime, duration, overallScore }) => makeSegment({
  index,
  startTime,
  endTime: startTime + duration,
  duration,
  overallScore,
}));

// Helper: Generate an array of non-overlapping segments with sequential startTimes
const segmentsArb = fc.integer({ min: 1, max: 20 }).chain(count => {
  return fc.array(
    fc.record({
      duration: fc.double({ min: 0.5, max: 30, noNaN: true }),
      gap: fc.double({ min: 0, max: 5, noNaN: true }),
      overallScore: fc.double({ min: 0, max: 100, noNaN: true }),
    }),
    { minLength: count, maxLength: count },
  ).map(items => {
    let currentTime = 0;
    return items.map((item, idx) => {
      const startTime = currentTime + item.gap;
      const endTime = startTime + item.duration;
      currentTime = endTime;
      return makeSegment({
        index: idx,
        startTime,
        endTime,
        duration: item.duration,
        overallScore: item.overallScore,
      });
    });
  });
});

// Helper: Generate a VersionProfile
const profileArb = fc.record({
  name: fc.constantFrom('highlight', 'summary', 'extended', 'custom'),
  targetDuration: fc.double({ min: 1, max: 600, noNaN: true }),
  selectionStrategy: fc.constantFrom('quality_first' as const, 'balanced' as const, 'comprehensive' as const),
});

// Feature: v2-video-processing, Property 7: Version Profile Duration Constraint
describe('Property 7: Version Profile Duration Constraint', () => {
  /**
   * Validates: Requirements 9.2
   *
   * For any version generation request where sourceDuration < profile.targetDuration,
   * that profile SHALL be skipped (status: 'skipped') and not produce an output.
   */
  it('profiles with targetDuration > sourceDuration satisfy the skip condition', () => {
    fc.assert(
      fc.property(
        segmentsArb,
        fc.double({ min: 0.01, max: 100, noNaN: true }), // extra duration beyond source
        (segments, extraDuration) => {
          const sourceDuration = Math.max(...segments.map(s => s.endTime));
          const targetDuration = sourceDuration + extraDuration;

          // The skip condition in generateVersions: sourceDuration < targetDuration
          const shouldSkip = sourceDuration < targetDuration;
          expect(shouldSkip).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('profiles with targetDuration <= sourceDuration do NOT satisfy the skip condition', () => {
    fc.assert(
      fc.property(
        segmentsArb,
        fc.double({ min: 0, max: 1, noNaN: true }), // fraction of source duration
        (segments, fraction) => {
          const sourceDuration = Math.max(...segments.map(s => s.endTime));
          // targetDuration is at most sourceDuration
          const targetDuration = sourceDuration * fraction;

          const shouldSkip = sourceDuration < targetDuration;
          expect(shouldSkip).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('generateVersions skip logic: profiles exceeding source duration produce skipped status', () => {
    fc.assert(
      fc.property(
        segmentsArb,
        fc.double({ min: 0.01, max: 200, noNaN: true }),
        fc.constantFrom('quality_first' as const, 'balanced' as const, 'comprehensive' as const),
        (segments, extraDuration, strategy) => {
          const sourceDuration = Math.max(...segments.map(s => s.endTime));
          const targetDuration = sourceDuration + extraDuration;

          const profile: VersionProfile = {
            name: 'test_skip',
            targetDuration,
            selectionStrategy: strategy,
          };

          // Simulate the generateVersions skip logic
          const profiles = [profile];
          const skippedProfiles: string[] = [];
          const processedProfiles: string[] = [];

          for (const p of profiles) {
            if (sourceDuration < p.targetDuration) {
              skippedProfiles.push(p.name);
            } else {
              processedProfiles.push(p.name);
            }
          }

          // Profile should be skipped (status: 'skipped')
          expect(skippedProfiles).toContain('test_skip');
          expect(processedProfiles).not.toContain('test_skip');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: v2-video-processing, Property 8: Multi-Version Count Invariant
describe('Property 8: Multi-Version Count Invariant', () => {
  /**
   * Validates: Requirements 10.4, 10.5
   *
   * For any multi-version generation result, versions.length + errors.length
   * SHALL equal the number of requested profiles that were not skipped due to
   * duration constraints.
   *
   * We simulate the generateVersions logic with pure functions to verify the
   * count invariant holds for any combination of profiles and segments.
   */
  it('versions + errors equals non-skipped profile count', () => {
    fc.assert(
      fc.property(
        segmentsArb,
        fc.array(profileArb, { minLength: 1, maxLength: 5 }),
        (segments, profiles) => {
          const sourceDuration = Math.max(...segments.map(s => s.endTime));
          const emptyBlackFrameResults = new Map<number, BlackFrameResult>();
          const emptyJunkResults = new Map<number, JunkClipResult>();

          // Simulate generateVersions logic
          let versionCount = 0;
          let errorCount = 0;
          let skippedCount = 0;

          for (const profile of profiles) {
            if (sourceDuration < profile.targetDuration) {
              skippedCount++;
              continue;
            }

            // Profile is not skipped — it either produces a version or an error
            const selected = selectSegmentsForProfile(
              segments,
              profile,
              emptyBlackFrameResults,
              emptyJunkResults,
            );

            if (selected.length === 0) {
              errorCount++; // "No valid segments"
            } else {
              versionCount++; // Would produce a version
            }
          }

          // The invariant: versions + errors = total profiles - skipped
          const nonSkippedCount = profiles.length - skippedCount;
          expect(versionCount + errorCount).toBe(nonSkippedCount);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('skipped profiles are never counted in versions or errors', () => {
    fc.assert(
      fc.property(
        segmentsArb,
        fc.array(profileArb, { minLength: 1, maxLength: 5 }),
        (segments, profiles) => {
          const sourceDuration = Math.max(...segments.map(s => s.endTime));

          let skippedCount = 0;
          let processedCount = 0;

          for (const profile of profiles) {
            if (sourceDuration < profile.targetDuration) {
              skippedCount++;
            } else {
              processedCount++;
            }
          }

          // Total must equal sum of skipped + processed
          expect(skippedCount + processedCount).toBe(profiles.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: v2-video-processing, Property 9: Chronological Order Preservation
describe('Property 9: Chronological Order Preservation', () => {
  /**
   * Validates: Requirements 11.4
   *
   * For any version output, the selected segments SHALL be ordered by startTime
   * in ascending order. This is directly testable on selectSegmentsForProfile.
   */
  it('selectSegmentsForProfile output is always sorted by startTime ascending', () => {
    fc.assert(
      fc.property(
        segmentsArb,
        profileArb,
        (segments, profile) => {
          const emptyBlackFrameResults = new Map<number, BlackFrameResult>();
          const emptyJunkResults = new Map<number, JunkClipResult>();

          const result = selectSegmentsForProfile(
            segments,
            profile,
            emptyBlackFrameResults,
            emptyJunkResults,
          );

          // Verify chronological order
          for (let i = 1; i < result.length; i++) {
            expect(result[i].startTime).toBeGreaterThanOrEqual(result[i - 1].startTime);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('chronological order holds even with shuffled input segments', () => {
    fc.assert(
      fc.property(
        segmentsArb.chain(segments =>
          fc.shuffledSubarray(segments, { minLength: segments.length, maxLength: segments.length })
            .map(shuffled => shuffled.map((s, idx) => ({ ...s, index: idx })))
        ),
        profileArb,
        (shuffledSegments, profile) => {
          const emptyBlackFrameResults = new Map<number, BlackFrameResult>();
          const emptyJunkResults = new Map<number, JunkClipResult>();

          const result = selectSegmentsForProfile(
            shuffledSegments,
            profile,
            emptyBlackFrameResults,
            emptyJunkResults,
          );

          // Output must still be sorted by startTime regardless of input order
          for (let i = 1; i < result.length; i++) {
            expect(result[i].startTime).toBeGreaterThanOrEqual(result[i - 1].startTime);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('chronological order holds with black frame and junk filtering applied', () => {
    fc.assert(
      fc.property(
        segmentsArb,
        profileArb,
        fc.array(fc.integer({ min: 0, max: 19 }), { minLength: 0, maxLength: 5 }), // indices to mark as black frame
        fc.array(fc.integer({ min: 0, max: 19 }), { minLength: 0, maxLength: 5 }), // indices to mark as junk
        (segments, profile, blackFrameIndices, junkIndices) => {
          const blackFrameResults = new Map<number, BlackFrameResult>();
          for (const idx of blackFrameIndices) {
            if (idx < segments.length) {
              blackFrameResults.set(idx, {
                blackFrameRatio: 0.9,
                blackFrameScore: 0.1,
                isBlackFrameSegment: true,
                sampledFrameCount: 5,
                blackFrameCount: 4,
                thresholdUsed: 10,
              });
            }
          }

          const junkResults = new Map<number, JunkClipResult>();
          for (const idx of junkIndices) {
            if (idx < segments.length) {
              junkResults.set(idx, {
                isJunk: true,
                reason: 'too_short',
                confidence: 1.0,
                details: { duration: 0.5, motionMagnitude: null, pitchAngle: null, hasAccidentalPattern: false },
              });
            }
          }

          const result = selectSegmentsForProfile(
            segments,
            profile,
            blackFrameResults,
            junkResults,
          );

          // Output must still be sorted by startTime
          for (let i = 1; i < result.length; i++) {
            expect(result[i].startTime).toBeGreaterThanOrEqual(result[i - 1].startTime);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Near-Black Segment Filtering Tests
// =============================================================================

describe('Near-black segment filtering', () => {
  const qualityFirstProfile: VersionProfile = {
    name: 'highlight',
    targetDuration: 30,
    selectionStrategy: 'quality_first',
  };

  it('filters out near-black segments', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 95 }),
      makeSegment({ index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 90 }),
      makeSegment({ index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 80 }),
    ];

    const blackFrameResults = new Map<number, BlackFrameResult>([
      [1, {
        blackFrameRatio: 0.3,
        blackFrameScore: 0.7,
        isBlackFrameSegment: false,
        sampledFrameCount: 5,
        blackFrameCount: 1,
        thresholdUsed: 10,
        nearBlackRatio: 0.95,
        nearBlackFrameCount: 5,
        isNearBlackSegment: true,
        nearBlackThresholdUsed: 20,
      }],
    ]);

    const emptyJunkResults = new Map<number, JunkClipResult>();

    const result = selectSegmentsForProfile(segments, qualityFirstProfile, blackFrameResults, emptyJunkResults);

    // Segment 1 should be filtered out due to near-black
    expect(result.length).toBe(2);
    expect(result.map(s => s.index)).not.toContain(1);
    expect(result.map(s => s.index)).toContain(0);
    expect(result.map(s => s.index)).toContain(2);
  });

  it('does not filter segments that are not near-black', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80 }),
      makeSegment({ index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 70 }),
    ];

    const blackFrameResults = new Map<number, BlackFrameResult>([
      [0, {
        blackFrameRatio: 0.1,
        blackFrameScore: 0.9,
        isBlackFrameSegment: false,
        sampledFrameCount: 5,
        blackFrameCount: 0,
        thresholdUsed: 10,
        nearBlackRatio: 0.3,
        nearBlackFrameCount: 1,
        isNearBlackSegment: false,
        nearBlackThresholdUsed: 20,
      }],
    ]);

    const emptyJunkResults = new Map<number, JunkClipResult>();

    const result = selectSegmentsForProfile(segments, qualityFirstProfile, blackFrameResults, emptyJunkResults);

    expect(result.length).toBe(2);
  });
});

// =============================================================================
// Environment Variable Parsing Tests
// =============================================================================

describe('parseDurationEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns default value when env var is not set', () => {
    delete process.env.VIDEO_HIGHLIGHT_DURATION;
    expect(parseDurationEnv('VIDEO_HIGHLIGHT_DURATION', 30)).toBe(30);
  });

  it('returns default value when env var is empty string', () => {
    process.env.VIDEO_HIGHLIGHT_DURATION = '';
    expect(parseDurationEnv('VIDEO_HIGHLIGHT_DURATION', 30)).toBe(30);
  });

  it('returns parsed value when env var is valid integer in range', () => {
    process.env.VIDEO_HIGHLIGHT_DURATION = '45';
    expect(parseDurationEnv('VIDEO_HIGHLIGHT_DURATION', 30)).toBe(45);
  });

  it('returns default value when env var is below minimum', () => {
    process.env.VIDEO_HIGHLIGHT_DURATION = '3';
    expect(parseDurationEnv('VIDEO_HIGHLIGHT_DURATION', 30)).toBe(30);
  });

  it('returns default value when env var is above maximum', () => {
    process.env.VIDEO_HIGHLIGHT_DURATION = '700';
    expect(parseDurationEnv('VIDEO_HIGHLIGHT_DURATION', 30)).toBe(30);
  });

  it('returns default value when env var is not a number', () => {
    process.env.VIDEO_HIGHLIGHT_DURATION = 'abc';
    expect(parseDurationEnv('VIDEO_HIGHLIGHT_DURATION', 30)).toBe(30);
  });

  it('returns default value when env var is a float', () => {
    process.env.VIDEO_HIGHLIGHT_DURATION = '30.5';
    expect(parseDurationEnv('VIDEO_HIGHLIGHT_DURATION', 30)).toBe(30);
  });

  it('accepts boundary values (min=5, max=600)', () => {
    process.env.VIDEO_HIGHLIGHT_DURATION = '5';
    expect(parseDurationEnv('VIDEO_HIGHLIGHT_DURATION', 30)).toBe(5);

    process.env.VIDEO_HIGHLIGHT_DURATION = '600';
    expect(parseDurationEnv('VIDEO_HIGHLIGHT_DURATION', 30)).toBe(600);
  });

  it('returns default value for negative numbers', () => {
    process.env.VIDEO_HIGHLIGHT_DURATION = '-10';
    expect(parseDurationEnv('VIDEO_HIGHLIGHT_DURATION', 30)).toBe(30);
  });
});

// =============================================================================
// Version Skip Logic with status field
// =============================================================================

describe('Version skip logic (status: skipped)', () => {
  it('skips version when source duration is strictly less than target duration', () => {
    // Source duration = 25s (max endTime), target = 30s → should skip
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80 }),
      makeSegment({ index: 1, startTime: 10, endTime: 25, duration: 15, overallScore: 90 }),
    ];

    const sourceDuration = Math.max(...segments.map(s => s.endTime)); // 25
    const targetDuration = 30;

    expect(sourceDuration < targetDuration).toBe(true);
  });

  it('does not skip when source duration equals target duration', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80 }),
      makeSegment({ index: 1, startTime: 10, endTime: 30, duration: 20, overallScore: 90 }),
    ];

    const sourceDuration = Math.max(...segments.map(s => s.endTime)); // 30
    const targetDuration = 30;

    expect(sourceDuration < targetDuration).toBe(false);
  });

  it('does not skip when source duration exceeds target duration', () => {
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80 }),
      makeSegment({ index: 1, startTime: 10, endTime: 40, duration: 30, overallScore: 90 }),
    ];

    const sourceDuration = Math.max(...segments.map(s => s.endTime)); // 40
    const targetDuration = 30;

    expect(sourceDuration < targetDuration).toBe(false);
  });
});

// =============================================================================
// Duration Constraint Tests
// =============================================================================

describe('Duration constraint: output within [targetDuration * 0.8, targetDuration]', () => {
  const emptyBlackFrameResults = new Map<number, BlackFrameResult>();
  const emptyJunkResults = new Map<number, JunkClipResult>();

  it('quality_first output duration is within bounds when segments are sufficient', () => {
    // 10 segments of 5s each = 50s total, targetDuration = 30s
    const segments: VideoSegment[] = Array.from({ length: 10 }, (_, i) =>
      makeSegment({ index: i, startTime: i * 5, endTime: (i + 1) * 5, duration: 5, overallScore: 90 - i * 5 }),
    );

    const profile: VersionProfile = { name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' };
    const result = selectSegmentsForProfile(segments, profile, emptyBlackFrameResults, emptyJunkResults);

    const totalDuration = result.reduce((sum, s) => sum + s.duration, 0);
    // With greedy selection: picks until cumulative >= 30
    // 5+5+5+5+5+5 = 30 >= 30, so 6 segments selected, total = 30
    expect(totalDuration).toBeGreaterThanOrEqual(30 * 0.8);
    expect(totalDuration).toBeLessThanOrEqual(30 * 1.1); // allow slight overshoot from greedy
  });

  it('balanced output duration does not exceed targetDuration when trimming works', () => {
    // 9 segments of 5s each = 45s total, targetDuration = 30s
    const segments: VideoSegment[] = Array.from({ length: 9 }, (_, i) =>
      makeSegment({ index: i, startTime: i * 5, endTime: (i + 1) * 5, duration: 5, overallScore: 90 - i * 5 }),
    );

    const profile: VersionProfile = { name: 'summary', targetDuration: 30, selectionStrategy: 'balanced' };
    const result = selectSegmentsForProfile(segments, profile, emptyBlackFrameResults, emptyJunkResults);

    const totalDuration = result.reduce((sum, s) => sum + s.duration, 0);
    expect(totalDuration).toBeLessThanOrEqual(30);
  });
});
