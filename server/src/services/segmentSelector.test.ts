/**
 * Unit tests for segmentSelector.ts
 *
 * Tests the core selection logic, target duration calculation,
 * and validation functions.
 */

import { describe, it, expect } from 'vitest';
import {
  selectSegments,
  calculateTargetDuration,
  validateTargetDuration,
  validateSegmentIndices,
  SegmentCandidate,
} from './segmentSelector';

// ---------------------------------------------------------------------------
// Helper to create test segments
// ---------------------------------------------------------------------------

function makeSegment(overrides: Partial<SegmentCandidate> & { index: number }): SegmentCandidate {
  return {
    startTime: overrides.index * 5,
    endTime: overrides.index * 5 + 5,
    duration: 5,
    overallScore: 70,
    label: 'good',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// selectSegments
// ---------------------------------------------------------------------------

describe('selectSegments', () => {
  it('should exclude severely_blurry segments', () => {
    const segments: SegmentCandidate[] = [
      makeSegment({ index: 0, overallScore: 90, label: 'severely_blurry' }),
      makeSegment({ index: 1, overallScore: 80, label: 'good' }),
      makeSegment({ index: 2, overallScore: 70, label: 'good' }),
    ];

    const result = selectSegments(segments, 60);
    expect(result.selectedIndices).not.toContain(0);
    expect(result.skippedCount).toBe(1);
  });

  it('should exclude severely_shaky segments', () => {
    const segments: SegmentCandidate[] = [
      makeSegment({ index: 0, overallScore: 95, label: 'severely_shaky' }),
      makeSegment({ index: 1, overallScore: 60, label: 'good' }),
    ];

    const result = selectSegments(segments, 60);
    expect(result.selectedIndices).not.toContain(0);
    expect(result.selectedIndices).toContain(1);
  });

  it('should exclude severely_exposed segments', () => {
    const segments: SegmentCandidate[] = [
      makeSegment({ index: 0, overallScore: 95, label: 'severely_exposed' }),
      makeSegment({ index: 1, overallScore: 50, label: 'good' }),
    ];

    const result = selectSegments(segments, 60);
    expect(result.selectedIndices).not.toContain(0);
    expect(result.selectedIndices).toContain(1);
  });

  it('should exclude segments with overallScore < 30', () => {
    const segments: SegmentCandidate[] = [
      makeSegment({ index: 0, overallScore: 29, label: 'good' }),
      makeSegment({ index: 1, overallScore: 30, label: 'good' }),
      makeSegment({ index: 2, overallScore: 50, label: 'good' }),
    ];

    const result = selectSegments(segments, 60);
    expect(result.selectedIndices).not.toContain(0);
    expect(result.selectedIndices).toContain(1);
    expect(result.selectedIndices).toContain(2);
  });

  it('should select by overallScore descending (greedy)', () => {
    const segments: SegmentCandidate[] = [
      makeSegment({ index: 0, overallScore: 50, duration: 10 }),
      makeSegment({ index: 1, overallScore: 90, duration: 10 }),
      makeSegment({ index: 2, overallScore: 70, duration: 10 }),
    ];

    // targetDuration = 15, so only 2 segments needed (10+10 >= 15)
    const result = selectSegments(segments, 15);
    // Should pick index 1 (score 90) first, then index 2 (score 70)
    expect(result.selectedIndices).toContain(1);
    expect(result.selectedIndices).toContain(2);
    expect(result.selectedIndices).not.toContain(0);
  });

  it('should stop when cumulative duration reaches targetDuration (last segment allowed to exceed)', () => {
    const segments: SegmentCandidate[] = [
      makeSegment({ index: 0, overallScore: 90, duration: 8, startTime: 0, endTime: 8 }),
      makeSegment({ index: 1, overallScore: 80, duration: 8, startTime: 8, endTime: 16 }),
      makeSegment({ index: 2, overallScore: 70, duration: 8, startTime: 16, endTime: 24 }),
      makeSegment({ index: 3, overallScore: 60, duration: 8, startTime: 24, endTime: 32 }),
    ];

    // targetDuration = 10, first segment (8s) < 10, so pick second (8+8=16 >= 10)
    const result = selectSegments(segments, 10);
    expect(result.selectedIndices.length).toBe(2);
    expect(result.totalDuration).toBe(16);
  });

  it('should select all eligible segments when total duration < targetDuration', () => {
    const segments: SegmentCandidate[] = [
      makeSegment({ index: 0, overallScore: 90, duration: 5 }),
      makeSegment({ index: 1, overallScore: 80, duration: 5 }),
      makeSegment({ index: 2, overallScore: 70, duration: 5 }),
    ];

    // Total eligible duration = 15, targetDuration = 60
    const result = selectSegments(segments, 60);
    expect(result.selectedIndices.length).toBe(3);
    expect(result.totalDuration).toBe(15);
  });

  it('should output segments sorted by startTime ascending', () => {
    const segments: SegmentCandidate[] = [
      makeSegment({ index: 0, overallScore: 50, startTime: 20, endTime: 25, duration: 5 }),
      makeSegment({ index: 1, overallScore: 90, startTime: 10, endTime: 15, duration: 5 }),
      makeSegment({ index: 2, overallScore: 70, startTime: 0, endTime: 5, duration: 5 }),
    ];

    const result = selectSegments(segments, 60);
    // All selected, sorted by startTime: index 2 (0s), index 1 (10s), index 0 (20s)
    expect(result.selectedIndices).toEqual([2, 1, 0]);
  });

  it('should return empty result when all segments are excluded', () => {
    const segments: SegmentCandidate[] = [
      makeSegment({ index: 0, overallScore: 20, label: 'good' }),
      makeSegment({ index: 1, overallScore: 90, label: 'severely_blurry' }),
    ];

    const result = selectSegments(segments, 60);
    expect(result.selectedIndices).toEqual([]);
    expect(result.totalDuration).toBe(0);
    expect(result.skippedCount).toBe(2);
  });

  it('should handle empty input', () => {
    const result = selectSegments([], 60);
    expect(result.selectedIndices).toEqual([]);
    expect(result.totalDuration).toBe(0);
    expect(result.skippedCount).toBe(0);
  });

  describe('adjacency preference', () => {
    it('should prefer adjacent segment when score diff <= 10 and time gap <= 5s', () => {
      // Segment at startTime=0 is selected first (highest score).
      // Next candidates: index 2 (score 85, far away) vs index 1 (score 82, adjacent)
      // Score diff = 85-82 = 3 <= 10, and index 1 is adjacent to index 0
      const segments: SegmentCandidate[] = [
        makeSegment({ index: 0, overallScore: 90, startTime: 0, endTime: 5, duration: 5 }),
        makeSegment({ index: 1, overallScore: 82, startTime: 5, endTime: 10, duration: 5 }),
        makeSegment({ index: 2, overallScore: 85, startTime: 50, endTime: 55, duration: 5 }),
      ];

      // targetDuration = 10, need 2 segments
      const result = selectSegments(segments, 10);
      // Should pick index 0 first (highest), then prefer index 1 (adjacent) over index 2
      expect(result.selectedIndices).toContain(0);
      expect(result.selectedIndices).toContain(1);
      expect(result.selectedIndices).not.toContain(2);
    });

    it('should NOT prefer adjacent segment when score diff > 10', () => {
      const segments: SegmentCandidate[] = [
        makeSegment({ index: 0, overallScore: 90, startTime: 0, endTime: 5, duration: 5 }),
        makeSegment({ index: 1, overallScore: 60, startTime: 5, endTime: 10, duration: 5 }),
        makeSegment({ index: 2, overallScore: 80, startTime: 50, endTime: 55, duration: 5 }),
      ];

      // targetDuration = 10, need 2 segments
      // Score diff between index 2 (80) and index 1 (60) is 20 > 10
      const result = selectSegments(segments, 10);
      expect(result.selectedIndices).toContain(0);
      expect(result.selectedIndices).toContain(2);
      expect(result.selectedIndices).not.toContain(1);
    });

    it('should NOT prefer adjacent segment when time gap > 5s', () => {
      const segments: SegmentCandidate[] = [
        makeSegment({ index: 0, overallScore: 90, startTime: 0, endTime: 5, duration: 5 }),
        makeSegment({ index: 1, overallScore: 82, startTime: 15, endTime: 20, duration: 5 }),
        makeSegment({ index: 2, overallScore: 85, startTime: 50, endTime: 55, duration: 5 }),
      ];

      // targetDuration = 10
      // index 1 has score diff 3 from index 2, but time gap from index 0 is 10s > 5s
      const result = selectSegments(segments, 10);
      expect(result.selectedIndices).toContain(0);
      expect(result.selectedIndices).toContain(2);
    });
  });
});

// ---------------------------------------------------------------------------
// calculateTargetDuration
// ---------------------------------------------------------------------------

describe('calculateTargetDuration', () => {
  it('should return null for videos < 60s', () => {
    expect(calculateTargetDuration(30)).toBeNull();
    expect(calculateTargetDuration(59.9)).toBeNull();
  });

  it('should return 60 for videos between 60s and 600s', () => {
    expect(calculateTargetDuration(60)).toBe(60);
    expect(calculateTargetDuration(300)).toBe(60);
    expect(calculateTargetDuration(600)).toBe(60);
  });

  it('should return 300 for videos > 600s', () => {
    expect(calculateTargetDuration(601)).toBe(300);
    expect(calculateTargetDuration(1200)).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// validateTargetDuration
// ---------------------------------------------------------------------------

describe('validateTargetDuration', () => {
  it('should accept valid values in [10, 600]', () => {
    expect(validateTargetDuration(10)).toEqual({ valid: true });
    expect(validateTargetDuration(60)).toEqual({ valid: true });
    expect(validateTargetDuration(600)).toEqual({ valid: true });
  });

  it('should reject values below 10', () => {
    const result = validateTargetDuration(9);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('10');
  });

  it('should reject values above 600', () => {
    const result = validateTargetDuration(601);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('600');
  });

  it('should reject non-integers', () => {
    const result = validateTargetDuration(10.5);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('integer');
  });

  it('should reject null/undefined', () => {
    expect(validateTargetDuration(null).valid).toBe(false);
    expect(validateTargetDuration(undefined).valid).toBe(false);
  });

  it('should reject non-numeric values', () => {
    expect(validateTargetDuration('abc').valid).toBe(false);
    expect(validateTargetDuration({}).valid).toBe(false);
  });

  it('should accept numeric strings that parse to valid integers', () => {
    expect(validateTargetDuration('60').valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateSegmentIndices
// ---------------------------------------------------------------------------

describe('validateSegmentIndices', () => {
  it('should accept valid indices within range', () => {
    expect(validateSegmentIndices([0, 1, 2], 5)).toEqual({ valid: true });
    expect(validateSegmentIndices([0], 0)).toEqual({ valid: true });
    expect(validateSegmentIndices([5], 5)).toEqual({ valid: true });
  });

  it('should reject empty array', () => {
    const result = validateSegmentIndices([], 5);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('empty');
  });

  it('should reject non-array', () => {
    expect(validateSegmentIndices('not-array', 5).valid).toBe(false);
    expect(validateSegmentIndices(123, 5).valid).toBe(false);
    expect(validateSegmentIndices(null, 5).valid).toBe(false);
  });

  it('should reject indices out of range', () => {
    const result = validateSegmentIndices([0, 6], 5);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('out of range');
  });

  it('should reject negative indices', () => {
    const result = validateSegmentIndices([-1, 0], 5);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('out of range');
  });

  it('should reject non-integer indices', () => {
    const result = validateSegmentIndices([1.5], 5);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('integer');
  });
});
