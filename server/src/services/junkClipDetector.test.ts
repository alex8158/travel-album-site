import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { classifyJunkClip, computePixelVariance, computeEdgeDensity } from './junkClipDetector';

// --- Mocks for detection method tests (task 2.9) ---

let ffmpegOnHandlers: Record<string, Function> = {};
const mockFfmpegChain = {
  seekInput: vi.fn().mockReturnThis(),
  frames: vi.fn().mockReturnThis(),
  output: vi.fn().mockReturnThis(),
  on: vi.fn(function (this: any, event: string, handler: Function) {
    ffmpegOnHandlers[event] = handler;
    return this;
  }),
  run: vi.fn(() => {
    if (ffmpegOnHandlers['end']) {
      ffmpegOnHandlers['end']();
    }
  }),
};

const mockFfmpeg = vi.fn(() => {
  ffmpegOnHandlers = {};
  return mockFfmpegChain;
});

vi.mock('fluent-ffmpeg', () => ({
  default: (...args: any[]) => mockFfmpeg(...args),
}));

const mockSharpChain = {
  resize: vi.fn().mockReturnThis(),
  grayscale: vi.fn().mockReturnThis(),
  raw: vi.fn().mockReturnThis(),
  toBuffer: vi.fn().mockResolvedValue(Buffer.alloc(64 * 64, 128)),
};

vi.mock('sharp', () => ({
  default: vi.fn(() => mockSharpChain),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      mkdtempSync: vi.fn(() => '/tmp/junk-test'),
      rmSync: vi.fn(),
    },
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn(() => '/tmp/junk-test'),
    rmSync: vi.fn(),
  };
});

vi.mock('../helpers/tempDir', () => ({
  getTempDir: () => '/tmp',
}));

vi.mock('../database', () => ({
  getDb: vi.fn(),
}));

vi.mock('uuid', () => ({
  v4: () => 'test-uuid',
}));

describe('classifyJunkClip', () => {
  describe('too_short (priority 1)', () => {
    it('classifies segments shorter than minDuration as too_short', () => {
      const result = classifyJunkClip(0.5, null, null, false);
      expect(result.isJunk).toBe(true);
      expect(result.reason).toBe('too_short');
      expect(result.confidence).toBe(1.0);
    });

    it('uses custom minDuration from options', () => {
      const result = classifyJunkClip(1.5, null, null, false, { minDuration: 2.0 });
      expect(result.isJunk).toBe(true);
      expect(result.reason).toBe('too_short');
    });

    it('too_short takes priority over other conditions', () => {
      const result = classifyJunkClip(0.3, 200, 90, true);
      expect(result.reason).toBe('too_short');
    });
  });

  describe('extreme_blur (priority 2)', () => {
    it('classifies high motion magnitude as extreme_blur', () => {
      const result = classifyJunkClip(2.0, 100, null, false);
      expect(result.isJunk).toBe(true);
      expect(result.reason).toBe('extreme_blur');
    });

    it('computes confidence as motionMagnitude / (threshold * 2)', () => {
      const result = classifyJunkClip(2.0, 120, null, false);
      expect(result.confidence).toBeCloseTo(120 / 160);
    });

    it('caps confidence at 1.0', () => {
      const result = classifyJunkClip(2.0, 200, null, false);
      expect(result.confidence).toBe(1.0);
    });

    it('skips extreme_blur check when motionMagnitude is null', () => {
      const result = classifyJunkClip(2.0, null, null, false);
      expect(result.isJunk).toBe(false);
    });

    it('extreme_blur takes priority over ground_shot', () => {
      const result = classifyJunkClip(2.0, 100, 90, true);
      expect(result.reason).toBe('extreme_blur');
    });
  });

  describe('ground_shot (priority 3)', () => {
    it('classifies high pitch angle as ground_shot', () => {
      const result = classifyJunkClip(2.0, null, 75, false);
      expect(result.isJunk).toBe(true);
      expect(result.reason).toBe('ground_shot');
    });

    it('computes confidence as (pitchAngle - groundShotAngle) / 30 + 0.5', () => {
      const result = classifyJunkClip(2.0, null, 75, false);
      expect(result.confidence).toBeCloseTo((75 - 60) / 30 + 0.5);
    });

    it('caps confidence at 1.0', () => {
      const result = classifyJunkClip(2.0, null, 100, false);
      expect(result.confidence).toBe(1.0);
    });

    it('skips ground_shot check when pitchAngle is null', () => {
      const result = classifyJunkClip(2.0, null, null, true);
      expect(result.reason).toBe('accidental_touch');
    });

    it('ground_shot takes priority over accidental_touch', () => {
      const result = classifyJunkClip(2.0, null, 75, true);
      expect(result.reason).toBe('ground_shot');
    });
  });

  describe('accidental_touch (priority 4)', () => {
    it('classifies accidental pattern as accidental_touch', () => {
      const result = classifyJunkClip(2.0, null, null, true);
      expect(result.isJunk).toBe(true);
      expect(result.reason).toBe('accidental_touch');
      expect(result.confidence).toBe(0.8);
    });
  });

  describe('no junk', () => {
    it('returns isJunk=false when no conditions match', () => {
      const result = classifyJunkClip(2.0, 50, 30, false);
      expect(result.isJunk).toBe(false);
      expect(result.reason).toBeNull();
      expect(result.confidence).toBe(0.0);
    });
  });

  describe('details', () => {
    it('always populates details with input values', () => {
      const result = classifyJunkClip(3.0, 45, 20, false);
      expect(result.details).toEqual({
        duration: 3.0,
        motionMagnitude: 45,
        pitchAngle: 20,
        hasAccidentalPattern: false,
        occlusionRatio: null,
      });
    });

    it('populates details even when junk is detected', () => {
      const result = classifyJunkClip(0.5, 100, 90, true);
      expect(result.details).toEqual({
        duration: 0.5,
        motionMagnitude: 100,
        pitchAngle: 90,
        hasAccidentalPattern: true,
        occlusionRatio: null,
      });
    });

    it('includes occlusionRatio in details when provided', () => {
      const result = classifyJunkClip(3.0, null, null, false, undefined, 0.85);
      expect(result.details.occlusionRatio).toBe(0.85);
    });
  });
});

describe('classifyJunkClip - Property-Based Tests', () => {
  // Feature: v2-video-processing, Property 3: Junk Classification Priority Order
  // For any segment with multiple junk conditions simultaneously true, the reported reason
  // SHALL be the first matching in priority order: too_short, extreme_blur, ground_shot, accidental_touch.
  // **Validates: Requirements 3.6**

  describe('Property 3: Priority Order', () => {
    it('too_short always takes priority when duration < minDuration, regardless of other conditions', () => {
      fc.assert(
        fc.property(
          fc.float({ min: Math.fround(0.01), max: Math.fround(0.99), noNaN: true }),  // duration < 1.0 (too_short)
          fc.float({ min: Math.fround(81), max: Math.fround(200), noNaN: true }),      // motionMagnitude > 80 (extreme_blur)
          fc.float({ min: Math.fround(61), max: Math.fround(90), noNaN: true }),       // pitchAngle > 60 (ground_shot)
          fc.boolean(),                                       // hasAccidentalPattern
          (duration, motionMagnitude, pitchAngle, hasAccidentalPattern) => {
            const result = classifyJunkClip(duration, motionMagnitude, pitchAngle, hasAccidentalPattern);
            expect(result.isJunk).toBe(true);
            expect(result.reason).toBe('too_short');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('extreme_blur takes priority over ground_shot and accidental_touch when duration >= minDuration', () => {
      fc.assert(
        fc.property(
          fc.float({ min: Math.fround(1.0), max: Math.fround(10.0), noNaN: true }),   // duration >= 1.0 (not too_short)
          fc.float({ min: Math.fround(81), max: Math.fround(200), noNaN: true }),      // motionMagnitude > 80 (extreme_blur)
          fc.float({ min: Math.fround(61), max: Math.fround(90), noNaN: true }),       // pitchAngle > 60 (ground_shot)
          fc.boolean(),                                       // hasAccidentalPattern
          (duration, motionMagnitude, pitchAngle, hasAccidentalPattern) => {
            const result = classifyJunkClip(duration, motionMagnitude, pitchAngle, hasAccidentalPattern);
            expect(result.isJunk).toBe(true);
            expect(result.reason).toBe('extreme_blur');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('ground_shot takes priority over accidental_touch when no higher-priority conditions match', () => {
      fc.assert(
        fc.property(
          fc.float({ min: Math.fround(1.0), max: Math.fround(10.0), noNaN: true }),   // duration >= 1.0 (not too_short)
          fc.float({ min: Math.fround(61), max: Math.fround(90), noNaN: true }),       // pitchAngle > 60 (ground_shot)
          (duration, pitchAngle) => {
            // motionMagnitude null or <= 80 (no extreme_blur), hasAccidentalPattern = true
            const result = classifyJunkClip(duration, null, pitchAngle, true);
            expect(result.isJunk).toBe(true);
            expect(result.reason).toBe('ground_shot');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('accidental_touch is reported only when no higher-priority conditions match', () => {
      fc.assert(
        fc.property(
          fc.float({ min: Math.fround(1.0), max: Math.fround(10.0), noNaN: true }),   // duration >= 1.0 (not too_short)
          fc.oneof(
            fc.constant(null as number | null),
            fc.float({ min: Math.fround(0), max: Math.fround(80), noNaN: true })      // motionMagnitude <= 80 (no extreme_blur)
          ),
          fc.oneof(
            fc.constant(null as number | null),
            fc.float({ min: Math.fround(0), max: Math.fround(60), noNaN: true })      // pitchAngle <= 60 (no ground_shot)
          ),
          (duration, motionMagnitude, pitchAngle) => {
            // No occlusion (null or <= 0.7), hasAccidentalPattern = true
            const result = classifyJunkClip(duration, motionMagnitude, pitchAngle, true, undefined, null);
            expect(result.isJunk).toBe(true);
            expect(result.reason).toBe('accidental_touch');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: v2-video-processing, Property 4: Junk Confidence Bounded
  // For any junk clip analysis result, the confidence score SHALL be in [0.0, 1.0].
  // **Validates: Requirements 3.7**

  describe('Property 4: Confidence Bounded [0, 1]', () => {
    it('confidence is always in [0.0, 1.0] for any valid inputs', () => {
      fc.assert(
        fc.property(
          fc.float({ min: Math.fround(0.01), max: Math.fround(10.0), noNaN: true }),   // duration
          fc.oneof(
            fc.constant(null as number | null),
            fc.float({ min: Math.fround(0), max: Math.fround(200), noNaN: true })      // motionMagnitude
          ),
          fc.oneof(
            fc.constant(null as number | null),
            fc.float({ min: Math.fround(0), max: Math.fround(90), noNaN: true })       // pitchAngle
          ),
          fc.boolean(),                                        // hasAccidentalPattern
          (duration, motionMagnitude, pitchAngle, hasAccidentalPattern) => {
            const result = classifyJunkClip(duration, motionMagnitude, pitchAngle, hasAccidentalPattern);
            expect(result.confidence).toBeGreaterThanOrEqual(0.0);
            expect(result.confidence).toBeLessThanOrEqual(1.0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('confidence is in [0.0, 1.0] even with extreme input values', () => {
      fc.assert(
        fc.property(
          fc.float({ min: Math.fround(0.001), max: Math.fround(100.0), noNaN: true }),  // wide duration range
          fc.oneof(
            fc.constant(null as number | null),
            fc.float({ min: Math.fround(0), max: Math.fround(1000), noNaN: true })      // very high motion
          ),
          fc.oneof(
            fc.constant(null as number | null),
            fc.float({ min: Math.fround(0), max: Math.fround(180), noNaN: true })       // extreme pitch angles
          ),
          fc.boolean(),
          (duration, motionMagnitude, pitchAngle, hasAccidentalPattern) => {
            const result = classifyJunkClip(duration, motionMagnitude, pitchAngle, hasAccidentalPattern);
            expect(result.confidence).toBeGreaterThanOrEqual(0.0);
            expect(result.confidence).toBeLessThanOrEqual(1.0);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

// --- Task 2.9: Unit tests for detection helper methods ---

describe('estimateMotionMagnitude', () => {
  let estimateMotionMagnitude: typeof import('./junkClipDetector').estimateMotionMagnitude;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset ffmpeg to succeed by default
    mockFfmpegChain.run.mockImplementation(() => {
      if (ffmpegOnHandlers['end']) {
        ffmpegOnHandlers['end']();
      }
    });
    // Reset sharp to return a buffer
    mockSharpChain.toBuffer.mockResolvedValue(Buffer.alloc(64 * 64, 128));

    const mod = await import('./junkClipDetector');
    estimateMotionMagnitude = mod.estimateMotionMagnitude;
  });

  it('returns null when duration is zero or negative', async () => {
    const result = await estimateMotionMagnitude('/fake/video.mp4', 5, 5);
    expect(result).toBeNull();
  });

  it('returns null when all frame extractions fail', async () => {
    mockFfmpegChain.run.mockImplementation(() => {
      if (ffmpegOnHandlers['error']) {
        ffmpegOnHandlers['error'](new Error('ffmpeg failed'));
      }
    });

    const result = await estimateMotionMagnitude('/fake/video.mp4', 0, 2);
    expect(result).toBeNull();
  });

  it('does not throw on ffmpeg errors', async () => {
    mockFfmpegChain.run.mockImplementation(() => {
      if (ffmpegOnHandlers['error']) {
        ffmpegOnHandlers['error'](new Error('ffmpeg crashed'));
      }
    });

    await expect(estimateMotionMagnitude('/fake/video.mp4', 0, 2)).resolves.not.toThrow();
  });

  it('returns a numeric value for valid inputs with identical frames', async () => {
    // All frames return the same buffer → differences should be 0
    mockSharpChain.toBuffer.mockResolvedValue(Buffer.alloc(64 * 64, 100));

    const result = await estimateMotionMagnitude('/fake/video.mp4', 0, 2);
    expect(result).toBe(0);
  });

  it('returns a positive value when frames differ', async () => {
    let callCount = 0;
    mockSharpChain.toBuffer.mockImplementation(async () => {
      callCount++;
      // Alternate between bright and dark frames
      const value = callCount % 2 === 0 ? 200 : 50;
      return Buffer.alloc(64 * 64, value);
    });

    const result = await estimateMotionMagnitude('/fake/video.mp4', 0, 2);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(0);
  });
});

describe('estimatePitchAngle', () => {
  let estimatePitchAngle: typeof import('./junkClipDetector').estimatePitchAngle;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFfmpegChain.run.mockImplementation(() => {
      if (ffmpegOnHandlers['end']) {
        ffmpegOnHandlers['end']();
      }
    });
    mockSharpChain.toBuffer.mockResolvedValue(Buffer.alloc(64 * 64, 128));

    const mod = await import('./junkClipDetector');
    estimatePitchAngle = mod.estimatePitchAngle;
  });

  it('returns null when duration is zero or negative', async () => {
    const result = await estimatePitchAngle('/fake/video.mp4', 3, 3);
    expect(result).toBeNull();
  });

  it('returns null when all frame extractions fail', async () => {
    mockFfmpegChain.run.mockImplementation(() => {
      if (ffmpegOnHandlers['error']) {
        ffmpegOnHandlers['error'](new Error('ffmpeg failed'));
      }
    });

    const result = await estimatePitchAngle('/fake/video.mp4', 0, 2);
    expect(result).toBeNull();
  });

  it('does not throw on ffmpeg errors', async () => {
    mockFfmpegChain.run.mockImplementation(() => {
      if (ffmpegOnHandlers['error']) {
        ffmpegOnHandlers['error'](new Error('ffmpeg crashed'));
      }
    });

    await expect(estimatePitchAngle('/fake/video.mp4', 0, 2)).resolves.not.toThrow();
  });

  it('returns a numeric value for valid inputs', async () => {
    const result = await estimatePitchAngle('/fake/video.mp4', 0, 2);
    expect(result).not.toBeNull();
    expect(typeof result).toBe('number');
  });

  it('returns a value between 0 and 90 degrees', async () => {
    const result = await estimatePitchAngle('/fake/video.mp4', 0, 2);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThanOrEqual(0);
    expect(result!).toBeLessThanOrEqual(90);
  });
});

describe('detectAccidentalTouch', () => {
  let detectAccidentalTouch: typeof import('./junkClipDetector').detectAccidentalTouch;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFfmpegChain.run.mockImplementation(() => {
      if (ffmpegOnHandlers['end']) {
        ffmpegOnHandlers['end']();
      }
    });
    mockSharpChain.toBuffer.mockResolvedValue(Buffer.alloc(64 * 64, 128));

    const mod = await import('./junkClipDetector');
    detectAccidentalTouch = mod.detectAccidentalTouch;
  });

  it('returns false when duration is zero or negative', async () => {
    const result = await detectAccidentalTouch('/fake/video.mp4', 5, 5);
    expect(result).toBe(false);
  });

  it('returns false when all frame extractions fail', async () => {
    mockFfmpegChain.run.mockImplementation(() => {
      if (ffmpegOnHandlers['error']) {
        ffmpegOnHandlers['error'](new Error('ffmpeg failed'));
      }
    });

    const result = await detectAccidentalTouch('/fake/video.mp4', 0, 2);
    expect(result).toBe(false);
  });

  it('does not throw on ffmpeg errors', async () => {
    mockFfmpegChain.run.mockImplementation(() => {
      if (ffmpegOnHandlers['error']) {
        ffmpegOnHandlers['error'](new Error('ffmpeg crashed'));
      }
    });

    await expect(detectAccidentalTouch('/fake/video.mp4', 0, 2)).resolves.not.toThrow();
  });

  it('returns a boolean value for valid inputs', async () => {
    const result = await detectAccidentalTouch('/fake/video.mp4', 0, 2);
    expect(typeof result).toBe('boolean');
  });

  it('returns false when all frames are identical (no motion)', async () => {
    // All frames return the same buffer → no motion pattern
    mockSharpChain.toBuffer.mockResolvedValue(Buffer.alloc(64 * 64, 100));

    const result = await detectAccidentalTouch('/fake/video.mp4', 0, 2);
    expect(result).toBe(false);
  });
});

// --- Task 6.1: Lens occlusion detection tests ---

describe('detectLensOcclusion', () => {
  let detectLensOcclusion: typeof import('./junkClipDetector').detectLensOcclusion;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFfmpegChain.run.mockImplementation(() => {
      if (ffmpegOnHandlers['end']) {
        ffmpegOnHandlers['end']();
      }
    });
    mockSharpChain.toBuffer.mockResolvedValue(Buffer.alloc(64 * 64, 128));

    const mod = await import('./junkClipDetector');
    detectLensOcclusion = mod.detectLensOcclusion;
  });

  it('returns isOccluded=false when duration is zero or negative', async () => {
    const result = await detectLensOcclusion('/fake/video.mp4', 5, 5);
    expect(result.isOccluded).toBe(false);
    expect(result.occlusionRatio).toBe(0);
  });

  it('returns isOccluded=false when all frame extractions fail', async () => {
    mockFfmpegChain.run.mockImplementation(() => {
      if (ffmpegOnHandlers['error']) {
        ffmpegOnHandlers['error'](new Error('ffmpeg failed'));
      }
    });

    const result = await detectLensOcclusion('/fake/video.mp4', 0, 2);
    expect(result.isOccluded).toBe(false);
    expect(result.occlusionRatio).toBe(0);
  });

  it('detects occlusion when frames have low variance and low edge density', async () => {
    // Uniform gray frame → very low variance and no edges
    mockSharpChain.toBuffer.mockResolvedValue(Buffer.alloc(64 * 64, 100));

    const result = await detectLensOcclusion('/fake/video.mp4', 0, 5, {
      varianceThreshold: 300,
      edgeThreshold: 0.05,
    });
    expect(result.isOccluded).toBe(true);
    expect(result.occlusionRatio).toBe(1.0);
  });

  it('does not detect occlusion when frames have high variance', async () => {
    // Create a buffer with high variance (alternating pixel values)
    const buf = Buffer.alloc(64 * 64);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = i % 2 === 0 ? 0 : 255;
    }
    mockSharpChain.toBuffer.mockResolvedValue(buf);

    const result = await detectLensOcclusion('/fake/video.mp4', 0, 5, {
      varianceThreshold: 300,
      edgeThreshold: 0.05,
    });
    // High variance means not occluded
    expect(result.isOccluded).toBe(false);
  });

  it('skips failed frames and continues analysis (fault tolerance)', async () => {
    let callCount = 0;
    mockFfmpegChain.run.mockImplementation(() => {
      callCount++;
      // Fail on frames 2 and 4, succeed on 1, 3, 5
      if (callCount === 2 || callCount === 4) {
        if (ffmpegOnHandlers['error']) {
          ffmpegOnHandlers['error'](new Error('frame extraction failed'));
        }
      } else {
        if (ffmpegOnHandlers['end']) {
          ffmpegOnHandlers['end']();
        }
      }
    });
    // Uniform frame → occluded
    mockSharpChain.toBuffer.mockResolvedValue(Buffer.alloc(64 * 64, 100));

    const result = await detectLensOcclusion('/fake/video.mp4', 0, 5, {
      varianceThreshold: 300,
      edgeThreshold: 0.05,
    });
    // 3 out of 3 successful frames are occluded → ratio = 1.0
    expect(result.isOccluded).toBe(true);
    expect(result.occlusionRatio).toBe(1.0);
  });

  it('does not throw on ffmpeg errors', async () => {
    mockFfmpegChain.run.mockImplementation(() => {
      if (ffmpegOnHandlers['error']) {
        ffmpegOnHandlers['error'](new Error('ffmpeg crashed'));
      }
    });

    await expect(detectLensOcclusion('/fake/video.mp4', 0, 2)).resolves.not.toThrow();
  });
});

describe('computePixelVariance', () => {
  it('returns 0 for empty buffer', () => {
    expect(computePixelVariance(Buffer.alloc(0))).toBe(0);
  });

  it('returns 0 for uniform buffer', () => {
    const buf = Buffer.alloc(100, 128);
    expect(computePixelVariance(buf)).toBe(0);
  });

  it('returns correct variance for known values', () => {
    // Buffer with values [0, 255] → mean = 127.5, variance = (127.5^2 + 127.5^2)/2 = 127.5^2
    const buf = Buffer.from([0, 255]);
    const expected = 127.5 * 127.5; // 16256.25
    expect(computePixelVariance(buf)).toBeCloseTo(expected, 1);
  });

  it('returns positive variance for non-uniform buffer', () => {
    const buf = Buffer.alloc(64 * 64);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = i % 256;
    }
    expect(computePixelVariance(buf)).toBeGreaterThan(0);
  });
});

describe('computeEdgeDensity', () => {
  it('returns 0 for uniform image', () => {
    const buf = Buffer.alloc(64 * 64, 128);
    expect(computeEdgeDensity(buf, 64, 64)).toBe(0);
  });

  it('returns 0 for image smaller than 3x3', () => {
    const buf = Buffer.alloc(4, 128);
    expect(computeEdgeDensity(buf, 2, 2)).toBe(0);
  });

  it('returns positive edge density for image with edges', () => {
    // Create a 64x64 image with a vertical edge in the middle
    const buf = Buffer.alloc(64 * 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        buf[y * 64 + x] = x < 32 ? 0 : 255;
      }
    }
    const density = computeEdgeDensity(buf, 64, 64);
    expect(density).toBeGreaterThan(0);
  });

  it('returns edge density in [0, 1] range', () => {
    const buf = Buffer.alloc(64 * 64);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = Math.floor(Math.random() * 256);
    }
    const density = computeEdgeDensity(buf, 64, 64);
    expect(density).toBeGreaterThanOrEqual(0);
    expect(density).toBeLessThanOrEqual(1);
  });
});

describe('classifyJunkClip - lens_occlusion priority', () => {
  it('classifies as lens_occlusion when occlusionRatio > 0.7', () => {
    const result = classifyJunkClip(2.0, null, null, false, undefined, 0.85);
    expect(result.isJunk).toBe(true);
    expect(result.reason).toBe('lens_occlusion');
  });

  it('does not classify as lens_occlusion when occlusionRatio <= 0.7', () => {
    const result = classifyJunkClip(2.0, null, null, false, undefined, 0.5);
    expect(result.isJunk).toBe(false);
  });

  it('lens_occlusion takes priority over accidental_touch', () => {
    const result = classifyJunkClip(2.0, null, null, true, undefined, 0.85);
    expect(result.reason).toBe('lens_occlusion');
  });

  it('ground_shot takes priority over lens_occlusion', () => {
    const result = classifyJunkClip(2.0, null, 75, false, undefined, 0.85);
    expect(result.reason).toBe('ground_shot');
  });

  it('extreme_blur takes priority over lens_occlusion', () => {
    const result = classifyJunkClip(2.0, 100, null, false, undefined, 0.85);
    expect(result.reason).toBe('extreme_blur');
  });

  it('too_short takes priority over lens_occlusion', () => {
    const result = classifyJunkClip(0.5, null, null, false, undefined, 0.85);
    expect(result.reason).toBe('too_short');
  });

  it('uses custom occlusionFrameRatio from options', () => {
    // With ratio 0.9, occlusionRatio 0.85 should NOT trigger
    const result = classifyJunkClip(2.0, null, null, false, { occlusionFrameRatio: 0.9 }, 0.85);
    expect(result.isJunk).toBe(false);
  });

  it('does not classify as lens_occlusion when occlusionRatio is null', () => {
    const result = classifyJunkClip(2.0, null, null, false, undefined, null);
    expect(result.isJunk).toBe(false);
  });
});

describe('parseOcclusionEnvVars', () => {
  let parseOcclusionEnvVars: typeof import('./junkClipDetector').parseOcclusionEnvVars;

  beforeEach(async () => {
    const mod = await import('./junkClipDetector');
    parseOcclusionEnvVars = mod.parseOcclusionEnvVars;
  });

  it('returns defaults when env vars are not set', () => {
    delete process.env.VIDEO_OCCLUSION_VARIANCE_THRESHOLD;
    delete process.env.VIDEO_OCCLUSION_EDGE_THRESHOLD;
    const result = parseOcclusionEnvVars();
    expect(result.varianceThreshold).toBe(300);
    expect(result.edgeThreshold).toBe(0.05);
  });

  it('parses valid variance threshold from env', () => {
    process.env.VIDEO_OCCLUSION_VARIANCE_THRESHOLD = '500';
    const result = parseOcclusionEnvVars();
    expect(result.varianceThreshold).toBe(500);
    delete process.env.VIDEO_OCCLUSION_VARIANCE_THRESHOLD;
  });

  it('parses valid edge threshold from env', () => {
    process.env.VIDEO_OCCLUSION_EDGE_THRESHOLD = '0.1';
    const result = parseOcclusionEnvVars();
    expect(result.edgeThreshold).toBe(0.1);
    delete process.env.VIDEO_OCCLUSION_EDGE_THRESHOLD;
  });

  it('uses default for invalid variance threshold (non-positive)', () => {
    process.env.VIDEO_OCCLUSION_VARIANCE_THRESHOLD = '-10';
    const result = parseOcclusionEnvVars();
    expect(result.varianceThreshold).toBe(300);
    delete process.env.VIDEO_OCCLUSION_VARIANCE_THRESHOLD;
  });

  it('uses default for invalid edge threshold (out of range)', () => {
    process.env.VIDEO_OCCLUSION_EDGE_THRESHOLD = '1.5';
    const result = parseOcclusionEnvVars();
    expect(result.edgeThreshold).toBe(0.05);
    delete process.env.VIDEO_OCCLUSION_EDGE_THRESHOLD;
  });

  it('uses default for non-numeric variance threshold', () => {
    process.env.VIDEO_OCCLUSION_VARIANCE_THRESHOLD = 'abc';
    const result = parseOcclusionEnvVars();
    expect(result.varianceThreshold).toBe(300);
    delete process.env.VIDEO_OCCLUSION_VARIANCE_THRESHOLD;
  });
});
