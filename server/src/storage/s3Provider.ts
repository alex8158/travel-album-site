import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
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
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: relativePath,
        Body: data,
      },
    });
    await upload.done();
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

  async initMultipartUpload(relativePath: string): Promise<string> {
    const response = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: relativePath,
      })
    );
    if (!response.UploadId) {
      throw new Error('Failed to initiate multipart upload: no UploadId returned');
    }
    return response.UploadId;
  }

  async getPresignedPartUrl(relativePath: string, uploadId: string, partNumber: number): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: relativePath,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    return getSignedUrl(this.client, command, { expiresIn: 3600 });
  }

  async completeMultipartUpload(relativePath: string, uploadId: string, parts: Array<{partNumber: number; etag: string}>): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: relativePath,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({
            PartNumber: p.partNumber,
            ETag: p.etag,
          })),
        },
      })
    );
  }

  async abortMultipartUpload(relativePath: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: relativePath,
        UploadId: uploadId,
      })
    );
  }

  async listParts(relativePath: string, uploadId: string): Promise<Array<{partNumber: number; etag: string; size: number}>> {
    const response = await this.client.send(
      new ListPartsCommand({
        Bucket: this.bucket,
        Key: relativePath,
        UploadId: uploadId,
      })
    );
    return (response.Parts || []).map((p) => ({
      partNumber: p.PartNumber!,
      etag: p.ETag!,
      size: p.Size!,
    }));
  }

  async getPresignedUploadUrl(relativePath: string): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: relativePath,
    });
    return getSignedUrl(this.client, command, { expiresIn: 3600 });
  }
}
