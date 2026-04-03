import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { LocalStorageProvider } from './localProvider';

const TEST_BASE = path.join(__dirname, '__test_uploads__');

describe('LocalStorageProvider', () => {
  let provider: LocalStorageProvider;

  beforeEach(async () => {
    provider = new LocalStorageProvider(TEST_BASE);
    await fs.mkdir(TEST_BASE, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(TEST_BASE, { recursive: true, force: true });
  });

  describe('save', () => {
    it('should save a Buffer to the correct path', async () => {
      const data = Buffer.from('hello world');
      await provider.save('test/file.txt', data);

      const fullPath = path.join(TEST_BASE, 'test/file.txt');
      const content = await fs.readFile(fullPath);
      expect(content).toEqual(data);
    });

    it('should save a Readable stream to the correct path', async () => {
      const data = Buffer.from('stream content');
      const stream = Readable.from([data]);
      await provider.save('stream/file.txt', stream);

      const fullPath = path.join(TEST_BASE, 'stream/file.txt');
      const content = await fs.readFile(fullPath);
      expect(content).toEqual(data);
    });

    it('should create nested directories as needed', async () => {
      const data = Buffer.from('nested');
      await provider.save('a/b/c/deep.txt', data);

      const fullPath = path.join(TEST_BASE, 'a/b/c/deep.txt');
      const content = await fs.readFile(fullPath);
      expect(content).toEqual(data);
    });
  });

  describe('read', () => {
    it('should read a saved file and return Buffer', async () => {
      const data = Buffer.from('read me');
      await provider.save('read/file.txt', data);

      const result = await provider.read('read/file.txt');
      expect(result).toEqual(data);
    });

    it('should throw when file does not exist', async () => {
      await expect(provider.read('nonexistent.txt')).rejects.toThrow();
    });
  });

  describe('delete', () => {
    it('should delete an existing file', async () => {
      const data = Buffer.from('delete me');
      await provider.save('del/file.txt', data);
      expect(await provider.exists('del/file.txt')).toBe(true);

      await provider.delete('del/file.txt');
      expect(await provider.exists('del/file.txt')).toBe(false);
    });

    it('should not throw when file does not exist', async () => {
      await expect(provider.delete('no-such-file.txt')).resolves.not.toThrow();
    });
  });

  describe('exists', () => {
    it('should return true for existing file', async () => {
      await provider.save('exists/file.txt', Buffer.from('hi'));
      expect(await provider.exists('exists/file.txt')).toBe(true);
    });

    it('should return false for non-existing file', async () => {
      expect(await provider.exists('nope.txt')).toBe(false);
    });
  });

  describe('getUrl', () => {
    it('should return /uploads/ prefixed path', async () => {
      const url = await provider.getUrl('tripId/originals/photo.jpg');
      expect(url).toBe('/uploads/tripId/originals/photo.jpg');
    });
  });

  describe('downloadToTemp', () => {
    it('should return the absolute path directly', async () => {
      const result = await provider.downloadToTemp('tripId/originals/photo.jpg');
      expect(result).toBe(path.resolve(TEST_BASE, 'tripId/originals/photo.jpg'));
    });

    it('should return an absolute path', async () => {
      const result = await provider.downloadToTemp('some/file.txt');
      expect(path.isAbsolute(result)).toBe(true);
    });
  });

  describe('constructor', () => {
    it('should default to ./uploads when no basePath or env var', async () => {
      const originalEnv = process.env.LOCAL_STORAGE_PATH;
      delete process.env.LOCAL_STORAGE_PATH;

      const p = new LocalStorageProvider();
      // We can verify by checking downloadToTemp returns a path based on ./uploads
      await expect(p.downloadToTemp('test.txt')).resolves.toBe(path.resolve('./uploads', 'test.txt'));

      process.env.LOCAL_STORAGE_PATH = originalEnv;
    });
  });
});
