import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { normalizeSegment, normalizeSegments, detectAudioCodec, getTargetLufs, analyzeLoudness, parseLoudnormOutput, LoudnessAnalysis, NormalizationOptions, startRssMonitoring, getChildProcessRssMB, FfmpegProcessMonitor } from './audioNormalizer';
import * as child_process from 'child_process';
import * as fs from 'fs';
import { EventEmitter } from 'events';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(() => ''),
}));

// Mock fs
vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
  },
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}));

function createMockProcess(exitCode: number, stdout = '', delay = 0) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter() as any;
  proc.stderr = new EventEmitter() as any;
  proc.stdin = new EventEmitter() as any;
  proc.pid = 12345;

  // Add destroy methods to satisfy FD cleanup calls
  proc.stdout.destroy = vi.fn();
  proc.stderr.destroy = vi.fn();

  setTimeout(() => {
    if (stdout) {
      proc.stdout.emit('data', Buffer.from(stdout));
    }
    proc.emit('close', exitCode);
  }, delay);

  return proc;
}

describe('getTargetLufs', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return -16 when AUDIO_TARGET_LUFS is not set', () => {
    delete process.env.AUDIO_TARGET_LUFS;
    expect(getTargetLufs()).toBe(-16);
  });

  it('should return the parsed value when AUDIO_TARGET_LUFS is a valid number', () => {
    process.env.AUDIO_TARGET_LUFS = '-14';
    expect(getTargetLufs()).toBe(-14);
  });

  it('should return -16 when AUDIO_TARGET_LUFS is not a valid number', () => {
    process.env.AUDIO_TARGET_LUFS = 'invalid';
    expect(getTargetLufs()).toBe(-16);
  });

  it('should handle negative float values', () => {
    process.env.AUDIO_TARGET_LUFS = '-23.5';
    expect(getTargetLufs()).toBe(-23.5);
  });

  it('should return -16 when AUDIO_TARGET_LUFS is empty string', () => {
    process.env.AUDIO_TARGET_LUFS = '';
    expect(getTargetLufs()).toBe(-16);
  });
});

describe('analyzeLoudness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return correct LoudnessAnalysis when ffmpeg outputs valid loudnorm JSON', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = new EventEmitter();
    mockSpawn.mockReturnValueOnce(proc as any);

    const promise = analyzeLoudness('/test/segment.mp4');

    // Emit valid loudnorm JSON on stderr (ffmpeg outputs loudnorm data to stderr)
    const loudnormJson = JSON.stringify({
      input_i: '-18.5',
      input_lra: '9.2',
      input_tp: '-3.1',
      input_thresh: '-28.5',
      output_i: '-16.0',
      output_lra: '7.0',
      output_tp: '-1.5',
      output_thresh: '-26.0',
      normalization_type: 'dynamic',
      target_offset: '0.0',
    });
    proc.stderr.emit('data', Buffer.from(`[Parsed_loudnorm_0 @ 0x...] \n${loudnormJson}\n`));
    proc.emit('close', 0);

    const result = await promise;

    expect(result.hasAudio).toBe(true);
    expect(result.integratedLoudness).toBe(-18.5);
    expect(result.loudnessRange).toBe(9.2);
    expect(result.truePeak).toBe(-3.1);
  });

  it('should return hasAudio=false when ffmpeg output indicates no audio stream', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = new EventEmitter();
    mockSpawn.mockReturnValueOnce(proc as any);

    const promise = analyzeLoudness('/test/no-audio.mp4');

    // Emit no-audio indicator on stderr
    proc.stderr.emit('data', Buffer.from('Output file #0 does not contain any stream\n'));
    proc.emit('close', 1);

    const result = await promise;

    expect(result.hasAudio).toBe(false);
    expect(result.integratedLoudness).toBe(-23);
    expect(result.loudnessRange).toBe(0);
    expect(result.truePeak).toBe(0);
  });

  it('should return hasAudio=false when stderr contains "no audio"', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = new EventEmitter();
    mockSpawn.mockReturnValueOnce(proc as any);

    const promise = analyzeLoudness('/test/video-only.mp4');

    proc.stderr.emit('data', Buffer.from('Stream mapping: no audio\n'));
    proc.emit('close', 1);

    const result = await promise;

    expect(result.hasAudio).toBe(false);
    expect(result.integratedLoudness).toBe(-23);
    expect(result.loudnessRange).toBe(0);
    expect(result.truePeak).toBe(0);
  });

  it('should return default values when ffmpeg spawn error occurs', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = new EventEmitter();
    mockSpawn.mockReturnValueOnce(proc as any);

    const promise = analyzeLoudness('/test/segment.mp4');

    // Emit spawn error (e.g., ffmpeg not found)
    proc.emit('error', new Error('spawn ENOENT'));

    const result = await promise;

    expect(result.hasAudio).toBe(true);
    expect(result.integratedLoudness).toBe(-23);
    expect(result.loudnessRange).toBe(7);
    expect(result.truePeak).toBe(-1);
  });

  it('should return default values when ffmpeg outputs unparseable garbage', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = new EventEmitter();
    mockSpawn.mockReturnValueOnce(proc as any);

    const promise = analyzeLoudness('/test/corrupt.mp4');

    // Emit garbage output that doesn't contain valid loudnorm JSON
    proc.stderr.emit('data', Buffer.from('frame= 100 fps=50 q=0.0 size=N/A time=00:00:04.00 bitrate=N/A\nsome random garbage output\n'));
    proc.emit('close', 0);

    const result = await promise;

    expect(result.hasAudio).toBe(true);
    expect(result.integratedLoudness).toBe(-23);
    expect(result.loudnessRange).toBe(7);
    expect(result.truePeak).toBe(-1);
  });

  it('should call ffmpeg with correct arguments', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = new EventEmitter();
    mockSpawn.mockReturnValueOnce(proc as any);

    const promise = analyzeLoudness('/path/to/video.mp4');

    proc.stderr.emit('data', Buffer.from('garbage'));
    proc.emit('close', 0);

    await promise;

    expect(mockSpawn).toHaveBeenCalledWith('ffmpeg', [
      '-i', '/path/to/video.mp4',
      '-af', 'loudnorm=print_format=json',
      '-f', 'null',
      '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  });
});

describe('parseLoudnormOutput', () => {
  it('should parse valid loudnorm JSON from stderr', () => {
    const stderr = `[Parsed_loudnorm_0 @ 0x7f8b8c000000]
{
  "input_i": "-20.3",
  "input_lra": "8.5",
  "input_tp": "-4.2",
  "input_thresh": "-30.3"
}`;

    const result = parseLoudnormOutput(stderr);

    expect(result).not.toBeNull();
    expect(result!.hasAudio).toBe(true);
    expect(result!.integratedLoudness).toBe(-20.3);
    expect(result!.loudnessRange).toBe(8.5);
    expect(result!.truePeak).toBe(-4.2);
  });

  it('should return null when no JSON block is found', () => {
    const stderr = 'frame= 100 fps=50 q=0.0 size=N/A time=00:00:04.00\n';
    const result = parseLoudnormOutput(stderr);
    expect(result).toBeNull();
  });

  it('should return null when JSON has NaN values', () => {
    const stderr = `{
  "input_i": "nan",
  "input_lra": "8.5",
  "input_tp": "-4.2"
}`;
    const result = parseLoudnormOutput(stderr);
    expect(result).toBeNull();
  });
});

describe('normalizeSegment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should skip normalization when analysis has no audio', async () => {
    const analysis: LoudnessAnalysis = {
      integratedLoudness: -23,
      loudnessRange: 0,
      truePeak: 0,
      hasAudio: false,
    };

    const result = await normalizeSegment('/input.mp4', '/output.mp4', analysis);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_audio');
    expect(result.normalizedPath).toBeNull();
    expect(result.targetLoudness).toBe(-16);
  });

  it('should skip normalization when loudness is within tolerance', async () => {
    const analysis: LoudnessAnalysis = {
      integratedLoudness: -16.5,
      loudnessRange: 7,
      truePeak: -2,
      hasAudio: true,
    };

    const result = await normalizeSegment('/input.mp4', '/output.mp4', analysis);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('within_tolerance');
    expect(result.normalizedPath).toBeNull();
  });

  it('should skip when exactly at tolerance boundary', async () => {
    const analysis: LoudnessAnalysis = {
      integratedLoudness: -17.0, // |(-17) - (-16)| = 1.0 = tolerance
      loudnessRange: 7,
      truePeak: -2,
      hasAudio: true,
    };

    const result = await normalizeSegment('/input.mp4', '/output.mp4', analysis);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('within_tolerance');
  });

  it('should normalize when loudness exceeds tolerance', async () => {
    const analysis: LoudnessAnalysis = {
      integratedLoudness: -25,
      loudnessRange: 7,
      truePeak: -2,
      hasAudio: true,
    };

    const mockSpawn = vi.mocked(child_process.spawn);

    // First call: ffprobe to detect codec → returns 'aac'
    const ffprobeProc = createMockProcess(0, 'aac');
    // Second call: ffmpeg normalization with AAC → success
    const ffmpegProc = createMockProcess(0);

    mockSpawn
      .mockReturnValueOnce(ffprobeProc as any)
      .mockReturnValueOnce(ffmpegProc as any);

    const result = await normalizeSegment('/input.mp4', '/output.mp4', analysis);

    expect(result.skipped).toBe(false);
    expect(result.reason).toBe('normalized');
    expect(result.normalizedPath).toBe('/output.mp4');
    expect(result.originalLoudness).toBe(-25);
    expect(result.targetLoudness).toBe(-16);
  });

  it('should try original codec first, then fallback to AAC on failure', async () => {
    const analysis: LoudnessAnalysis = {
      integratedLoudness: -25,
      loudnessRange: 7,
      truePeak: -2,
      hasAudio: true,
    };

    const mockSpawn = vi.mocked(child_process.spawn);

    // ffprobe returns 'opus'
    const ffprobeProc = createMockProcess(0, 'opus');
    // First ffmpeg attempt with opus → fails
    const ffmpegFail = createMockProcess(1);
    // Second ffmpeg attempt with AAC → succeeds
    const ffmpegSuccess = createMockProcess(0);

    mockSpawn
      .mockReturnValueOnce(ffprobeProc as any)
      .mockReturnValueOnce(ffmpegFail as any)
      .mockReturnValueOnce(ffmpegSuccess as any);

    const result = await normalizeSegment('/input.mp4', '/output.mp4', analysis);

    expect(result.skipped).toBe(false);
    expect(result.reason).toBe('normalized');
    expect(result.normalizedPath).toBe('/output.mp4');

    // Verify the first ffmpeg call used opus codec
    const secondCall = mockSpawn.mock.calls[1];
    expect(secondCall[1]).toContain('opus');

    // Verify the fallback call used aac
    const thirdCall = mockSpawn.mock.calls[2];
    expect(thirdCall[1]).toContain('aac');
  });

  it('should return error when both codec attempts fail', async () => {
    const analysis: LoudnessAnalysis = {
      integratedLoudness: -25,
      loudnessRange: 7,
      truePeak: -2,
      hasAudio: true,
    };

    const mockSpawn = vi.mocked(child_process.spawn);

    // ffprobe returns 'opus'
    const ffprobeProc = createMockProcess(0, 'opus');
    // First ffmpeg attempt with opus → fails
    const ffmpegFail1 = createMockProcess(1);
    // Second ffmpeg attempt with AAC → also fails
    const ffmpegFail2 = createMockProcess(1);

    mockSpawn
      .mockReturnValueOnce(ffprobeProc as any)
      .mockReturnValueOnce(ffmpegFail1 as any)
      .mockReturnValueOnce(ffmpegFail2 as any);

    const result = await normalizeSegment('/input.mp4', '/output.mp4', analysis);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('error');
    expect(result.normalizedPath).toBeNull();
  });

  it('should use custom options when provided', async () => {
    const analysis: LoudnessAnalysis = {
      integratedLoudness: -20,
      loudnessRange: 5,
      truePeak: -1,
      hasAudio: true,
    };

    const options: NormalizationOptions = {
      targetLufs: -14,
      truePeakLimit: -2.0,
      tolerance: 2.0,
    };

    // |(-20) - (-14)| = 6 > 2.0 tolerance, so should normalize
    const mockSpawn = vi.mocked(child_process.spawn);

    const ffprobeProc = createMockProcess(0, 'aac');
    const ffmpegProc = createMockProcess(0);

    mockSpawn
      .mockReturnValueOnce(ffprobeProc as any)
      .mockReturnValueOnce(ffmpegProc as any);

    const result = await normalizeSegment('/input.mp4', '/output.mp4', analysis, options);

    expect(result.skipped).toBe(false);
    expect(result.reason).toBe('normalized');
    expect(result.targetLoudness).toBe(-14);

    // Verify the ffmpeg args include the custom target and peak limit
    const ffmpegCall = mockSpawn.mock.calls[1];
    const afArg = ffmpegCall[1]![ffmpegCall[1]!.indexOf('-af') + 1] as string;
    expect(afArg).toContain('I=-14');
    expect(afArg).toContain('TP=-2');
  });

  it('should skip to AAC directly when codec is already aac', async () => {
    const analysis: LoudnessAnalysis = {
      integratedLoudness: -25,
      loudnessRange: 7,
      truePeak: -2,
      hasAudio: true,
    };

    const mockSpawn = vi.mocked(child_process.spawn);

    // ffprobe returns 'aac' — should skip the "preserve codec" attempt
    const ffprobeProc = createMockProcess(0, 'aac');
    // Only one ffmpeg call with AAC
    const ffmpegProc = createMockProcess(0);

    mockSpawn
      .mockReturnValueOnce(ffprobeProc as any)
      .mockReturnValueOnce(ffmpegProc as any);

    const result = await normalizeSegment('/input.mp4', '/output.mp4', analysis);

    expect(result.skipped).toBe(false);
    expect(result.reason).toBe('normalized');
    // Should only have 2 spawn calls (ffprobe + 1 ffmpeg), not 3
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('should handle ffprobe failure gracefully and use AAC', async () => {
    const analysis: LoudnessAnalysis = {
      integratedLoudness: -25,
      loudnessRange: 7,
      truePeak: -2,
      hasAudio: true,
    };

    const mockSpawn = vi.mocked(child_process.spawn);

    // ffprobe fails (returns null codec)
    const ffprobeProc = createMockProcess(1);
    // ffmpeg with AAC succeeds
    const ffmpegProc = createMockProcess(0);

    mockSpawn
      .mockReturnValueOnce(ffprobeProc as any)
      .mockReturnValueOnce(ffmpegProc as any);

    const result = await normalizeSegment('/input.mp4', '/output.mp4', analysis);

    expect(result.skipped).toBe(false);
    expect(result.reason).toBe('normalized');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('should include LRA in loudnorm filter', async () => {
    const analysis: LoudnessAnalysis = {
      integratedLoudness: -25,
      loudnessRange: 12,
      truePeak: -2,
      hasAudio: true,
    };

    const mockSpawn = vi.mocked(child_process.spawn);

    const ffprobeProc = createMockProcess(0, 'aac');
    const ffmpegProc = createMockProcess(0);

    mockSpawn
      .mockReturnValueOnce(ffprobeProc as any)
      .mockReturnValueOnce(ffmpegProc as any);

    await normalizeSegment('/input.mp4', '/output.mp4', analysis);

    const ffmpegCall = mockSpawn.mock.calls[1];
    const afArg = ffmpegCall[1]![ffmpegCall[1]!.indexOf('-af') + 1] as string;
    expect(afArg).toContain('LRA=12');
    expect(afArg).toContain('linear=true');
  });
});

describe('detectAudioCodec', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return codec name on success', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);
    const proc = createMockProcess(0, 'aac\n');
    mockSpawn.mockReturnValueOnce(proc as any);

    const codec = await detectAudioCodec('/test.mp4');
    expect(codec).toBe('aac');
  });

  it('should return null on ffprobe failure', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);
    const proc = createMockProcess(1);
    mockSpawn.mockReturnValueOnce(proc as any);

    const codec = await detectAudioCodec('/test.mp4');
    expect(codec).toBeNull();
  });

  it('should return null on spawn error', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = new EventEmitter();
    mockSpawn.mockReturnValueOnce(proc as any);

    const promise = detectAudioCodec('/test.mp4');
    proc.emit('error', new Error('spawn failed'));

    const codec = await promise;
    expect(codec).toBeNull();
  });
});


describe('normalizeSegments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create output directory and process all segments', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    // For each segment: analyzeLoudness (1 spawn) + detectAudioCodec (1 spawn) + normalize (1 spawn)
    // Segment 1: analyzeLoudness → no audio detected
    const analyzeProc1 = new EventEmitter() as any;
    analyzeProc1.stdout = new EventEmitter();
    analyzeProc1.stderr = new EventEmitter();
    analyzeProc1.stdin = new EventEmitter();

    // Segment 2: analyzeLoudness → loudness within tolerance
    const analyzeProc2 = new EventEmitter() as any;
    analyzeProc2.stdout = new EventEmitter();
    analyzeProc2.stderr = new EventEmitter();
    analyzeProc2.stdin = new EventEmitter();

    mockSpawn
      .mockReturnValueOnce(analyzeProc1 as any)
      .mockReturnValueOnce(analyzeProc2 as any);

    const segmentPaths = ['/segments/seg1.mp4', '/segments/seg2.mp4'];
    const outputDir = '/output/normalized';

    const promise = normalizeSegments(segmentPaths, outputDir);

    // Segment 1: emit no audio indicator
    analyzeProc1.stderr.emit('data', Buffer.from('does not contain any stream'));
    analyzeProc1.emit('close', 1);

    // Wait a tick for the first segment to complete and second to start
    await new Promise(r => setTimeout(r, 10));

    // Segment 2: emit loudnorm JSON with loudness within tolerance of -16
    const loudnormJson = JSON.stringify({
      input_i: '-15.5',
      input_lra: '7.0',
      input_tp: '-2.0',
    });
    analyzeProc2.stderr.emit('data', Buffer.from(`some ffmpeg output\n${loudnormJson}\n`));
    analyzeProc2.emit('close', 0);

    const results = await promise;

    // Output directory should be created (via the default fs import)
    expect(fs.default.mkdirSync).toHaveBeenCalledWith(outputDir, { recursive: true });

    // Should return results for both segments
    expect(results).toHaveLength(2);

    // Segment 1: no audio → skipped
    expect(results[0].skipped).toBe(true);
    expect(results[0].reason).toBe('no_audio');
    expect(results[0].normalizedPath).toBeNull();

    // Segment 2: within tolerance → skipped
    expect(results[1].skipped).toBe(true);
    expect(results[1].reason).toBe('within_tolerance');
    expect(results[1].normalizedPath).toBeNull();
  });

  it('should name output files as {baseName}_normalized.mp4', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    // Segment needs normalization: analyzeLoudness + detectCodec + ffmpeg normalize
    const analyzeProc = new EventEmitter() as any;
    analyzeProc.stdout = new EventEmitter();
    analyzeProc.stderr = new EventEmitter();
    analyzeProc.stdin = new EventEmitter();

    const ffprobeProc = createMockProcess(0, 'aac');
    const ffmpegProc = createMockProcess(0);

    mockSpawn
      .mockReturnValueOnce(analyzeProc as any)
      .mockReturnValueOnce(ffprobeProc as any)
      .mockReturnValueOnce(ffmpegProc as any);

    const segmentPaths = ['/segments/clip_001.mp4'];
    const outputDir = '/output/normalized';

    const promise = normalizeSegments(segmentPaths, outputDir);

    // Emit loudnorm JSON with loudness far from target
    const loudnormJson = JSON.stringify({
      input_i: '-25.0',
      input_lra: '7.0',
      input_tp: '-2.0',
    });
    analyzeProc.stderr.emit('data', Buffer.from(`ffmpeg output\n${loudnormJson}\n`));
    analyzeProc.emit('close', 0);

    const results = await promise;

    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(false);
    expect(results[0].reason).toBe('normalized');
    expect(results[0].normalizedPath).toBe('/output/normalized/clip_001_normalized.mp4');
  });

  it('should return empty array for empty input', async () => {
    const results = await normalizeSegments([], '/output/normalized');

    expect(results).toHaveLength(0);
    expect(fs.default.mkdirSync).toHaveBeenCalledWith('/output/normalized', { recursive: true });
  });

  it('should pass options through to normalizeSegment', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    // Segment with loudness -18 LUFS, custom target -14, tolerance 2
    // |(-18) - (-14)| = 4 > 2 → should normalize
    const analyzeProc = new EventEmitter() as any;
    analyzeProc.stdout = new EventEmitter();
    analyzeProc.stderr = new EventEmitter();
    analyzeProc.stdin = new EventEmitter();

    const ffprobeProc = createMockProcess(0, 'aac');
    const ffmpegProc = createMockProcess(0);

    mockSpawn
      .mockReturnValueOnce(analyzeProc as any)
      .mockReturnValueOnce(ffprobeProc as any)
      .mockReturnValueOnce(ffmpegProc as any);

    const options: NormalizationOptions = {
      targetLufs: -14,
      truePeakLimit: -2.0,
      tolerance: 2.0,
    };

    const promise = normalizeSegments(['/segments/seg.mp4'], '/output', options);

    const loudnormJson = JSON.stringify({
      input_i: '-18.0',
      input_lra: '5.0',
      input_tp: '-1.0',
    });
    analyzeProc.stderr.emit('data', Buffer.from(loudnormJson));
    analyzeProc.emit('close', 0);

    const results = await promise;

    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(false);
    expect(results[0].reason).toBe('normalized');
    expect(results[0].targetLoudness).toBe(-14);
  });
});


// Feature: v2-video-processing, Property 6: Audio Normalization Skip Condition
// **Validates: Requirements 7.4**
describe('Property 6: Audio Normalization Skip Condition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should skip normalization when |measured - target| <= tolerance', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate target LUFS in a realistic range
        fc.integer({ min: -70, max: 0 }),
        // Generate tolerance as integer to avoid floating point issues
        fc.integer({ min: 1, max: 10 }),
        // Generate a delta that is guaranteed to be within tolerance
        // Use integer math: delta in [-tolerance, tolerance]
        fc.integer({ min: -10, max: 10 }),
        async (targetLufs, tolerance, rawDelta) => {
          // Clamp delta to be within [-tolerance, tolerance]
          const delta = Math.max(-tolerance, Math.min(tolerance, rawDelta));
          const measuredLoudness = targetLufs + delta;

          // Verify our precondition: |measured - target| <= tolerance
          fc.pre(Math.abs(measuredLoudness - targetLufs) <= tolerance);

          const analysis: LoudnessAnalysis = {
            integratedLoudness: measuredLoudness,
            loudnessRange: 7,
            truePeak: -2,
            hasAudio: true,
          };

          const options: NormalizationOptions = {
            targetLufs,
            tolerance,
            truePeakLimit: -1.5,
          };

          const result = await normalizeSegment('/input.mp4', '/output.mp4', analysis, options);

          // When |measured - target| <= tolerance, normalization should be skipped
          expect(result.skipped).toBe(true);
          expect(result.reason).toBe('within_tolerance');
          expect(result.normalizedPath).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should NOT skip normalization when |measured - target| > tolerance', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    await fc.assert(
      fc.asyncProperty(
        // Generate target LUFS in a realistic range
        fc.integer({ min: -60, max: -5 }),
        // Generate tolerance > 0
        fc.integer({ min: 1, max: 5 }),
        // Generate extra offset beyond tolerance (at least 1 more)
        fc.integer({ min: 1, max: 20 }),
        // Direction: above or below target
        fc.boolean(),
        async (targetLufs, tolerance, extraOffset, above) => {
          // Ensure |measured - target| > tolerance
          const offset = tolerance + extraOffset;
          const measuredLoudness = above ? targetLufs + offset : targetLufs - offset;

          const analysis: LoudnessAnalysis = {
            integratedLoudness: measuredLoudness,
            loudnessRange: 7,
            truePeak: -2,
            hasAudio: true,
          };

          const options: NormalizationOptions = {
            targetLufs,
            tolerance,
            truePeakLimit: -1.5,
          };

          // Mock ffprobe (codec detection) → returns 'aac'
          const ffprobeProc = createMockProcess(0, 'aac');
          // Mock ffmpeg normalization → success
          const ffmpegProc = createMockProcess(0);

          mockSpawn
            .mockReturnValueOnce(ffprobeProc as any)
            .mockReturnValueOnce(ffmpegProc as any);

          const result = await normalizeSegment('/input.mp4', '/output.mp4', analysis, options);

          // When |measured - target| > tolerance, normalization should NOT be skipped
          expect(result.skipped).toBe(false);
          expect(result.reason).toBe('normalized');
          expect(result.normalizedPath).toBe('/output.mp4');
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ---------------------------------------------------------------------------
// V3 Enhancement Tests: Serial Execution, RSS Monitoring, FD Release
// ---------------------------------------------------------------------------

describe('V3: Serial Execution Guarantee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should process segments one at a time (no concurrent ffmpeg processes)', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    // Track concurrent process count
    let concurrentProcesses = 0;
    let maxConcurrentProcesses = 0;

    const createTrackedProcess = (exitCode: number, stderr = '') => {
      concurrentProcesses++;
      maxConcurrentProcesses = Math.max(maxConcurrentProcesses, concurrentProcesses);

      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter() as any;
      proc.stderr = new EventEmitter() as any;
      proc.stdin = new EventEmitter() as any;
      proc.pid = undefined; // No pid to avoid RSS monitoring intervals

      // Schedule close event
      const closeTimer = setTimeout(() => {
        if (stderr) {
          proc.stderr.emit('data', Buffer.from(stderr));
        }
        concurrentProcesses--;
        proc.emit('close', exitCode);
      }, 10);

      return proc;
    };

    // 3 segments, each will need: analyzeLoudness (1 spawn) → no audio detected
    const noAudioStderr = 'does not contain any stream';

    mockSpawn
      .mockImplementationOnce(() => createTrackedProcess(1, noAudioStderr) as any)
      .mockImplementationOnce(() => createTrackedProcess(1, noAudioStderr) as any)
      .mockImplementationOnce(() => createTrackedProcess(1, noAudioStderr) as any);

    const segmentPaths = ['/seg1.mp4', '/seg2.mp4', '/seg3.mp4'];
    const promise = normalizeSegments(segmentPaths, '/output');

    // Advance timers to let all processes complete
    await vi.advanceTimersByTimeAsync(100);

    const results = await promise;

    expect(results).toHaveLength(3);
    // At most 1 ffmpeg process should have been running at any time
    expect(maxConcurrentProcesses).toBe(1);
  });

  it('should not start next segment until current segment completes', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    const executionOrder: string[] = [];

    // Segment 1: analyzeLoudness → no audio (quick)
    const proc1 = new EventEmitter() as any;
    proc1.stdout = new EventEmitter() as any;
    proc1.stderr = new EventEmitter() as any;
    proc1.pid = undefined;

    // Segment 2: analyzeLoudness → no audio (quick)
    const proc2 = new EventEmitter() as any;
    proc2.stdout = new EventEmitter() as any;
    proc2.stderr = new EventEmitter() as any;
    proc2.pid = undefined;

    mockSpawn
      .mockImplementationOnce(() => {
        executionOrder.push('spawn_seg1');
        setTimeout(() => {
          proc1.stderr.emit('data', Buffer.from('does not contain any stream'));
          proc1.emit('close', 1);
          executionOrder.push('close_seg1');
        }, 50);
        return proc1 as any;
      })
      .mockImplementationOnce(() => {
        executionOrder.push('spawn_seg2');
        setTimeout(() => {
          proc2.stderr.emit('data', Buffer.from('does not contain any stream'));
          proc2.emit('close', 1);
          executionOrder.push('close_seg2');
        }, 50);
        return proc2 as any;
      });

    const promise = normalizeSegments(['/seg1.mp4', '/seg2.mp4'], '/output');

    await vi.advanceTimersByTimeAsync(200);

    await promise;

    // Verify strict ordering: seg1 must complete before seg2 starts
    expect(executionOrder).toEqual([
      'spawn_seg1',
      'close_seg1',
      'spawn_seg2',
      'close_seg2',
    ]);
  });
});

describe('V3: RSS Monitoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should poll child process RSS every 5 seconds', () => {
    const mockExecSync = vi.mocked(child_process.execSync);
    // Return 100MB in KB
    mockExecSync.mockReturnValue('102400\n');

    const proc = new EventEmitter() as any;
    proc.pid = 9999;

    const { stop, getMonitor } = startRssMonitoring(proc);

    // Advance 5 seconds - first poll
    vi.advanceTimersByTime(5000);
    expect(mockExecSync).toHaveBeenCalledTimes(1);

    // Advance another 5 seconds - second poll
    vi.advanceTimersByTime(5000);
    expect(mockExecSync).toHaveBeenCalledTimes(2);

    const monitor = getMonitor();
    expect(monitor).not.toBeNull();
    expect(monitor!.pid).toBe(9999);
    expect(monitor!.rssMB).toBe(100); // 102400 KB / 1024

    stop();
  });

  it('should log warning when RSS exceeds 512MB', () => {
    const mockExecSync = vi.mocked(child_process.execSync);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Return 600MB in KB
    mockExecSync.mockReturnValue(`${600 * 1024}\n`);

    const proc = new EventEmitter() as any;
    proc.pid = 1234;

    const { stop } = startRssMonitoring(proc);

    // Advance 5 seconds to trigger first poll
    vi.advanceTimersByTime(5000);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('PID=1234')
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('exceeds 512MB')
    );

    stop();
    warnSpy.mockRestore();
  });

  it('should not log warning when RSS is below 512MB', () => {
    const mockExecSync = vi.mocked(child_process.execSync);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Return 200MB in KB
    mockExecSync.mockReturnValue(`${200 * 1024}\n`);

    const proc = new EventEmitter() as any;
    proc.pid = 5678;

    const { stop } = startRssMonitoring(proc);

    vi.advanceTimersByTime(5000);

    expect(warnSpy).not.toHaveBeenCalled();

    stop();
    warnSpy.mockRestore();
  });

  it('should stop monitoring when process exits', () => {
    const mockExecSync = vi.mocked(child_process.execSync);
    mockExecSync.mockReturnValue('102400\n');

    const proc = new EventEmitter() as any;
    proc.pid = 4321;

    startRssMonitoring(proc);

    // Simulate process exit
    proc.emit('exit', 0);

    // Advance time - should not poll anymore
    mockExecSync.mockClear();
    vi.advanceTimersByTime(10000);

    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('should stop monitoring when process errors', () => {
    const mockExecSync = vi.mocked(child_process.execSync);
    mockExecSync.mockReturnValue('102400\n');

    const proc = new EventEmitter() as any;
    proc.pid = 4322;

    startRssMonitoring(proc);

    // Simulate process error
    proc.emit('error', new Error('spawn failed'));

    // Advance time - should not poll anymore
    mockExecSync.mockClear();
    vi.advanceTimersByTime(10000);

    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('should return no-op when process has no pid', () => {
    const proc = new EventEmitter() as any;
    proc.pid = undefined;

    const { stop, getMonitor } = startRssMonitoring(proc);

    expect(getMonitor()).toBeNull();
    // Should not throw
    stop();
  });

  it('should stop monitoring when getChildProcessRssMB returns null (process gone)', () => {
    const mockExecSync = vi.mocked(child_process.execSync);
    // First call succeeds, second call throws (process gone)
    mockExecSync
      .mockReturnValueOnce('102400\n')
      .mockImplementationOnce(() => { throw new Error('No such process'); });

    const proc = new EventEmitter() as any;
    proc.pid = 7777;

    startRssMonitoring(proc);

    // First poll - succeeds
    vi.advanceTimersByTime(5000);
    expect(mockExecSync).toHaveBeenCalledTimes(1);

    // Second poll - process gone, returns null, stops monitoring
    vi.advanceTimersByTime(5000);
    expect(mockExecSync).toHaveBeenCalledTimes(2);

    // Third poll - should not happen (monitoring stopped)
    mockExecSync.mockClear();
    vi.advanceTimersByTime(5000);
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe('V3: File Descriptor Release', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call destroy on stdout and stderr after analyzeLoudness completes', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter() as any;
    proc.stderr = new EventEmitter() as any;
    proc.pid = undefined;
    proc.stdout.destroy = vi.fn();
    proc.stderr.destroy = vi.fn();

    mockSpawn.mockReturnValueOnce(proc as any);

    const promise = analyzeLoudness('/test.mp4');

    proc.stderr.emit('data', Buffer.from('does not contain any stream'));
    proc.emit('close', 1);

    await promise;

    expect(proc.stdout.destroy).toHaveBeenCalled();
    expect(proc.stderr.destroy).toHaveBeenCalled();
  });

  it('should call destroy on stdout and stderr after analyzeLoudness error', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter() as any;
    proc.stderr = new EventEmitter() as any;
    proc.pid = undefined;
    proc.stdout.destroy = vi.fn();
    proc.stderr.destroy = vi.fn();

    mockSpawn.mockReturnValueOnce(proc as any);

    const promise = analyzeLoudness('/test.mp4');

    proc.emit('error', new Error('spawn ENOENT'));

    await promise;

    expect(proc.stdout.destroy).toHaveBeenCalled();
    expect(proc.stderr.destroy).toHaveBeenCalled();
  });

  it('should call destroy on stdout and stderr after detectAudioCodec completes', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter() as any;
    proc.stderr = new EventEmitter() as any;
    proc.pid = undefined;
    proc.stdout.destroy = vi.fn();
    proc.stderr.destroy = vi.fn();

    mockSpawn.mockReturnValueOnce(proc as any);

    const promise = detectAudioCodec('/test.mp4');

    proc.stdout.emit('data', Buffer.from('aac\n'));
    proc.emit('close', 0);

    await promise;

    expect(proc.stdout.destroy).toHaveBeenCalled();
    expect(proc.stderr.destroy).toHaveBeenCalled();
  });

  it('should not throw when destroy is not available on streams', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    // Create proc without destroy methods (simulating edge case)
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter() as any;
    proc.stderr = new EventEmitter() as any;
    proc.pid = undefined;
    // Intentionally NOT adding destroy methods

    mockSpawn.mockReturnValueOnce(proc as any);

    const promise = analyzeLoudness('/test.mp4');

    proc.stderr.emit('data', Buffer.from('does not contain any stream'));
    proc.emit('close', 1);

    // Should not throw even without destroy methods
    const result = await promise;
    expect(result.hasAudio).toBe(false);
  });

  it('should use file path arguments and not read file content into Buffer', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter() as any;
    proc.stderr = new EventEmitter() as any;
    proc.pid = undefined;

    mockSpawn.mockReturnValueOnce(proc as any);

    const promise = analyzeLoudness('/path/to/large-video.mp4');

    proc.stderr.emit('data', Buffer.from('does not contain any stream'));
    proc.emit('close', 1);

    await promise;

    // Verify spawn was called with -i filepath (not piping content)
    expect(mockSpawn).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-i', '/path/to/large-video.mp4']),
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );

    // stdin is 'ignore' - no data is written to the process
    // This confirms audio file content is NOT read into Node.js Buffer
  });

  it('should use stdio ignore for stdin to prevent Buffer loading', async () => {
    const mockSpawn = vi.mocked(child_process.spawn);

    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter() as any;
    proc.stderr = new EventEmitter() as any;
    proc.pid = undefined;

    mockSpawn.mockReturnValueOnce(proc as any);

    const promise = analyzeLoudness('/test.mp4');

    proc.stderr.emit('data', Buffer.from('garbage'));
    proc.emit('close', 0);

    await promise;

    // Verify stdin is set to 'ignore' (no data piped in)
    const spawnCall = mockSpawn.mock.calls[0];
    const options = spawnCall[2] as any;
    expect(options.stdio[0]).toBe('ignore');
  });
});
