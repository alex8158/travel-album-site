import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { vi } from 'vitest';

// Mock the database module before importing analysisStore
vi.mock('../database', () => {
  let mockDb: Database.Database | null = null;

  return {
    getDb: () => {
      if (!mockDb) {
        mockDb = new Database(':memory:');
        mockDb.exec(`
          CREATE TABLE media_analysis (
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
            created_at TEXT NOT NULL
          );
          CREATE INDEX idx_media_analysis_media_id ON media_analysis(media_id);
        `);
      }
      return mockDb;
    },
    __resetDb: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

import { upsertAnalysisResult, getAnalysisResult, buildAnalysisVersion } from './analysisStore';
import { getDb } from '../database';

// Access the reset helper
const { __resetDb } = await import('../database') as any;

describe('analysisStore', () => {
  beforeEach(() => {
    // Reset DB for each test to get a fresh in-memory database
    __resetDb();
  });

  afterEach(() => {
    __resetDb();
  });

  describe('buildAnalysisVersion', () => {
    it('builds correct version key for black_frame type', () => {
      expect(buildAnalysisVersion(0, 'black_frame')).toBe('segment_0');
      expect(buildAnalysisVersion(3, 'black_frame')).toBe('segment_3');
      expect(buildAnalysisVersion(10, 'black_frame')).toBe('segment_10');
    });

    it('builds correct version key for junk_clip type', () => {
      expect(buildAnalysisVersion(0, 'junk_clip')).toBe('segment_0_junk');
      expect(buildAnalysisVersion(3, 'junk_clip')).toBe('segment_3_junk');
      expect(buildAnalysisVersion(10, 'junk_clip')).toBe('segment_10_junk');
    });
  });

  describe('upsertAnalysisResult', () => {
    it('inserts a new record when none exists', () => {
      const reasonJson = JSON.stringify({ type: 'black_frame', blackFrameRatio: 0.9 });

      upsertAnalysisResult({
        mediaId: 'media-1',
        segmentIndex: 0,
        analysisType: 'black_frame',
        qualityScore: 0.1,
        reasonJson,
      });

      const db = getDb();
      const rows = db.prepare('SELECT * FROM media_analysis WHERE media_id = ?').all('media-1') as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].media_id).toBe('media-1');
      expect(rows[0].quality_score).toBe(0.1);
      expect(rows[0].reason).toBe(reasonJson);
      expect(rows[0].analysis_version).toBe('segment_0');
      expect(rows[0].id).toBeTruthy();
      expect(rows[0].created_at).toBeTruthy();
    });

    it('updates an existing record when one exists for the same key', () => {
      const reason1 = JSON.stringify({ type: 'black_frame', blackFrameRatio: 0.9 });
      const reason2 = JSON.stringify({ type: 'black_frame', blackFrameRatio: 0.5 });

      // Insert first
      upsertAnalysisResult({
        mediaId: 'media-1',
        segmentIndex: 0,
        analysisType: 'black_frame',
        qualityScore: 0.1,
        reasonJson: reason1,
      });

      // Upsert with updated values
      upsertAnalysisResult({
        mediaId: 'media-1',
        segmentIndex: 0,
        analysisType: 'black_frame',
        qualityScore: 0.5,
        reasonJson: reason2,
      });

      const db = getDb();
      const rows = db.prepare('SELECT * FROM media_analysis WHERE media_id = ?').all('media-1') as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].quality_score).toBe(0.5);
      expect(rows[0].reason).toBe(reason2);
    });

    it('stores different analysis types for the same segment independently', () => {
      const blackFrameReason = JSON.stringify({ type: 'black_frame', blackFrameRatio: 0.9 });
      const junkReason = JSON.stringify({ type: 'junk_clip', isJunk: true, reason: 'too_short' });

      upsertAnalysisResult({
        mediaId: 'media-1',
        segmentIndex: 0,
        analysisType: 'black_frame',
        qualityScore: 0.1,
        reasonJson: blackFrameReason,
      });

      upsertAnalysisResult({
        mediaId: 'media-1',
        segmentIndex: 0,
        analysisType: 'junk_clip',
        qualityScore: 0.0,
        reasonJson: junkReason,
      });

      const db = getDb();
      const rows = db.prepare('SELECT * FROM media_analysis WHERE media_id = ? ORDER BY analysis_version').all('media-1') as any[];
      expect(rows).toHaveLength(2);

      // black_frame uses "segment_0"
      const bfRow = rows.find((r: any) => r.analysis_version === 'segment_0');
      expect(bfRow).toBeTruthy();
      expect(bfRow.quality_score).toBe(0.1);
      expect(bfRow.reason).toBe(blackFrameReason);

      // junk_clip uses "segment_0_junk"
      const jcRow = rows.find((r: any) => r.analysis_version === 'segment_0_junk');
      expect(jcRow).toBeTruthy();
      expect(jcRow.quality_score).toBe(0.0);
      expect(jcRow.reason).toBe(junkReason);
    });

    it('stores different segments independently for the same media', () => {
      const reason0 = JSON.stringify({ type: 'black_frame', blackFrameRatio: 0.9 });
      const reason1 = JSON.stringify({ type: 'black_frame', blackFrameRatio: 0.2 });

      upsertAnalysisResult({
        mediaId: 'media-1',
        segmentIndex: 0,
        analysisType: 'black_frame',
        qualityScore: 0.1,
        reasonJson: reason0,
      });

      upsertAnalysisResult({
        mediaId: 'media-1',
        segmentIndex: 1,
        analysisType: 'black_frame',
        qualityScore: 0.8,
        reasonJson: reason1,
      });

      const db = getDb();
      const rows = db.prepare('SELECT * FROM media_analysis WHERE media_id = ? ORDER BY analysis_version').all('media-1') as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].analysis_version).toBe('segment_0');
      expect(rows[0].quality_score).toBe(0.1);
      expect(rows[1].analysis_version).toBe('segment_1');
      expect(rows[1].quality_score).toBe(0.8);
    });

    it('stores different media items independently', () => {
      const reason = JSON.stringify({ type: 'black_frame', blackFrameRatio: 0.5 });

      upsertAnalysisResult({
        mediaId: 'media-1',
        segmentIndex: 0,
        analysisType: 'black_frame',
        qualityScore: 0.5,
        reasonJson: reason,
      });

      upsertAnalysisResult({
        mediaId: 'media-2',
        segmentIndex: 0,
        analysisType: 'black_frame',
        qualityScore: 0.7,
        reasonJson: reason,
      });

      const db = getDb();
      const allRows = db.prepare('SELECT * FROM media_analysis').all() as any[];
      expect(allRows).toHaveLength(2);
    });
  });

  describe('getAnalysisResult', () => {
    it('returns null when no record exists', () => {
      const result = getAnalysisResult('media-1', 0, 'black_frame');
      expect(result).toBeNull();
    });

    it('returns the stored result when a record exists', () => {
      const reasonJson = JSON.stringify({ type: 'black_frame', blackFrameRatio: 0.9 });

      upsertAnalysisResult({
        mediaId: 'media-1',
        segmentIndex: 0,
        analysisType: 'black_frame',
        qualityScore: 0.1,
        reasonJson,
      });

      const result = getAnalysisResult('media-1', 0, 'black_frame');
      expect(result).not.toBeNull();
      expect(result!.qualityScore).toBe(0.1);
      expect(result!.reasonJson).toBe(reasonJson);
    });

    it('returns the correct type when both types exist for same segment', () => {
      const bfReason = JSON.stringify({ type: 'black_frame', blackFrameRatio: 0.9 });
      const jcReason = JSON.stringify({ type: 'junk_clip', isJunk: true });

      upsertAnalysisResult({
        mediaId: 'media-1',
        segmentIndex: 0,
        analysisType: 'black_frame',
        qualityScore: 0.1,
        reasonJson: bfReason,
      });

      upsertAnalysisResult({
        mediaId: 'media-1',
        segmentIndex: 0,
        analysisType: 'junk_clip',
        qualityScore: 0.0,
        reasonJson: jcReason,
      });

      const bfResult = getAnalysisResult('media-1', 0, 'black_frame');
      expect(bfResult!.reasonJson).toBe(bfReason);

      const jcResult = getAnalysisResult('media-1', 0, 'junk_clip');
      expect(jcResult!.reasonJson).toBe(jcReason);
    });
  });
});
