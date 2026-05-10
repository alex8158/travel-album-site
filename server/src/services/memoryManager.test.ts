import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMemoryManager,
  parseMemoryManagerConfig,
  calculatePressureLevel,
  type MemoryManagerConfig,
  type MemoryManager,
} from './memoryManager';

describe('memoryManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('parseMemoryManagerConfig', () => {
    it('returns defaults when no env vars set', () => {
      delete process.env.VIDEO_MEMORY_LIMIT_MB;
      delete process.env.VIDEO_MEMORY_WARNING_RATIO;
      delete process.env.VIDEO_MEMORY_CRITICAL_RATIO;

      const config = parseMemoryManagerConfig();
      expect(config.memoryLimitMB).toBe(1024);
      expect(config.warningRatio).toBe(0.7);
      expect(config.criticalRatio).toBe(0.85);
      expect(config.checkIntervalMs).toBe(5000);
      expect(config.debounceDurationMs).toBe(5000);
    });

    it('parses valid env vars', () => {
      process.env.VIDEO_MEMORY_LIMIT_MB = '2048';
      process.env.VIDEO_MEMORY_WARNING_RATIO = '0.6';
      process.env.VIDEO_MEMORY_CRITICAL_RATIO = '0.9';

      const config = parseMemoryManagerConfig();
      expect(config.memoryLimitMB).toBe(2048);
      expect(config.warningRatio).toBe(0.6);
      expect(config.criticalRatio).toBe(0.9);

      delete process.env.VIDEO_MEMORY_LIMIT_MB;
      delete process.env.VIDEO_MEMORY_WARNING_RATIO;
      delete process.env.VIDEO_MEMORY_CRITICAL_RATIO;
    });

    it('falls back to defaults for out-of-range values', () => {
      process.env.VIDEO_MEMORY_LIMIT_MB = '50'; // below 128
      process.env.VIDEO_MEMORY_WARNING_RATIO = '1.5'; // above 0.9
      process.env.VIDEO_MEMORY_CRITICAL_RATIO = '0.01'; // below 0.2

      const config = parseMemoryManagerConfig();
      expect(config.memoryLimitMB).toBe(1024);
      expect(config.warningRatio).toBe(0.7);
      expect(config.criticalRatio).toBe(0.85);

      delete process.env.VIDEO_MEMORY_LIMIT_MB;
      delete process.env.VIDEO_MEMORY_WARNING_RATIO;
      delete process.env.VIDEO_MEMORY_CRITICAL_RATIO;
    });

    it('falls back to default criticalRatio when not > warningRatio', () => {
      process.env.VIDEO_MEMORY_WARNING_RATIO = '0.8';
      process.env.VIDEO_MEMORY_CRITICAL_RATIO = '0.7'; // not > 0.8

      const config = parseMemoryManagerConfig();
      expect(config.warningRatio).toBe(0.8);
      // criticalRatio should be adjusted to be > warningRatio
      expect(config.criticalRatio).toBeGreaterThan(config.warningRatio);

      delete process.env.VIDEO_MEMORY_WARNING_RATIO;
      delete process.env.VIDEO_MEMORY_CRITICAL_RATIO;
    });

    it('falls back to defaults for non-numeric values', () => {
      process.env.VIDEO_MEMORY_LIMIT_MB = 'abc';
      process.env.VIDEO_MEMORY_WARNING_RATIO = 'xyz';

      const config = parseMemoryManagerConfig();
      expect(config.memoryLimitMB).toBe(1024);
      expect(config.warningRatio).toBe(0.7);

      delete process.env.VIDEO_MEMORY_LIMIT_MB;
      delete process.env.VIDEO_MEMORY_WARNING_RATIO;
    });
  });

  describe('calculatePressureLevel', () => {
    const config: MemoryManagerConfig = {
      memoryLimitMB: 1024,
      warningRatio: 0.7,
      criticalRatio: 0.85,
      checkIntervalMs: 5000,
      debounceDurationMs: 5000,
    };

    it('returns normal when RSS is below warning threshold', () => {
      // warning threshold = 1024 * 0.7 = 716.8
      expect(calculatePressureLevel(500, config)).toBe('normal');
      expect(calculatePressureLevel(716, config)).toBe('normal');
    });

    it('returns warning when RSS is between warning and critical thresholds', () => {
      // warning = 716.8, critical = 1024 * 0.85 = 870.4
      expect(calculatePressureLevel(717, config)).toBe('warning');
      expect(calculatePressureLevel(800, config)).toBe('warning');
      expect(calculatePressureLevel(870, config)).toBe('warning');
    });

    it('returns critical when RSS is at or above critical threshold', () => {
      // critical = 870.4
      expect(calculatePressureLevel(871, config)).toBe('critical');
      expect(calculatePressureLevel(1024, config)).toBe('critical');
      expect(calculatePressureLevel(2000, config)).toBe('critical');
    });

    it('handles edge case at exact thresholds', () => {
      const exactWarning = 1024 * 0.7; // 716.8
      const exactCritical = 1024 * 0.85; // 870.4

      expect(calculatePressureLevel(exactWarning, config)).toBe('warning');
      expect(calculatePressureLevel(exactCritical, config)).toBe('critical');
    });
  });

  describe('createMemoryManager - basic operations', () => {
    let manager: MemoryManager;
    let mockRss: number;

    beforeEach(() => {
      mockRss = 500;
      manager = createMemoryManager(
        { memoryLimitMB: 1024, warningRatio: 0.7, criticalRatio: 0.85 },
        () => mockRss,
      );
    });

    afterEach(() => {
      manager.stopMonitoring();
    });

    it('getRssMB returns current RSS', () => {
      expect(manager.getRssMB()).toBe(500);
      mockRss = 800;
      expect(manager.getRssMB()).toBe(800);
    });

    it('getCurrentStatus returns correct status', () => {
      manager.startMonitoring();
      const status = manager.getCurrentStatus();
      expect(status.rssMB).toBe(500);
      expect(status.pressureLevel).toBe('normal');
      expect(status.limitMB).toBe(1024);
      expect(status.usageRatio).toBeCloseTo(500 / 1024);
    });

    it('getPressureLevel returns current level', () => {
      manager.startMonitoring();
      expect(manager.getPressureLevel()).toBe('normal');
    });

    it('getConfig returns config copy', () => {
      const config = manager.getConfig();
      expect(config.memoryLimitMB).toBe(1024);
      expect(config.warningRatio).toBe(0.7);
      expect(config.criticalRatio).toBe(0.85);
    });
  });

  describe('createMemoryManager - pressure level transitions', () => {
    let manager: MemoryManager;
    let mockRss: number;

    beforeEach(() => {
      mockRss = 500;
      manager = createMemoryManager(
        {
          memoryLimitMB: 1024,
          warningRatio: 0.7,
          criticalRatio: 0.85,
          checkIntervalMs: 5000,
          debounceDurationMs: 5000,
        },
        () => mockRss,
      );
      manager.startMonitoring();
    });

    afterEach(() => {
      manager.stopMonitoring();
    });

    it('transitions to critical immediately (no debounce)', () => {
      mockRss = 900; // above critical threshold (870.4)
      vi.advanceTimersByTime(5000); // one check interval
      expect(manager.getPressureLevel()).toBe('critical');
    });

    it('transitions from normal to warning requires debounce', () => {
      mockRss = 750; // above warning threshold (716.8)
      vi.advanceTimersByTime(5000); // first check - starts debounce
      expect(manager.getPressureLevel()).toBe('normal'); // still normal (debouncing)

      vi.advanceTimersByTime(5000); // second check - debounce elapsed
      expect(manager.getPressureLevel()).toBe('warning');
    });

    it('recovery from critical is immediate', () => {
      // First go to critical
      mockRss = 900;
      vi.advanceTimersByTime(5000);
      expect(manager.getPressureLevel()).toBe('critical');

      // Recover to normal
      mockRss = 500;
      vi.advanceTimersByTime(5000);
      expect(manager.getPressureLevel()).toBe('normal');
    });

    it('debounce resets if level fluctuates back', () => {
      mockRss = 750; // warning zone
      vi.advanceTimersByTime(5000); // starts debounce
      expect(manager.getPressureLevel()).toBe('normal');

      mockRss = 500; // back to normal
      vi.advanceTimersByTime(5000); // resets debounce
      expect(manager.getPressureLevel()).toBe('normal');

      mockRss = 750; // warning zone again
      vi.advanceTimersByTime(5000); // starts new debounce
      expect(manager.getPressureLevel()).toBe('normal');

      vi.advanceTimersByTime(5000); // debounce elapsed
      expect(manager.getPressureLevel()).toBe('warning');
    });
  });

  describe('createMemoryManager - degradation parameters', () => {
    let manager: MemoryManager;
    let mockRss: number;

    beforeEach(() => {
      mockRss = 500;
      manager = createMemoryManager(
        {
          memoryLimitMB: 1024,
          warningRatio: 0.7,
          criticalRatio: 0.85,
          checkIntervalMs: 5000,
          debounceDurationMs: 5000,
        },
        () => mockRss,
      );
      manager.startMonitoring();
    });

    afterEach(() => {
      manager.stopMonitoring();
    });

    it('normal: returns default frame sample count and configured max concurrency', () => {
      expect(manager.getFrameSampleCount(5)).toBe(5);
      expect(manager.getMaxConcurrency(3)).toBe(3);
    });

    it('warning: returns reduced frame sample count and concurrency 1', () => {
      mockRss = 750;
      vi.advanceTimersByTime(10000); // debounce elapsed
      expect(manager.getPressureLevel()).toBe('warning');

      expect(manager.getFrameSampleCount(5)).toBe(3);
      expect(manager.getMaxConcurrency(3)).toBe(1);
    });

    it('critical: returns concurrency 0 and shouldPauseTasks true', () => {
      mockRss = 900;
      vi.advanceTimersByTime(5000);
      expect(manager.getPressureLevel()).toBe('critical');

      expect(manager.getMaxConcurrency(3)).toBe(0);
      expect(manager.shouldPauseTasks()).toBe(true);
    });
  });

  describe('createMemoryManager - monitoring lifecycle', () => {
    let manager: MemoryManager;
    let mockRss: number;

    beforeEach(() => {
      mockRss = 500;
      manager = createMemoryManager(
        { memoryLimitMB: 1024, warningRatio: 0.7, criticalRatio: 0.85 },
        () => mockRss,
      );
    });

    it('stopMonitoring returns MemorySummary', () => {
      manager.startMonitoring();
      mockRss = 600;
      vi.advanceTimersByTime(5000);
      mockRss = 700;
      vi.advanceTimersByTime(5000);

      const summary = manager.stopMonitoring();
      expect(summary.peakRssMB).toBeGreaterThanOrEqual(600);
      expect(summary.gcTriggerCount).toBe(0);
      expect(summary.skippedVideos).toEqual([]);
    });

    it('recordSkippedVideo adds to summary', () => {
      manager.startMonitoring();
      manager.recordSkippedVideo('video-1', 'analysis', 'memory_timeout');

      const summary = manager.stopMonitoring();
      expect(summary.skippedVideos).toHaveLength(1);
      expect(summary.skippedVideos[0]).toEqual({
        mediaId: 'video-1',
        stage: 'analysis',
        reason: 'memory_timeout',
      });
    });

    it('startMonitoring resets state', () => {
      manager.startMonitoring();
      manager.recordSkippedVideo('video-1', 'analysis', 'oom');
      manager.stopMonitoring();

      manager.startMonitoring();
      const summary = manager.stopMonitoring();
      expect(summary.skippedVideos).toHaveLength(0);
      expect(summary.peakRssMB).toBeGreaterThanOrEqual(0);
    });
  });

  describe('createMemoryManager - critical timeout and GC', () => {
    let manager: MemoryManager;
    let mockRss: number;

    beforeEach(() => {
      mockRss = 500;
      manager = createMemoryManager(
        {
          memoryLimitMB: 1024,
          warningRatio: 0.7,
          criticalRatio: 0.85,
          checkIntervalMs: 5000,
          debounceDurationMs: 5000,
        },
        () => mockRss,
      );
      manager.startMonitoring();
    });

    afterEach(() => {
      manager.stopMonitoring();
    });

    it('triggers GC after 30s critical with no task completion', () => {
      const gcSpy = vi.fn();
      (global as any).gc = gcSpy;

      mockRss = 900; // critical
      vi.advanceTimersByTime(5000); // enter critical
      expect(manager.getPressureLevel()).toBe('critical');

      // Advance to 30s
      vi.advanceTimersByTime(25000);
      expect(gcSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5000); // 35s total - triggers GC at 30s check
      expect(gcSpy).toHaveBeenCalledTimes(1);

      delete (global as any).gc;
    });

    it('cancels tasks after GC + 10s still critical', () => {
      const gcSpy = vi.fn();
      (global as any).gc = gcSpy;

      mockRss = 900;
      vi.advanceTimersByTime(5000); // enter critical

      // Advance past 30s to trigger GC
      vi.advanceTimersByTime(30000);
      expect(gcSpy).toHaveBeenCalled();

      // Advance 10 more seconds (total 45s from critical start)
      vi.advanceTimersByTime(10000);
      expect(manager.shouldPauseTasks()).toBe(true);

      delete (global as any).gc;
    });

    it('does not trigger GC if task completes during critical', () => {
      const gcSpy = vi.fn();
      (global as any).gc = gcSpy;

      mockRss = 900;
      vi.advanceTimersByTime(5000); // enter critical

      vi.advanceTimersByTime(15000); // 20s into critical
      manager.notifyTaskCompleted(); // task completed

      vi.advanceTimersByTime(20000); // 40s total - but task completed resets
      // GC should still trigger because lastTaskCompletionTime is checked against criticalSince
      // Actually, notifyTaskCompleted sets lastTaskCompletionTime to now, which is > criticalSince
      // So noTaskCompletion will be false
      expect(gcSpy).not.toHaveBeenCalled();

      delete (global as any).gc;
    });
  });

  describe('createMemoryManager - checkBetweenStages', () => {
    let manager: MemoryManager;
    let mockRss: number;

    beforeEach(() => {
      mockRss = 500;
      manager = createMemoryManager(
        {
          memoryLimitMB: 1024,
          warningRatio: 0.7,
          criticalRatio: 0.85,
          checkIntervalMs: 5000,
          debounceDurationMs: 5000,
        },
        () => mockRss,
      );
      manager.startMonitoring();
    });

    afterEach(() => {
      manager.stopMonitoring();
      vi.useRealTimers();
    });

    it('resolves immediately when not critical', async () => {
      await expect(manager.checkBetweenStages('analysis')).resolves.toBeUndefined();
    });

    it('waits and resolves when pressure recovers', async () => {
      mockRss = 900; // critical
      vi.advanceTimersByTime(5000); // enter critical

      // Start checkBetweenStages - it will poll
      const promise = manager.checkBetweenStages('detection');

      // After 5s, recover
      mockRss = 500;
      await vi.advanceTimersByTimeAsync(5000);

      await expect(promise).resolves.toBeUndefined();
    });

    it('throws after 60s timeout', async () => {
      mockRss = 900; // critical
      vi.advanceTimersByTime(5000); // enter critical

      let caughtError: Error | null = null;
      const promise = manager.checkBetweenStages('normalization').catch((err) => {
        caughtError = err;
      });

      // Advance 60s+ while staying critical
      await vi.advanceTimersByTimeAsync(65000);
      await promise;

      expect(caughtError).not.toBeNull();
      expect(caughtError!.message).toMatch(/Memory pressure critical/);
    });
  });

  describe('createMemoryManager - waitForRecovery', () => {
    let manager: MemoryManager;
    let mockRss: number;

    beforeEach(() => {
      mockRss = 500;
      manager = createMemoryManager(
        {
          memoryLimitMB: 1024,
          warningRatio: 0.7,
          criticalRatio: 0.85,
          checkIntervalMs: 5000,
          debounceDurationMs: 5000,
        },
        () => mockRss,
      );
      manager.startMonitoring();
    });

    afterEach(() => {
      manager.stopMonitoring();
    });

    it('returns true immediately when not critical', async () => {
      const result = await manager.waitForRecovery(60000);
      expect(result).toBe(true);
    });

    it('returns true when recovery happens within timeout', async () => {
      mockRss = 900;
      vi.advanceTimersByTime(5000); // enter critical

      const promise = manager.waitForRecovery(60000);
      mockRss = 500;
      await vi.advanceTimersByTimeAsync(5000);

      expect(await promise).toBe(true);
    });

    it('returns false when timeout expires', async () => {
      mockRss = 900;
      vi.advanceTimersByTime(5000); // enter critical

      const promise = manager.waitForRecovery(15000);
      await vi.advanceTimersByTimeAsync(20000);

      expect(await promise).toBe(false);
    });
  });

  describe('createMemoryManager - stage tracking', () => {
    let manager: MemoryManager;
    let mockRss: number;

    beforeEach(() => {
      mockRss = 500;
      manager = createMemoryManager(
        { memoryLimitMB: 1024, warningRatio: 0.7, criticalRatio: 0.85 },
        () => mockRss,
      );
    });

    it('tracks RSS by stage in summary', async () => {
      manager.startMonitoring();

      mockRss = 400;
      await manager.checkBetweenStages('analysis');
      vi.advanceTimersByTime(5000);

      mockRss = 600;
      await manager.checkBetweenStages('detection');
      vi.advanceTimersByTime(5000);

      const summary = manager.stopMonitoring();
      expect(summary.avgRssMBByStage).toHaveProperty('analysis');
      expect(summary.avgRssMBByStage).toHaveProperty('detection');
    });
  });
});
