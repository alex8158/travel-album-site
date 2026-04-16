import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';
import { computeHash, computePHash, hammingDistance } from './dedupEngine';

// --- Helpers ---

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** Create a solid-color test image and return its path */
async function createTestImage(
  dir: string,
  name: string,
  color: { r: number; g: number; b: number },
  width = 64,
  height = 64
): Promise<string> {
  const fp = path.join(dir, name);
  await sharp({
    create: { width, height, channels: 3, background: color },
  })
    .jpeg()
    .toFile(fp);
  return fp;
}

afterEach(() => {
  for (const d of tmpDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// --- computeHash tests ---

describe('computeHash', () => {
  it('should return a 16-character hex string', async () => {
    const dir = makeTmpDir();
    const img = await createTestImage(dir, 'test.jpg', { r: 128, g: 128, b: 128 });
    const hash = await computeHash(img);
    expect(hash).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true);
  });

  it('should be deterministic (same image → same hash)', async () => {
    const dir = makeTmpDir();
    const img = await createTestImage(dir, 'test.jpg', { r: 200, g: 100, b: 50 });
    const hash1 = await computeHash(img);
    const hash2 = await computeHash(img);
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for visually different images', async () => {
    const dir = makeTmpDir();
    const white = await createTestImage(dir, 'white.jpg', { r: 255, g: 255, b: 255 });
    const size = 64;
    const checkerPath = path.join(dir, 'checker.jpg');
    const checkerBuf = Buffer.alloc(size * size * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 3;
        const isWhite = ((Math.floor(x / 8) + Math.floor(y / 8)) % 2) === 0;
        const val = isWhite ? 255 : 0;
        checkerBuf[idx] = val;
        checkerBuf[idx + 1] = val;
        checkerBuf[idx + 2] = val;
      }
    }
    await sharp(checkerBuf, { raw: { width: size, height: size, channels: 3 } })
      .jpeg()
      .toFile(checkerPath);

    const hashWhite = await computeHash(white);
    const hashChecker = await computeHash(checkerPath);
    expect(hashWhite).not.toBe(hashChecker);
  });
});

// --- computePHash tests ---

describe('computePHash', () => {
  it('should return a 16-character hex string', async () => {
    const dir = makeTmpDir();
    const img = await createTestImage(dir, 'test.jpg', { r: 128, g: 128, b: 128 });
    const hash = await computePHash(img);
    expect(hash).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true);
  });

  it('should be deterministic (same image → same hash)', async () => {
    const dir = makeTmpDir();
    const img = await createTestImage(dir, 'test.jpg', { r: 200, g: 100, b: 50 });
    const hash1 = await computePHash(img);
    const hash2 = await computePHash(img);
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for visually different images', async () => {
    const dir = makeTmpDir();
    const white = await createTestImage(dir, 'white.jpg', { r: 255, g: 255, b: 255 });
    const size = 64;
    const checkerPath = path.join(dir, 'checker.jpg');
    const checkerBuf = Buffer.alloc(size * size * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 3;
        const isWhite = ((Math.floor(x / 8) + Math.floor(y / 8)) % 2) === 0;
        const val = isWhite ? 255 : 0;
        checkerBuf[idx] = val;
        checkerBuf[idx + 1] = val;
        checkerBuf[idx + 2] = val;
      }
    }
    await sharp(checkerBuf, { raw: { width: size, height: size, channels: 3 } })
      .jpeg()
      .toFile(checkerPath);

    const hashWhite = await computePHash(white);
    const hashChecker = await computePHash(checkerPath);
    expect(hashWhite).not.toBe(hashChecker);
  });
});

// --- hammingDistance tests ---

describe('hammingDistance', () => {
  it('should return 0 for identical hashes', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('ffffffffffffffff', 'ffffffffffffffff')).toBe(0);
  });

  it('should count differing bits correctly', () => {
    expect(hammingDistance('1000000000000000', '0000000000000000')).toBe(1);
    expect(hammingDistance('f000000000000000', '0000000000000000')).toBe(4);
  });

  it('should be symmetric', () => {
    const a = 'abcdef0123456789';
    const b = '0000000000000000';
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });

  it('should return 64 for completely opposite hashes', () => {
    expect(hammingDistance('ffffffffffffffff', '0000000000000000')).toBe(64);
  });

  it('should throw for different length hashes', () => {
    expect(() => hammingDistance('abc', 'abcd')).toThrow();
  });
});

