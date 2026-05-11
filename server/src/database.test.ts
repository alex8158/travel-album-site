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
    expect(columnNames).toContain('user_id');
    expect(columnNames).toEqual(
      expect.arrayContaining(['id', 'title', 'description', 'cover_image_id', 'visibility', 'user_id', 'created_at', 'updated_at']),
    );
  });

  it('should create media_items table with correct columns', () => {
    const db = getDb();
    const columns = db.prepare("PRAGMA table_info(media_items)").all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain('user_id');
    expect(columnNames).toContain('visibility');
    expect(columnNames).toEqual(
      expect.arrayContaining([
        'id', 'trip_id', 'file_path', 'thumbnail_path', 'media_type', 'mime_type',
        'original_filename', 'file_size', 'width', 'height', 'perceptual_hash',
        'quality_score', 'sharpness_score', 'duplicate_group_id', 'created_at',
        'status', 'trashed_reason', 'processing_error', 'optimized_path', 'compiled_path',
        'user_id', 'visibility',
      ]),
    );
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
    // Clean up from any previous test run
    db.prepare('DELETE FROM trips WHERE id = ?').run('trip-db-test-1');
    db.prepare(
      'INSERT INTO trips (id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('trip-db-test-1', 'Test Trip', 'A test trip', now, now);

    const row = db.prepare('SELECT * FROM trips WHERE id = ?').get('trip-db-test-1') as any;
    expect(row.title).toBe('Test Trip');
    expect(row.description).toBe('A test trip');
  });

  it('should create users table with correct columns', () => {
    const db = getDb();
    const columns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toEqual(
      expect.arrayContaining(['id', 'username', 'password_hash', 'role', 'status', 'created_at', 'updated_at']),
    );
  });

  it('should create media_tags table with correct columns', () => {
    const db = getDb();
    const columns = db.prepare("PRAGMA table_info(media_tags)").all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toEqual(
      expect.arrayContaining(['id', 'media_id', 'tag_name', 'created_at']),
    );
  });

  it('should create indexes on media_tags table', () => {
    const db = getDb();
    const indexes = db.prepare("PRAGMA index_list(media_tags)").all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_media_tags_media_id');
    expect(indexNames).toContain('idx_media_tags_tag_name');
  });
});

describe('V2 Schema Foundation - New Tables', () => {
  afterEach(() => {
    closeDb();
  });

  describe('Table existence and columns', () => {
    it('should create media_versions table with correct columns', () => {
      const db = getDb();
      const columns = db.prepare("PRAGMA table_info(media_versions)").all() as Array<{ name: string }>;
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toEqual(
        expect.arrayContaining([
          'id', 'media_id', 'version_type', 'file_path', 'file_size',
          'width', 'height', 'duration', 'model_name', 'processor_name',
          'params', 'status', 'created_at',
        ]),
      );
    });

    it('should create media_analysis table with correct columns', () => {
      const db = getDb();
      const columns = db.prepare("PRAGMA table_info(media_analysis)").all() as Array<{ name: string }>;
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toEqual(
        expect.arrayContaining([
          'id', 'media_id', 'blur_score', 'sharpness_score', 'exposure_score',
          'color_score', 'noise_score', 'aesthetic_score', 'quality_score',
          'is_blurry', 'is_overexposed', 'is_underexposed', 'is_duplicate',
          'is_recommended', 'recommendation', 'reason', 'analysis_version', 'created_at',
        ]),
      );
    });

    it('should create duplicate_group_items table with correct columns', () => {
      const db = getDb();
      const columns = db.prepare("PRAGMA table_info(duplicate_group_items)").all() as Array<{ name: string }>;
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toEqual(
        expect.arrayContaining([
          'id', 'group_id', 'media_id', 'similarity_score',
          'quality_score', 'recommendation', 'reason', 'created_at',
        ]),
      );
    });

    it('should create ai_invocations table with correct columns', () => {
      const db = getDb();
      const columns = db.prepare("PRAGMA table_info(ai_invocations)").all() as Array<{ name: string }>;
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toEqual(
        expect.arrayContaining([
          'id', 'media_id', 'segment_id', 'provider', 'model_name',
          'task_type', 'request_payload', 'response_payload',
          'input_tokens', 'output_tokens', 'estimated_cost',
          'status', 'error_message', 'started_at', 'finished_at', 'created_at',
        ]),
      );
    });
  });

  describe('Index existence', () => {
    it('should have idx_media_versions_media_id index', () => {
      const db = getDb();
      const indexes = db.prepare("PRAGMA index_list(media_versions)").all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_media_versions_media_id');
    });

    it('should have idx_media_analysis_media_id index', () => {
      const db = getDb();
      const indexes = db.prepare("PRAGMA index_list(media_analysis)").all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_media_analysis_media_id');
    });

    it('should have idx_duplicate_group_items_group_id index', () => {
      const db = getDb();
      const indexes = db.prepare("PRAGMA index_list(duplicate_group_items)").all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_duplicate_group_items_group_id');
    });

    it('should have idx_duplicate_group_items_group_media unique index', () => {
      const db = getDb();
      const indexes = db.prepare("PRAGMA index_list(duplicate_group_items)").all() as Array<{ name: string; unique: number }>;
      const uniqueIndex = indexes.find((i) => i.name === 'idx_duplicate_group_items_group_media');
      expect(uniqueIndex).toBeDefined();
      expect(uniqueIndex!.unique).toBe(1);
    });

    it('should have idx_ai_invocations_media_id index', () => {
      const db = getDb();
      const indexes = db.prepare("PRAGMA index_list(ai_invocations)").all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_ai_invocations_media_id');
    });

    it('should have idx_ai_invocations_task_type index', () => {
      const db = getDb();
      const indexes = db.prepare("PRAGMA index_list(ai_invocations)").all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_ai_invocations_task_type');
    });
  });

  describe('Foreign key constraints', () => {
    it('should reject media_versions insert with invalid media_id', () => {
      const db = getDb();
      const now = new Date().toISOString();
      expect(() => {
        db.prepare(
          `INSERT INTO media_versions (id, media_id, version_type, file_path, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run('ver-1', 'nonexistent-media', 'thumbnail', '/path/to/file.jpg', now);
      }).toThrow();
    });

    it('should reject media_analysis insert with invalid media_id', () => {
      const db = getDb();
      const now = new Date().toISOString();
      expect(() => {
        db.prepare(
          `INSERT INTO media_analysis (id, media_id, created_at)
           VALUES (?, ?, ?)`
        ).run('analysis-1', 'nonexistent-media', now);
      }).toThrow();
    });

    it('should reject duplicate_group_items insert with invalid group_id', () => {
      const db = getDb();
      const now = new Date().toISOString();
      // First create a valid media item to isolate the group_id FK test
      db.prepare(
        `INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
      ).run('trip-fk-test', 'FK Test Trip', now, now);
      db.prepare(
        `INSERT INTO media_items (id, trip_id, file_path, mime_type, original_filename, file_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('media-fk-test', 'trip-fk-test', '/path.jpg', 'image/jpeg', 'test.jpg', 1000, now);

      expect(() => {
        db.prepare(
          `INSERT INTO duplicate_group_items (id, group_id, media_id, created_at)
           VALUES (?, ?, ?, ?)`
        ).run('dgi-1', 'nonexistent-group', 'media-fk-test', now);
      }).toThrow();
    });

    it('should reject duplicate_group_items insert with invalid media_id', () => {
      const db = getDb();
      const now = new Date().toISOString();
      // Create a valid group to isolate the media_id FK test
      db.prepare(
        `INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
      ).run('trip-fk-test2', 'FK Test Trip 2', now, now);
      db.prepare(
        `INSERT INTO duplicate_groups (id, trip_id, image_count, created_at)
         VALUES (?, ?, ?, ?)`
      ).run('group-fk-test', 'trip-fk-test2', 0, now);

      expect(() => {
        db.prepare(
          `INSERT INTO duplicate_group_items (id, group_id, media_id, created_at)
           VALUES (?, ?, ?, ?)`
        ).run('dgi-2', 'group-fk-test', 'nonexistent-media', now);
      }).toThrow();
    });
  });

  describe('Unique constraints', () => {
    it('should reject duplicate (group_id, media_id) in duplicate_group_items', () => {
      const db = getDb();
      const now = new Date().toISOString();

      // Set up prerequisite data
      db.prepare(
        `INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
      ).run('trip-uniq-test', 'Unique Test Trip', now, now);
      db.prepare(
        `INSERT INTO duplicate_groups (id, trip_id, image_count, created_at)
         VALUES (?, ?, ?, ?)`
      ).run('group-uniq-test', 'trip-uniq-test', 0, now);
      db.prepare(
        `INSERT INTO media_items (id, trip_id, file_path, mime_type, original_filename, file_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('media-uniq-test', 'trip-uniq-test', '/path.jpg', 'image/jpeg', 'test.jpg', 1000, now);

      // First insert should succeed
      db.prepare(
        `INSERT INTO duplicate_group_items (id, group_id, media_id, created_at)
         VALUES (?, ?, ?, ?)`
      ).run('dgi-uniq-1', 'group-uniq-test', 'media-uniq-test', now);

      // Second insert with same (group_id, media_id) should fail
      expect(() => {
        db.prepare(
          `INSERT INTO duplicate_group_items (id, group_id, media_id, created_at)
           VALUES (?, ?, ?, ?)`
        ).run('dgi-uniq-2', 'group-uniq-test', 'media-uniq-test', now);
      }).toThrow();
    });
  });
});
