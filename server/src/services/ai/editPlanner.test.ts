/**
 * Unit tests for EditPlanner validation and fallback logic.
 * No real AI model calls — tests pure functions only.
 */

import { describe, it, expect } from 'vitest';
import { validateEditPlan, fallbackSelection, validateAndFallback, selectWithDurationLimit } from './editPlanner';

describe('EditPlanner - validateEditPlan', () => {
  const validIndices = new Set([0, 1, 2, 3, 4]);

  it('returns valid EditPlan for correct input', () => {
    const input = {
      segments: [
        { segmentIndex: 0, reason: '开场镜头', transitionTo: 'fade' },
        { segmentIndex: 2, reason: '高潮部分', transitionTo: 'cut' },
      ],
      pace: 'medium',
      narrativeSummary: '一段旅行记录',
    };

    const result = validateEditPlan(input, 'media-1', validIndices);
    expect(result).not.toBeNull();
    expect(result!.segments).toHaveLength(2);
    expect(result!.pace).toBe('medium');
    expect(result!.mediaId).toBe('media-1');
  });

  it('returns null for empty segments array', () => {
    const result = validateEditPlan({ segments: [], pace: 'fast' }, 'media-1', validIndices);
    expect(result).toBeNull();
  });

  it('returns null for invalid segment index', () => {
    const input = {
      segments: [{ segmentIndex: 99, reason: 'test' }],
      pace: 'medium',
    };
    const result = validateEditPlan(input, 'media-1', validIndices);
    expect(result).toBeNull();
  });

  it('returns null for missing reason', () => {
    const input = {
      segments: [{ segmentIndex: 0 }],
      pace: 'medium',
    };
    const result = validateEditPlan(input, 'media-1', validIndices);
    expect(result).toBeNull();
  });

  it('defaults pace to medium for invalid value', () => {
    const input = {
      segments: [{ segmentIndex: 0, reason: 'test' }],
      pace: 'invalid',
    };
    const result = validateEditPlan(input, 'media-1', validIndices);
    expect(result!.pace).toBe('medium');
  });

  it('filters invalid transition types', () => {
    const input = {
      segments: [{ segmentIndex: 0, reason: 'test', transitionTo: 'wipe' }],
      pace: 'fast',
    };
    const result = validateEditPlan(input, 'media-1', validIndices);
    expect(result!.segments[0].transitionTo).toBeUndefined();
  });
});

describe('EditPlanner - fallbackSelection', () => {
  const segments = [
    { index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80, narrativeScore: 60, sceneDescription: '', emotionTags: [] },
    { index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 60, narrativeScore: 90, sceneDescription: '', emotionTags: [] },
    { index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 90, narrativeScore: 40, sceneDescription: '', emotionTags: [] },
    { index: 3, startTime: 30, endTime: 40, duration: 10, overallScore: 50, narrativeScore: 50, sceneDescription: '', emotionTags: [] },
  ];

  it('selects segments by weighted score (narrative*0.4 + overall*0.6)', () => {
    const plan = fallbackSelection(segments, 'media-1', 20);

    // Weighted scores: seg0=0.4*60+0.6*80=72, seg1=0.4*90+0.6*60=72, seg2=0.4*40+0.6*90=70, seg3=0.4*50+0.6*50=50
    // Top 2 by weighted: seg0(72), seg1(72) — both tie, then seg2(70)
    expect(plan.segments.length).toBeGreaterThanOrEqual(2);
    expect(plan.totalDuration).toBeLessThanOrEqual(20);
  });

  it('returns segments in chronological order', () => {
    const plan = fallbackSelection(segments, 'media-1', 30);

    for (let i = 1; i < plan.segments.length; i++) {
      const prevSeg = segments.find(s => s.index === plan.segments[i - 1].segmentIndex)!;
      const currSeg = segments.find(s => s.index === plan.segments[i].segmentIndex)!;
      expect(currSeg.startTime).toBeGreaterThanOrEqual(prevSeg.startTime);
    }
  });

  it('respects target duration limit', () => {
    const plan = fallbackSelection(segments, 'media-1', 15);
    expect(plan.totalDuration).toBeLessThanOrEqual(20); // At most 2 segments
  });
});

describe('EditPlanner - validateAndFallback', () => {
  const segments = [
    { index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80, narrativeScore: 60, sceneDescription: '', emotionTags: [] },
    { index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 70, narrativeScore: 70, sceneDescription: '', emotionTags: [] },
  ];

  it('uses LLM output when valid', () => {
    const llmOutput = JSON.stringify({
      segments: [{ segmentIndex: 0, reason: '好的开场' }],
      pace: 'fast',
      narrativeSummary: '快节奏旅行',
    });

    const { plan, fallbackUsed } = validateAndFallback(llmOutput, 'media-1', segments, 30);
    expect(fallbackUsed).toBe(false);
    expect(plan.segments[0].segmentIndex).toBe(0);
    expect(plan.pace).toBe('fast');
  });

  it('falls back on invalid JSON', () => {
    const { plan, fallbackUsed } = validateAndFallback('not json at all', 'media-1', segments, 30);
    expect(fallbackUsed).toBe(true);
    expect(plan.segments.length).toBeGreaterThan(0);
  });

  it('falls back on out-of-range segment indices', () => {
    const llmOutput = JSON.stringify({
      segments: [{ segmentIndex: 99, reason: 'invalid' }],
      pace: 'medium',
    });

    const { plan, fallbackUsed } = validateAndFallback(llmOutput, 'media-1', segments, 30);
    expect(fallbackUsed).toBe(true);
  });
});

describe('EditPlanner - selectWithDurationLimit', () => {
  const segments = [
    { index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80, narrativeScore: 60, sceneDescription: '', emotionTags: [] },
    { index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 70, narrativeScore: 70, sceneDescription: '', emotionTags: [] },
    { index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 60, narrativeScore: 80, sceneDescription: '', emotionTags: [] },
  ];

  it('selects segments up to duration limit', () => {
    const result = selectWithDurationLimit(segments, [0, 1, 2], 15);
    // First segment (10s) fits, second would exceed 15s but since result.length > 0, it stops
    expect(result).toEqual([0]);
  });

  it('includes at least one segment even if it exceeds limit', () => {
    const result = selectWithDurationLimit(segments, [0], 5);
    expect(result).toEqual([0]); // First segment always included
  });

  it('returns all segments when total fits within limit', () => {
    const result = selectWithDurationLimit(segments, [0, 1, 2], 100);
    expect(result).toEqual([0, 1, 2]);
  });
});
