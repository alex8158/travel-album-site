import { promises as fs } from 'fs';
import { createWriteStream, existsSync } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { StorageProvider } from './types';

export class LocalStorageProvider implements StorageProvider {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath || process.env.LOCAL_STORAGE_PATH || './uploads';
  }

  /** Strip leading 'uploads/' prefix if present (legacy path compatibility) */
  private normalizePath(relativePath: string): string {
    if (relativePath.startsWith('uploads/')) {
      return relativePath.slice('uploads/'.length);
    }
    return relativePath;
  }

  async save(relativePath: string, data: Buffer | Readable): Promise<void> {
    const fullPath = path.resolve(this.basePath, this.normalizePath(relativePath));
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    if (Buffer.isBuffer(data)) {
      await fs.writeFile(fullPath, data);
    } else {
      await pipeline(data, createWriteStream(fullPath));
    }
  }

  async read(relativePath: string): Promise<Buffer> {
    const fullPath = path.resolve(this.basePath, this.normalizePath(relativePath));
    return fs.readFile(fullPath);
  }

  async delete(relativePath: string): Promise<void> {
    const fullPath = path.resolve(this.basePath, this.normalizePath(relativePath));
    try {
      await fs.unlink(fullPath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    const fullPath = path.resolve(this.basePath, this.normalizePath(relativePath));
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async getUrl(relativePath: string): Promise<string> {
    return `/uploads/${this.normalizePath(relativePath)}`;
  }

  async downloadToTemp(relativePath: string): Promise<string> {
    return path.resolve(this.basePath, this.normalizePath(relativePath));
  }
}
