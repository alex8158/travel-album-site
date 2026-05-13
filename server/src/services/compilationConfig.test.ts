import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getVideoMemoryLimitMB, getCompilationConfig } from './compilationConfig';

describe('compilationConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getVideoMemoryLimitMB', () => {
    it('returns default 4096 when env var is not set', () => {
      delete process.env.VIDEO_MEMORY_LIMIT_MB;
      expect(getVideoMemoryLimitMB()).toBe(4096);
    });

    it('returns default 4096 when env var is empty string', () => {
      process.env.VIDEO_MEMORY_LIMIT_MB = '';
      expect(getVideoMemoryLimitMB()).toBe(4096);
    });

    it('returns parsed value when valid', () => {
      process.env.VIDEO_MEMORY_LIMIT_MB = '2048';
      expect(getVideoMemoryLimitMB()).toBe(2048);
    });

    it('returns parsed value at minimum boundary (128)', () => {
      process.env.VIDEO_MEMORY_LIMIT_MB = '128';
      expect(getVideoMemoryLimitMB()).toBe(128);
    });

    it('returns parsed value at maximum boundary (65536)', () => {
      process.env.VIDEO_MEMORY_LIMIT_MB = '65536';
      expect(getVideoMemoryLimitMB()).toBe(65536);
    });

    it('returns default for value below minimum', () => {
      process.env.VIDEO_MEMORY_LIMIT_MB = '50';
      expect(getVideoMemoryLimitMB()).toBe(4096);
    });

    it('returns default for value above maximum', () => {
      process.env.VIDEO_MEMORY_LIMIT_MB = '100000';
      expect(getVideoMemoryLimitMB()).toBe(4096);
    });

    it('returns default for non-numeric value', () => {
      process.env.VIDEO_MEMORY_LIMIT_MB = 'abc';
      expect(getVideoMemoryLimitMB()).toBe(4096);
    });

    it('returns default for NaN', () => {
      process.env.VIDEO_MEMORY_LIMIT_MB = 'NaN';
      expect(getVideoMemoryLimitMB()).toBe(4096);
    });

    it('truncates float to integer', () => {
      process.env.VIDEO_MEMORY_LIMIT_MB = '4096.7';
      expect(getVideoMemoryLimitMB()).toBe(4096);
    });
  });

  describe('getCompilationConfig', () => {
    it('returns config object with videoMemoryLimitMB', () => {
      process.env.VIDEO_MEMORY_LIMIT_MB = '8192';
      const config = getCompilationConfig();
      expect(config).toEqual({ videoMemoryLimitMB: 8192 });
    });

    it('returns default config when no env vars set', () => {
      delete process.env.VIDEO_MEMORY_LIMIT_MB;
      const config = getCompilationConfig();
      expect(config).toEqual({ videoMemoryLimitMB: 4096 });
    });
  });
});
