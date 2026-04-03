import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { computeQualityScore, selectBest, processTrip, getTrashedDuplicateCount } from './qualitySelector';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-test-'));
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

/** Create a checkerboard pattern image (higher sharpness) */
async function createCheckerImage(
  dir: string,
  name: string,
  width = 64,
  height = 64
): Promise<string> {
  const fp = path.join(dir, name);
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const isWhite = ((Math.floor(x / 8) + Math.floor(y / 8)) % 2) === 0;
      const val = isWhite ? 255 : 0;
      buf[idx] = val;
      buf[idx + 1] = val;
      buf[idx + 2] = val;
    }
  }
  await sharp(buf, { raw: { width, height, channels: 3 } })
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

// --- computeQualityScore tests ---

describe('computeQualityScore', () => {
  it('should return normalized resolution in [0, 1]', async () => {
    const dir = makeTmpDir();
    const img = await createTestImage(dir, 'test.jpg', { r: 128, g: 128, b: 128 }, 100, 80);
    const score = await computeQualityScore(img);
    // resolution = min(100*80 / 12_000_000, 1.0)
    expect(score.resolution).toBeCloseTo(8000 / 12_000_000, 6);
  });

  it('should return normalized file size in [0, 1]', async () => {
    const dir = makeTmpDir();
    const img = await createTestImage(dir, 'test.jpg', { r: 128, g: 128, b: 128 });
    const score = await computeQualityScore(img);
    expect(score.fileSize).toBeGreaterThan(0);
    expect(score.fileSize).toBeLessThanOrEqual(1.0);
  });

  it('should return normalized sharpness in [0, 1]', async () => {
    const dir = makeTmpDir();
    const img = await createTestImage(dir, 'test.jpg', { r: 128, g: 128, b: 128 });
    const score = await computeQualityScore(img);
    expect(score.sharpness).toBeGreaterThanOrEqual(0);
    expect(score.sharpness).toBeLessThanOrEqual(1.0);
  });

  it('should give higher sharpness to a detailed image than a solid color', async () => {
    const dir = makeTmpDir();
    const solid = await createTestImage(dir, 'solid.jpg', { r: 128, g: 128, b: 128 }, 128, 128);
    const checker = await createCheckerImage(dir, 'checker.jpg', 128, 128);

    const solidScore = await computeQualityScore(solid);
    const checkerScore = await computeQualityScore(checker);

    expect(checkerScore.sharpness).toBeGreaterThan(solidScore.sharpness!);
  });

  it('should compute overall as weighted sum of all dimensions', async () => {
    const dir = makeTmpDir();
    const img = await createTestImage(dir, 'test.jpg', { r: 50, g: 50, b: 50 }, 200, 150);
    const score = await computeQualityScore(img);
    // overall should be a weighted combination, not just resolution
    expect(score.overall).toBeGreaterThan(0);
    expect(score.overall).toBeLessThanOrEqual(1.0);
    // Verify it includes contributions from multiple dimensions
    expect(score.exposure).not.toBeNull();
    expect(score.contrast).not.toBeNull();
    expect(score.noiseArtifact).not.toBeNull();
  });
});

// --- selectBest and processTrip tests (with in-memory DB) ---

describe('selectBest', () => {
  let testDb: Database.Database;

  beforeEach(async () => {
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
        status TEXT NOT NULL DEFAULT 'active',
        trashed_reason TEXT,
        processing_error TEXT,
        blur_status TEXT,
        exposure_score REAL,
        contrast_score REAL,
        noise_score REAL,
        phash TEXT,
        optimized_path TEXT,
        compiled_path TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (trip_id) REFERENCES trips(id),
        FOREIGN KEY (duplicate_group_id) REFERENCES duplicate_groups(id)
      );
    `);

    const now = new Date().toISOString();
    testDb.prepare(
      'INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run('trip-1', 'Test Trip', now, now);

    const dbModule = await import('../database') as any;
    dbModule.__setMockDb(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  function insertGroup(id: string, tripId: string, defaultImageId: string, imageCount: number): void {
    testDb.prepare(
      'INSERT INTO duplicate_groups (id, trip_id, default_image_id, image_count, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, tripId, defaultImageId, imageCount, new Date().toISOString());
  }

  function insertMediaItem(id: string, tripId: string, filePath: string, groupId: string | null, fileSize = 1000): void {
    testDb.prepare(`
      INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, duplicate_group_id, created_at)
      VALUES (?, ?, ?, 'image', 'image/jpeg', ?, ?, ?, ?)
    `).run(id, tripId, filePath, path.basename(filePath), fileSize, groupId, new Date().toISOString());
  }

  it('should select the image with highest resolution', async () => {
    const dir = makeTmpDir();
    const small = await createTestImage(dir, 'small.jpg', { r: 100, g: 100, b: 100 }, 64, 64);
    const large = await createTestImage(dir, 'large.jpg', { r: 100, g: 100, b: 100 }, 256, 256);

    insertGroup('group-1', 'trip-1', 'img-small', 2);
    insertMediaItem('img-small', 'trip-1', small, 'group-1');
    insertMediaItem('img-large', 'trip-1', large, 'group-1');

    const best = await selectBest('group-1');
    expect(best.id).toBe('img-large');

    // Verify DB was updated
    const row = testDb.prepare('SELECT default_image_id FROM duplicate_groups WHERE id = ?').get('group-1') as any;
    expect(row.default_image_id).toBe('img-large');
  });

  it('should use sharpness as tiebreaker when resolution is equal', async () => {
    const dir = makeTmpDir();
    const solid = await createTestImage(dir, 'solid.jpg', { r: 128, g: 128, b: 128 }, 128, 128);
    const checker = await createCheckerImage(dir, 'checker.jpg', 128, 128);

    insertGroup('group-1', 'trip-1', 'img-solid', 2);
    insertMediaItem('img-solid', 'trip-1', solid, 'group-1');
    insertMediaItem('img-checker', 'trip-1', checker, 'group-1');

    const best = await selectBest('group-1');
    expect(best.id).toBe('img-checker');
  });

  it('should update quality_score and dimension scores in media_items', async () => {
    const dir = makeTmpDir();
    const img = await createTestImage(dir, 'test.jpg', { r: 50, g: 50, b: 50 }, 100, 100);

    insertGroup('group-1', 'trip-1', 'img-1', 1);
    insertMediaItem('img-1', 'trip-1', img, 'group-1');

    await selectBest('group-1');

    const row = testDb.prepare('SELECT quality_score, sharpness_score, exposure_score, contrast_score, noise_score FROM media_items WHERE id = ?').get('img-1') as any;
    // quality_score is the weighted overall, should be in [0, 1]
    expect(row.quality_score).toBeGreaterThanOrEqual(0);
    expect(row.quality_score).toBeLessThanOrEqual(1.0);
    expect(row.sharpness_score).toBeGreaterThanOrEqual(0);
    // New dimension columns should be written
    expect(row.exposure_score).not.toBeNull();
    expect(row.contrast_score).not.toBeNull();
    expect(row.noise_score).not.toBeNull();
  });

  it('should trash non-best images with reason duplicate', async () => {
    const dir = makeTmpDir();
    const small = await createTestImage(dir, 'small.jpg', { r: 100, g: 100, b: 100 }, 64, 64);
    const large = await createTestImage(dir, 'large.jpg', { r: 100, g: 100, b: 100 }, 256, 256);

    insertGroup('group-1', 'trip-1', 'img-small', 2);
    insertMediaItem('img-small', 'trip-1', small, 'group-1');
    insertMediaItem('img-large', 'trip-1', large, 'group-1');

    await selectBest('group-1');

    // Best image should remain active
    const bestRow = testDb.prepare('SELECT status, trashed_reason FROM media_items WHERE id = ?').get('img-large') as any;
    expect(bestRow.status).toBe('active');
    expect(bestRow.trashed_reason).toBeNull();

    // Non-best image should be trashed
    const trashedRow = testDb.prepare('SELECT status, trashed_reason FROM media_items WHERE id = ?').get('img-small') as any;
    expect(trashedRow.status).toBe('trashed');
    expect(trashedRow.trashed_reason).toBe('duplicate');
  });

  it('should not trash the only image in a single-member group', async () => {
    const dir = makeTmpDir();
    const img = await createTestImage(dir, 'only.jpg', { r: 50, g: 50, b: 50 }, 100, 100);

    insertGroup('group-1', 'trip-1', 'img-1', 1);
    insertMediaItem('img-1', 'trip-1', img, 'group-1');

    await selectBest('group-1');

    const row = testDb.prepare('SELECT status, trashed_reason FROM media_items WHERE id = ?').get('img-1') as any;
    expect(row.status).toBe('active');
    expect(row.trashed_reason).toBeNull();
  });
});

describe('getTrashedDuplicateCount', () => {
  let testDb: Database.Database;

  beforeEach(async () => {
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
        status TEXT NOT NULL DEFAULT 'active',
        trashed_reason TEXT,
        processing_error TEXT,
        blur_status TEXT,
        exposure_score REAL,
        contrast_score REAL,
        noise_score REAL,
        phash TEXT,
        optimized_path TEXT,
        compiled_path TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (trip_id) REFERENCES trips(id),
        FOREIGN KEY (duplicate_group_id) REFERENCES duplicate_groups(id)
      );
    `);

    const now = new Date().toISOString();
    testDb.prepare(
      'INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run('trip-1', 'Test Trip', now, now);

    const dbModule = await import('../database') as any;
    dbModule.__setMockDb(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('should return 0 when no trashed duplicates exist', () => {
    const count = getTrashedDuplicateCount('trip-1');
    expect(count).toBe(0);
  });

  it('should count only items with status trashed and reason duplicate', () => {
    const now = new Date().toISOString();
    // Insert items with various statuses
    testDb.prepare(`
      INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, trashed_reason, created_at)
      VALUES (?, ?, ?, 'image', 'image/jpeg', ?, 1000, ?, ?, ?)
    `).run('img-1', 'trip-1', '/fake/1.jpg', '1.jpg', 'active', null, now);
    testDb.prepare(`
      INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, trashed_reason, created_at)
      VALUES (?, ?, ?, 'image', 'image/jpeg', ?, 1000, ?, ?, ?)
    `).run('img-2', 'trip-1', '/fake/2.jpg', '2.jpg', 'trashed', 'duplicate', now);
    testDb.prepare(`
      INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, trashed_reason, created_at)
      VALUES (?, ?, ?, 'image', 'image/jpeg', ?, 1000, ?, ?, ?)
    `).run('img-3', 'trip-1', '/fake/3.jpg', '3.jpg', 'trashed', 'blur', now);
    testDb.prepare(`
      INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, trashed_reason, created_at)
      VALUES (?, ?, ?, 'image', 'image/jpeg', ?, 1000, ?, ?, ?)
    `).run('img-4', 'trip-1', '/fake/4.jpg', '4.jpg', 'trashed', 'duplicate', now);

    const count = getTrashedDuplicateCount('trip-1');
    expect(count).toBe(2);
  });
});

describe('processTrip', () => {
  let testDb: Database.Database;

  beforeEach(async () => {
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
        status TEXT NOT NULL DEFAULT 'active',
        trashed_reason TEXT,
        processing_error TEXT,
        blur_status TEXT,
        exposure_score REAL,
        contrast_score REAL,
        noise_score REAL,
        phash TEXT,
        optimized_path TEXT,
        compiled_path TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (trip_id) REFERENCES trips(id),
        FOREIGN KEY (duplicate_group_id) REFERENCES duplicate_groups(id)
      );
    `);

    const now = new Date().toISOString();
    testDb.prepare(
      'INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run('trip-1', 'Test Trip', now, now);

    const dbModule = await import('../database') as any;
    dbModule.__setMockDb(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('should compute quality scores for ungrouped images', async () => {
    const dir = makeTmpDir();
    const img = await createTestImage(dir, 'solo.jpg', { r: 200, g: 200, b: 200 }, 80, 60);

    testDb.prepare(`
      INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, created_at)
      VALUES (?, ?, ?, 'image', 'image/jpeg', 'solo.jpg', 1000, ?)
    `).run('img-solo', 'trip-1', img, new Date().toISOString());

    await processTrip('trip-1');

    const row = testDb.prepare('SELECT quality_score, sharpness_score, exposure_score, contrast_score, noise_score FROM media_items WHERE id = ?').get('img-solo') as any;
    // quality_score is the weighted overall, should be in [0, 1]
    expect(row.quality_score).toBeGreaterThanOrEqual(0);
    expect(row.quality_score).toBeLessThanOrEqual(1.0);
    expect(row.sharpness_score).toBeGreaterThanOrEqual(0);
    // New dimension columns should be written
    expect(row.exposure_score).not.toBeNull();
    expect(row.contrast_score).not.toBeNull();
    expect(row.noise_score).not.toBeNull();
  });

  it('should process both grouped and ungrouped images', async () => {
    const dir = makeTmpDir();
    const img1 = await createTestImage(dir, 'a.jpg', { r: 100, g: 100, b: 100 }, 64, 64);
    const img2 = await createTestImage(dir, 'b.jpg', { r: 100, g: 100, b: 100 }, 128, 128);
    const imgSolo = await createTestImage(dir, 'solo.jpg', { r: 200, g: 200, b: 200 }, 96, 96);

    const now = new Date().toISOString();

    // Insert a duplicate group
    testDb.prepare(
      'INSERT INTO duplicate_groups (id, trip_id, default_image_id, image_count, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('group-1', 'trip-1', 'img-1', 2, now);

    // Grouped images
    testDb.prepare(`
      INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, duplicate_group_id, created_at)
      VALUES (?, ?, ?, 'image', 'image/jpeg', 'a.jpg', 1000, 'group-1', ?)
    `).run('img-1', 'trip-1', img1, now);
    testDb.prepare(`
      INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, duplicate_group_id, created_at)
      VALUES (?, ?, ?, 'image', 'image/jpeg', 'b.jpg', 1000, 'group-1', ?)
    `).run('img-2', 'trip-1', img2, now);

    // Ungrouped image
    testDb.prepare(`
      INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, created_at)
      VALUES (?, ?, ?, 'image', 'image/jpeg', 'solo.jpg', 1000, ?)
    `).run('img-solo', 'trip-1', imgSolo, now);

    await processTrip('trip-1');

    // Group default should be the larger image
    const group = testDb.prepare('SELECT default_image_id FROM duplicate_groups WHERE id = ?').get('group-1') as any;
    expect(group.default_image_id).toBe('img-2');

    // All images should have quality scores
    const allItems = testDb.prepare("SELECT id, quality_score FROM media_items WHERE trip_id = ? AND media_type = 'image'").all('trip-1') as any[];
    for (const item of allItems) {
      expect(item.quality_score).not.toBeNull();
      expect(item.quality_score).toBeGreaterThan(0);
    }
  });
});
