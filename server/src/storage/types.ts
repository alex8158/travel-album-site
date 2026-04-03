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
}

export type StorageType = 'local' | 's3' | 'oss' | 'cos';
