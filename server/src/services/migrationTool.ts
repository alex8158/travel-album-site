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

/**
 * Migrate all files referenced in the database from one StorageProvider to another.
 *
 * Each file is migrated independently — a single failure is recorded but does
 * not stop the remaining files from being processed.
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

  for (const filePath of filePaths) {
    try {
      const data = await sourceProvider.read(filePath);
      await targetProvider.save(filePath, data);
      result.successCount++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result.failedCount++;
      result.failedFiles.push({ path: filePath, error: message });
    }
  }

  return result;
}
