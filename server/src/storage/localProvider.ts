import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { StorageProvider } from './types';

export class LocalStorageProvider implements StorageProvider {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath || process.env.LOCAL_STORAGE_PATH || './uploads';
  }

  async save(relativePath: string, data: Buffer | Readable): Promise<void> {
    const fullPath = path.resolve(this.basePath, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    if (Buffer.isBuffer(data)) {
      await fs.writeFile(fullPath, data);
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of data) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      await fs.writeFile(fullPath, Buffer.concat(chunks));
    }
  }

  async read(relativePath: string): Promise<Buffer> {
    const fullPath = path.resolve(this.basePath, relativePath);
    return fs.readFile(fullPath);
  }

  async delete(relativePath: string): Promise<void> {
    const fullPath = path.resolve(this.basePath, relativePath);
    try {
      await fs.unlink(fullPath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    const fullPath = path.resolve(this.basePath, relativePath);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async getUrl(relativePath: string): Promise<string> {
    return `/uploads/${relativePath}`;
  }

  async downloadToTemp(relativePath: string): Promise<string> {
    return path.resolve(this.basePath, relativePath);
  }
}
