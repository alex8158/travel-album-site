/**
 * Unit tests for audioService — validateAudioFile function.
 *
 * Task 2.1: Verifies audio file validation including format checks,
 * size limits, and ffprobe verification.
 *
 * **Validates: Requirements 2.1, 2.2, 2.5, 3.2, 3.4**
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import * as child_process from 'child_process';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('fluent-ffmpeg', () => {
  const fn: any = () => ({});
  fn.ffprobe = vi.fn();
  return { default: fn };
});

vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    promises: {
      stat: vi.fn().mockResolvedValue({ size: 1024 }),
    },
  },
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  promises: {
    stat: vi.fn().mockResolvedValue({ size: 1024 }),
  },
}));

vi.mock('../helpers/tempDir', () => ({
  getTempDir: () => '/tmp/test',
}));

import { validateAudioFile } from './audioService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockProcess(exitCode: number, stdout = '') {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter() as any;
  proc.stderr = new EventEmitter() as any;
  proc.stdout.destroy = vi.fn();
  proc.stderr.destroy = vi.fn();

  setTimeout(() => {
    if (stdout) {
      proc.stdout.emit('data', Buffer.from(stdout));
    }
    proc.emit('close', exitCode);
  }, 0);

  return proc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateAudioFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('file size validation', () => {
    it('should reject files exceeding 50MB', async () => {
      const buffer = Buffer.alloc(52_428_801); // 50MB + 1 byte
      const result = await validateAudioFile(buffer, 'large.mp3');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('50MB');
    });

    it('should accept files exactly at 50MB limit', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0, 'audio');
      mockSpawn.mockReturnValueOnce(proc as any);

      const buffer = Buffer.alloc(52_428_800); // exactly 50MB
      const result = await validateAudioFile(buffer, 'exact.mp3');
      expect(result).toEqual({ valid: true });
    });

    it('should reject empty files', async () => {
      const buffer = Buffer.alloc(0);
      const result = await validateAudioFile(buffer, 'empty.mp3');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });
  });

  describe('format validation', () => {
    it('should accept MP3 files', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0, 'audio');
      mockSpawn.mockReturnValueOnce(proc as any);

      const buffer = Buffer.alloc(1024);
      const result = await validateAudioFile(buffer, 'song.mp3');
      expect(result).toEqual({ valid: true });
    });

    it('should accept AAC files', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0, 'audio');
      mockSpawn.mockReturnValueOnce(proc as any);

      const buffer = Buffer.alloc(2048);
      const result = await validateAudioFile(buffer, 'track.aac');
      expect(result).toEqual({ valid: true });
    });

    it('should accept WAV files', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0, 'audio');
      mockSpawn.mockReturnValueOnce(proc as any);

      const buffer = Buffer.alloc(4096);
      const result = await validateAudioFile(buffer, 'audio.wav');
      expect(result).toEqual({ valid: true });
    });

    it('should accept OGG files', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0, 'audio');
      mockSpawn.mockReturnValueOnce(proc as any);

      const buffer = Buffer.alloc(512);
      const result = await validateAudioFile(buffer, 'music.ogg');
      expect(result).toEqual({ valid: true });
    });

    it('should reject unsupported formats (mp4)', async () => {
      const buffer = Buffer.alloc(1024);
      const result = await validateAudioFile(buffer, 'video.mp4');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('MP3, AAC, WAV, OGG');
    });

    it('should reject files with no extension', async () => {
      const buffer = Buffer.alloc(1024);
      const result = await validateAudioFile(buffer, 'noextension');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('MP3, AAC, WAV, OGG');
    });

    it('should handle uppercase extensions', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0, 'audio');
      mockSpawn.mockReturnValueOnce(proc as any);

      const buffer = Buffer.alloc(1024);
      const result = await validateAudioFile(buffer, 'SONG.MP3');
      expect(result).toEqual({ valid: true });
    });

    it('should reject FLAC format', async () => {
      const buffer = Buffer.alloc(1024);
      const result = await validateAudioFile(buffer, 'song.flac');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('MP3, AAC, WAV, OGG');
    });

    it('should reject MIDI format', async () => {
      const buffer = Buffer.alloc(1024);
      const result = await validateAudioFile(buffer, 'tune.midi');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('MP3, AAC, WAV, OGG');
    });
  });

  describe('ffprobe validation', () => {
    it('should return valid when ffprobe finds an audio stream', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0, 'audio');
      mockSpawn.mockReturnValueOnce(proc as any);

      const buffer = Buffer.alloc(1024);
      const result = await validateAudioFile(buffer, 'song.mp3');
      expect(result).toEqual({ valid: true });

      // Verify ffprobe was called with correct args
      expect(mockSpawn).toHaveBeenCalledWith(
        'ffprobe',
        expect.arrayContaining(['-select_streams', 'a:0', '-show_entries', 'stream=codec_type']),
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
      );
    });

    it('should return invalid when ffprobe finds no audio stream', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0, 'video');
      mockSpawn.mockReturnValueOnce(proc as any);

      const buffer = Buffer.alloc(1024);
      const result = await validateAudioFile(buffer, 'fake.mp3');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not a valid audio file');
    });

    it('should return invalid when ffprobe exits with error code', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(1);
      mockSpawn.mockReturnValueOnce(proc as any);

      const buffer = Buffer.alloc(1024);
      const result = await validateAudioFile(buffer, 'corrupt.mp3');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not a valid audio file');
    });

    it('should not call ffprobe when size check fails', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);

      const buffer = Buffer.alloc(52_428_801);
      await validateAudioFile(buffer, 'large.mp3');
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should not call ffprobe when format check fails', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);

      const buffer = Buffer.alloc(1024);
      await validateAudioFile(buffer, 'video.mp4');
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should handle ffprobe spawn error gracefully', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter() as any;
      proc.stderr = new EventEmitter() as any;
      proc.stdout.destroy = vi.fn();
      proc.stderr.destroy = vi.fn();

      mockSpawn.mockReturnValueOnce(proc as any);

      const resultPromise = validateAudioFile(Buffer.alloc(1024), 'song.mp3');

      // Simulate spawn error (e.g., ffprobe not found)
      setTimeout(() => proc.emit('error', new Error('ENOENT')), 0);

      const result = await resultPromise;
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not a valid audio file');
    });

    it('should return invalid when ffprobe returns empty stdout', async () => {
      const mockSpawn = vi.mocked(child_process.spawn);
      const proc = createMockProcess(0, '');
      mockSpawn.mockReturnValueOnce(proc as any);

      const buffer = Buffer.alloc(1024);
      const result = await validateAudioFile(buffer, 'empty-stream.wav');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not a valid audio file');
    });
  });
});
