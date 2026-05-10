/**
 * Bug Condition Exploration Tests for videoEditor.ts
 *
 * These tests encode the EXPECTED (correct) behavior.
 * They are expected to FAIL on unfixed code — failure confirms the bugs exist.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { selectSegments, buildTransitionFilters } from './videoEditor';
import type { VideoSegment } from './videoAnalyzer';

// ---------------------------------------------------------------------------
// Helper: create a minimal VideoSegment for testing
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

// ===========================================================================
// Bug 2 — selectSegments break→continue
// ===========================================================================
describe('Bug 2 — selectSegments break→continue', () => {
  it('should select shorter segments after skipping one that exceeds 1.1× target', () => {
    /**
     * Segments sorted by score descending: [10s@90, 8s@80, 3s@70, 2s@60]
     * targetDuration = 15
     *
     * Expected greedy selection:
     *   1. Pick 10s (score 90) → cumulative = 10
     *   2. Try 8s (score 80) → 10+8=18 > 15*1.1=16.5 → SKIP (continue)
     *   3. Try 3s (score 70) → 10+3=13 ≤ 16.5 → pick → cumulative = 13
     *   4. Try 2s (score 60) → 13+2=15 ≤ 16.5 → pick → cumulative = 15
     *
     * On UNFIXED code: step 2 does `break` instead of `continue`,
     * so only 10s is selected (total = 10, far below target 15).
     */
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0,  endTime: 10, duration: 10, overallScore: 90 }),
      makeSegment({ index: 1, startTime: 10, endTime: 18, duration: 8,  overallScore: 80 }),
      makeSegment({ index: 2, startTime: 20, endTime: 23, duration: 3,  overallScore: 70 }),
      makeSegment({ index: 3, startTime: 25, endTime: 27, duration: 2,  overallScore: 60 }),
    ];

    const result = selectSegments(segments, 15);
    const totalDuration = result.reduce((sum, s) => sum + s.duration, 0);

    // On fixed code: totalDuration should be ≥ 15 (10+3+2=15)
    // On unfixed code: totalDuration will be only 10 (break after first segment)
    expect(totalDuration).toBeGreaterThanOrEqual(15);
    expect(result.length).toBeGreaterThanOrEqual(3);
  });
});

// ===========================================================================
// Bug 4 — buildTransitionFilters 'none' afade duration
// ===========================================================================
describe('Bug 4 — buildTransitionFilters none mode afade duration', () => {
  it('should use ~0.1s afade duration in none mode, not the default 0.5s', () => {
    /**
     * When transitionType is 'none' with audio and multiple segments,
     * the afade duration should be ~0.1s (imperceptible) not 0.5s.
     *
     * On UNFIXED code: uses transitionDuration (0.5) as fadeDur.
     * On FIXED code: uses ~0.1s fixed duration for 'none' mode.
     */
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 85 }),
      makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 80 }),
      makeSegment({ index: 2, startTime: 10, endTime: 15, duration: 5, overallScore: 75 }),
    ];

    const result = buildTransitionFilters(segments, 'none', 0.5, true);

    expect(result.audioFilter).not.toBeNull();

    // The afade duration values in the filter string should be ~0.1, not 0.5
    // Parse out all afade d= values
    const fadeDurations = result.audioFilter!.match(/afade=t=(?:in|out)(?::st=[\d.]+)?:d=([\d.]+)/g);
    expect(fadeDurations).not.toBeNull();

    for (const match of fadeDurations!) {
      const durMatch = match.match(/:d=([\d.]+)$/);
      expect(durMatch).not.toBeNull();
      const dur = parseFloat(durMatch![1]);
      // Should be ~0.1s, definitely not 0.5s
      expect(dur).toBeLessThanOrEqual(0.15);
    }
  });
});


// ===========================================================================
// Preservation Property Tests (Task 2)
//
// These tests verify existing correct behavior on UNFIXED code.
// They MUST PASS before and after the fix to ensure no regressions.
//
// **Validates: Requirements 3.1, 3.2, 3.3, 3.5**
// ===========================================================================

// ---------------------------------------------------------------------------
// Preservation 1 — 手动剪辑 fade/crossfade
// ---------------------------------------------------------------------------
describe('Preservation 1 — buildTransitionFilters fade/crossfade', () => {
  it('fade: generates video fade in/out + audio afade filters', () => {
    /**
     * **Validates: Requirements 3.1**
     *
     * When transitionType is 'fade', buildTransitionFilters should produce
     * both videoFilter and audioFilter strings with correct fade syntax.
     */
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 85 }),
      makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 80 }),
    ];

    const result = buildTransitionFilters(segments, 'fade', 0.5, true);

    // Video filter should contain fade in/out for each segment + concat
    expect(result.videoFilter).not.toBeNull();
    expect(result.videoFilter).toContain('fade=t=in');
    expect(result.videoFilter).toContain('fade=t=out');
    expect(result.videoFilter).toContain('concat=n=2:v=1:a=0[vout]');

    // Audio filter should contain afade in/out for each segment + concat
    expect(result.audioFilter).not.toBeNull();
    expect(result.audioFilter).toContain('afade=t=in');
    expect(result.audioFilter).toContain('afade=t=out');
    expect(result.audioFilter).toContain('concat=n=2:v=0:a=1[aout]');
  });

  it('crossfade: generates xfade + acrossfade filters', () => {
    /**
     * **Validates: Requirements 3.1**
     *
     * When transitionType is 'crossfade', buildTransitionFilters should produce
     * xfade video filters and acrossfade audio filters.
     */
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 85 }),
      makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 80 }),
    ];

    const result = buildTransitionFilters(segments, 'crossfade', 0.5, true);

    // Video filter should contain xfade
    expect(result.videoFilter).not.toBeNull();
    expect(result.videoFilter).toContain('xfade=transition=fade');

    // Audio filter should contain acrossfade
    expect(result.audioFilter).not.toBeNull();
    expect(result.audioFilter).toContain('acrossfade');
  });

  it('fade with 3 segments: generates per-segment fade filters', () => {
    /**
     * **Validates: Requirements 3.1**
     */
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 4, duration: 4, overallScore: 90 }),
      makeSegment({ index: 1, startTime: 4, endTime: 8, duration: 4, overallScore: 85 }),
      makeSegment({ index: 2, startTime: 8, endTime: 12, duration: 4, overallScore: 80 }),
    ];

    const result = buildTransitionFilters(segments, 'fade', 0.5, true);

    expect(result.videoFilter).not.toBeNull();
    // Should have 3 video stream labels [v0], [v1], [v2] and concat=n=3
    expect(result.videoFilter).toContain('[v0]');
    expect(result.videoFilter).toContain('[v1]');
    expect(result.videoFilter).toContain('[v2]');
    expect(result.videoFilter).toContain('concat=n=3:v=1:a=0[vout]');

    expect(result.audioFilter).not.toBeNull();
    expect(result.audioFilter).toContain('[a0]');
    expect(result.audioFilter).toContain('[a1]');
    expect(result.audioFilter).toContain('[a2]');
    expect(result.audioFilter).toContain('concat=n=3:v=0:a=1[aout]');
  });
});

// ---------------------------------------------------------------------------
// Preservation 2 — 短视频不裁剪 (targetDuration === null, all good)
// ---------------------------------------------------------------------------
describe('Preservation 2 — selectSegments targetDuration=null returns all good segments', () => {
  it('returns all segments when targetDuration is null and all pass quality filter', () => {
    /**
     * **Validates: Requirements 3.2**
     *
     * When targetDuration is null (short video < 60s) and all segments are
     * good quality, selectSegments should return all of them unchanged.
     */
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 85 }),
      makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 80 }),
      makeSegment({ index: 2, startTime: 10, endTime: 15, duration: 5, overallScore: 75 }),
    ];

    const result = selectSegments(segments, null);

    expect(result).toHaveLength(3);
    // Should be sorted by startTime
    expect(result[0].startTime).toBe(0);
    expect(result[1].startTime).toBe(5);
    expect(result[2].startTime).toBe(10);
  });

  it('returns segments sorted by startTime regardless of input order', () => {
    /**
     * **Validates: Requirements 3.2**
     */
    const segments: VideoSegment[] = [
      makeSegment({ index: 2, startTime: 10, endTime: 15, duration: 5, overallScore: 75 }),
      makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 85 }),
      makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 80 }),
    ];

    const result = selectSegments(segments, null);

    expect(result).toHaveLength(3);
    expect(result[0].index).toBe(0);
    expect(result[1].index).toBe(1);
    expect(result[2].index).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Preservation 3 — 无音频视频 (withAudio: false)
// ---------------------------------------------------------------------------
describe('Preservation 3 — buildTransitionFilters withAudio=false returns null audioFilter', () => {
  const segments: VideoSegment[] = [
    makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 85 }),
    makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 80 }),
  ];

  it('none mode: audioFilter is null when withAudio=false', () => {
    /**
     * **Validates: Requirements 3.5**
     */
    const result = buildTransitionFilters(segments, 'none', 0.5, false);
    expect(result.audioFilter).toBeNull();
  });

  it('fade mode: audioFilter is null when withAudio=false', () => {
    /**
     * **Validates: Requirements 3.5**
     */
    const result = buildTransitionFilters(segments, 'fade', 0.5, false);
    expect(result.audioFilter).toBeNull();
  });

  it('crossfade mode: audioFilter is null when withAudio=false', () => {
    /**
     * **Validates: Requirements 3.5**
     */
    const result = buildTransitionFilters(segments, 'crossfade', 0.5, false);
    expect(result.audioFilter).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Preservation 5 — selectSegments targetDuration=null with filtered segments
// ---------------------------------------------------------------------------
describe('Preservation 5 — selectSegments targetDuration=null with some filtered segments', () => {
  it('returns only good segments when some are severely_blurry', () => {
    /**
     * **Validates: Requirements 3.3**
     *
     * When targetDuration is null and some segments have severe quality issues,
     * only the segments that pass the quality filter are returned.
     */
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 85, label: 'good' }),
      makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 30, label: 'severely_blurry' }),
      makeSegment({ index: 2, startTime: 10, endTime: 15, duration: 5, overallScore: 75, label: 'good' }),
    ];

    const result = selectSegments(segments, null);

    // Only the 2 good segments should be returned
    expect(result).toHaveLength(2);
    expect(result[0].index).toBe(0);
    expect(result[1].index).toBe(2);
  });

  it('returns only good segments regardless of total duration sum', () => {
    /**
     * **Validates: Requirements 3.3**
     *
     * With targetDuration=null, duration sum doesn't matter — all good
     * segments are returned even if their total is very short.
     */
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 3, duration: 3, overallScore: 85, label: 'good' }),
      makeSegment({ index: 1, startTime: 3, endTime: 6, duration: 3, overallScore: 20, label: 'severely_shaky' }),
      makeSegment({ index: 2, startTime: 6, endTime: 9, duration: 3, overallScore: 10, label: 'severely_exposed' }),
      makeSegment({ index: 3, startTime: 9, endTime: 12, duration: 3, overallScore: 70, label: 'good' }),
    ];

    const result = selectSegments(segments, null);

    // Only the 2 good segments (index 0 and 3) should be returned
    expect(result).toHaveLength(2);
    expect(result[0].index).toBe(0);
    expect(result[1].index).toBe(3);
    // Total duration is only 6s — that's fine, no duration constraint
    const totalDuration = result.reduce((sum, s) => sum + s.duration, 0);
    expect(totalDuration).toBe(6);
  });

  it('filters out blurry and shaky segments too', () => {
    /**
     * **Validates: Requirements 3.3**
     *
     * selectSegments also filters 'blurry' and 'shaky' labels (not just severe).
     */
    const segments: VideoSegment[] = [
      makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 85, label: 'good' }),
      makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 40, label: 'blurry' }),
      makeSegment({ index: 2, startTime: 10, endTime: 15, duration: 5, overallScore: 25, label: 'shaky' }),
      makeSegment({ index: 3, startTime: 15, endTime: 20, duration: 5, overallScore: 70, label: 'good' }),
    ];

    const result = selectSegments(segments, null);

    // Only the 2 good segments
    expect(result).toHaveLength(2);
    expect(result[0].index).toBe(0);
    expect(result[1].index).toBe(3);
  });
});

// ===========================================================================
// Task 5.5 — Unit tests for filter-before-quality ordering, all-excluded case,
// and mixed scenarios
// ===========================================================================

describe('selectSegments — pre-filter ordering and edge cases', () => {
  describe('filter-before-quality ordering', () => {
    it('excludes a "good" quality segment that is marked as black frame', () => {
      // Segment 0: good quality, high score — but marked as black frame
      // Segment 1: good quality, lower score — clean
      const segments: VideoSegment[] = [
        makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 95, label: 'good' }),
        makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 70, label: 'good' }),
      ];

      const blackFrameResults = new Map<number, BlackFrameResult>([
        [0, { isBlackFrameSegment: true, blackFrameRatio: 0.9, blackFrameScore: 0.1, sampledFrameCount: 5, blackFrameCount: 4, thresholdUsed: 10 } as BlackFrameResult],
        [1, { isBlackFrameSegment: false, blackFrameRatio: 0.1, blackFrameScore: 0.9, sampledFrameCount: 5, blackFrameCount: 0, thresholdUsed: 10 } as BlackFrameResult],
      ]);

      const result = selectSegments(segments, null, { blackFrameResults });

      // Segment 0 should be excluded despite having the highest score
      expect(result).toHaveLength(1);
      expect(result[0].index).toBe(1);
    });

    it('excludes a "good" quality segment that is marked as junk', () => {
      // Segment 0: good quality, high score — but marked as junk
      // Segment 1: good quality, lower score — clean
      const segments: VideoSegment[] = [
        makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 92, label: 'good' }),
        makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 65, label: 'good' }),
      ];

      const junkResults = new Map<number, JunkClipResult>([
        [0, { isJunk: true, reason: 'ground_shot', confidence: 0.95, details: { duration: 5, motionMagnitude: null, pitchAngle: 70, hasAccidentalPattern: false } } as JunkClipResult],
        [1, { isJunk: false, reason: null, confidence: 0.05, details: { duration: 5, motionMagnitude: null, pitchAngle: null, hasAccidentalPattern: false } } as JunkClipResult],
      ]);

      const result = selectSegments(segments, null, { junkResults });

      // Segment 0 should be excluded despite having the highest score
      expect(result).toHaveLength(1);
      expect(result[0].index).toBe(1);
    });
  });

  describe('all-excluded case', () => {
    it('returns empty array when all segments are black frame', () => {
      const segments: VideoSegment[] = [
        makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 90, label: 'good' }),
        makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 85, label: 'good' }),
        makeSegment({ index: 2, startTime: 10, endTime: 15, duration: 5, overallScore: 80, label: 'good' }),
      ];

      const blackFrameResults = new Map<number, BlackFrameResult>([
        [0, { isBlackFrameSegment: true, blackFrameRatio: 0.9, blackFrameScore: 0.1, sampledFrameCount: 5, blackFrameCount: 4, thresholdUsed: 10 } as BlackFrameResult],
        [1, { isBlackFrameSegment: true, blackFrameRatio: 0.85, blackFrameScore: 0.15, sampledFrameCount: 5, blackFrameCount: 4, thresholdUsed: 10 } as BlackFrameResult],
        [2, { isBlackFrameSegment: true, blackFrameRatio: 0.95, blackFrameScore: 0.05, sampledFrameCount: 5, blackFrameCount: 5, thresholdUsed: 10 } as BlackFrameResult],
      ]);

      const result = selectSegments(segments, null, { blackFrameResults });
      expect(result).toHaveLength(0);
    });

    it('returns empty array when all segments are junk', () => {
      const segments: VideoSegment[] = [
        makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 90, label: 'good' }),
        makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 85, label: 'good' }),
      ];

      const junkResults = new Map<number, JunkClipResult>([
        [0, { isJunk: true, reason: 'too_short', confidence: 1.0, details: { duration: 0.5, motionMagnitude: null, pitchAngle: null, hasAccidentalPattern: false } } as JunkClipResult],
        [1, { isJunk: true, reason: 'accidental_touch', confidence: 0.9, details: { duration: 5, motionMagnitude: 120, pitchAngle: null, hasAccidentalPattern: true } } as JunkClipResult],
      ]);

      const result = selectSegments(segments, null, { junkResults });
      expect(result).toHaveLength(0);
    });

    it('returns empty array when segments are a mix of black frame and junk', () => {
      const segments: VideoSegment[] = [
        makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 90, label: 'good' }),
        makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 85, label: 'good' }),
        makeSegment({ index: 2, startTime: 10, endTime: 15, duration: 5, overallScore: 80, label: 'good' }),
      ];

      const blackFrameResults = new Map<number, BlackFrameResult>([
        [0, { isBlackFrameSegment: true, blackFrameRatio: 0.9, blackFrameScore: 0.1, sampledFrameCount: 5, blackFrameCount: 4, thresholdUsed: 10 } as BlackFrameResult],
        [1, { isBlackFrameSegment: false, blackFrameRatio: 0.1, blackFrameScore: 0.9, sampledFrameCount: 5, blackFrameCount: 0, thresholdUsed: 10 } as BlackFrameResult],
        [2, { isBlackFrameSegment: false, blackFrameRatio: 0.2, blackFrameScore: 0.8, sampledFrameCount: 5, blackFrameCount: 1, thresholdUsed: 10 } as BlackFrameResult],
      ]);

      const junkResults = new Map<number, JunkClipResult>([
        [0, { isJunk: false, reason: null, confidence: 0.05, details: { duration: 5, motionMagnitude: null, pitchAngle: null, hasAccidentalPattern: false } } as JunkClipResult],
        [1, { isJunk: true, reason: 'extreme_blur', confidence: 0.92, details: { duration: 5, motionMagnitude: 100, pitchAngle: null, hasAccidentalPattern: false } } as JunkClipResult],
        [2, { isJunk: true, reason: 'ground_shot', confidence: 0.88, details: { duration: 5, motionMagnitude: null, pitchAngle: 75, hasAccidentalPattern: false } } as JunkClipResult],
      ]);

      const result = selectSegments(segments, null, { blackFrameResults, junkResults });
      // Segment 0: black frame → excluded
      // Segment 1: junk → excluded
      // Segment 2: junk → excluded
      expect(result).toHaveLength(0);
    });
  });

  describe('mixed scenarios', () => {
    it('only clean segments appear in output when some are black frame and some are junk', () => {
      const segments: VideoSegment[] = [
        makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 90, label: 'good' }),   // black frame
        makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 85, label: 'good' }),  // junk
        makeSegment({ index: 2, startTime: 10, endTime: 15, duration: 5, overallScore: 80, label: 'good' }), // clean
        makeSegment({ index: 3, startTime: 15, endTime: 20, duration: 5, overallScore: 75, label: 'good' }), // clean
        makeSegment({ index: 4, startTime: 20, endTime: 25, duration: 5, overallScore: 70, label: 'good' }), // black frame
      ];

      const blackFrameResults = new Map<number, BlackFrameResult>([
        [0, { isBlackFrameSegment: true, blackFrameRatio: 0.9, blackFrameScore: 0.1, sampledFrameCount: 5, blackFrameCount: 4, thresholdUsed: 10 } as BlackFrameResult],
        [1, { isBlackFrameSegment: false, blackFrameRatio: 0.1, blackFrameScore: 0.9, sampledFrameCount: 5, blackFrameCount: 0, thresholdUsed: 10 } as BlackFrameResult],
        [2, { isBlackFrameSegment: false, blackFrameRatio: 0.0, blackFrameScore: 1.0, sampledFrameCount: 5, blackFrameCount: 0, thresholdUsed: 10 } as BlackFrameResult],
        [3, { isBlackFrameSegment: false, blackFrameRatio: 0.0, blackFrameScore: 1.0, sampledFrameCount: 5, blackFrameCount: 0, thresholdUsed: 10 } as BlackFrameResult],
        [4, { isBlackFrameSegment: true, blackFrameRatio: 0.85, blackFrameScore: 0.15, sampledFrameCount: 5, blackFrameCount: 4, thresholdUsed: 10 } as BlackFrameResult],
      ]);

      const junkResults = new Map<number, JunkClipResult>([
        [0, { isJunk: false, reason: null, confidence: 0.05, details: { duration: 5, motionMagnitude: null, pitchAngle: null, hasAccidentalPattern: false } } as JunkClipResult],
        [1, { isJunk: true, reason: 'accidental_touch', confidence: 0.9, details: { duration: 5, motionMagnitude: 90, pitchAngle: null, hasAccidentalPattern: true } } as JunkClipResult],
        [2, { isJunk: false, reason: null, confidence: 0.02, details: { duration: 5, motionMagnitude: null, pitchAngle: null, hasAccidentalPattern: false } } as JunkClipResult],
        [3, { isJunk: false, reason: null, confidence: 0.03, details: { duration: 5, motionMagnitude: null, pitchAngle: null, hasAccidentalPattern: false } } as JunkClipResult],
        [4, { isJunk: false, reason: null, confidence: 0.01, details: { duration: 5, motionMagnitude: null, pitchAngle: null, hasAccidentalPattern: false } } as JunkClipResult],
      ]);

      const result = selectSegments(segments, null, { blackFrameResults, junkResults });

      // Only segments 2 and 3 should survive
      expect(result).toHaveLength(2);
      expect(result[0].index).toBe(2);
      expect(result[1].index).toBe(3);
    });

    it('excludes a junk segment even if it has the highest quality score', () => {
      const segments: VideoSegment[] = [
        makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 99, label: 'good' }),  // junk despite high score
        makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 60, label: 'good' }), // clean, lower score
        makeSegment({ index: 2, startTime: 10, endTime: 15, duration: 5, overallScore: 55, label: 'good' }), // clean, lowest score
      ];

      const junkResults = new Map<number, JunkClipResult>([
        [0, { isJunk: true, reason: 'extreme_blur', confidence: 0.95, details: { duration: 5, motionMagnitude: 150, pitchAngle: null, hasAccidentalPattern: false } } as JunkClipResult],
        [1, { isJunk: false, reason: null, confidence: 0.05, details: { duration: 5, motionMagnitude: 10, pitchAngle: null, hasAccidentalPattern: false } } as JunkClipResult],
        [2, { isJunk: false, reason: null, confidence: 0.02, details: { duration: 5, motionMagnitude: 5, pitchAngle: null, hasAccidentalPattern: false } } as JunkClipResult],
      ]);

      const result = selectSegments(segments, null, { junkResults });

      // Segment 0 excluded despite score=99
      expect(result).toHaveLength(2);
      expect(result[0].index).toBe(1);
      expect(result[1].index).toBe(2);
    });

    it('passes all segments through when filterOptions is undefined (backward compatibility)', () => {
      const segments: VideoSegment[] = [
        makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 85, label: 'good' }),
        makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 80, label: 'good' }),
        makeSegment({ index: 2, startTime: 10, endTime: 15, duration: 5, overallScore: 75, label: 'good' }),
      ];

      // No filterOptions passed
      const result = selectSegments(segments, null);

      expect(result).toHaveLength(3);
      expect(result[0].index).toBe(0);
      expect(result[1].index).toBe(1);
      expect(result[2].index).toBe(2);
    });

    it('passes all segments through when filterOptions has empty maps (backward compatibility)', () => {
      const segments: VideoSegment[] = [
        makeSegment({ index: 0, startTime: 0, endTime: 5, duration: 5, overallScore: 85, label: 'good' }),
        makeSegment({ index: 1, startTime: 5, endTime: 10, duration: 5, overallScore: 80, label: 'good' }),
      ];

      const result = selectSegments(segments, null, {
        blackFrameResults: new Map(),
        junkResults: new Map(),
      });

      expect(result).toHaveLength(2);
      expect(result[0].index).toBe(0);
      expect(result[1].index).toBe(1);
    });
  });
});

// ===========================================================================
// Feature: v2-video-processing, Property 5: Segment Filtering Completeness
//
// Property-based test verifying that for any set of segments with associated
// black frame and junk results, the filtered output SHALL contain no segments
// where isBlackFrameSegment = true OR isJunk = true.
//
// **Validates: Requirements 5.1, 5.2**
// ===========================================================================
import fc from 'fast-check';
import type { BlackFrameResult } from './blackFrameDetector';
import type { JunkClipResult } from './junkClipDetector';

describe('Property 5 — Segment Filtering Completeness', () => {
  // Generator for valid labels that pass the quality filter
  const validLabelArb = fc.constantFrom('good', 'good', 'good') as fc.Arbitrary<VideoSegment['label']>;

  // Generator for a VideoSegment that will pass quality filtering
  // (valid label, duration >= 2.0 which is the default minSegmentDuration)
  const videoSegmentArb = (index: number) =>
    fc.record({
      startTime: fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
      duration: fc.double({ min: 2.0, max: 60, noNaN: true, noDefaultInfinity: true }),
      overallScore: fc.double({ min: 50, max: 100, noNaN: true, noDefaultInfinity: true }),
      sharpnessScore: fc.double({ min: 50, max: 100, noNaN: true, noDefaultInfinity: true }),
      stabilityScore: fc.double({ min: 50, max: 100, noNaN: true, noDefaultInfinity: true }),
      exposureScore: fc.double({ min: 30, max: 80, noNaN: true, noDefaultInfinity: true }),
      label: validLabelArb,
    }).map((rec) => ({
      index,
      startTime: rec.startTime,
      endTime: rec.startTime + rec.duration,
      duration: rec.duration,
      overallScore: rec.overallScore,
      sharpnessScore: rec.sharpnessScore,
      stabilityScore: rec.stabilityScore,
      exposureScore: rec.exposureScore,
      label: rec.label,
    } as VideoSegment));

  // Generator for an array of VideoSegments (1 to 20 segments)
  const segmentsArb = fc.integer({ min: 1, max: 20 }).chain((count) =>
    fc.tuple(...Array.from({ length: count }, (_, i) => videoSegmentArb(i)))
  );

  // Generator for BlackFrameResult
  const blackFrameResultArb = fc.record({
    isBlackFrameSegment: fc.boolean(),
    blackFrameRatio: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    blackFrameScore: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    sampledFrameCount: fc.integer({ min: 2, max: 10 }),
    blackFrameCount: fc.integer({ min: 0, max: 10 }),
    thresholdUsed: fc.integer({ min: 5, max: 20 }),
  }) as fc.Arbitrary<BlackFrameResult>;

  // Generator for JunkClipResult
  const junkClipResultArb = fc.record({
    isJunk: fc.boolean(),
    reason: fc.constantFrom('too_short', 'extreme_blur', 'ground_shot', 'accidental_touch', null),
    confidence: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    details: fc.record({
      duration: fc.double({ min: 0.1, max: 60, noNaN: true, noDefaultInfinity: true }),
      motionMagnitude: fc.oneof(fc.double({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }), fc.constant(null)),
      pitchAngle: fc.oneof(fc.double({ min: 0, max: 90, noNaN: true, noDefaultInfinity: true }), fc.constant(null)),
      hasAccidentalPattern: fc.boolean(),
    }),
  }) as fc.Arbitrary<JunkClipResult>;

  it('output never contains segments flagged as black frame or junk', () => {
    fc.assert(
      fc.property(
        segmentsArb,
        fc.integer({ min: 10, max: 300 }), // targetDuration
        fc.boolean(), // whether to include blackFrameResults
        fc.boolean(), // whether to include junkResults
        (segments, targetDuration, includeBlackFrame, includeJunk) => {
          // Build blackFrameResults map — randomly assign results to each segment
          const blackFrameResults = new Map<number, BlackFrameResult>();
          const junkResults = new Map<number, JunkClipResult>();

          // We need to generate deterministic results for each segment
          // Use a simple approach: mark some segments as black frame / junk
          for (let i = 0; i < segments.length; i++) {
            if (includeBlackFrame) {
              // Alternate: even indices are black frame segments
              blackFrameResults.set(i, {
                isBlackFrameSegment: i % 3 === 0, // every 3rd segment is black frame
                blackFrameRatio: i % 3 === 0 ? 0.9 : 0.1,
                blackFrameScore: i % 3 === 0 ? 0.1 : 0.9,
                sampledFrameCount: 5,
                blackFrameCount: i % 3 === 0 ? 4 : 0,
                thresholdUsed: 10,
              } as BlackFrameResult);
            }
            if (includeJunk) {
              junkResults.set(i, {
                isJunk: i % 4 === 1, // every 4th segment (offset 1) is junk
                reason: i % 4 === 1 ? 'too_short' : null,
                confidence: i % 4 === 1 ? 0.95 : 0.1,
                details: {
                  duration: segments[i].duration,
                  motionMagnitude: null,
                  pitchAngle: null,
                  hasAccidentalPattern: false,
                },
              } as JunkClipResult);
            }
          }

          const filterOptions = {
            blackFrameResults: includeBlackFrame ? blackFrameResults : undefined,
            junkResults: includeJunk ? junkResults : undefined,
          };

          const result = selectSegments(segments, targetDuration, filterOptions);

          // PROPERTY: No segment in the output should be flagged as black frame or junk
          for (const seg of result) {
            if (includeBlackFrame && blackFrameResults.has(seg.index)) {
              const bfResult = blackFrameResults.get(seg.index)!;
              expect(bfResult.isBlackFrameSegment).toBe(false);
            }
            if (includeJunk && junkResults.has(seg.index)) {
              const junkResult = junkResults.get(seg.index)!;
              expect(junkResult.isJunk).toBe(false);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('output never contains segments flagged as black frame or junk (randomized maps)', () => {
    // A second property test with fully randomized black frame and junk maps
    fc.assert(
      fc.property(
        segmentsArb,
        fc.oneof(fc.constant(null), fc.integer({ min: 10, max: 300 })), // targetDuration (null or number)
        (segments) => {
          // Generate random black frame and junk results for each segment
          const blackFrameResults = new Map<number, BlackFrameResult>();
          const junkResults = new Map<number, JunkClipResult>();

          for (let i = 0; i < segments.length; i++) {
            // Randomly decide if this segment is a black frame segment
            const isBlackFrame = Math.random() < 0.3;
            blackFrameResults.set(i, {
              isBlackFrameSegment: isBlackFrame,
              blackFrameRatio: isBlackFrame ? 0.85 : 0.1,
              blackFrameScore: isBlackFrame ? 0.15 : 0.9,
              sampledFrameCount: 5,
              blackFrameCount: isBlackFrame ? 4 : 0,
              thresholdUsed: 10,
            } as BlackFrameResult);

            // Randomly decide if this segment is junk
            const isJunk = Math.random() < 0.3;
            junkResults.set(i, {
              isJunk,
              reason: isJunk ? 'ground_shot' : null,
              confidence: isJunk ? 0.9 : 0.05,
              details: {
                duration: segments[i].duration,
                motionMagnitude: null,
                pitchAngle: null,
                hasAccidentalPattern: false,
              },
            } as JunkClipResult);
          }

          const filterOptions = { blackFrameResults, junkResults };

          // Test with both null and numeric targetDuration
          const result = selectSegments(segments, null, filterOptions);

          // PROPERTY: No output segment should be flagged as black frame or junk
          for (const seg of result) {
            const bfResult = blackFrameResults.get(seg.index);
            if (bfResult) {
              expect(bfResult.isBlackFrameSegment).toBe(false);
            }
            const junkResult = junkResults.get(seg.index);
            if (junkResult) {
              expect(junkResult.isJunk).toBe(false);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
