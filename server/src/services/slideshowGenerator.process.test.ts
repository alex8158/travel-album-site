/**
 * Process-lifecycle tests for runFfmpegProcess, exercised through generateSlideshow.
 *
 * `spawn('ffmpeg', ...)` is redirected to a REAL Node child running a small script,
 * so stderr volume, exit codes, signals and close timing are real OS behaviour while
 * the tests stay independent of an installed ffmpeg. The script receives ffmpeg's
 * output path (the last ffmpeg argument) as process.argv[1].
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

const h = vi.hoisted(() => ({
  script: '',
  command: null as string | null,
  children: [] as ChildProcess[],
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (_cmd: string, args: string[], opts: import('child_process').SpawnOptions) => {
      const child = h.command
        ? actual.spawn(h.command, args, opts)
        : actual.spawn(process.execPath, ['-e', h.script, args[args.length - 1]], opts);
      h.children.push(child);
      return child;
    },
  };
});

import { generateSlideshow } from './slideshowGenerator';

let root: string;
let photos: string[];

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Snapshot of the child at the moment the generator's promise settled. */
async function runAndSnapshot(opts: { timeoutMs: number; onProgress?: (p: number) => void }) {
  const outDir = fs.mkdtempSync(path.join(root, 'out-'));
  const t0 = Date.now();
  const result = await generateSlideshow({
    photoPaths: photos,
    audioPath: null,
    outputDir: outDir,
    photoDuration: 1,
    timeoutMs: opts.timeoutMs,
    onProgress: opts.onProgress,
  });
  const elapsedMs = Date.now() - t0;
  const child = h.children[h.children.length - 1];
  const snapshot = {
    exitCode: child?.exitCode ?? null,
    signalCode: child?.signalCode ?? null,
    alive: isAlive(child?.pid),
  };
  return { result, elapsedMs, child, snapshot, files: fs.readdirSync(outDir) };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slideshow-proc-test-'));
  photos = [];
  for (const [i, color] of [[255, 0, 0], [0, 255, 0], [0, 0, 255]].entries()) {
    const p = path.join(root, `p${i}.jpg`);
    await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: color[0], g: color[1], b: color[2] } } })
      .jpeg()
      .toFile(p);
    photos.push(p);
  }
});

afterAll(() => {
  for (const c of h.children) {
    if (isAlive(c.pid)) c.kill('SIGKILL');
  }
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  h.script = '';
  h.command = null;
});

describe('runFfmpegProcess (via generateSlideshow, real child processes)', () => {
  it('succeeds on exit 0 and still reports progress from stderr', async () => {
    h.script = `
      require('fs').writeFileSync(process.argv[1], 'video');
      process.stderr.write('frame=1 time=00:00:01.50 bitrate=1\\n', () => process.exit(0));
    `;
    const progress: number[] = [];
    const { result, files } = await runAndSnapshot({ timeoutMs: 10_000, onProgress: (p) => progress.push(p) });
    expect(result.success).toBe(true);
    expect(result.totalDuration).toBe(3);
    expect(progress).toContain(50);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^slideshow_\d+\.mp4$/);
  });

  it('keeps only a bounded stderr tail in the error message', async () => {
    // 1 MB of stderr without a newline, then a marker, then exit 1.
    h.script = `
      process.stderr.write('x'.repeat(1024 * 1024) + 'TAIL-MARKER', () => process.exit(1));
    `;
    const { result, snapshot } = await runAndSnapshot({ timeoutMs: 10_000 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ffmpeg 处理失败，退出码: 1');
    expect(result.error).toContain('TAIL-MARKER');
    // Unbounded accumulation would put the whole 1 MB line into the message.
    expect(result.error!.length).toBeLessThanOrEqual(64 * 1024 + 200);
    expect(snapshot.exitCode).toBe(1);
  });

  it('kills an endless stderr flood on timeout, settles after the child closed, and leaves no partial file', async () => {
    // Mimics ffmpeg on a garbage JPEG: creates a 0-byte output file, then prints
    // "No JPEG data found in image" forever.
    h.script = `
      require('fs').writeFileSync(process.argv[1], '');
      const line = 'No JPEG data found in image\\n'.repeat(2000);
      const pump = () => { while (process.stderr.write(line)) {} process.stderr.once('drain', pump); };
      pump();
    `;
    const { result, snapshot, files, elapsedMs } = await runAndSnapshot({ timeoutMs: 1500 });
    expect(result.success).toBe(false);
    expect(result.error).toBe('视频生成超时');
    expect(snapshot.signalCode).toBe('SIGKILL');
    expect(snapshot.alive).toBe(false);
    expect(files).toEqual([]);
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it('turns a handler exception into a rejection, kills the child, and waits for it to close', async () => {
    h.script = `
      require('fs').writeFileSync(process.argv[1], '');
      process.stderr.write('frame=1 time=00:00:01.00 bitrate=1\\n');
      setInterval(() => {}, 1000);
    `;
    const { result, snapshot, files, elapsedMs } = await runAndSnapshot({
      timeoutMs: 20_000,
      onProgress: () => {
        throw new Error('boom from onProgress');
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('ffmpeg 输出处理失败: boom from onProgress');
    expect(snapshot.signalCode).toBe('SIGKILL');
    expect(snapshot.alive).toBe(false);
    expect(files).toEqual([]);
    // Settled by the kill, not by the 20 s timeout.
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it('rejects immediately when the child never starts', async () => {
    h.command = path.join(root, 'definitely-not-ffmpeg');
    const { result, child, files } = await runAndSnapshot({ timeoutMs: 10_000 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^ffmpeg 进程启动失败: .*ENOENT/);
    expect(child.pid).toBeUndefined();
    expect(files).toEqual([]);
  });
});
