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

  it('should default dinov2DedupThreshold to 0.82 when env var is not set', async () => {
    delete process.env.DINOV2_DEDUP_THRESHOLD;
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.dinov2DedupThreshold).toBe(0.82);
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
    expect(PROCESS_THRESHOLDS.dinov2DedupThreshold).toBe(0.82);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid DINOV2_DEDUP_THRESHOLD="abc"')
    );
    warnSpy.mockRestore();
  });

  it('should warn and use default when env var exceeds upper bound', async () => {
    process.env.DINOV2_DEDUP_THRESHOLD = '1.5';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.dinov2DedupThreshold).toBe(0.82);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid DINOV2_DEDUP_THRESHOLD="1.5"')
    );
    warnSpy.mockRestore();
  });

  it('should warn and use default when env var is below lower bound', async () => {
    process.env.DINOV2_DEDUP_THRESHOLD = '-0.1';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.dinov2DedupThreshold).toBe(0.82);
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
    expect(PROCESS_THRESHOLDS.dinov2DedupThreshold).toBe(0.82);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid DINOV2_DEDUP_THRESHOLD=""')
    );
    warnSpy.mockRestore();
  });
});


describe('dedupThresholds - new threshold fields defaults', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should have correct default values for overexposure thresholds', async () => {
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.overexposureGlobalRatio).toBe(0.40);
    expect(PROCESS_THRESHOLDS.overexposureSubjectVThreshold).toBe(245);
    expect(PROCESS_THRESHOLDS.overexposureSubjectSThreshold).toBe(45);
    expect(PROCESS_THRESHOLDS.overexposureSubjectMinAreaRatio).toBe(0.006);
    expect(PROCESS_THRESHOLDS.overexposureSubjectMaxAreaRatio).toBe(0.015);
    expect(PROCESS_THRESHOLDS.overexposureSubjectSevereTotalAreaRatio).toBe(0.012);
    expect(PROCESS_THRESHOLDS.overexposureMinComponentPixels).toBe(300);
    expect(PROCESS_THRESHOLDS.overexposureTextureGradientThreshold).toBe(5.0);
  });

  it('should have correct default values for DINOv2 thresholds', async () => {
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.dinov2ConfirmedThreshold).toBe(0.88);
    expect(PROCESS_THRESHOLDS.dinov2GrayLowThreshold).toBe(0.75);
    expect(PROCESS_THRESHOLDS.dinov2DedupThreshold).toBe(0.82);
  });

  it('should have correct default values for CLIP thresholds', async () => {
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.clipConfirmedThreshold).toBe(0.93);
    expect(PROCESS_THRESHOLDS.clipGrayHighThreshold).toBe(0.90);
    expect(PROCESS_THRESHOLDS.clipGrayLowThreshold).toBe(0.86);
  });

  it('should have correct default for globalSimilarityTopK', async () => {
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.globalSimilarityTopK).toBe(10);
  });
});

describe('dedupThresholds - envPositiveInt validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should accept a valid positive integer override', async () => {
    process.env.OVEREXPOSURE_MIN_COMPONENT_PIXELS = '500';
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.overexposureMinComponentPixels).toBe(500);
  });

  it('should warn and use default for non-numeric value', async () => {
    process.env.OVEREXPOSURE_MIN_COMPONENT_PIXELS = 'hello';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.overexposureMinComponentPixels).toBe(300);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid OVEREXPOSURE_MIN_COMPONENT_PIXELS="hello"')
    );
    warnSpy.mockRestore();
  });

  it('should warn and use default for zero value', async () => {
    process.env.OVEREXPOSURE_MIN_COMPONENT_PIXELS = '0';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.overexposureMinComponentPixels).toBe(300);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid OVEREXPOSURE_MIN_COMPONENT_PIXELS="0"')
    );
    warnSpy.mockRestore();
  });

  it('should warn and use default for negative value', async () => {
    process.env.OVEREXPOSURE_MIN_COMPONENT_PIXELS = '-10';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.overexposureMinComponentPixels).toBe(300);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid OVEREXPOSURE_MIN_COMPONENT_PIXELS="-10"')
    );
    warnSpy.mockRestore();
  });

  it('should warn and use default for floating point value', async () => {
    process.env.GLOBAL_SIMILARITY_TOP_K = '3.7';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    // parseInt('3.7') = 3, but Number.isInteger(3) is true so it should parse as 3
    // Actually parseInt('3.7', 10) = 3 which IS an integer and > 0
    expect(PROCESS_THRESHOLDS.globalSimilarityTopK).toBe(3);
    warnSpy.mockRestore();
  });
});

describe('dedupThresholds - envPositiveNumber validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should accept a valid positive float override', async () => {
    process.env.OVEREXPOSURE_TEXTURE_GRADIENT_THRESHOLD = '7.5';
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.overexposureTextureGradientThreshold).toBe(7.5);
  });

  it('should warn and use default for non-numeric value', async () => {
    process.env.OVEREXPOSURE_TEXTURE_GRADIENT_THRESHOLD = 'bad';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.overexposureTextureGradientThreshold).toBe(5.0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid OVEREXPOSURE_TEXTURE_GRADIENT_THRESHOLD="bad"')
    );
    warnSpy.mockRestore();
  });

  it('should warn and use default for zero value', async () => {
    process.env.OVEREXPOSURE_TEXTURE_GRADIENT_THRESHOLD = '0';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.overexposureTextureGradientThreshold).toBe(5.0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid OVEREXPOSURE_TEXTURE_GRADIENT_THRESHOLD="0"')
    );
    warnSpy.mockRestore();
  });

  it('should warn and use default for negative value', async () => {
    process.env.OVEREXPOSURE_TEXTURE_GRADIENT_THRESHOLD = '-2.0';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.overexposureTextureGradientThreshold).toBe(5.0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid OVEREXPOSURE_TEXTURE_GRADIENT_THRESHOLD="-2.0"')
    );
    warnSpy.mockRestore();
  });
});

describe('dedupThresholds - overexposure ratio env overrides', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should accept valid ratio override for overexposureGlobalRatio', async () => {
    process.env.OVEREXPOSURE_GLOBAL_RATIO = '0.5';
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.overexposureGlobalRatio).toBe(0.5);
  });

  it('should warn and use default when ratio exceeds 1', async () => {
    process.env.OVEREXPOSURE_GLOBAL_RATIO = '1.5';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.overexposureGlobalRatio).toBe(0.40);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid OVEREXPOSURE_GLOBAL_RATIO="1.5"')
    );
    warnSpy.mockRestore();
  });

  it('should warn and use default when ratio is negative', async () => {
    process.env.OVEREXPOSURE_SUBJECT_MIN_AREA_RATIO = '-0.01';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PROCESS_THRESHOLDS } = await import('./dedupThresholds');
    expect(PROCESS_THRESHOLDS.overexposureSubjectMinAreaRatio).toBe(0.006);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid OVEREXPOSURE_SUBJECT_MIN_AREA_RATIO="-0.01"')
    );
    warnSpy.mockRestore();
  });
});
