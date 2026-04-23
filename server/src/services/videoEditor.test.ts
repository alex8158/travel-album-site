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
