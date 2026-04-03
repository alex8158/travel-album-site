import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { StorageProvider } from '../storage/types';
import { migrateStorage, type MigrationResult } from './migrationTool';

// ---------- helpers ----------

function createMockProvider(
  files: Record<string, Buffer> = {}
): StorageProvider {
  const store = new Map(Object.entries(files));
  return {
    async save(relativePath: string, data: Buffer) {
      store.set(relativePath, data as Buffer);
    },
    async read(relativePath: string): Promise<Buffer> {
      const buf = store.get(relativePath);
      if (!buf) throw new Error(`File not found: ${relativePath}`);
      return buf;
    },
    async delete(relativePath: string) {
      store.delete(relativePath);
    },
    async exists(relativePath: string) {
      return store.has(relativePath);
    },
    async getUrl(relativePath: string) {
      return `http://mock/${relativePath}`;
    },
    async downloadToTemp(relativePath: string) {
      return `/tmp/${relativePath}`;
    },
  };
}

function createFailingSourceProvider(
  files: Record<string, Buffer>,
  failPaths: Set<string>
): StorageProvider {
  const base = createMockProvider(files);
  return {
    ...base,
    async read(relativePath: string): Promise<Buffer> {
      if (failPaths.has(relativePath)) {
        throw new Error(`Read error: ${relativePath}`);
      }
      return base.read(relativePath);
    },
  };
}

// ---------- in-memory DB setup ----------

let testDb: Database.Database;

vi.mock('../database', () => ({
  getDb: () => testDb,
}));

function seedMediaItems(
  rows: {
    file_path: string;
    thumbnail_path?: string | null;
    optimized_path?: string | null;
    compiled_path?: string | null;
  }[]
) {
  const insert = testDb.prepare(`
    INSERT INTO media_items (id, trip_id, file_path, thumbnail_path, optimized_path, compiled_path,
      media_type, mime_type, original_filename, file_size, created_at, status, visibility)
    VALUES (?, 'trip-1', ?, ?, ?, ?, 'image', 'image/jpeg', 'photo.jpg', 1024, datetime('now'), 'active', 'public')
  `);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    insert.run(
      `media-${i}`,
      r.file_path,
      r.thumbnail_path ?? null,
      r.optimized_path ?? null,
      r.compiled_path ?? null
    );
  }
}

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = OFF');
  testDb.exec(`
    CREATE TABLE media_items (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      thumbnail_path TEXT,
      optimized_path TEXT,
      compiled_path TEXT,
      media_type TEXT NOT NULL DEFAULT 'unknown',
      mime_type TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      visibility TEXT NOT NULL DEFAULT 'public',
      created_at TEXT NOT NULL
    );
  `);
});

afterEach(() => {
  testDb.close();
});

// ---------- tests ----------

describe('migrateStorage', () => {
  it('should migrate all files successfully when no errors occur', async () => {
    seedMediaItems([
      { file_path: 'a/original.jpg', thumbnail_path: 'a/thumb.jpg' },
    ]);

    const source = createMockProvider({
      'a/original.jpg': Buffer.from('original'),
      'a/thumb.jpg': Buffer.from('thumb'),
    });
    const target = createMockProvider();

    const result = await migrateStorage(source, target);

    expect(result.successCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.failedFiles).toEqual([]);

    // Verify data landed in target
    expect(await target.read('a/original.jpg')).toEqual(Buffer.from('original'));
    expect(await target.read('a/thumb.jpg')).toEqual(Buffer.from('thumb'));
  });

  it('should continue migrating when a single file fails', async () => {
    seedMediaItems([
      {
        file_path: 'a/original.jpg',
        thumbnail_path: 'a/thumb.jpg',
        optimized_path: 'a/optimized.jpg',
      },
    ]);

    const failPaths = new Set(['a/thumb.jpg']);
    const source = createFailingSourceProvider(
      {
        'a/original.jpg': Buffer.from('original'),
        'a/optimized.jpg': Buffer.from('optimized'),
      },
      failPaths
    );
    const target = createMockProvider();

    const result = await migrateStorage(source, target);

    expect(result.successCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(result.failedFiles).toHaveLength(1);
    expect(result.failedFiles[0].path).toBe('a/thumb.jpg');
    expect(result.failedFiles[0].error).toContain('a/thumb.jpg');
  });

  it('should return zero counts when there are no media items', async () => {
    // No rows seeded
    const source = createMockProvider();
    const target = createMockProvider();

    const result = await migrateStorage(source, target);

    expect(result.successCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.failedFiles).toEqual([]);
  });

  it('should deduplicate file paths across rows', async () => {
    // Two media items share the same thumbnail_path
    seedMediaItems([
      { file_path: 'a/original1.jpg', thumbnail_path: 'shared/thumb.jpg' },
      { file_path: 'a/original2.jpg', thumbnail_path: 'shared/thumb.jpg' },
    ]);

    const source = createMockProvider({
      'a/original1.jpg': Buffer.from('o1'),
      'a/original2.jpg': Buffer.from('o2'),
      'shared/thumb.jpg': Buffer.from('thumb'),
    });
    const target = createMockProvider();

    const result = await migrateStorage(source, target);

    // 3 unique paths, not 4
    expect(result.successCount).toBe(3);
    expect(result.failedCount).toBe(0);
  });

  it('should skip null path columns', async () => {
    seedMediaItems([
      {
        file_path: 'a/original.jpg',
        thumbnail_path: null,
        optimized_path: null,
        compiled_path: null,
      },
    ]);

    const source = createMockProvider({
      'a/original.jpg': Buffer.from('data'),
    });
    const target = createMockProvider();

    const result = await migrateStorage(source, target);

    expect(result.successCount).toBe(1);
    expect(result.failedCount).toBe(0);
  });

  it('should handle all four path columns', async () => {
    seedMediaItems([
      {
        file_path: 'a/original.jpg',
        thumbnail_path: 'a/thumb.jpg',
        optimized_path: 'a/optimized.jpg',
        compiled_path: 'a/compiled.jpg',
      },
    ]);

    const source = createMockProvider({
      'a/original.jpg': Buffer.from('o'),
      'a/thumb.jpg': Buffer.from('t'),
      'a/optimized.jpg': Buffer.from('opt'),
      'a/compiled.jpg': Buffer.from('comp'),
    });
    const target = createMockProvider();

    const result = await migrateStorage(source, target);

    expect(result.successCount).toBe(4);
    expect(result.failedCount).toBe(0);
  });

  it('should satisfy successCount + failedCount == total unique paths', async () => {
    seedMediaItems([
      { file_path: 'a.jpg', thumbnail_path: 'b.jpg' },
      { file_path: 'c.jpg', thumbnail_path: 'd.jpg' },
    ]);

    const failPaths = new Set(['b.jpg', 'c.jpg']);
    const source = createFailingSourceProvider(
      {
        'a.jpg': Buffer.from('a'),
        'd.jpg': Buffer.from('d'),
      },
      failPaths
    );
    const target = createMockProvider();

    const result = await migrateStorage(source, target);

    const totalPaths = 4; // a.jpg, b.jpg, c.jpg, d.jpg
    expect(result.successCount + result.failedCount).toBe(totalPaths);
    expect(result.failedFiles.length).toBe(result.failedCount);
  });
});
