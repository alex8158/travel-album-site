import OSS from 'ali-oss';
import { Readable } from 'stream';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { StorageProvider } from './types';

export class OSSStorageProvider implements StorageProvider {
  private client: OSS;

  constructor() {
    const bucket = process.env.OSS_BUCKET;
    const region = process.env.OSS_REGION;
    const accessKeyId = process.env.OSS_ACCESS_KEY_ID;
    const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;

    if (!bucket) {
      throw new Error('OSS_BUCKET environment variable is required');
    }
    if (!accessKeyId || !accessKeySecret) {
      throw new Error('OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET environment variables are required');
    }

    this.client = new OSS({
      bucket,
      region: region || 'oss-cn-hangzhou',
      accessKeyId,
      accessKeySecret,
    });
  }

  async save(relativePath: string, data: Buffer | Readable): Promise<void> {
    let body: Buffer;
    if (Buffer.isBuffer(data)) {
      body = data;
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of data) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      body = Buffer.concat(chunks);
    }

    await this.client.put(relativePath, body);
  }

  async read(relativePath: string): Promise<Buffer> {
    const result = await this.client.get(relativePath);
    return result.content as Buffer;
  }

  async delete(relativePath: string): Promise<void> {
    try {
      await this.client.delete(relativePath);
    } catch (err: any) {
      if (err.code === 'NoSuchKey') {
        return;
      }
      throw err;
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await this.client.head(relativePath);
      return true;
    } catch (err: any) {
      if (err.code === 'NoSuchKey' || err.status === 404) {
        return false;
      }
      throw err;
    }
  }

  async getUrl(relativePath: string): Promise<string> {
    return this.client.signatureUrl(relativePath, { expires: 3600 });
  }

  async downloadToTemp(relativePath: string): Promise<string> {
    const data = await this.read(relativePath);
    const ext = path.extname(relativePath);
    const tempPath = path.join(
      os.tmpdir(),
      `oss-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    );
    await fs.writeFile(tempPath, data);
    return tempPath;
  }
}
