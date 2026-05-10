import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import { createStreamProcessor, StreamProcessor } from './streamProcessor';
import { StorageProvider } from '../storage/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStorage(overrides?: Partial<StorageProvider>): StorageProvider {
  return {
    save: vi.fn().mockImplementation(async (_path: string, data: Buffer | Readable) => {
      // Consume the stream to prevent unhandled errors from unconsumed read streams
      if (data instanceof Readable) {
        await new Promise<void>((resolve, reject) => {
          data.on('end', resolve);
          data.on('error', reject);
          data.resume(); // drain the stream
        });
      }
    }),
    read: vi.fn().mockResolvedValue(Buffer.from('')),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    getUrl: vi.fn().mockResolvedValue(''),
    downloadToTemp: vi.fn().mockResolvedValue(''),
    initMultipartUpload: vi.fn().mockResolvedValue(''),
    getPresignedPartUrl: vi.fn().mockResolvedValue(''),
    getPresignedUploadUrl: vi.fn().mockResolvedValue(''),
    completeMultipartUpload: vi.fn().mockResolvedValue(undefined),
    abortMultipartUpload: vi.fn().mockResolvedValue(undefined),
    listParts: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

let testDir: string;

async function createTestDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-processor-test-'));
  return dir;
}

async function createTempFile(dir: string, name: string, content: string): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content);
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamProcessor', () => {
  let processor: StreamProcessor;
  let mockStorage: StorageProvider;

  beforeEach(async () => {
    testDir = await createTestDir();
    mockStorage = createMockStorage();
    processor = createStreamProcessor(mockStorage);
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('transferToStorage', () => {
    it('should transfer file to storage via stream and delete temp file', async () => {
      const content = 'hello world video data';
      const tempFile = await createTempFile(testDir, 'video.mp4', content);

      const result = await processor.transferToStorage(tempFile, 'trips/1/video.mp4');

      expect(result.success).toBe(true);
      expect(result.bytesTransferred).toBe(Buffer.byteLength(content));
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Verify storage.save was called with a Readable stream
      expect(mockStorage.save).toHaveBeenCalledTimes(1);
      const [storagePath, data] = (mockStorage.save as any).mock.calls[0];
      expect(storagePath).toBe('trips/1/video.mp4');
      expect(data).toBeInstanceOf(Readable);

      // Verify temp file was deleted
      await expect(fs.access(tempFile)).rejects.toThrow();
    });

    it('should not delete temp file when deleteOnSuccess is false', async () => {
      const content = 'keep me';
      const tempFile = await createTempFile(testDir, 'keep.mp4', content);

      const result = await processor.transferToStorage(tempFile, 'dest/keep.mp4', {
        deleteOnSuccess: false,
      });

      expect(result.success).toBe(true);
      // Temp file should still exist
      await expect(fs.access(tempFile)).resolves.toBeUndefined();
    });

    it('should throw error when temp file does not exist', async () => {
      const nonExistentPath = path.join(testDir, 'nonexistent.mp4');

      await expect(
        processor.transferToStorage(nonExistentPath, 'dest/file.mp4'),
      ).rejects.toThrow(/not accessible/);

      // Storage should not be called
      expect(mockStorage.save).not.toHaveBeenCalled();
    });

    it('should throw error when temp file is not readable', async () => {
      const tempFile = await createTempFile(testDir, 'noperm.mp4', 'data');
      // Remove read permission
      await fs.chmod(tempFile, 0o000);

      await expect(
        processor.transferToStorage(tempFile, 'dest/file.mp4'),
      ).rejects.toThrow(/not accessible/);

      // Restore permissions for cleanup
      await fs.chmod(tempFile, 0o644);
    });

    it('should throw timeout error when transfer exceeds timeout', async () => {
      const content = 'timeout test data';
      const tempFile = await createTempFile(testDir, 'slow.mp4', content);

      // Mock storage.save to resolve only after a long delay (longer than timeout)
      const hangingStorage = createMockStorage({
        save: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 5000)),
        ),
      });
      const slowProcessor = createStreamProcessor(hangingStorage);

      await expect(
        slowProcessor.transferToStorage(tempFile, 'dest/slow.mp4', { timeoutMs: 50 }),
      ).rejects.toThrow(/timed out/);
    }, 10000);

    it('should throw error when storage.save fails', async () => {
      const content = 'fail test';
      const tempFile = await createTempFile(testDir, 'fail.mp4', content);

      const failingStorage = createMockStorage({
        save: vi.fn().mockRejectedValue(new Error('disk full')),
      });
      const failProcessor = createStreamProcessor(failingStorage);

      await expect(
        failProcessor.transferToStorage(tempFile, 'dest/fail.mp4'),
      ).rejects.toThrow(/disk full/);

      // Temp file should be cleaned up on error
      await expect(fs.access(tempFile)).rejects.toThrow();
    });

    it('should log warning but return success when temp file deletion fails', async () => {
      const content = 'delete fail test';
      const tempFile = await createTempFile(testDir, 'delfail.mp4', content);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Make the file undeletable by removing write permission on parent dir
      // Instead, we'll mock fs.unlink to fail after save succeeds
      // We need a different approach: use a real file but make the directory read-only
      await fs.chmod(testDir, 0o555);

      const result = await processor.transferToStorage(tempFile, 'dest/delfail.mp4');

      expect(result.success).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[StreamProcessor] Failed to delete temp file'),
      );

      // Restore permissions for cleanup
      await fs.chmod(testDir, 0o755);
      warnSpy.mockRestore();
    });

    it('should use default timeout of 300000ms', async () => {
      const content = 'default timeout';
      const tempFile = await createTempFile(testDir, 'default.mp4', content);

      // Just verify it doesn't timeout immediately (default is 300s)
      const result = await processor.transferToStorage(tempFile, 'dest/default.mp4');
      expect(result.success).toBe(true);
    });
  });

  describe('verifyCleanup', () => {
    it('should do nothing when temp directory is empty', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await processor.verifyCleanup(testDir);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should do nothing when temp directory does not exist', async () => {
      const nonExistentDir = path.join(testDir, 'nonexistent');

      // Should not throw
      await expect(processor.verifyCleanup(nonExistentDir)).resolves.toBeUndefined();
    });

    it('should force-delete residual files and log warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Create residual files
      await createTempFile(testDir, 'residual1.tmp', 'leftover1');
      await createTempFile(testDir, 'residual2.tmp', 'leftover2');

      await processor.verifyCleanup(testDir);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Found 2 residual file(s)'),
      );

      // Verify files were deleted
      const remaining = await fs.readdir(testDir);
      expect(remaining).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it('should force-delete residual directories recursively', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Create a residual subdirectory with files
      const subDir = path.join(testDir, 'frames');
      await fs.mkdir(subDir);
      await createTempFile(subDir, 'frame001.png', 'pixel data');
      await createTempFile(subDir, 'frame002.png', 'pixel data');

      await processor.verifyCleanup(testDir);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Found 1 residual file(s)'),
      );

      // Verify directory was deleted
      const remaining = await fs.readdir(testDir);
      expect(remaining).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it('should log warning and continue when individual file deletion fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Create files, then make one undeletable
      const file1 = await createTempFile(testDir, 'deletable.tmp', 'data');
      const subDir = path.join(testDir, 'locked');
      await fs.mkdir(subDir);
      await createTempFile(subDir, 'inner.tmp', 'data');
      // Make subdir read-only so its contents can't be deleted
      await fs.chmod(subDir, 0o555);

      await processor.verifyCleanup(testDir);

      // Should have logged the "Found residual" warning
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('residual file(s)'),
      );

      // Restore permissions for cleanup
      await fs.chmod(subDir, 0o755);
      warnSpy.mockRestore();
    });
  });
});
