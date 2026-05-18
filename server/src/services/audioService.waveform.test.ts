/**
 * Unit tests for audioService — generateWaveformData function.
 *
 * Task 2.7: Verifies waveform data generation including:
 * - Returns ~200 normalized amplitude values
 * - Values are in range [0, 1]
 * - Handles track not found
 * - Handles silent audio (all zeros)
 *
 * **Validates: Requirements 7.6**
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbGet = vi.fn();
const mockDbPrepare = vi.fn(() => ({ get: mockDbGet, all: vi.fn(), run: vi.fn() }));

vi.mock('../database', () => ({
  getDb: () => ({ prepare: mockDbPrepare }),
}));

const mockDownloadToTemp = vi.fn();

vi.mock('../storage/factory', () => ({
  getStorageProvider: () => ({
    downloadToTemp: mockDownloadToTemp,
  }),
}));

// Mock child_process.spawn for ffmpeg
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

// Mock fluent-ffmpeg (needed because audioService imports it)
vi.mock('fluent-ffmpeg', () => {
  const fn: any = () => ({});
  fn.ffprobe = vi.fn();
  return { default: fn };
});

// We need to mock fs for readFileSync (raw PCM data) but keep other fs functions
const mockReadFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: (...args: any[]) => mockReadFileSync(...args),
      writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
      unlinkSync: (...args: any[]) => mockUnlinkSync(...args),
      mkdirSync: (...args: any[]) => mockMkdirSync(...args),
      existsSync: () => true,
      promises: actual.promises,
    },
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
    unlinkSync: (...args: any[]) => mockUnlinkSync(...args),
    mkdirSync: (...args: any[]) => mockMkdirSync(...args),
    existsSync: () => true,
  };
});

vi.mock('../helpers/tempDir', () => ({
  getTempDir: () => '/tmp/test',
}));

import { generateWaveformData } from './audioService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a Buffer of raw float32 PCM samples.
 */
function createPcmBuffer(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i++) {
    buf.writeFloatLE(samples[i], i * 4);
  }
  return buf;
}

/**
 * Helper to set up a mock spawn that simulates ffmpeg completing successfully.
 */
function setupFfmpegSuccess() {
  mockSpawn.mockImplementation(() => {
    const proc: any = {
      stdout: { on: vi.fn(), destroy: vi.fn() },
      stderr: { on: vi.fn(), destroy: vi.fn() },
      on: vi.fn(),
    };

    // Simulate close event with code 0
    proc.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'close') {
        setTimeout(() => cb(0), 0);
      }
    });

    return proc;
  });
}

/**
 * Helper to set up a mock spawn that simulates ffmpeg failing.
 */
function setupFfmpegFailure(code: number = 1) {
  mockSpawn.mockImplementation(() => {
    const proc: any = {
      stdout: { on: vi.fn(), destroy: vi.fn() },
      stderr: { on: vi.fn(), destroy: vi.fn() },
      on: vi.fn(),
    };

    proc.stderr.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'data') {
        cb(Buffer.from('ffmpeg error'));
      }
    });

    proc.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'close') {
        setTimeout(() => cb(code), 0);
      }
    });

    return proc;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateWaveformData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw when track is not found', async () => {
    mockDbGet.mockReturnValue(undefined);

    await expect(generateWaveformData('nonexistent-id')).rejects.toThrow('Audio track not found');
  });

  it('should return 200 values all in [0, 1] range', async () => {
    mockDbGet.mockReturnValue({
      id: 'track-1',
      user_id: 'user-1',
      title: 'Test Track',
      file_path: 'audio/user-1/track-1.mp3',
      format: 'mp3',
      duration: 120,
      file_size: 1000000,
      source: 'upload',
      source_url: null,
      created_at: '2024-01-01T00:00:00Z',
    });

    mockDownloadToTemp.mockResolvedValue('/tmp/test/track-1.mp3');
    setupFfmpegSuccess();

    // Create PCM data with 800 samples (4 per chunk for 200 chunks)
    const samples: number[] = [];
    for (let i = 0; i < 800; i++) {
      samples.push(Math.sin(i * 0.1) * 0.8); // Sine wave with amplitude 0.8
    }
    mockReadFileSync.mockReturnValue(createPcmBuffer(samples));

    const result = await generateWaveformData('track-1');

    expect(result).toHaveLength(200);
    for (const value of result) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('should normalize values so max is 1', async () => {
    mockDbGet.mockReturnValue({
      id: 'track-2',
      user_id: 'user-1',
      title: 'Loud Track',
      file_path: 'audio/user-1/track-2.mp3',
      format: 'mp3',
      duration: 60,
      file_size: 500000,
      source: 'upload',
      source_url: null,
      created_at: '2024-01-01T00:00:00Z',
    });

    mockDownloadToTemp.mockResolvedValue('/tmp/test/track-2.mp3');
    setupFfmpegSuccess();

    // Create PCM data with varying amplitudes
    const samples: number[] = [];
    for (let i = 0; i < 800; i++) {
      // First half louder, second half quieter
      const amplitude = i < 400 ? 0.9 : 0.3;
      samples.push(amplitude * Math.sin(i * 0.5));
    }
    mockReadFileSync.mockReturnValue(createPcmBuffer(samples));

    const result = await generateWaveformData('track-2');

    // The maximum value should be 1 (normalized)
    const maxValue = Math.max(...result);
    expect(maxValue).toBeCloseTo(1, 5);

    // There should be variation (not all the same)
    const minValue = Math.min(...result.filter(v => v > 0));
    expect(minValue).toBeLessThan(1);
  });

  it('should return all zeros for silent audio', async () => {
    mockDbGet.mockReturnValue({
      id: 'track-3',
      user_id: 'user-1',
      title: 'Silent Track',
      file_path: 'audio/user-1/track-3.mp3',
      format: 'mp3',
      duration: 30,
      file_size: 100000,
      source: 'upload',
      source_url: null,
      created_at: '2024-01-01T00:00:00Z',
    });

    mockDownloadToTemp.mockResolvedValue('/tmp/test/track-3.mp3');
    setupFfmpegSuccess();

    // All zeros (silence)
    const samples = new Array(800).fill(0);
    mockReadFileSync.mockReturnValue(createPcmBuffer(samples));

    const result = await generateWaveformData('track-3');

    expect(result).toHaveLength(200);
    for (const value of result) {
      expect(value).toBe(0);
    }
  });

  it('should return 200 zeros for empty PCM output', async () => {
    mockDbGet.mockReturnValue({
      id: 'track-4',
      user_id: 'user-1',
      title: 'Empty Track',
      file_path: 'audio/user-1/track-4.mp3',
      format: 'mp3',
      duration: 0.1,
      file_size: 100,
      source: 'upload',
      source_url: null,
      created_at: '2024-01-01T00:00:00Z',
    });

    mockDownloadToTemp.mockResolvedValue('/tmp/test/track-4.mp3');
    setupFfmpegSuccess();

    // Empty buffer (no samples)
    mockReadFileSync.mockReturnValue(Buffer.alloc(0));

    const result = await generateWaveformData('track-4');

    expect(result).toHaveLength(200);
    for (const value of result) {
      expect(value).toBe(0);
    }
  });

  it('should throw when ffmpeg fails', async () => {
    mockDbGet.mockReturnValue({
      id: 'track-5',
      user_id: 'user-1',
      title: 'Bad Track',
      file_path: 'audio/user-1/track-5.mp3',
      format: 'mp3',
      duration: 60,
      file_size: 500000,
      source: 'upload',
      source_url: null,
      created_at: '2024-01-01T00:00:00Z',
    });

    mockDownloadToTemp.mockResolvedValue('/tmp/test/track-5.mp3');
    setupFfmpegFailure(1);

    await expect(generateWaveformData('track-5')).rejects.toThrow(/ffmpeg exited with code 1/);
  });

  it('should clean up temp PCM file after success', async () => {
    mockDbGet.mockReturnValue({
      id: 'track-6',
      user_id: 'user-1',
      title: 'Cleanup Track',
      file_path: 'audio/user-1/track-6.mp3',
      format: 'mp3',
      duration: 60,
      file_size: 500000,
      source: 'upload',
      source_url: null,
      created_at: '2024-01-01T00:00:00Z',
    });

    mockDownloadToTemp.mockResolvedValue('/tmp/test/track-6.mp3');
    setupFfmpegSuccess();

    const samples = new Array(800).fill(0.5);
    mockReadFileSync.mockReturnValue(createPcmBuffer(samples));

    await generateWaveformData('track-6');

    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it('should call storageProvider.downloadToTemp with correct file_path', async () => {
    mockDbGet.mockReturnValue({
      id: 'track-7',
      user_id: 'user-1',
      title: 'Path Track',
      file_path: 'audio/user-1/track-7.ogg',
      format: 'ogg',
      duration: 90,
      file_size: 800000,
      source: 'download',
      source_url: 'https://example.com/music.ogg',
      created_at: '2024-01-01T00:00:00Z',
    });

    mockDownloadToTemp.mockResolvedValue('/tmp/test/track-7.ogg');
    setupFfmpegSuccess();

    const samples = new Array(800).fill(0.3);
    mockReadFileSync.mockReturnValue(createPcmBuffer(samples));

    await generateWaveformData('track-7');

    expect(mockDownloadToTemp).toHaveBeenCalledWith('audio/user-1/track-7.ogg');
  });
});
