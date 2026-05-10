/**
 * StreamProcessor — 流式文件传输处理器
 *
 * 核心职责：
 * - 将临时文件以流方式传输到存储层（createReadStream → pipeline → storage.save）
 * - 传输成功后删除临时文件
 * - 300 秒超时机制
 * - 错误处理：stream 销毁、临时文件清理、错误包装
 * - 验证临时目录中无残留文件并强制清理
 * - 文件不存在/不可读的前置检查
 * - 删除失败时记录警告但仍返回成功
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 5.5, 5.6, 5.7
 */

import { createReadStream, promises as fs } from 'fs';
import { Readable } from 'stream';
import path from 'path';
import { StorageProvider } from '../storage/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StreamTransferOptions {
  timeoutMs?: number;          // 默认 300000 (300s)
  deleteOnSuccess?: boolean;   // 默认 true
}

export interface StreamTransferResult {
  success: boolean;
  bytesTransferred: number;
  durationMs: number;
}

export interface StreamProcessor {
  /**
   * 将临时文件以流方式传输到存储层，完成后删除临时文件
   */
  transferToStorage(
    tempFilePath: string,
    storagePath: string,
    options?: StreamTransferOptions,
  ): Promise<StreamTransferResult>;

  /**
   * 验证临时目录中无残留文件，若有则强制清理
   */
  verifyCleanup(tempDir: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 300000; // 300 seconds
const DEFAULT_DELETE_ON_SUCCESS = true;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createStreamProcessor(storage: StorageProvider): StreamProcessor {
  return {
    async transferToStorage(
      tempFilePath: string,
      storagePath: string,
      options?: StreamTransferOptions,
    ): Promise<StreamTransferResult> {
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const deleteOnSuccess = options?.deleteOnSuccess ?? DEFAULT_DELETE_ON_SUCCESS;

      // Pre-check: verify file exists and is readable
      try {
        await fs.access(tempFilePath, fs.constants.R_OK);
      } catch (err: any) {
        throw new Error(
          `Stream transfer failed: temp file not accessible at "${tempFilePath}": ${err.message}`,
        );
      }

      // Get file size for bytesTransferred tracking
      let fileSize = 0;
      try {
        const stat = await fs.stat(tempFilePath);
        fileSize = stat.size;
      } catch (err: any) {
        throw new Error(
          `Stream transfer failed: cannot stat temp file "${tempFilePath}": ${err.message}`,
        );
      }

      const startTime = Date.now();

      let readStream: Readable | null = null;
      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      try {
        // Create read stream
        readStream = createReadStream(tempFilePath);

        // Use Promise.race for timeout: race storage.save against a timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Stream transfer timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });

        // Pass the stream to storage.save() which handles the pipeline internally
        await Promise.race([
          storage.save(storagePath, readStream),
          timeoutPromise,
        ]);

        // Clear timeout on success
        if (timeoutHandle) clearTimeout(timeoutHandle);

        const durationMs = Date.now() - startTime;

        // Delete temp file on success
        if (deleteOnSuccess) {
          try {
            await fs.unlink(tempFilePath);
          } catch (deleteErr: any) {
            // Requirement 3.7: 删除失败时记录警告但仍返回成功
            console.warn(
              `[StreamProcessor] Failed to delete temp file after successful transfer: "${tempFilePath}": ${deleteErr.message}`,
            );
          }
        }

        return {
          success: true,
          bytesTransferred: fileSize,
          durationMs,
        };
      } catch (err: any) {
        // Clear timeout
        if (timeoutHandle) clearTimeout(timeoutHandle);

        // Destroy the read stream if it's still open
        if (readStream && !readStream.destroyed) {
          readStream.destroy();
        }

        // Clean up temp file on error
        try {
          await fs.unlink(tempFilePath);
        } catch {
          // Ignore cleanup errors during error handling
        }

        // Wrap error with context
        const reason = timedOut
          ? `Stream transfer timed out after ${timeoutMs}ms`
          : `Stream transfer failed: ${err.message}`;

        throw new Error(reason);
      }
    },

    async verifyCleanup(tempDir: string): Promise<void> {
      let entries: string[];
      try {
        entries = await fs.readdir(tempDir);
      } catch (err: any) {
        // Directory doesn't exist — nothing to clean
        if (err.code === 'ENOENT') return;
        throw err;
      }

      if (entries.length === 0) return;

      // Requirement 5.7: 残留文件存在时强制删除并记录警告
      console.warn(
        `[StreamProcessor] Found ${entries.length} residual file(s) in temp directory "${tempDir}". Forcing cleanup.`,
      );

      for (const entry of entries) {
        const fullPath = path.join(tempDir, entry);
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isDirectory()) {
            await fs.rm(fullPath, { recursive: true, force: true });
          } else {
            await fs.unlink(fullPath);
          }
        } catch (cleanupErr: any) {
          // Requirement 5.6: 删除失败记录警告并继续
          console.warn(
            `[StreamProcessor] Failed to clean up residual file "${fullPath}": ${cleanupErr.message}`,
          );
        }
      }
    },
  };
}
