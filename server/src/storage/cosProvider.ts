import COS from 'cos-nodejs-sdk-v5';
import { Readable } from 'stream';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { StorageProvider } from './types';

export class COSStorageProvider implements StorageProvider {
  private client: COS;
  private bucket: string;
  private region: string;

  constructor() {
    this.bucket = process.env.COS_BUCKET || '';
    this.region = process.env.COS_REGION || 'ap-guangzhou';
    const secretId = process.env.COS_SECRET_ID;
    const secretKey = process.env.COS_SECRET_KEY;

    if (!this.bucket) {
      throw new Error('COS_BUCKET environment variable is required');
    }
    if (!secretId || !secretKey) {
      throw new Error('COS_SECRET_ID and COS_SECRET_KEY environment variables are required');
    }

    this.client = new COS({
      SecretId: secretId,
      SecretKey: secretKey,
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

    await this.client.putObject({
      Bucket: this.bucket,
      Region: this.region,
      Key: relativePath,
      Body: body,
    });
  }

  async read(relativePath: string): Promise<Buffer> {
    const result = await this.client.getObject({
      Bucket: this.bucket,
      Region: this.region,
      Key: relativePath,
    });
    return result.Body as Buffer;
  }

  async delete(relativePath: string): Promise<void> {
    try {
      await this.client.deleteObject({
        Bucket: this.bucket,
        Region: this.region,
        Key: relativePath,
      });
    } catch (err: any) {
      if (err.statusCode === 404) {
        return;
      }
      throw err;
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await this.client.headObject({
        Bucket: this.bucket,
        Region: this.region,
        Key: relativePath,
      });
      return true;
    } catch (err: any) {
      if (err.statusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  async getUrl(relativePath: string): Promise<string> {
    return this.client.getObjectUrl({
      Bucket: this.bucket,
      Region: this.region,
      Key: relativePath,
      Sign: true,
    });
  }

  async downloadToTemp(relativePath: string): Promise<string> {
    const data = await this.read(relativePath);
    const ext = path.extname(relativePath);
    const tempPath = path.join(
      os.tmpdir(),
      `cos-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    );
    await fs.writeFile(tempPath, data);
    return tempPath;
  }

  async initMultipartUpload(relativePath: string): Promise<string> {
    throw new Error('initMultipartUpload not implemented for this provider');
  }

  async getPresignedPartUrl(relativePath: string, uploadId: string, partNumber: number): Promise<string> {
    throw new Error('getPresignedPartUrl not implemented for this provider');
  }

  async completeMultipartUpload(relativePath: string, uploadId: string, parts: Array<{partNumber: number; etag: string}>): Promise<void> {
    throw new Error('completeMultipartUpload not implemented for this provider');
  }

  async abortMultipartUpload(relativePath: string, uploadId: string): Promise<void> {
    throw new Error('abortMultipartUpload not implemented for this provider');
  }

  async listParts(relativePath: string, uploadId: string): Promise<Array<{partNumber: number; etag: string; size: number}>> {
    throw new Error('listParts not implemented for this provider');
  }

  async getPresignedUploadUrl(relativePath: string): Promise<string> {
    throw new Error('getPresignedUploadUrl not implemented for this provider');
  }
}
