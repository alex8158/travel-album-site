import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { computeHash, computePHash, hammingDistance, deduplicate, type SlidingWindowDedupOptions } from './dedupEngine';
import type { MediaItem } from '../types';

// Mock the database module
vi.mock('../database', () => {
  let mockDb: any = null;
  return {
    getDb: () => mockDb,
    __setMockDb: (db: any) => { mockDb = db; },
  };
});

// Mock the storage provider
vi.mock('../storage/factory', () => ({
  getStorageProvider: () => ({
    downloadToTemp: vi.fn(async (filePath: string) => filePath),
    delete: vi.fn(async () => {}),
  }),
}));

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

// --- deduplicate tests (with in-memory DB) ---

describe('deduplicate', () => {
  let testDb: Database.Database;

  beforeEach(async () => {
    // Create in-memory DB with same schema (including status column for new deduplicate)
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    testDb.exec(`
      CREATE TABLE trips (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        cover_image_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE duplicate_groups (
        id TEXT PRIMARY KEY,
        trip_id TEXT NOT NULL,
        default_image_id TEXT,
        image_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (trip_id) REFERENCES trips(id)
      );
      CREATE TABLE media_items (
        id TEXT PRIMARY KEY,
        trip_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        thumbnail_path TEXT,
        media_type TEXT NOT NULL DEFAULT 'unknown',
        mime_type TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        perceptual_hash TEXT,
        quality_score REAL,
        sharpness_score REAL,
        duplicate_group_id TEXT,
        phash TEXT,
        blur_status TEXT,
        exposure_score REAL,
        contrast_score REAL,
        noise_score REAL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        FOREIGN KEY (trip_id) REFERENCES trips(id),
        FOREIGN KEY (duplicate_group_id) REFERENCES duplicate_groups(id)
      );
    `);

    // Insert a test trip
    testDb.prepare(
      'INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run('trip-1', 'Test Trip', new Date().toISOString(), new Date().toISOString());

    // Set mock DB
    const dbModule = await import('../database') as any;
    dbModule.__setMockDb(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  function insertMediaItem(item: MediaItem): void {
    testDb.prepare(`
      INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, width, height, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(item.id, item.tripId, item.filePath, item.mediaType, item.mimeType, item.originalFilename, item.fileSize, item.width ?? null, item.height ?? null, item.status ?? 'active', item.createdAt);
  }

  it('should detect identical images as duplicates and remove one', async () => {
    const dir = makeTmpDir();
    const img1 = await createTestImage(dir, 'a.jpg', { r: 100, g: 100, b: 100 });
    const img2 = path.join(dir, 'b.jpg');
    fs.copyFileSync(img1, img2);

    const items: MediaItem[] = [
      { id: 'img-1', tripId: 'trip-1', filePath: img1, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'a.jpg', fileSize: 1000, width: 64, height: 64, status: 'active', visibility: 'public', createdAt: new Date().toISOString() },
      { id: 'img-2', tripId: 'trip-1', filePath: img2, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'b.jpg', fileSize: 1000, width: 64, height: 64, status: 'active', visibility: 'public', createdAt: new Date().toISOString() },
    ];
    items.forEach(insertMediaItem);

    const result = await deduplicate('trip-1');
    // Identical images: one kept, one removed
    expect(result.removedCount).toBe(1);
    expect(result.kept).toHaveLength(1);
    expect(result.removed).toHaveLength(1);
  });

  it('should not remove visually different images', async () => {
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

    const items: MediaItem[] = [
      { id: 'img-1', tripId: 'trip-1', filePath: white, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'white.jpg', fileSize: 1000, width: 64, height: 64, status: 'active', visibility: 'public', createdAt: new Date().toISOString() },
      { id: 'img-2', tripId: 'trip-1', filePath: checkerPath, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'checker.jpg', fileSize: 1000, width: 64, height: 64, status: 'active', visibility: 'public', createdAt: new Date().toISOString() },
    ];
    items.forEach(insertMediaItem);

    const result = await deduplicate('trip-1', { hammingThreshold: 5 });
    expect(result.removedCount).toBe(0);
    expect(result.kept).toHaveLength(2);
  });

  it('should permanently delete duplicate from DB', async () => {
    const dir = makeTmpDir();
    const img1 = await createTestImage(dir, 'a.jpg', { r: 100, g: 100, b: 100 });
    const img2 = path.join(dir, 'b.jpg');
    fs.copyFileSync(img1, img2);

    const items: MediaItem[] = [
      { id: 'img-1', tripId: 'trip-1', filePath: img1, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'a.jpg', fileSize: 1000, width: 64, height: 64, status: 'active', visibility: 'public', createdAt: new Date().toISOString() },
      { id: 'img-2', tripId: 'trip-1', filePath: img2, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'b.jpg', fileSize: 1000, width: 64, height: 64, status: 'active', visibility: 'public', createdAt: new Date().toISOString() },
    ];
    items.forEach(insertMediaItem);

    const result = await deduplicate('trip-1');
    // The removed item should be deleted from DB
    const removedId = result.removed[0];
    const row = testDb.prepare('SELECT id FROM media_items WHERE id = ?').get(removedId);
    expect(row).toBeUndefined();
  });

  it('should remove all but one when multiple identical images exist', async () => {
    const dir = makeTmpDir();
    const imgA = await createTestImage(dir, 'a.jpg', { r: 100, g: 100, b: 100 });
    const imgB = path.join(dir, 'b.jpg');
    fs.copyFileSync(imgA, imgB);
    const imgC = path.join(dir, 'c.jpg');
    fs.copyFileSync(imgA, imgC);

    const items: MediaItem[] = [
      { id: 'img-1', tripId: 'trip-1', filePath: imgA, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'a.jpg', fileSize: 1000, width: 64, height: 64, status: 'active', visibility: 'public', createdAt: new Date().toISOString() },
      { id: 'img-2', tripId: 'trip-1', filePath: imgB, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'b.jpg', fileSize: 1000, width: 64, height: 64, status: 'active', visibility: 'public', createdAt: new Date().toISOString() },
      { id: 'img-3', tripId: 'trip-1', filePath: imgC, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'c.jpg', fileSize: 1000, width: 64, height: 64, status: 'active', visibility: 'public', createdAt: new Date().toISOString() },
    ];
    items.forEach(insertMediaItem);

    const result = await deduplicate('trip-1');
    // All identical: keep 1, remove 2
    expect(result.kept).toHaveLength(1);
    expect(result.removedCount).toBe(2);
  });

  it('should not group distinct images — sliding window prevents false matches', async () => {
    const dir = makeTmpDir();
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

    const invCheckerPath = path.join(dir, 'inv_checker.jpg');
    const invCheckerBuf = Buffer.alloc(size * size * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 3;
        const isWhite = ((Math.floor(x / 8) + Math.floor(y / 8)) % 2) !== 0;
        const val = isWhite ? 255 : 0;
        invCheckerBuf[idx] = val;
        invCheckerBuf[idx + 1] = val;
        invCheckerBuf[idx + 2] = val;
      }
    }
    await sharp(invCheckerBuf, { raw: { width: size, height: size, channels: 3 } })
      .jpeg()
      .toFile(invCheckerPath);

    const diagPath = path.join(dir, 'diag.jpg');
    const diagBuf = Buffer.alloc(size * size * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 3;
        const val = (x < size / 2 && y < size / 2) ? 240 : (x >= size / 2 && y >= size / 2) ? 10 : 128;
        diagBuf[idx] = val;
        diagBuf[idx + 1] = val;
        diagBuf[idx + 2] = val;
      }
    }
    await sharp(diagBuf, { raw: { width: size, height: size, channels: 3 } })
      .jpeg()
      .toFile(diagPath);

    const items: MediaItem[] = [
      { id: 'img-1', tripId: 'trip-1', filePath: checkerPath, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'checker.jpg', fileSize: 1000, width: size, height: size, status: 'active', visibility: 'public', createdAt: new Date().toISOString() },
      { id: 'img-2', tripId: 'trip-1', filePath: invCheckerPath, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'inv_checker.jpg', fileSize: 1000, width: size, height: size, status: 'active', visibility: 'public', createdAt: new Date().toISOString() },
      { id: 'img-3', tripId: 'trip-1', filePath: diagPath, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'diag.jpg', fileSize: 1000, width: size, height: size, status: 'active', visibility: 'public', createdAt: new Date().toISOString() },
    ];
    items.forEach(insertMediaItem);

    const result = await deduplicate('trip-1', { hammingThreshold: 5 });
    expect(result.removedCount).toBe(0);
    expect(result.kept).toHaveLength(3);
  });

  it('should return empty result for trip with no images', async () => {
    const result = await deduplicate('trip-1');
    expect(result.kept).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.removedCount).toBe(0);
  });

  it('should accept SlidingWindowDedupOptions to override thresholds', async () => {
    const dir = makeTmpDir();
    const img1 = await createTestImage(dir, 'a.jpg', { r: 100, g: 100, b: 100 });
    const img2 = path.join(dir, 'b.jpg');
    fs.copyFileSync(img1, img2);

    const items: MediaItem[] = [
      { id: 'img-1', tripId: 'trip-1', filePath: img1, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'a.jpg', fileSize: 1000, width: 64, height: 64, status: 'active', visibility: 'public', createdAt: new Date().toISOString() },
      { id: 'img-2', tripId: 'trip-1', filePath: img2, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'b.jpg', fileSize: 1000, width: 64, height: 64, status: 'active', visibility: 'public', createdAt: new Date().toISOString() },
    ];
    items.forEach(insertMediaItem);

    const opts: SlidingWindowDedupOptions = { hammingThreshold: 0 };
    const result = await deduplicate('trip-1', opts);
    // Identical images have distance 0, so threshold 0 should still match
    expect(result.removedCount).toBe(1);
  });
});
