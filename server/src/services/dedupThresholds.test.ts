import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('dedupThresholds - DINOv2 threshold', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should default dinov2DedupThreshold to 0.85 when env var is not set', async () => {
    delete process.env.DINOV2_DEDUP_THRESHOLD;
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.dinov2DedupThreshold).toBe(0.85);
  });

  it('should use env var value when it is a valid number in [0, 1]', async () => {
    process.env.DINOV2_DEDUP_THRESHOLD = '0.85';
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.dinov2DedupThreshold).toBe(0.85);
  });

  it('should accept boundary value 0', async () => {
    process.env.DINOV2_DEDUP_THRESHOLD = '0';
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.dinov2DedupThreshold).toBe(0);
  });

  it('should accept boundary value 1', async () => {
    process.env.DINOV2_DEDUP_THRESHOLD = '1';
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.dinov2DedupThreshold).toBe(1);
  });

  it('should warn and use default when env var is not a valid number', async () => {
    process.env.DINOV2_DEDUP_THRESHOLD = 'abc';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.dinov2DedupThreshold).toBe(0.85);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid DINOV2_DEDUP_THRESHOLD="abc"')
    );
    warnSpy.mockRestore();
  });

  it('should warn and use default when env var exceeds upper bound', async () => {
    process.env.DINOV2_DEDUP_THRESHOLD = '1.5';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.dinov2DedupThreshold).toBe(0.85);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid DINOV2_DEDUP_THRESHOLD="1.5"')
    );
    warnSpy.mockRestore();
  });

  it('should warn and use default when env var is below lower bound', async () => {
    process.env.DINOV2_DEDUP_THRESHOLD = '-0.1';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.dinov2DedupThreshold).toBe(0.85);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid DINOV2_DEDUP_THRESHOLD="-0.1"')
    );
    warnSpy.mockRestore();
  });

  it('should warn and use default when env var is empty string', async () => {
    process.env.DINOV2_DEDUP_THRESHOLD = '';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    // parseFloat('') returns NaN
    expect(PROCESS_THRESHOLDS.dinov2DedupThreshold).toBe(0.85);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid DINOV2_DEDUP_THRESHOLD=""')
    );
    warnSpy.mockRestore();
  });
});
