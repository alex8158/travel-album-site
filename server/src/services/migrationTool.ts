import { getDb } from '../database';
import type { StorageProvider } from '../storage/types';

export interface MigrationResult {
  successCount: number;
  failedCount: number;
  failedFiles: { path: string; error: string }[];
}

interface FilePathRow {
  file_path: string | null;
  thumbnail_path: string | null;
  optimized_path: string | null;
  compiled_path: string | null;
}

/**
 * Collect all unique, non-null file paths stored in media_items.
 */
function collectFilePaths(db: ReturnType<typeof getDb>): string[] {
  const rows = db
    .prepare(
      'SELECT file_path, thumbnail_path, optimized_path, compiled_path FROM media_items'
    )
    .all() as FilePathRow[];

  const paths = new Set<string>();
  for (const row of rows) {
    if (row.file_path) paths.add(row.file_path);
    if (row.thumbnail_path) paths.add(row.thumbnail_path);
    if (row.optimized_path) paths.add(row.optimized_path);
    if (row.compiled_path) paths.add(row.compiled_path);
  }
  return Array.from(paths);
}

/** Strip leading 'uploads/' prefix if present (legacy path compatibility) */
function normalizePath(p: string): string {
  return p.startsWith('uploads/') ? p.slice('uploads/'.length) : p;
}

/**
 * Migrate all files referenced in the database from one StorageProvider to another.
 *
 * Each file is migrated independently — a single failure is recorded but does
 * not stop the remaining files from being processed.
 * Paths are normalized (uploads/ prefix stripped) for the target provider.
 */
export async function migrateStorage(
  sourceProvider: StorageProvider,
  targetProvider: StorageProvider
): Promise<MigrationResult> {
  const db = getDb();
  const filePaths = collectFilePaths(db);

  const result: MigrationResult = {
    successCount: 0,
    failedCount: 0,
    failedFiles: [],
  };

  // Also prepare to update DB paths to normalized form
  const updateStmts = {
    file_path: db.prepare('UPDATE media_items SET file_path = ? WHERE file_path = ?'),
    thumbnail_path: db.prepare('UPDATE media_items SET thumbnail_path = ? WHERE thumbnail_path = ?'),
    optimized_path: db.prepare('UPDATE media_items SET optimized_path = ? WHERE optimized_path = ?'),
    compiled_path: db.prepare('UPDATE media_items SET compiled_path = ? WHERE compiled_path = ?'),
  };

  for (const filePath of filePaths) {
    const normalizedPath = normalizePath(filePath);
    try {
      const data = await sourceProvider.read(filePath);
      await targetProvider.save(normalizedPath, data);

      // Update DB paths to normalized form if they changed
      if (normalizedPath !== filePath) {
        for (const stmt of Object.values(updateStmts)) {
          stmt.run(normalizedPath, filePath);
        }
      }

      result.successCount++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result.failedCount++;
      result.failedFiles.push({ path: filePath, error: message });
    }
  }

  return result;
}
