import fs from 'fs';
import { StorageProvider } from '../storage/types';

/**
 * Per-processing-run cache that maps storage-relative paths to local temp paths.
 * Ensures each image is downloaded at most once per pipeline run.
 */
export class TempPathCache {
  private cache = new Map<string, string>();
  private storageProvider: StorageProvider;

  constructor(storageProvider: StorageProvider) {
    this.storageProvider = storageProvider;
  }

  /**
   * Get a local temp path for the given storage-relative path.
   * Downloads on first access; returns cached path on subsequent calls.
   * If a cached file has been deleted, re-downloads automatically.
   */
  async get(relativePath: string): Promise<string> {
    const cached = this.cache.get(relativePath);
    if (cached) {
      try {
        fs.accessSync(cached, fs.constants.R_OK);
        return cached;
      } catch {
        // Cached file gone — re-download
        this.cache.delete(relativePath);
      }
    }
    const localPath = await this.storageProvider.downloadToTemp(relativePath);
    this.cache.set(relativePath, localPath);
    return localPath;
  }

  /**
   * Clean up all cached temp files. Safe to call multiple times.
   * Skips files that are the same as the relative path (local provider returns original path).
   */
  cleanup(): void {
    for (const [relativePath, localPath] of this.cache.entries()) {
      // Don't delete original files (local provider returns the actual file path)
      if (localPath === relativePath) continue;
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }
    }
    this.cache.clear();
  }

  /** Number of cached entries. */
  get size(): number {
    return this.cache.size;
  }
}
