import { describe, it, expect } from 'vitest';
import {
  deriveVLMStatus,
  createVLMCallStatsTracker,
  recordVLMSuccess,
  recordVLMFailure,
  recordVLMSkippedStage,
  buildVLMDiagnostic,
  VLMCallStats,
} from './types';

describe('deriveVLMStatus', () => {
  function makeStats(overrides: Partial<VLMCallStats> = {}): VLMCallStats {
    return {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      parseFailures: 0,
      timeoutFailures: 0,
      providerAuthFailures: 0,
      skippedStages: [],
      stageStats: {},
      diagnostic: '',
      ...overrides,
    };
  }

  it('returns "disabled" when vlmEnabled is false regardless of other state', () => {
    const stats = makeStats({ totalCalls: 5, successfulCalls: 5 });
    expect(deriveVLMStatus(stats, false, true)).toBe('disabled');
    expect(deriveVLMStatus(stats, false, false)).toBe('disabled');
  });

  it('returns "not_configured" when vlmAvailable is false and vlmEnabled is true', () => {
    const stats = makeStats({ totalCalls: 5, successfulCalls: 5 });
    expect(deriveVLMStatus(stats, true, false)).toBe('not_configured');
  });

  it('returns "skipped" when totalCalls is 0 and VLM is enabled and available', () => {
    const stats = makeStats();
    expect(deriveVLMStatus(stats, true, true)).toBe('skipped');
  });

  it('returns "success" when all calls succeeded', () => {
    const stats = makeStats({ totalCalls: 5, successfulCalls: 5, failedCalls: 0 });
    expect(deriveVLMStatus(stats, true, true)).toBe('success');
  });

  it('returns "partial_failure" when some calls succeeded and some failed', () => {
    const stats = makeStats({ totalCalls: 5, successfulCalls: 3, failedCalls: 2 });
    expect(deriveVLMStatus(stats, true, true)).toBe('partial_failure');
  });

  it('returns "failed" when all calls failed', () => {
    const stats = makeStats({ totalCalls: 3, successfulCalls: 0, failedCalls: 3 });
    expect(deriveVLMStatus(stats, true, true)).toBe('failed');
  });

  it('priority: disabled > not_configured', () => {
    // Even if not available, disabled takes precedence
    const stats = makeStats();
    expect(deriveVLMStatus(stats, false, false)).toBe('disabled');
  });

  it('priority: not_configured > skipped', () => {
    const stats = makeStats(); // 0 calls
    expect(deriveVLMStatus(stats, true, false)).toBe('not_configured');
  });
});

describe('createVLMCallStatsTracker', () => {
  it('creates a tracker with all counters at zero', () => {
    const tracker = createVLMCallStatsTracker();
    expect(tracker.totalCalls).toBe(0);
    expect(tracker.successfulCalls).toBe(0);
    expect(tracker.failedCalls).toBe(0);
    expect(tracker.parseFailures).toBe(0);
    expect(tracker.timeoutFailures).toBe(0);
    expect(tracker.providerAuthFailures).toBe(0);
    expect(tracker.skippedStages).toEqual([]);
    expect(tracker.stageStats).toEqual({});
    expect(tracker.diagnostic).toBe('');
  });
});

describe('recordVLMSuccess', () => {
  it('increments totalCalls and successfulCalls', () => {
    const tracker = createVLMCallStatsTracker();
    recordVLMSuccess(tracker, 'aiReview');
    expect(tracker.totalCalls).toBe(1);
    expect(tracker.successfulCalls).toBe(1);
    expect(tracker.failedCalls).toBe(0);
  });

  it('tracks per-stage stats', () => {
    const tracker = createVLMCallStatsTracker();
    recordVLMSuccess(tracker, 'aiReview');
    recordVLMSuccess(tracker, 'aiReview');
    recordVLMSuccess(tracker, 'sceneDedup');
    expect(tracker.stageStats['aiReview']).toEqual({ calls: 2, successes: 2, failures: 0 });
    expect(tracker.stageStats['sceneDedup']).toEqual({ calls: 1, successes: 1, failures: 0 });
  });
});

describe('recordVLMFailure', () => {
  it('increments totalCalls and failedCalls', () => {
    const tracker = createVLMCallStatsTracker();
    recordVLMFailure(tracker, 'aiReview', 'timeout');
    expect(tracker.totalCalls).toBe(1);
    expect(tracker.failedCalls).toBe(1);
    expect(tracker.successfulCalls).toBe(0);
  });

  it('tracks parse failures', () => {
    const tracker = createVLMCallStatsTracker();
    recordVLMFailure(tracker, 'aiReview', 'parse');
    expect(tracker.parseFailures).toBe(1);
    expect(tracker.timeoutFailures).toBe(0);
    expect(tracker.providerAuthFailures).toBe(0);
  });

  it('tracks timeout failures', () => {
    const tracker = createVLMCallStatsTracker();
    recordVLMFailure(tracker, 'aiReview', 'timeout');
    expect(tracker.timeoutFailures).toBe(1);
  });

  it('tracks auth failures', () => {
    const tracker = createVLMCallStatsTracker();
    recordVLMFailure(tracker, 'aiReview', 'auth');
    expect(tracker.providerAuthFailures).toBe(1);
  });

  it('tracks "other" failures without incrementing specific counters', () => {
    const tracker = createVLMCallStatsTracker();
    recordVLMFailure(tracker, 'aiReview', 'other');
    expect(tracker.failedCalls).toBe(1);
    expect(tracker.parseFailures).toBe(0);
    expect(tracker.timeoutFailures).toBe(0);
    expect(tracker.providerAuthFailures).toBe(0);
  });

  it('tracks per-stage failure stats', () => {
    const tracker = createVLMCallStatsTracker();
    recordVLMFailure(tracker, 'sceneDedup', 'timeout');
    recordVLMFailure(tracker, 'sceneDedup', 'parse');
    expect(tracker.stageStats['sceneDedup']).toEqual({ calls: 2, successes: 0, failures: 2 });
  });
});

describe('recordVLMSkippedStage', () => {
  it('adds stage to skippedStages', () => {
    const tracker = createVLMCallStatsTracker();
    recordVLMSkippedStage(tracker, 'aiReview');
    expect(tracker.skippedStages).toEqual(['aiReview']);
  });

  it('does not add duplicate stages', () => {
    const tracker = createVLMCallStatsTracker();
    recordVLMSkippedStage(tracker, 'aiReview');
    recordVLMSkippedStage(tracker, 'aiReview');
    expect(tracker.skippedStages).toEqual(['aiReview']);
  });

  it('adds multiple different stages', () => {
    const tracker = createVLMCallStatsTracker();
    recordVLMSkippedStage(tracker, 'aiReview');
    recordVLMSkippedStage(tracker, 'sceneDedup');
    expect(tracker.skippedStages).toEqual(['aiReview', 'sceneDedup']);
  });
});

describe('buildVLMDiagnostic', () => {
  it('returns disabled message when vlmEnabled is false', () => {
    const stats = createVLMCallStatsTracker();
    const diag = buildVLMDiagnostic(stats, false, true);
    expect(diag).toContain('disabled');
  });

  it('returns not configured message when vlmAvailable is false', () => {
    const stats = createVLMCallStatsTracker();
    const diag = buildVLMDiagnostic(stats, true, false);
    expect(diag).toContain('No VLM provider configured');
  });

  it('returns skipped stages info when no calls made', () => {
    const stats = createVLMCallStatsTracker();
    stats.skippedStages = ['aiReview', 'sceneDedup'];
    const diag = buildVLMDiagnostic(stats, true, true);
    expect(diag).toContain('aiReview');
    expect(diag).toContain('sceneDedup');
  });

  it('returns call ratio when calls were made', () => {
    const stats = createVLMCallStatsTracker();
    stats.totalCalls = 5;
    stats.successfulCalls = 3;
    stats.failedCalls = 2;
    stats.timeoutFailures = 2;
    const diag = buildVLMDiagnostic(stats, true, true);
    expect(diag).toContain('3/5 calls succeeded');
    expect(diag).toContain('2 timeouts');
  });
});
