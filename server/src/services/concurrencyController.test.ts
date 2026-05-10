import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createConcurrencyController,
  parseMaxConcurrentSegments,
  createDefaultConcurrencyController,
} from './concurrencyController';

describe('ConcurrencyController', () => {
  describe('createConcurrencyController', () => {
    it('should create a controller with the specified max concurrency', () => {
      const ctrl = createConcurrencyController(5);
      expect(ctrl.getMaxConcurrency()).toBe(5);
      expect(ctrl.getCurrentCount()).toBe(0);
      expect(ctrl.getQueueLength()).toBe(0);
    });

    it('should throw for invalid maxConcurrency values', () => {
      expect(() => createConcurrencyController(0)).toThrow();
      expect(() => createConcurrencyController(-1)).toThrow();
      expect(() => createConcurrencyController(1.5)).toThrow();
    });
  });

  describe('acquire / release', () => {
    it('should immediately resolve when slots are available', async () => {
      const ctrl = createConcurrencyController(3);
      await ctrl.acquire();
      expect(ctrl.getCurrentCount()).toBe(1);
      await ctrl.acquire();
      expect(ctrl.getCurrentCount()).toBe(2);
      await ctrl.acquire();
      expect(ctrl.getCurrentCount()).toBe(3);
    });

    it('should queue when max concurrency is reached', async () => {
      const ctrl = createConcurrencyController(1);
      await ctrl.acquire();
      expect(ctrl.getCurrentCount()).toBe(1);

      let resolved = false;
      const pending = ctrl.acquire().then(() => { resolved = true; });
      // Give microtask a chance to run
      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(ctrl.getQueueLength()).toBe(1);

      ctrl.release();
      await pending;
      expect(resolved).toBe(true);
      expect(ctrl.getQueueLength()).toBe(0);
    });

    it('should serve waiting tasks in FIFO order', async () => {
      const ctrl = createConcurrencyController(1);
      await ctrl.acquire();

      const order: number[] = [];
      const p1 = ctrl.acquire().then(() => { order.push(1); });
      const p2 = ctrl.acquire().then(() => { order.push(2); });
      const p3 = ctrl.acquire().then(() => { order.push(3); });

      expect(ctrl.getQueueLength()).toBe(3);

      ctrl.release(); // releases to p1
      await p1;
      ctrl.release(); // releases to p2
      await p2;
      ctrl.release(); // releases to p3
      await p3;

      expect(order).toEqual([1, 2, 3]);
    });

    it('should decrement currentCount on release when no waiters', () => {
      const ctrl = createConcurrencyController(3);
      // Synchronous acquire (slots available)
      ctrl.acquire();
      ctrl.acquire();
      expect(ctrl.getCurrentCount()).toBe(2);

      ctrl.release();
      expect(ctrl.getCurrentCount()).toBe(1);
      ctrl.release();
      expect(ctrl.getCurrentCount()).toBe(0);
    });

    it('should not go below 0 on extra release', () => {
      const ctrl = createConcurrencyController(2);
      ctrl.release();
      expect(ctrl.getCurrentCount()).toBe(0);
    });
  });

  describe('setMaxConcurrency', () => {
    it('should update max concurrency', () => {
      const ctrl = createConcurrencyController(3);
      ctrl.setMaxConcurrency(5);
      expect(ctrl.getMaxConcurrency()).toBe(5);
    });

    it('should release queued tasks when max is increased', async () => {
      const ctrl = createConcurrencyController(1);
      await ctrl.acquire();

      let resolved1 = false;
      let resolved2 = false;
      const p1 = ctrl.acquire().then(() => { resolved1 = true; });
      const p2 = ctrl.acquire().then(() => { resolved2 = true; });

      expect(ctrl.getQueueLength()).toBe(2);

      // Increase max to 3 — should release both queued tasks
      ctrl.setMaxConcurrency(3);
      await Promise.resolve();
      await Promise.resolve();

      expect(resolved1).toBe(true);
      expect(resolved2).toBe(true);
      expect(ctrl.getCurrentCount()).toBe(3);
      expect(ctrl.getQueueLength()).toBe(0);
    });

    it('should not interrupt running tasks when max is decreased', async () => {
      const ctrl = createConcurrencyController(3);
      await ctrl.acquire();
      await ctrl.acquire();
      await ctrl.acquire();
      expect(ctrl.getCurrentCount()).toBe(3);

      ctrl.setMaxConcurrency(1);
      // All 3 tasks still running
      expect(ctrl.getCurrentCount()).toBe(3);
      expect(ctrl.getMaxConcurrency()).toBe(1);

      // New acquire should wait
      let resolved = false;
      ctrl.acquire().then(() => { resolved = true; });
      await Promise.resolve();
      expect(resolved).toBe(false);
    });

    it('should ignore invalid values', () => {
      const ctrl = createConcurrencyController(3);
      ctrl.setMaxConcurrency(0);
      expect(ctrl.getMaxConcurrency()).toBe(3);
      ctrl.setMaxConcurrency(-1);
      expect(ctrl.getMaxConcurrency()).toBe(3);
      ctrl.setMaxConcurrency(1.5);
      expect(ctrl.getMaxConcurrency()).toBe(3);
    });
  });

  describe('parseMaxConcurrentSegments', () => {
    const originalEnv = process.env.VIDEO_MAX_CONCURRENT_SEGMENTS;

    beforeEach(() => {
      delete process.env.VIDEO_MAX_CONCURRENT_SEGMENTS;
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.VIDEO_MAX_CONCURRENT_SEGMENTS = originalEnv;
      } else {
        delete process.env.VIDEO_MAX_CONCURRENT_SEGMENTS;
      }
    });

    it('should return default 3 when env is not set', () => {
      expect(parseMaxConcurrentSegments()).toBe(3);
    });

    it('should return default 3 when env is empty string', () => {
      process.env.VIDEO_MAX_CONCURRENT_SEGMENTS = '';
      expect(parseMaxConcurrentSegments()).toBe(3);
    });

    it('should parse valid integer values', () => {
      process.env.VIDEO_MAX_CONCURRENT_SEGMENTS = '5';
      expect(parseMaxConcurrentSegments()).toBe(5);

      process.env.VIDEO_MAX_CONCURRENT_SEGMENTS = '1';
      expect(parseMaxConcurrentSegments()).toBe(1);

      process.env.VIDEO_MAX_CONCURRENT_SEGMENTS = '16';
      expect(parseMaxConcurrentSegments()).toBe(16);
    });

    it('should return default and warn for out-of-range values', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      process.env.VIDEO_MAX_CONCURRENT_SEGMENTS = '0';
      expect(parseMaxConcurrentSegments()).toBe(3);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockClear();
      process.env.VIDEO_MAX_CONCURRENT_SEGMENTS = '17';
      expect(parseMaxConcurrentSegments()).toBe(3);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('should return default and warn for non-integer values', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      process.env.VIDEO_MAX_CONCURRENT_SEGMENTS = '3.5';
      expect(parseMaxConcurrentSegments()).toBe(3);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockClear();
      process.env.VIDEO_MAX_CONCURRENT_SEGMENTS = 'abc';
      expect(parseMaxConcurrentSegments()).toBe(3);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe('createDefaultConcurrencyController', () => {
    const originalEnv = process.env.VIDEO_MAX_CONCURRENT_SEGMENTS;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.VIDEO_MAX_CONCURRENT_SEGMENTS = originalEnv;
      } else {
        delete process.env.VIDEO_MAX_CONCURRENT_SEGMENTS;
      }
    });

    it('should create controller with env-configured max', () => {
      process.env.VIDEO_MAX_CONCURRENT_SEGMENTS = '8';
      const ctrl = createDefaultConcurrencyController();
      expect(ctrl.getMaxConcurrency()).toBe(8);
    });

    it('should create controller with default max when env is invalid', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.VIDEO_MAX_CONCURRENT_SEGMENTS = 'invalid';
      const ctrl = createDefaultConcurrencyController();
      expect(ctrl.getMaxConcurrency()).toBe(3);
      warnSpy.mockRestore();
    });
  });
});
