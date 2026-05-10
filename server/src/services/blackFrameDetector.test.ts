import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fc from 'fast-check';
import {
  computeFrameBrightness,
  classifyBlackFrames,
  detectBlackFrames,
  parseNearBlackThreshold,
  parseNearBlackRatioThreshold,
} from './blackFrameDetector';

// --- Mocks for detectBlackFrames tests ---

// Track ffmpeg calls for assertions
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
    // By default, resolve successfully (trigger 'end')
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

// Mock sharp to return a grayscale raw buffer
const mockSharpChain = {
  grayscale: vi.fn().mockReturnThis(),
  raw: vi.fn().mockReturnThis(),
  toBuffer: vi.fn().mockResolvedValue(Buffer.alloc(100, 128)), // default: mid-brightness
};

vi.mock('sharp', () => ({
  default: vi.fn(() => mockSharpChain),
}));

// Mock fs operations used by detectBlackFrames
vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      mkdtempSync: vi.fn(() => '/tmp/blackframe-test'),
      rmSync: vi.fn(),
    },
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn(() => '/tmp/blackframe-test'),
    rmSync: vi.fn(),
  };
});

// Mock getTempDir helper
vi.mock('../helpers/tempDir', () => ({
  getTempDir: () => '/tmp',
}));

// Mock database (not needed for detectBlackFrames but imported by the module)
vi.mock('../database', () => ({
  getDb: vi.fn(),
}));

describe('computeFrameBrightness', () => {
  it('returns 0 for an empty buffer', () => {
    const buf = Buffer.alloc(0);
    expect(computeFrameBrightness(buf)).toBe(0);
  });

  it('returns 0 for an all-black buffer', () => {
    const buf = Buffer.alloc(100, 0);
    expect(computeFrameBrightness(buf)).toBe(0);
  });

  it('returns 255 for an all-white buffer', () => {
    const buf = Buffer.alloc(100, 255);
    expect(computeFrameBrightness(buf)).toBe(255);
  });

  it('returns the correct mean for a mixed buffer', () => {
    // 4 pixels: 0, 100, 200, 100 → mean = 100
    const buf = Buffer.from([0, 100, 200, 100]);
    expect(computeFrameBrightness(buf)).toBe(100);
  });

  it('returns the correct mean for a single pixel', () => {
    const buf = Buffer.from([128]);
    expect(computeFrameBrightness(buf)).toBe(128);
  });

  it('handles a large buffer correctly', () => {
    // 1000 pixels all set to 50
    const buf = Buffer.alloc(1000, 50);
    expect(computeFrameBrightness(buf)).toBe(50);
  });
});

describe('classifyBlackFrames', () => {
  it('returns defaults for an empty array', () => {
    const result = classifyBlackFrames([]);
    expect(result.blackFrameRatio).toBe(0);
    expect(result.blackFrameScore).toBe(1.0);
    expect(result.isBlackFrameSegment).toBe(false);
    expect(result.sampledFrameCount).toBe(0);
    expect(result.blackFrameCount).toBe(0);
    expect(result.thresholdUsed).toBe(10);
    // Near-black defaults
    expect(result.nearBlackRatio).toBe(0);
    expect(result.nearBlackFrameCount).toBe(0);
    expect(result.isNearBlackSegment).toBe(false);
    expect(result.nearBlackThresholdUsed).toBe(20);
  });

  it('classifies all-black frames correctly', () => {
    const brightnesses = [0, 1, 2, 3, 5]; // all < 10
    const result = classifyBlackFrames(brightnesses);
    expect(result.blackFrameRatio).toBe(1.0);
    expect(result.blackFrameScore).toBe(0.0);
    expect(result.isBlackFrameSegment).toBe(true);
    expect(result.sampledFrameCount).toBe(5);
    expect(result.blackFrameCount).toBe(5);
  });

  it('classifies no-black frames correctly', () => {
    const brightnesses = [100, 150, 200, 128, 255]; // all >= 10
    const result = classifyBlackFrames(brightnesses);
    expect(result.blackFrameRatio).toBe(0.0);
    expect(result.blackFrameScore).toBe(1.0);
    expect(result.isBlackFrameSegment).toBe(false);
    expect(result.blackFrameCount).toBe(0);
  });

  it('classifies mixed frames correctly', () => {
    // 4 out of 5 are black (ratio = 0.8), but isBlackFrameSegment requires > 0.8
    const brightnesses = [0, 1, 2, 3, 100];
    const result = classifyBlackFrames(brightnesses);
    expect(result.blackFrameRatio).toBe(0.8);
    expect(result.blackFrameScore).toBeCloseTo(0.2);
    expect(result.isBlackFrameSegment).toBe(false); // 0.8 is NOT > 0.8
    expect(result.blackFrameCount).toBe(4);
  });

  it('marks segment as black when ratio exceeds threshold', () => {
    // 9 out of 10 are black (ratio = 0.9 > 0.8)
    const brightnesses = [0, 1, 2, 3, 4, 5, 6, 7, 8, 100];
    const result = classifyBlackFrames(brightnesses);
    expect(result.blackFrameRatio).toBe(0.9);
    expect(result.isBlackFrameSegment).toBe(true);
  });

  it('respects custom brightnessThreshold', () => {
    const brightnesses = [5, 15, 25]; // with threshold 20: 5 and 15 are black
    const result = classifyBlackFrames(brightnesses, { brightnessThreshold: 20 });
    expect(result.blackFrameCount).toBe(2);
    expect(result.thresholdUsed).toBe(20);
  });

  it('respects custom ratioThreshold', () => {
    // 3 out of 5 are black (ratio = 0.6)
    const brightnesses = [0, 1, 2, 100, 200];
    const result = classifyBlackFrames(brightnesses, { ratioThreshold: 0.5 });
    expect(result.isBlackFrameSegment).toBe(true); // 0.6 > 0.5
  });
});

describe('classifyBlackFrames - Property-Based Tests', () => {
  // Feature: v2-video-processing, Property 1: Black Frame Score Bounded
  // For any array of brightness values (each in [0, 255]), the computed blackFrameScore
  // SHALL always be in [0.0, 1.0], and blackFrameScore = 1.0 - blackFrameRatio.
  // **Validates: Requirements 1.6**
  it('Property 1: blackFrameScore is always in [0, 1] and equals 1 - blackFrameRatio', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1 }),
        (brightnesses) => {
          const result = classifyBlackFrames(brightnesses);

          // blackFrameScore must be in [0.0, 1.0]
          expect(result.blackFrameScore).toBeGreaterThanOrEqual(0.0);
          expect(result.blackFrameScore).toBeLessThanOrEqual(1.0);

          // blackFrameRatio must be in [0.0, 1.0]
          expect(result.blackFrameRatio).toBeGreaterThanOrEqual(0.0);
          expect(result.blackFrameRatio).toBeLessThanOrEqual(1.0);

          // blackFrameScore = 1.0 - blackFrameRatio
          expect(result.blackFrameScore).toBeCloseTo(1.0 - result.blackFrameRatio, 10);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: v2-video-processing, Property 2: Black Frame Classification Consistency
  // For any array of brightness values and threshold T:
  // - If ALL values < T then blackFrameRatio = 1.0 and isBlackFrameSegment = true
  // - If NO values < T then blackFrameRatio = 0.0 and isBlackFrameSegment = false
  // **Validates: Requirements 1.2, 1.3**
  it('Property 2: all-black case — if all values < threshold then ratio=1.0 and isBlackFrameSegment=true', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 255 }),  // threshold T (at least 1 so values can be below it)
        fc.array(fc.integer({ min: 0, max: 254 }), { minLength: 1 }),  // brightness values
        (threshold, brightnesses) => {
          // Ensure all values are strictly below the threshold
          const allBelowThreshold = brightnesses.map(v => v % threshold);

          const result = classifyBlackFrames(allBelowThreshold, { brightnessThreshold: threshold });

          expect(result.blackFrameRatio).toBe(1.0);
          expect(result.isBlackFrameSegment).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 2: no-black case — if no values < threshold then ratio=0.0 and isBlackFrameSegment=false', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 254 }),  // threshold T
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1 }),  // base brightness values
        (threshold, brightnesses) => {
          // Ensure all values are >= threshold
          const allAboveOrEqualThreshold = brightnesses.map(v => threshold + (v % (256 - threshold)));

          const result = classifyBlackFrames(allAboveOrEqualThreshold, { brightnessThreshold: threshold });

          expect(result.blackFrameRatio).toBe(0.0);
          expect(result.isBlackFrameSegment).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: v2-video-processing, Property 1 (supplemental): blackFrameScore + blackFrameRatio = 1.0
  // For any non-empty input, the sum of blackFrameScore and blackFrameRatio equals 1.0.
  // **Validates: Requirements 1.6**
  it('blackFrameScore + blackFrameRatio = 1.0 for any non-empty input', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1 }),
        (brightnesses) => {
          const result = classifyBlackFrames(brightnesses);

          expect(result.blackFrameScore + result.blackFrameRatio).toBeCloseTo(1.0, 10);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('classifyBlackFrames - Near-Black Frame Detection', () => {
  it('detects near-black frames with default thresholds', () => {
    // Frames with brightness 15: above pure-black threshold (10) but below near-black threshold (20)
    const brightnesses = [15, 15, 15, 15, 15, 15, 15, 15, 15, 15];
    const result = classifyBlackFrames(brightnesses, {
      brightnessThreshold: 10,
      nearBlackThreshold: 20,
      nearBlackRatioThreshold: 0.9,
    });

    expect(result.blackFrameCount).toBe(0); // 15 >= 10
    expect(result.nearBlackFrameCount).toBe(10); // 15 < 20
    expect(result.nearBlackRatio).toBe(1.0);
    expect(result.isNearBlackSegment).toBe(true);
    expect(result.isBlackFrameSegment).toBe(false);
    expect(result.nearBlackThresholdUsed).toBe(20);
  });

  it('does not mark as near-black when ratio is below threshold', () => {
    // 8 out of 10 frames are near-black (ratio = 0.8 < 0.9)
    const brightnesses = [15, 15, 15, 15, 15, 15, 15, 15, 100, 100];
    const result = classifyBlackFrames(brightnesses, {
      brightnessThreshold: 10,
      nearBlackThreshold: 20,
      nearBlackRatioThreshold: 0.9,
    });

    expect(result.nearBlackFrameCount).toBe(8);
    expect(result.nearBlackRatio).toBe(0.8);
    expect(result.isNearBlackSegment).toBe(false);
  });

  it('pure black takes priority over near-black', () => {
    // All frames are pure black (brightness < 10), which also means < 20
    // Both conditions met: blackFrameRatio = 1.0 > 0.8 AND nearBlackRatio = 1.0 > 0.9
    // Priority: isBlackFrameSegment = true, isNearBlackSegment = false
    const brightnesses = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const result = classifyBlackFrames(brightnesses, {
      brightnessThreshold: 10,
      ratioThreshold: 0.8,
      nearBlackThreshold: 20,
      nearBlackRatioThreshold: 0.9,
    });

    expect(result.blackFrameRatio).toBe(1.0);
    expect(result.isBlackFrameSegment).toBe(true);
    expect(result.nearBlackRatio).toBe(1.0);
    expect(result.isNearBlackSegment).toBe(false); // Priority: pure black wins
  });

  it('near-black ratio counts frames below nearBlackThreshold independently', () => {
    // Mix: some pure black, some near-black, some bright
    // Pure black (< 10): 5, 8 → 2 frames
    // Near-black (< 20): 5, 8, 12, 15, 18 → 5 frames
    const brightnesses = [5, 8, 12, 15, 18, 50, 100, 150, 200, 250];
    const result = classifyBlackFrames(brightnesses, {
      brightnessThreshold: 10,
      nearBlackThreshold: 20,
      nearBlackRatioThreshold: 0.9,
    });

    expect(result.blackFrameCount).toBe(2);
    expect(result.blackFrameRatio).toBe(0.2);
    expect(result.nearBlackFrameCount).toBe(5);
    expect(result.nearBlackRatio).toBe(0.5);
    expect(result.isBlackFrameSegment).toBe(false);
    expect(result.isNearBlackSegment).toBe(false);
  });

  it('respects custom nearBlackThreshold', () => {
    const brightnesses = [25, 30, 35, 40, 45];
    const result = classifyBlackFrames(brightnesses, {
      nearBlackThreshold: 50,
      nearBlackRatioThreshold: 0.9,
    });

    expect(result.nearBlackFrameCount).toBe(5); // all < 50
    expect(result.nearBlackRatio).toBe(1.0);
    expect(result.isNearBlackSegment).toBe(true);
    expect(result.nearBlackThresholdUsed).toBe(50);
  });

  it('respects custom nearBlackRatioThreshold', () => {
    // 7 out of 10 are near-black (ratio = 0.7)
    const brightnesses = [15, 15, 15, 15, 15, 15, 15, 100, 100, 100];
    const result = classifyBlackFrames(brightnesses, {
      nearBlackThreshold: 20,
      nearBlackRatioThreshold: 0.6, // lower threshold
    });

    expect(result.nearBlackRatio).toBe(0.7);
    expect(result.isNearBlackSegment).toBe(true); // 0.7 > 0.6
  });
});

describe('parseNearBlackThreshold', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VIDEO_NEAR_BLACK_THRESHOLD;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns default 20 when env is not set', () => {
    expect(parseNearBlackThreshold()).toBe(20);
  });

  it('returns parsed value when valid', () => {
    process.env.VIDEO_NEAR_BLACK_THRESHOLD = '30';
    expect(parseNearBlackThreshold()).toBe(30);
  });

  it('returns default for value below range', () => {
    process.env.VIDEO_NEAR_BLACK_THRESHOLD = '0';
    expect(parseNearBlackThreshold()).toBe(20);
  });

  it('returns default for value above range', () => {
    process.env.VIDEO_NEAR_BLACK_THRESHOLD = '256';
    expect(parseNearBlackThreshold()).toBe(20);
  });

  it('returns default for non-numeric value', () => {
    process.env.VIDEO_NEAR_BLACK_THRESHOLD = 'abc';
    expect(parseNearBlackThreshold()).toBe(20);
  });

  it('returns default for empty string', () => {
    process.env.VIDEO_NEAR_BLACK_THRESHOLD = '';
    expect(parseNearBlackThreshold()).toBe(20);
  });

  it('rounds float values to integer', () => {
    process.env.VIDEO_NEAR_BLACK_THRESHOLD = '25.7';
    expect(parseNearBlackThreshold()).toBe(26);
  });

  it('returns default for Infinity', () => {
    process.env.VIDEO_NEAR_BLACK_THRESHOLD = 'Infinity';
    expect(parseNearBlackThreshold()).toBe(20);
  });
});

describe('parseNearBlackRatioThreshold', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VIDEO_NEAR_BLACK_RATIO;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns default 0.9 when env is not set', () => {
    expect(parseNearBlackRatioThreshold()).toBe(0.9);
  });

  it('returns parsed value when valid', () => {
    process.env.VIDEO_NEAR_BLACK_RATIO = '0.8';
    expect(parseNearBlackRatioThreshold()).toBe(0.8);
  });

  it('accepts 0.0 as valid', () => {
    process.env.VIDEO_NEAR_BLACK_RATIO = '0.0';
    expect(parseNearBlackRatioThreshold()).toBe(0.0);
  });

  it('accepts 1.0 as valid', () => {
    process.env.VIDEO_NEAR_BLACK_RATIO = '1.0';
    expect(parseNearBlackRatioThreshold()).toBe(1.0);
  });

  it('returns default for value below range', () => {
    process.env.VIDEO_NEAR_BLACK_RATIO = '-0.1';
    expect(parseNearBlackRatioThreshold()).toBe(0.9);
  });

  it('returns default for value above range', () => {
    process.env.VIDEO_NEAR_BLACK_RATIO = '1.1';
    expect(parseNearBlackRatioThreshold()).toBe(0.9);
  });

  it('returns default for non-numeric value', () => {
    process.env.VIDEO_NEAR_BLACK_RATIO = 'xyz';
    expect(parseNearBlackRatioThreshold()).toBe(0.9);
  });

  it('returns default for NaN', () => {
    process.env.VIDEO_NEAR_BLACK_RATIO = 'NaN';
    expect(parseNearBlackRatioThreshold()).toBe(0.9);
  });
});

describe('detectBlackFrames', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset ffmpeg to succeed by default
    mockFfmpegChain.run.mockImplementation(() => {
      if (ffmpegOnHandlers['end']) {
        ffmpegOnHandlers['end']();
      }
    });
    // Reset sharp to return mid-brightness buffer by default
    mockSharpChain.toBuffer.mockResolvedValue(Buffer.alloc(100, 128));
  });

  it('normal segment (2s duration) — samples at least 5 frames and returns valid result', async () => {
    // 2s segment: sampleCount = max(5, ceil(2 * 2.5)) = max(5, 5) = 5
    const result = await detectBlackFrames('/fake/video.mp4', 0, 2);

    // Should have attempted 5 frame extractions
    expect(mockFfmpeg).toHaveBeenCalledTimes(5);

    // Result should be valid BlackFrameResult
    expect(result.sampledFrameCount).toBe(5);
    expect(result.blackFrameRatio).toBeGreaterThanOrEqual(0);
    expect(result.blackFrameRatio).toBeLessThanOrEqual(1);
    expect(result.blackFrameScore).toBeGreaterThanOrEqual(0);
    expect(result.blackFrameScore).toBeLessThanOrEqual(1);
    expect(typeof result.isBlackFrameSegment).toBe('boolean');
    expect(result.blackFrameCount).toBeGreaterThanOrEqual(0);
    expect(result.thresholdUsed).toBe(10);

    // With brightness=128 (all frames), no frames should be black or near-black
    expect(result.blackFrameCount).toBe(0);
    expect(result.blackFrameScore).toBe(1.0);
    expect(result.isBlackFrameSegment).toBe(false);

    // Near-black fields should also be present and valid
    expect(result.nearBlackRatio).toBe(0);
    expect(result.nearBlackFrameCount).toBe(0);
    expect(result.isNearBlackSegment).toBe(false);
    expect(result.nearBlackThresholdUsed).toBe(20);
  });

  it('short segment (<0.5s) — samples exactly 2 frames', async () => {
    // 0.3s segment: duration < 0.5 → sampleCount = 2
    const result = await detectBlackFrames('/fake/video.mp4', 1.0, 1.3);

    // Should have attempted exactly 2 frame extractions
    expect(mockFfmpeg).toHaveBeenCalledTimes(2);
    expect(result.sampledFrameCount).toBe(2);

    // Verify time points: start (1.0) and end (1.3)
    expect(mockFfmpegChain.seekInput).toHaveBeenCalledTimes(2);
  });

  it('frame extraction failure — skips failed frames and continues with remaining', async () => {
    let callCount = 0;
    mockFfmpegChain.run.mockImplementation(() => {
      callCount++;
      // Fail on frames 2 and 4 (0-indexed: 1 and 3)
      if (callCount === 2 || callCount === 4) {
        if (ffmpegOnHandlers['error']) {
          ffmpegOnHandlers['error'](new Error('ffmpeg extraction failed'));
        }
      } else {
        if (ffmpegOnHandlers['end']) {
          ffmpegOnHandlers['end']();
        }
      }
    });

    // 2s segment → 5 frames attempted, 2 fail → 3 succeed
    const result = await detectBlackFrames('/fake/video.mp4', 0, 2);

    expect(mockFfmpeg).toHaveBeenCalledTimes(5);
    // Only 3 frames should have been successfully analyzed
    expect(result.sampledFrameCount).toBe(3);
    // All successful frames have brightness 128 (not black)
    expect(result.blackFrameCount).toBe(0);
    expect(result.blackFrameScore).toBe(1.0);
  });

  it('all frames fail — returns default result (empty brightnesses → score=1.0, isBlackFrame=false)', async () => {
    // Make all ffmpeg extractions fail
    mockFfmpegChain.run.mockImplementation(() => {
      if (ffmpegOnHandlers['error']) {
        ffmpegOnHandlers['error'](new Error('ffmpeg extraction failed'));
      }
    });

    const result = await detectBlackFrames('/fake/video.mp4', 0, 2);

    // All 5 frames failed → empty brightnesses array → classifyBlackFrames([])
    expect(result.sampledFrameCount).toBe(0);
    expect(result.blackFrameRatio).toBe(0);
    expect(result.blackFrameScore).toBe(1.0);
    expect(result.isBlackFrameSegment).toBe(false);
    expect(result.blackFrameCount).toBe(0);
  });

  it('detects black frames when sharp returns dark pixels', async () => {
    // Return all-black buffer (brightness 0 < threshold 10)
    mockSharpChain.toBuffer.mockResolvedValue(Buffer.alloc(100, 0));

    const result = await detectBlackFrames('/fake/video.mp4', 0, 2);

    expect(result.sampledFrameCount).toBe(5);
    expect(result.blackFrameCount).toBe(5);
    expect(result.blackFrameRatio).toBe(1.0);
    expect(result.blackFrameScore).toBe(0.0);
    expect(result.isBlackFrameSegment).toBe(true);
  });

  it('longer segment samples more frames based on duration', async () => {
    // 4s segment: sampleCount = max(5, ceil(4 * 2.5)) = max(5, 10) = 10
    const result = await detectBlackFrames('/fake/video.mp4', 0, 4);

    expect(mockFfmpeg).toHaveBeenCalledTimes(10);
    expect(result.sampledFrameCount).toBe(10);
  });

  it('detects near-black frames when sharp returns dim pixels', async () => {
    // Return near-black buffer (brightness 15: above pure-black 10, below near-black 20)
    mockSharpChain.toBuffer.mockResolvedValue(Buffer.alloc(100, 15));

    const result = await detectBlackFrames('/fake/video.mp4', 0, 2, {
      brightnessThreshold: 10,
      nearBlackThreshold: 20,
      nearBlackRatioThreshold: 0.9,
    });

    expect(result.sampledFrameCount).toBe(5);
    expect(result.blackFrameCount).toBe(0); // 15 >= 10
    expect(result.isBlackFrameSegment).toBe(false);
    expect(result.nearBlackFrameCount).toBe(5); // 15 < 20
    expect(result.nearBlackRatio).toBe(1.0);
    expect(result.isNearBlackSegment).toBe(true);
  });

  it('passes near-black options through to classifyBlackFrames', async () => {
    // Return buffer with brightness 25 (above default near-black threshold 20)
    mockSharpChain.toBuffer.mockResolvedValue(Buffer.alloc(100, 25));

    const result = await detectBlackFrames('/fake/video.mp4', 0, 2, {
      nearBlackThreshold: 30, // custom threshold: 25 < 30
      nearBlackRatioThreshold: 0.9,
    });

    expect(result.nearBlackFrameCount).toBe(5); // 25 < 30
    expect(result.nearBlackRatio).toBe(1.0);
    expect(result.isNearBlackSegment).toBe(true);
    expect(result.nearBlackThresholdUsed).toBe(30);
  });
});
