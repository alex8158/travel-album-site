import { promises as fs } from 'fs';
import { createReadStream, createWriteStream } from 'fs';
import crypto from 'crypto';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import { getTempDir } from '../helpers/tempDir';
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

  // --- Multipart upload methods ---

  private getUploadsTempDir(): string {
    return path.join(getTempDir(), 'uploads');
  }

  private getUploadDir(uploadId: string): string {
    return path.join(this.getUploadsTempDir(), uploadId);
  }

  async initMultipartUpload(_relativePath: string): Promise<string> {
    const uploadId = uuidv4();
    await fs.mkdir(this.getUploadDir(uploadId), { recursive: true });
    return uploadId;
  }

  async getPresignedPartUrl(
    relativePath: string,
    uploadId: string,
    partNumber: number
  ): Promise<string> {
    // For local storage, return the server relay endpoint path.
    // relativePath is used as a proxy for mediaId in the URL pattern.
    return `/api/uploads/${encodeURIComponent(relativePath)}/parts/${partNumber}?uploadId=${encodeURIComponent(uploadId)}`;
  }

  async getPresignedUploadUrl(relativePath: string): Promise<string> {
    return `/api/uploads/${encodeURIComponent(relativePath)}/simple`;
  }

  async completeMultipartUpload(
    relativePath: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>
  ): Promise<void> {
    const uploadDir = this.getUploadDir(uploadId);
    const targetPath = path.resolve(this.basePath, this.normalizePath(relativePath));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    // Verify all expected parts exist
    const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    for (const part of sortedParts) {
      const partFile = path.join(uploadDir, `part_${part.partNumber}`);
      try {
        await fs.access(partFile);
      } catch {
        throw new Error(`Missing part file: part_${part.partNumber}`);
      }
    }

    // Stream-merge parts in order to the target path
    const writeStream = createWriteStream(targetPath);
    try {
      for (const part of sortedParts) {
        const partFile = path.join(uploadDir, `part_${part.partNumber}`);
        await pipeline(createReadStream(partFile), writeStream, { end: false });
      }
      writeStream.end();
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
    } catch (err) {
      writeStream.destroy();
      throw err;
    }

    // Clean up temp directory
    await fs.rm(uploadDir, { recursive: true, force: true });
  }

  async abortMultipartUpload(_relativePath: string, uploadId: string): Promise<void> {
    const uploadDir = this.getUploadDir(uploadId);
    await fs.rm(uploadDir, { recursive: true, force: true });
  }

  async listParts(_relativePath: string, uploadId: string): Promise<Array<{ partNumber: number; etag: string; size: number }>> {
    const uploadDir = this.getUploadDir(uploadId);
    let entries: string[];
    try {
      entries = await fs.readdir(uploadDir);
    } catch {
      return [];
    }

    const result: Array<{ partNumber: number; etag: string; size: number }> = [];
    for (const entry of entries) {
      const match = entry.match(/^part_(\d+)$/);
      if (!match) continue;

      const partNumber = parseInt(match[1], 10);
      const filePath = path.join(uploadDir, entry);
      const stat = await fs.stat(filePath);

      // Compute MD5 hash as etag
      const hash = crypto.createHash('md5');
      const stream = createReadStream(filePath);
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      const etag = hash.digest('hex');

      result.push({ partNumber, etag, size: stat.size });
    }

    return result.sort((a, b) => a.partNumber - b.partNumber);
  }
}
