import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { computeHash, hammingDistance, deduplicate } from './dedupEngine';
import type { MediaItem } from '../types';

// Mock the database module
vi.mock('../database', () => {
  let mockDb: any = null;
  return {
    getDb: () => mockDb,
    __setMockDb: (db: any) => { mockDb = db; },
  };
});

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
    // Create a checkerboard pattern image — alternating black/white blocks
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


// --- hammingDistance tests ---

describe('hammingDistance', () => {
  it('should return 0 for identical hashes', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('ffffffffffffffff', 'ffffffffffffffff')).toBe(0);
  });

  it('should count differing bits correctly', () => {
    // '1' = 0001, '0' = 0000 → 1 bit difference
    expect(hammingDistance('1000000000000000', '0000000000000000')).toBe(1);
    // 'f' = 1111, '0' = 0000 → 4 bit differences
    expect(hammingDistance('f000000000000000', '0000000000000000')).toBe(4);
  });

  it('should be symmetric', () => {
    const a = 'abcdef0123456789';
    const b = '0000000000000000';
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });

  it('should return 64 for completely opposite hashes', () => {
    // 'f' = 1111, '0' = 0000 → all 64 bits differ
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
    // Create in-memory DB with same schema
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
      INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(item.id, item.tripId, item.filePath, item.mediaType, item.mimeType, item.originalFilename, item.fileSize, item.createdAt);
  }

  it('should group identical images together', async () => {
    const dir = makeTmpDir();
    const img1 = await createTestImage(dir, 'a.jpg', { r: 100, g: 100, b: 100 });
    // Copy same image
    const img2 = path.join(dir, 'b.jpg');
    fs.copyFileSync(img1, img2);

    const items: MediaItem[] = [
      { id: 'img-1', tripId: 'trip-1', filePath: img1, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'a.jpg', fileSize: 1000, createdAt: new Date().toISOString() },
      { id: 'img-2', tripId: 'trip-1', filePath: img2, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'b.jpg', fileSize: 1000, createdAt: new Date().toISOString() },
    ];
    items.forEach(insertMediaItem);

    const groups = await deduplicate(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].imageCount).toBe(2);
  });

  it('should not group visually different images', async () => {
    const dir = makeTmpDir();
    const white = await createTestImage(dir, 'white.jpg', { r: 255, g: 255, b: 255 });
    // Create a checkerboard pattern image
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
      { id: 'img-1', tripId: 'trip-1', filePath: white, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'white.jpg', fileSize: 1000, createdAt: new Date().toISOString() },
      { id: 'img-2', tripId: 'trip-1', filePath: checkerPath, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'checker.jpg', fileSize: 1000, createdAt: new Date().toISOString() },
    ];
    items.forEach(insertMediaItem);

    const groups = await deduplicate(items, 5); // strict threshold
    expect(groups).toHaveLength(0);
  });

  it('should preserve all original files after dedup', async () => {
    const dir = makeTmpDir();
    const img1 = await createTestImage(dir, 'a.jpg', { r: 100, g: 100, b: 100 });
    const img2 = path.join(dir, 'b.jpg');
    fs.copyFileSync(img1, img2);

    const items: MediaItem[] = [
      { id: 'img-1', tripId: 'trip-1', filePath: img1, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'a.jpg', fileSize: 1000, createdAt: new Date().toISOString() },
      { id: 'img-2', tripId: 'trip-1', filePath: img2, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'b.jpg', fileSize: 1000, createdAt: new Date().toISOString() },
    ];
    items.forEach(insertMediaItem);

    await deduplicate(items);

    // All original files must still exist
    expect(fs.existsSync(img1)).toBe(true);
    expect(fs.existsSync(img2)).toBe(true);
  });

  it('should handle transitive grouping via Union-Find', async () => {
    const dir = makeTmpDir();
    // Create 3 images: A≈B and B≈C, so A, B, C should all be in one group
    const imgA = await createTestImage(dir, 'a.jpg', { r: 100, g: 100, b: 100 });
    const imgB = path.join(dir, 'b.jpg');
    fs.copyFileSync(imgA, imgB); // B identical to A
    const imgC = path.join(dir, 'c.jpg');
    fs.copyFileSync(imgA, imgC); // C identical to A

    const items: MediaItem[] = [
      { id: 'img-1', tripId: 'trip-1', filePath: imgA, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'a.jpg', fileSize: 1000, createdAt: new Date().toISOString() },
      { id: 'img-2', tripId: 'trip-1', filePath: imgB, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'b.jpg', fileSize: 1000, createdAt: new Date().toISOString() },
      { id: 'img-3', tripId: 'trip-1', filePath: imgC, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'c.jpg', fileSize: 1000, createdAt: new Date().toISOString() },
    ];
    items.forEach(insertMediaItem);

    const groups = await deduplicate(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].imageCount).toBe(3);
  });

  it('should return empty array for empty input', async () => {
    const groups = await deduplicate([]);
    expect(groups).toHaveLength(0);
  });

  it('should update perceptual_hash in media_items', async () => {
    const dir = makeTmpDir();
    const img = await createTestImage(dir, 'a.jpg', { r: 50, g: 50, b: 50 });

    const items: MediaItem[] = [
      { id: 'img-1', tripId: 'trip-1', filePath: img, mediaType: 'image', mimeType: 'image/jpeg', originalFilename: 'a.jpg', fileSize: 1000, createdAt: new Date().toISOString() },
    ];
    items.forEach(insertMediaItem);

    await deduplicate(items);

    const row = testDb.prepare('SELECT perceptual_hash FROM media_items WHERE id = ?').get('img-1') as any;
    expect(row.perceptual_hash).toBeTruthy();
    expect(row.perceptual_hash).toHaveLength(16);
  });
});
