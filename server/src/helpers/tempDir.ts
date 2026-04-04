import path from 'path';
import fs from 'fs';

/**
 * Get the temp directory for processing intermediate files.
 * Uses a `.tmp` directory alongside the uploads folder (same partition),
 * avoiding /tmp which may be on a small separate partition.
 *
 * Falls back to os.tmpdir() if TEMP_DIR env var is set.
 */
let _tempDir: string | null = null;

export function getTempDir(): string {
  if (_tempDir) return _tempDir;

  if (process.env.TEMP_DIR) {
    _tempDir = process.env.TEMP_DIR;
  } else {
    const storagePath = process.env.LOCAL_STORAGE_PATH || './uploads';
    _tempDir = path.resolve(storagePath, '..', '.tmp');
  }

  fs.mkdirSync(_tempDir, { recursive: true });
  return _tempDir;
}
