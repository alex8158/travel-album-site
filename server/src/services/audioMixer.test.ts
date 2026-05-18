import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import * as child_process from 'child_process';
import { mixAudioToVideo, AudioMixOptions, calculateTrimWindow, clampVolume } from './audioMixer';

// Mock fluent-ffmpeg for ffprobe
const mockFfprobe = vi.fn();

vi.mock('fluent-ffmpeg', () => {
  const fn: any = () => ({});
  fn.ffprobe = (...args: any[]) => mockFfprobe(...args);
  return { default: fn };
});

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Helper to create a mock ffmpeg process
function createMockProcess(exitCode: number, stderrOutput = ''): EventEmitter & { stderr: EventEmitter; stdout: EventEmitter } {
  const proc = new EventEmitter() as any;
  proc.stderr = new EventEmitter();
  proc.stdout = new EventEmitter();

  // Simulate async close
  setTimeout(() => {
    if (stderrOutput) {
      proc.stderr.emit('data', Buffer.from(stderrOutput));
    }
    proc.emit('close', exitCode);
  }, 10);

  return proc;
}

// Helper to set up ffprobe mock
function setupFfprobe(duration: number) {
  mockFfprobe.mockImplementation((_path: string, cb: Function) => {
    cb(null, { format: { duration } });
  });
}

describe('AudioMixer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mixAudioToVideo - auto-trim mode', () => {
    const baseOptions: AudioMixOptions = {
      audioTrackPath: '/tmp/audio.mp3',
      videoPath: '/tmp/video.mp4',
      outputPath: '/tmp/output.mp4',
      videoDuration: 30,
    };

    it('should truncate audio when audio >= video duration (no loop)', async () => {
      // Audio is 60s, video is 30s → no loop needed
      setupFfprobe(60);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      const result = await mixAudioToVideo(baseOptions);

      expect(result).toBe('/tmp/output.mp4');
      expect(mockSpawn).toHaveBeenCalledWith('ffmpeg', expect.any(Array), expect.any(Object));

      const args = mockSpawn.mock.calls[0][1] as string[];
      // Should NOT have -stream_loop
      expect(args).not.toContain('-stream_loop');
      // Should have atrim=0:30
      const filterIdx = args.indexOf('-filter_complex');
      const filter = args[filterIdx + 1];
      expect(filter).toContain('atrim=0:30');
      expect(filter).toContain('afade=t=in:d=1');
      expect(filter).toContain('afade=t=out:st=28:d=2');
    });

    it('should loop audio when audio < video duration', async () => {
      // Audio is 10s, video is 30s → needs loop
      setupFfprobe(10);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      const result = await mixAudioToVideo(baseOptions);

      expect(result).toBe('/tmp/output.mp4');

      const args = mockSpawn.mock.calls[0][1] as string[];
      // Should have -stream_loop -1 before the audio input
      const loopIdx = args.indexOf('-stream_loop');
      expect(loopIdx).toBeGreaterThan(-1);
      expect(args[loopIdx + 1]).toBe('-1');
      // -stream_loop should come before the audio input path
      const audioPathIdx = args.lastIndexOf('/tmp/audio.mp3');
      expect(loopIdx).toBeLessThan(audioPathIdx);
    });

    it('should apply default fade-in (1s) and fade-out (2s)', async () => {
      setupFfprobe(60);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo(baseOptions);

      const args = mockSpawn.mock.calls[0][1] as string[];
      const filterIdx = args.indexOf('-filter_complex');
      const filter = args[filterIdx + 1];
      // fade-in: 1s
      expect(filter).toContain('afade=t=in:d=1');
      // fade-out: starts at videoDuration - 2 = 28, duration 2
      expect(filter).toContain('afade=t=out:st=28:d=2');
    });

    it('should use custom fade durations when provided', async () => {
      setupFfprobe(60);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo({
        ...baseOptions,
        fadeInDuration: 2,
        fadeOutDuration: 3,
      });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const filterIdx = args.indexOf('-filter_complex');
      const filter = args[filterIdx + 1];
      expect(filter).toContain('afade=t=in:d=2');
      // fade-out starts at 30 - 3 = 27
      expect(filter).toContain('afade=t=out:st=27:d=3');
    });

    it('should throw error when ffmpeg fails', async () => {
      setupFfprobe(60);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(1, 'Error: something went wrong');
      mockSpawn.mockReturnValueOnce(proc as any);

      await expect(mixAudioToVideo(baseOptions)).rejects.toThrow('Audio mixing failed');
    });

    it('should throw error when ffprobe fails', async () => {
      mockFfprobe.mockImplementation((_path: string, cb: Function) => {
        cb(new Error('File not found'), null);
      });

      await expect(mixAudioToVideo(baseOptions)).rejects.toThrow('Failed to probe audio file');
    });

    it('should map video stream and bgm audio in output', async () => {
      setupFfprobe(60);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo(baseOptions);

      const args = mockSpawn.mock.calls[0][1] as string[];
      // Should map video from input 0
      expect(args).toContain('-map');
      const mapIndices = args.reduce<number[]>((acc, val, idx) => {
        if (val === '-map') acc.push(idx);
        return acc;
      }, []);
      expect(args[mapIndices[0] + 1]).toBe('0:v');
      expect(args[mapIndices[1] + 1]).toBe('[bgm]');
    });

    it('should copy video codec (no re-encoding)', async () => {
      setupFfprobe(60);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo(baseOptions);

      const args = mockSpawn.mock.calls[0][1] as string[];
      const cvIdx = args.indexOf('-c:v');
      expect(args[cvIdx + 1]).toBe('copy');
    });

    it('should handle audio duration exactly equal to video duration (no loop)', async () => {
      // Audio exactly equals video → no loop
      setupFfprobe(30);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo(baseOptions);

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain('-stream_loop');
    });
  });

  describe('calculateTrimWindow', () => {
    it('should calculate end from start point (end = start + videoDuration)', () => {
      const result = calculateTrimWindow(10, 60, 20);
      expect(result.start).toBe(20);
      expect(result.end).toBe(30); // 20 + 10
    });

    it('should calculate start from end point (start = end - videoDuration)', () => {
      const result = calculateTrimWindow(10, 60, undefined, 40);
      expect(result.start).toBe(30); // 40 - 10
      expect(result.end).toBe(40);
    });

    it('should default to start=0 when neither start nor end provided', () => {
      const result = calculateTrimWindow(10, 60);
      expect(result.start).toBe(0);
      expect(result.end).toBe(10);
    });

    it('should prefer startPoint when both start and end are provided', () => {
      const result = calculateTrimWindow(10, 60, 5, 40);
      expect(result.start).toBe(5);
      expect(result.end).toBe(15); // 5 + 10
    });

    it('should constrain start >= 0 (clamp negative start)', () => {
      // endPoint = 5, videoDuration = 10 → start = 5 - 10 = -5 → clamp to 0
      const result = calculateTrimWindow(10, 60, undefined, 5);
      expect(result.start).toBe(0);
      expect(result.end).toBe(10); // 0 + 10
    });

    it('should constrain end <= audioDuration', () => {
      // startPoint = 55, videoDuration = 10, audioDuration = 60 → end = 65 → clamp to 60
      const result = calculateTrimWindow(10, 60, 55);
      expect(result.end).toBe(60);
      expect(result.start).toBe(50); // 60 - 10
    });

    it('should maintain duration = videoDuration', () => {
      const result = calculateTrimWindow(15, 120, 30);
      expect(result.end - result.start).toBe(15);
    });

    it('should handle edge case: audio duration equals video duration', () => {
      const result = calculateTrimWindow(30, 30, 0);
      expect(result.start).toBe(0);
      expect(result.end).toBe(30);
    });

    it('should handle start at 0', () => {
      const result = calculateTrimWindow(10, 60, 0);
      expect(result.start).toBe(0);
      expect(result.end).toBe(10);
    });

    it('should handle end at audioDuration', () => {
      const result = calculateTrimWindow(10, 60, undefined, 60);
      expect(result.start).toBe(50); // 60 - 10
      expect(result.end).toBe(60);
    });
  });

  describe('mixAudioToVideo - manual trim mode', () => {
    const baseOptions: AudioMixOptions = {
      audioTrackPath: '/tmp/audio.mp3',
      videoPath: '/tmp/video.mp4',
      outputPath: '/tmp/output.mp4',
      videoDuration: 30,
    };

    it('should use manual trim mode when trimStart is provided', async () => {
      setupFfprobe(120);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo({ ...baseOptions, trimStart: 10 });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const filterIdx = args.indexOf('-filter_complex');
      const filter = args[filterIdx + 1];
      // Should use atrim with start=10, end=40 (10 + 30)
      expect(filter).toContain('atrim=10:40');
      // Should NOT have -stream_loop (manual trim doesn't loop)
      expect(args).not.toContain('-stream_loop');
    });

    it('should use manual trim mode when trimEnd is provided', async () => {
      setupFfprobe(120);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo({ ...baseOptions, trimEnd: 90 });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const filterIdx = args.indexOf('-filter_complex');
      const filter = args[filterIdx + 1];
      // start = 90 - 30 = 60, end = 90
      expect(filter).toContain('atrim=60:90');
    });

    it('should apply fade effects in manual trim mode', async () => {
      setupFfprobe(120);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo({ ...baseOptions, trimStart: 10 });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const filterIdx = args.indexOf('-filter_complex');
      const filter = args[filterIdx + 1];
      // fade-in 1s at start, fade-out 2s at end (30 - 2 = 28)
      expect(filter).toContain('afade=t=in:d=1');
      expect(filter).toContain('afade=t=out:st=28:d=2');
    });

    it('should constrain trim window when trimStart would exceed audio duration', async () => {
      // Audio is 35s, video is 30s, trimStart=10 → end would be 40 > 35
      // Should clamp: end=35, start=5
      setupFfprobe(35);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo({ ...baseOptions, trimStart: 10 });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const filterIdx = args.indexOf('-filter_complex');
      const filter = args[filterIdx + 1];
      expect(filter).toContain('atrim=5:35');
    });

    it('should use auto-trim mode when neither trimStart nor trimEnd is provided', async () => {
      setupFfprobe(60);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo(baseOptions);

      const args = mockSpawn.mock.calls[0][1] as string[];
      const filterIdx = args.indexOf('-filter_complex');
      const filter = args[filterIdx + 1];
      // Auto-trim: atrim=0:30
      expect(filter).toContain('atrim=0:30');
    });
  });

  describe('clampVolume', () => {
    it('should return 0 for undefined', () => {
      expect(clampVolume(undefined)).toBe(0);
    });

    it('should return 0 for null', () => {
      expect(clampVolume(null)).toBe(0);
    });

    it('should return 0 for 0', () => {
      expect(clampVolume(0)).toBe(0);
    });

    it('should return the value when within range [0, 0.2]', () => {
      expect(clampVolume(0.1)).toBe(0.1);
      expect(clampVolume(0.15)).toBe(0.15);
      expect(clampVolume(0.2)).toBe(0.2);
    });

    it('should clamp values above 0.2 to 0.2', () => {
      expect(clampVolume(0.5)).toBe(0.2);
      expect(clampVolume(1.0)).toBe(0.2);
      expect(clampVolume(100)).toBe(0.2);
    });

    it('should clamp negative values to 0', () => {
      expect(clampVolume(-0.1)).toBe(0);
      expect(clampVolume(-1)).toBe(0);
    });
  });

  describe('mixAudioToVideo - original audio volume control', () => {
    const baseOptions: AudioMixOptions = {
      audioTrackPath: '/tmp/audio.mp3',
      videoPath: '/tmp/video.mp4',
      outputPath: '/tmp/output.mp4',
      videoDuration: 30,
    };

    it('should map only [bgm] when originalAudioVolume is 0 (default)', async () => {
      setupFfprobe(60);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo({ ...baseOptions, originalAudioVolume: 0 });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const filterIdx = args.indexOf('-filter_complex');
      const filter = args[filterIdx + 1];

      // Should NOT contain amix or volume filter for original audio
      expect(filter).not.toContain('amix');
      expect(filter).not.toContain('[orig]');

      // Should map [bgm] directly
      const mapIndices = args.reduce<number[]>((acc, val, idx) => {
        if (val === '-map') acc.push(idx);
        return acc;
      }, []);
      expect(args[mapIndices[1] + 1]).toBe('[bgm]');
    });

    it('should map only [bgm] when originalAudioVolume is undefined', async () => {
      setupFfprobe(60);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo(baseOptions); // no originalAudioVolume

      const args = mockSpawn.mock.calls[0][1] as string[];
      const filterIdx = args.indexOf('-filter_complex');
      const filter = args[filterIdx + 1];

      expect(filter).not.toContain('amix');
      expect(filter).not.toContain('[orig]');

      const mapIndices = args.reduce<number[]>((acc, val, idx) => {
        if (val === '-map') acc.push(idx);
        return acc;
      }, []);
      expect(args[mapIndices[1] + 1]).toBe('[bgm]');
    });

    it('should use amix filter when originalAudioVolume > 0', async () => {
      setupFfprobe(60);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo({ ...baseOptions, originalAudioVolume: 0.1 });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const filterIdx = args.indexOf('-filter_complex');
      const filter = args[filterIdx + 1];

      // Should contain the volume filter for original audio
      expect(filter).toContain('[0:a]volume=0.1[orig]');
      // Should contain amix
      expect(filter).toContain('[orig][bgm]amix=inputs=2:duration=first[aout]');

      // Should map [aout] instead of [bgm]
      const mapIndices = args.reduce<number[]>((acc, val, idx) => {
        if (val === '-map') acc.push(idx);
        return acc;
      }, []);
      expect(args[mapIndices[1] + 1]).toBe('[aout]');
    });

    it('should clamp originalAudioVolume above 0.2 to 0.2', async () => {
      setupFfprobe(60);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo({ ...baseOptions, originalAudioVolume: 0.5 });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const filterIdx = args.indexOf('-filter_complex');
      const filter = args[filterIdx + 1];

      // Should be clamped to 0.2
      expect(filter).toContain('[0:a]volume=0.2[orig]');
      expect(filter).toContain('amix=inputs=2:duration=first[aout]');
    });

    it('should clamp negative originalAudioVolume to 0 (no amix)', async () => {
      setupFfprobe(60);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo({ ...baseOptions, originalAudioVolume: -0.1 });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const filterIdx = args.indexOf('-filter_complex');
      const filter = args[filterIdx + 1];

      // Clamped to 0, so no amix
      expect(filter).not.toContain('amix');
      expect(filter).not.toContain('[orig]');
    });

    it('should use amix filter with volume control in manual trim mode', async () => {
      setupFfprobe(120);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo({
        ...baseOptions,
        trimStart: 10,
        originalAudioVolume: 0.15,
      });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const filterIdx = args.indexOf('-filter_complex');
      const filter = args[filterIdx + 1];

      // Should have manual trim
      expect(filter).toContain('atrim=10:40');
      // Should have volume + amix
      expect(filter).toContain('[0:a]volume=0.15[orig]');
      expect(filter).toContain('[orig][bgm]amix=inputs=2:duration=first[aout]');

      // Should map [aout]
      const mapIndices = args.reduce<number[]>((acc, val, idx) => {
        if (val === '-map') acc.push(idx);
        return acc;
      }, []);
      expect(args[mapIndices[1] + 1]).toBe('[aout]');
    });

    it('should use exact volume value 0.2 (max boundary)', async () => {
      setupFfprobe(60);

      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0);
      mockSpawn.mockReturnValueOnce(proc as any);

      await mixAudioToVideo({ ...baseOptions, originalAudioVolume: 0.2 });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const filterIdx = args.indexOf('-filter_complex');
      const filter = args[filterIdx + 1];

      expect(filter).toContain('[0:a]volume=0.2[orig]');
      expect(filter).toContain('amix=inputs=2:duration=first[aout]');
    });
  });
});