import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ---------- in-memory DB setup ----------

let testDb: Database.Database;

vi.mock('../database', () => ({
  getDb: () => testDb,
}));

// ---------- storage mock setup ----------

const mockDownloadToTemp = vi.fn();

vi.mock('../storage/factory', () => ({
  getStorageProvider: () => ({
    downloadToTemp: mockDownloadToTemp,
  }),
}));

// Import after mock setup
import {
  persistColorCastResult,
  detectColorCast,
  detectColorCastFromFile,
  detectColorCastBatch,
  type ColorCastResult,
} from './colorCastDetector';

function initSchema() {
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS media_items (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'unknown',
      mime_type TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_analysis (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      blur_score REAL,
      sharpness_score REAL,
      exposure_score REAL,
      color_score REAL,
      noise_score REAL,
      aesthetic_score REAL,
      quality_score REAL,
      is_blurry INTEGER DEFAULT 0,
      is_overexposed INTEGER DEFAULT 0,
      is_underexposed INTEGER DEFAULT 0,
      is_duplicate INTEGER DEFAULT 0,
      is_recommended INTEGER DEFAULT 0,
      recommendation TEXT,
      reason TEXT,
      analysis_version TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (media_id) REFERENCES media_items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_media_analysis_media_id ON media_analysis(media_id);
  `);
}

function seedMediaItem(id?: string): string {
  const mediaId = id ?? uuidv4();
  testDb.prepare(`
    INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, created_at)
    VALUES (?, 'trip-1', 'uploads/photo.jpg', 'image', 'image/jpeg', 'photo.jpg', 1024, datetime('now'))
  `).run(mediaId);
  return mediaId;
}

function seedMediaItemForTrip(tripId: string, filePath: string, opts?: { id?: string; status?: string; mediaType?: string }): string {
  const mediaId = opts?.id ?? uuidv4();
  const status = opts?.status ?? 'active';
  const mediaType = opts?.mediaType ?? 'image';
  testDb.prepare(`
    INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, created_at)
    VALUES (?, ?, ?, ?, 'image/jpeg', 'photo.jpg', 1024, ?, datetime('now'))
  `).run(mediaId, tripId, filePath, mediaType, status);
  return mediaId;
}

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  initSchema();
  mockDownloadToTemp.mockReset();
});

afterEach(() => {
  testDb.close();
});

// ---------- tests ----------

describe('persistColorCastResult', () => {
  it('should insert a new media_analysis record when none exists', () => {
    const mediaId = seedMediaItem();
    const result: ColorCastResult = {
      type: 'warm',
      severity: 'mild',
      colorScore: 0.8,
      channelDeviations: { r: 10, g: -5, b: -5 },
      maxDeviation: 10,
    };

    persistColorCastResult(mediaId, result);

    const row = testDb.prepare('SELECT * FROM media_analysis WHERE media_id = ?').get(mediaId) as any;
    expect(row).toBeDefined();
    expect(row.color_score).toBe(0.8);
    const reason = JSON.parse(row.reason);
    expect(reason.castType).toBe('warm');
    expect(reason.severity).toBe('mild');
    expect(reason.channelDeviations).toEqual({ r: 10, g: -5, b: -5 });
  });

  it('should update existing media_analysis record (upsert behavior)', () => {
    const mediaId = seedMediaItem();
    const existingId = uuidv4();

    // Pre-insert a media_analysis record
    testDb.prepare(`
      INSERT INTO media_analysis (id, media_id, color_score, reason, created_at)
      VALUES (?, ?, 0.5, '{"castType":"cool","severity":"moderate","channelDeviations":{"r":-10,"g":0,"b":10}}', datetime('now'))
    `).run(existingId, mediaId);

    // Now persist a new result — should update, not insert
    const result: ColorCastResult = {
      type: 'warm',
      severity: 'mild',
      colorScore: 0.85,
      channelDeviations: { r: 7, g: -3, b: -4 },
      maxDeviation: 7,
    };

    persistColorCastResult(mediaId, result);

    // Should still be only one record
    const rows = testDb.prepare('SELECT * FROM media_analysis WHERE media_id = ?').all(mediaId) as any[];
    expect(rows).toHaveLength(1);

    // Should have updated values
    expect(rows[0].id).toBe(existingId);
    expect(rows[0].color_score).toBe(0.85);
    const reason = JSON.parse(rows[0].reason);
    expect(reason.castType).toBe('warm');
    expect(reason.severity).toBe('mild');
    expect(reason.channelDeviations).toEqual({ r: 7, g: -3, b: -4 });
  });

  it('should store structured JSON in reason column with castType, severity, channelDeviations', () => {
    const mediaId = seedMediaItem();
    const result = detectColorCast({ r: 200, g: 100, b: 100 });

    persistColorCastResult(mediaId, result);

    const row = testDb.prepare('SELECT reason FROM media_analysis WHERE media_id = ?').get(mediaId) as any;
    const reason = JSON.parse(row.reason);
    expect(reason).toHaveProperty('castType');
    expect(reason).toHaveProperty('severity');
    expect(reason).toHaveProperty('channelDeviations');
    expect(reason.channelDeviations).toHaveProperty('r');
    expect(reason.channelDeviations).toHaveProperty('g');
    expect(reason.channelDeviations).toHaveProperty('b');
  });

  it('should write colorScore to color_score column', () => {
    const mediaId = seedMediaItem();
    const result: ColorCastResult = {
      type: 'neutral',
      severity: 'none',
      colorScore: 1.0,
      channelDeviations: { r: 0, g: 0, b: 0 },
      maxDeviation: 0,
    };

    persistColorCastResult(mediaId, result);

    const row = testDb.prepare('SELECT color_score FROM media_analysis WHERE media_id = ?').get(mediaId) as any;
    expect(row.color_score).toBe(1.0);
  });
});


// ---------- detectColorCastFromFile tests ----------

describe('detectColorCastFromFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colorcast-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return a valid ColorCastResult for a real image', async () => {
    // Create a 10x10 solid warm-toned image (high red, low blue)
    const imgPath = path.join(tmpDir, 'warm.jpg');
    await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 220, g: 150, b: 100 } },
    })
      .jpeg()
      .toFile(imgPath);

    const result = await detectColorCastFromFile(imgPath);

    expect(result).toHaveProperty('type');
    expect(result).toHaveProperty('severity');
    expect(result).toHaveProperty('colorScore');
    expect(result).toHaveProperty('channelDeviations');
    expect(result).toHaveProperty('maxDeviation');
    expect(result.colorScore).toBeGreaterThanOrEqual(0);
    expect(result.colorScore).toBeLessThanOrEqual(1);
    expect(['warm', 'cool', 'green', 'magenta', 'neutral']).toContain(result.type);
    expect(['none', 'mild', 'moderate', 'severe']).toContain(result.severity);
  });

  it('should throw when file does not exist', async () => {
    const nonExistentPath = path.join(tmpDir, 'does-not-exist.jpg');

    await expect(detectColorCastFromFile(nonExistentPath)).rejects.toThrow();
  });
});

// ---------- detectColorCastBatch tests ----------

describe('detectColorCastBatch', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colorcast-batch-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should process all active images in a trip and return correct summary', async () => {
    const tripId = 'batch-trip-1';

    // Seed 3 active image media items
    const id1 = seedMediaItemForTrip(tripId, 'trip/img1.jpg');
    const id2 = seedMediaItemForTrip(tripId, 'trip/img2.jpg');
    const id3 = seedMediaItemForTrip(tripId, 'trip/img3.jpg');

    // Create real temp images for the mock to return
    const img1Path = path.join(tmpDir, 'img1.jpg');
    const img2Path = path.join(tmpDir, 'img2.jpg');
    const img3Path = path.join(tmpDir, 'img3.jpg');

    await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 128, g: 128, b: 128 } } }).jpeg().toFile(img1Path);
    await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 200, g: 100, b: 100 } } }).jpeg().toFile(img2Path);
    await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 100, g: 100, b: 200 } } }).jpeg().toFile(img3Path);

    mockDownloadToTemp
      .mockResolvedValueOnce(img1Path)
      .mockResolvedValueOnce(img2Path)
      .mockResolvedValueOnce(img3Path);

    const result = await detectColorCastBatch(tripId);

    expect(result.totalProcessed).toBe(3);
    expect(result.errors).toHaveLength(0);

    // Severity counts should sum to totalProcessed
    const totalSeverity = result.severityCounts.none + result.severityCounts.mild + result.severityCounts.moderate + result.severityCounts.severe;
    expect(totalSeverity).toBe(result.totalProcessed);
  });

  it('should continue processing when one image fails (error resilience)', async () => {
    const tripId = 'batch-trip-2';

    // Seed 3 active image media items
    const id1 = seedMediaItemForTrip(tripId, 'trip/img1.jpg');
    const id2 = seedMediaItemForTrip(tripId, 'trip/img2.jpg');
    const id3 = seedMediaItemForTrip(tripId, 'trip/img3.jpg');

    // Create real temp images for items 1 and 3, but fail on item 2
    const img1Path = path.join(tmpDir, 'img1.jpg');
    const img3Path = path.join(tmpDir, 'img3.jpg');

    await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 128, g: 128, b: 128 } } }).jpeg().toFile(img1Path);
    await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 128, g: 128, b: 128 } } }).jpeg().toFile(img3Path);

    mockDownloadToTemp
      .mockResolvedValueOnce(img1Path)
      .mockRejectedValueOnce(new Error('Download failed for img2'))
      .mockResolvedValueOnce(img3Path);

    const result = await detectColorCastBatch(tripId);

    // 2 succeeded, 1 failed
    expect(result.totalProcessed).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].mediaId).toBe(id2);
    expect(result.errors[0].error).toContain('Download failed for img2');
  });

  it('should return empty result when no images exist for the trip', async () => {
    const tripId = 'empty-trip';

    const result = await detectColorCastBatch(tripId);

    expect(result.totalProcessed).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.severityCounts).toEqual({ none: 0, mild: 0, moderate: 0, severe: 0 });
  });
});
