import { describe, it, expect, afterEach } from 'vitest';
import { getDb, closeDb } from './database';
import type { Trip, MediaItem, DuplicateGroup } from './types';

describe('Database initialization', () => {
  afterEach(() => {
    closeDb();
  });

  it('should create and return a database instance', () => {
    const db = getDb();
    expect(db).toBeDefined();
  });

  it('should return the same instance on subsequent calls', () => {
    const db1 = getDb();
    const db2 = getDb();
    expect(db1).toBe(db2);
  });

  it('should have WAL journal mode enabled', () => {
    const db = getDb();
    const result = db.pragma('journal_mode', { simple: true });
    expect(result).toBe('wal');
  });

  it('should create trips table with correct columns', () => {
    const db = getDb();
    const columns = db.prepare("PRAGMA table_info(trips)").all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain('visibility');
    expect(columnNames).toEqual(
      expect.arrayContaining(['id', 'title', 'description', 'cover_image_id', 'visibility', 'created_at', 'updated_at']),
    );
  });

  it('should create media_items table with correct columns', () => {
    const db = getDb();
    const columns = db.prepare("PRAGMA table_info(media_items)").all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toEqual([
      'id', 'trip_id', 'file_path', 'thumbnail_path', 'media_type', 'mime_type',
      'original_filename', 'file_size', 'width', 'height', 'perceptual_hash',
      'quality_score', 'sharpness_score', 'duplicate_group_id', 'created_at',
      'status', 'trashed_reason', 'processing_error', 'optimized_path', 'compiled_path',
    ]);
  });

  it('should create duplicate_groups table with correct columns', () => {
    const db = getDb();
    const columns = db.prepare("PRAGMA table_info(duplicate_groups)").all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toEqual([
      'id', 'trip_id', 'default_image_id', 'image_count', 'created_at',
    ]);
  });

  it('should allow inserting and querying a trip', () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO trips (id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('trip-1', 'Test Trip', 'A test trip', now, now);

    const row = db.prepare('SELECT * FROM trips WHERE id = ?').get('trip-1') as any;
    expect(row.title).toBe('Test Trip');
    expect(row.description).toBe('A test trip');
  });
});
