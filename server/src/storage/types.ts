import { Readable } from 'stream';

export interface StorageProvider {
  /** 保存文件，relativePath 如 "{tripId}/originals/{filename}" */
  save(relativePath: string, data: Buffer | Readable): Promise<void>;

  /** 读取文件，返回 Buffer */
  read(relativePath: string): Promise<Buffer>;

  /** 删除文件 */
  delete(relativePath: string): Promise<void>;

  /** 检查文件是否存在 */
  exists(relativePath: string): Promise<boolean>;

  /** 获取文件访问 URL（本地返回相对路径，对象存储返回签名 URL） */
  getUrl(relativePath: string): Promise<string>;

  /** 下载到临时文件并返回临时路径（用于 sharp/ffmpeg 本地处理） */
  downloadToTemp(relativePath: string): Promise<string>;

  /** 初始化分片上传，返回 uploadId */
  initMultipartUpload(relativePath: string): Promise<string>;

  /** 获取单个分片的 Presigned URL */
  getPresignedPartUrl(relativePath: string, uploadId: string, partNumber: number): Promise<string>;

  /** 合并所有分片，完成分片上传 */
  completeMultipartUpload(
    relativePath: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>
  ): Promise<void>;

  /** 取消分片上传，清理已上传的分片 */
  abortMultipartUpload(relativePath: string, uploadId: string): Promise<void>;

  /** 列出已上传的分片 */
  listParts(relativePath: string, uploadId: string): Promise<Array<{ partNumber: number; etag: string; size: number }>>;

  /** 获取简单上传的 Presigned URL */
  getPresignedUploadUrl(relativePath: string): Promise<string>;
}

export type StorageType = 'local' | 's3' | 'oss' | 'cos';
