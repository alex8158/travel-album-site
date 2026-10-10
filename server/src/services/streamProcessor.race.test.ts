/**
 * Regression tests for the transferToStorage stream/cleanup race
 * (CI run 38016284838: "Uncaught Exception Error: ENOENT ... fail.mp4").
 *
 * `createReadStream` is wrapped so individual tests can substitute a stream whose
 * events fire in a controlled order; by default the real implementation is used.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { createStreamProcessor } from './streamProcessor';
import { StorageProvider } from '../storage/types';

const streamFactory = vi.hoisted(() => ({
  override: null as null | ((filePath: string) => any),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const createReadStream = (...args: any[]) =>
    streamFactory.override
      ? streamFactory.override(args[0])
      : (actual.createReadStream as any)(...args);
  return { ...actual, default: { ...actual, createReadStream }, createReadStream };
});

function storageWith(save: StorageProvider['save']): StorageProvider {
  return {
    save: vi.fn(save),
    read: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(),
    getUrl: vi.fn(),
    downloadToTemp: vi.fn(),
    initMultipartUpload: vi.fn(),
    getPresignedPartUrl: vi.fn(),
    getPresignedUploadUrl: vi.fn(),
    completeMultipartUpload: vi.fn(),
    abortMultipartUpload: vi.fn(),
    listParts: vi.fn(),
  } as unknown as StorageProvider;
}

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: ${message}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

/** Let several macrotask turns pass so any late stream event has fired. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 20));
}

let testDir: string;
let uncaught: unknown[];
const onUncaught = (err: unknown) => { uncaught.push(err); };

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-processor-race-'));
  uncaught = [];
  process.on('uncaughtException', onUncaught);
});

afterEach(async () => {
  streamFactory.override = null;
  process.off('uncaughtException', onUncaught);
  vi.restoreAllMocks();
  await fs.chmod(testDir, 0o755).catch(() => {});
  await fs.rm(testDir, { recursive: true, force: true });
});

describe('transferToStorage stream/cleanup ordering', () => {
  it('storage rejects before consuming + late stream error: original error, no uncaught exception, close before unlink', async () => {
    const tempFile = path.join(testDir, 'fail.mp4');
    await fs.writeFile(tempFile, 'fail test');

    // A stream whose deferred open fails *after* storage.save has already
    // rejected — the exact ordering that produced the CI uncaught ENOENT.
    const events: string[] = [];
    let fileExistedAtClose: boolean | undefined;
    streamFactory.override = () => {
      const s = new Readable({
        construct(cb) {
          setImmediate(() => {
            events.push('open-failed');
            cb(errnoError('ENOENT', `no such file or directory, open '${tempFile}'`));
          });
        },
        read() {},
      });
      s.once('close', () => {
        events.push('close');
        fileExistedAtClose = existsSync(tempFile);
      });
      return s;
    };

    const processor = createStreamProcessor(
      storageWith(async () => {
        events.push('save-rejected');
        throw new Error('disk full');
      }),
    );

    await expect(processor.transferToStorage(tempFile, 'dest/fail.mp4')).rejects.toThrow(
      'Stream transfer failed: disk full',
    );
    events.push('transfer-rejected');
    await settle();

    expect(uncaught).toEqual([]);
    expect(events).toEqual(['save-rejected', 'open-failed', 'close', 'transfer-rejected']);
    expect(fileExistedAtClose).toBe(true); // stream closed before the unlink
    expect(existsSync(tempFile)).toBe(false); // temp file cleaned up
  });

  it('storage rejects before consuming a real fs stream (repeated): no uncaught exception', async () => {
    // Real createReadStream (no override), real deferred open. The unfixed code
    // raced the open against unlink and leaked ENOENT in ~20% of iterations.
    const processor = createStreamProcessor(
      storageWith(async () => { throw new Error('disk full'); }),
    );
    for (let i = 0; i < 200; i++) {
      const tempFile = path.join(testDir, `real-${i}.mp4`);
      await fs.writeFile(tempFile, 'fail test');
      await expect(processor.transferToStorage(tempFile, 'dest/x.mp4')).rejects.toThrow(
        'Stream transfer failed: disk full',
      );
      expect(existsSync(tempFile)).toBe(false);
    }
    await settle();
    expect(uncaught).toEqual([]);
  });

  it('read stream fails mid-consumption: transfer rejects with the read error and cleans up', async () => {
    const tempFile = path.join(testDir, 'midway.mp4');
    await fs.writeFile(tempFile, 'some bytes');

    streamFactory.override = () => {
      let sent = false;
      return new Readable({
        read() {
          if (!sent) {
            sent = true;
            this.push(Buffer.from('first chunk'));
          } else {
            setImmediate(() => this.destroy(errnoError('EIO', 'i/o error, read')));
          }
        },
      });
    };

    const received: Buffer[] = [];
    const processor = createStreamProcessor(
      storageWith(async (_p, data) => {
        await pipeline(
          data as Readable,
          new Writable({ write(chunk, _enc, cb) { received.push(chunk); cb(); } }),
        );
      }),
    );

    await expect(processor.transferToStorage(tempFile, 'dest/midway.mp4')).rejects.toThrow(
      /Stream transfer failed: EIO: i\/o error, read/,
    );
    await settle();
    expect(Buffer.concat(received).toString()).toBe('first chunk');
    expect(uncaught).toEqual([]);
    expect(existsSync(tempFile)).toBe(false);
  });

  it('read error is not hidden when storage.save resolves without observing it', async () => {
    const tempFile = path.join(testDir, 'ignored.mp4');
    await fs.writeFile(tempFile, 'some bytes');

    streamFactory.override = () =>
      new Readable({
        read() { setImmediate(() => this.destroy(errnoError('EIO', 'i/o error, read'))); },
      });

    // Careless storage: only waits for 'close', never listens for 'error'.
    const processor = createStreamProcessor(
      storageWith(async (_p, data) => {
        const s = data as Readable;
        await new Promise<void>((resolve) => { s.once('close', () => resolve()); s.resume(); });
      }),
    );

    await expect(processor.transferToStorage(tempFile, 'dest/ignored.mp4')).rejects.toThrow(
      /Stream transfer failed: EIO: i\/o error, read/,
    );
    await settle();
    expect(uncaught).toEqual([]);
    expect(existsSync(tempFile)).toBe(false);
  });

  it('success path: bytes counted, temp file deleted', async () => {
    const tempFile = path.join(testDir, 'ok.mp4');
    const content = 'hello stream';
    await fs.writeFile(tempFile, content);

    const received: Buffer[] = [];
    const processor = createStreamProcessor(
      storageWith(async (_p, data) => {
        await pipeline(
          data as Readable,
          new Writable({ write(chunk, _enc, cb) { received.push(chunk); cb(); } }),
        );
      }),
    );

    const result = await processor.transferToStorage(tempFile, 'dest/ok.mp4');
    expect(result.success).toBe(true);
    expect(result.bytesTransferred).toBe(Buffer.byteLength(content));
    expect(Buffer.concat(received).toString()).toBe(content);
    expect(existsSync(tempFile)).toBe(false);
    await settle();
    expect(uncaught).toEqual([]);
  });

  it('cleanup failure after a storage error does not replace the original error', async () => {
    const tempFile = path.join(testDir, 'locked.mp4');
    await fs.writeFile(tempFile, 'data');
    await fs.chmod(testDir, 0o555); // unlink will fail with EACCES
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const processor = createStreamProcessor(
      storageWith(async () => { throw new Error('disk full'); }),
    );

    await expect(processor.transferToStorage(tempFile, 'dest/locked.mp4')).rejects.toThrow(
      'Stream transfer failed: disk full',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[StreamProcessor] Failed to delete temp file after failed transfer'),
    );
    expect(existsSync(tempFile)).toBe(true); // cleanup really failed, error still original
    await settle();
    expect(uncaught).toEqual([]);
  });
});
