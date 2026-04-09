import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import { promises as fs } from 'fs';
import path from 'path';
import { getTempDir } from '../helpers/tempDir';
import { StorageProvider } from './types';

export class S3StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;

  constructor() {
    const region = process.env.S3_REGION;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    this.bucket = process.env.S3_BUCKET || '';

    if (!this.bucket) {
      throw new Error('S3_BUCKET environment variable is required');
    }

    this.client = new S3Client({
      region: region || 'us-east-1',
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
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

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: relativePath,
        Body: body,
      })
    );
  }

  async read(relativePath: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: relativePath,
      })
    );

    const stream = response.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async delete(relativePath: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: relativePath,
      })
    );
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: relativePath,
        })
      );
      return true;
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  async getUrl(relativePath: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: relativePath,
    });
    return getSignedUrl(this.client, command, { expiresIn: 3600 });
  }

  async downloadToTemp(relativePath: string): Promise<string> {
    const data = await this.read(relativePath);
    const ext = path.extname(relativePath);
    const tempPath = path.join(
      getTempDir(),
      `s3-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    );
    await fs.writeFile(tempPath, data);
    return tempPath;
  }
}
