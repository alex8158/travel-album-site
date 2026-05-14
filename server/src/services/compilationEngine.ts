/**
 * CompilationEngine — 视频编译引擎
 *
 * 负责自动/手动编译视频片段：
 * - autoCompile: 从 DB 读取 video_segments → 调用 segmentSelector → 调用 ffmpegCompiler → 更新 compiled_path
 * - manualCompile: 按用户指定片段和顺序调用 ffmpegCompiler → 更新 compiled_path
 * - getJobStatus: 获取编译任务状态
 *
 * Requirements: 1.1, 1.6, 1.7, 1.8, 1.9, 3.1, 3.2, 3.3, 3.4, 3.7, 5.5, 5.6, 5.7, 5.8, 5.9, 8.3
 */

import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';
import { selectSegments, calculateTargetDuration } from './segmentSelector';
import { compileSegments } from './ffmpegCompiler';
import type { SegmentCandidate } from './segmentSelector';
import type { SegmentInput } from './ffmpegCompiler';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompileOptions {
  targetDuration?: number;       // 自定义目标时长 (10-600秒)
  segmentIndices?: number[];     // 用户指定的片段索引列表
  timeout?: number;              // 超时时间(毫秒)，默认 300000
}

export interface CompileResult {
  success: boolean;
  compiledPath: string | null;
  selectedSegments: number[];
  totalDuration: number;
  error?: string;
  warnings?: string[];
}

export interface CompileJobStatus {
  jobId: string;
  mediaId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  percent: number;
  error?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate error message to maxLength characters.
 * Requirements: 8.3
 */
export function truncateError(message: string, maxLength: number = 500): string {
  if (message.length <= maxLength) return message;
  return message.slice(0, maxLength - 3) + '...';
}

/** Labels that indicate severely low quality */
const SEVERELY_LOW_QUALITY_LABELS = new Set([
  'severely_blurry',
  'severely_shaky',
  'severely_exposed',
]);

// ---------------------------------------------------------------------------
// CompilationEngine Class
// ---------------------------------------------------------------------------

export class CompilationEngine {
  /**
   * 自动编译：基于质量评分自动选择片段并拼接
   *
   * 流程：
   * 1. 从 DB 读取 video_segments
   * 2. 短视频逻辑：原始时长 < 60s 且无严重低质量片段时跳过编译
   * 3. 调用 segmentSelector 选择片段
   * 4. 无有效片段时设置 processing_error 为"无有效片段"
   * 5. 调用 ffmpegCompiler 拼接
   * 6. 更新 compiled_path
   *
   * Requirements: 1.1, 1.6, 1.7, 1.8, 1.9, 3.1, 3.2, 3.3, 3.4, 3.7, 8.3
   */
  async autoCompile(mediaId: string, options?: CompileOptions): Promise<CompileResult> {
    const db = getDb();

    // Create compile job
    const jobId = uuidv4();
    const now = new Date().toISOString();
    this.createJob(jobId, mediaId, now);

    try {
      // Mark job as running
      this.updateJobStatus(jobId, 'running', 10, undefined, now);

      // Read video_segments from DB
      const segmentRows = db.prepare(
        'SELECT * FROM video_segments WHERE media_id = ? ORDER BY segment_index ASC'
      ).all(mediaId) as Array<{
        id: string;
        media_id: string;
        segment_index: number;
        start_time: number;
        end_time: number;
        duration: number;
        overall_score: number | null;
        label: string;
      }>;

      if (segmentRows.length === 0) {
        const error = '无有效片段';
        this.setProcessingError(mediaId, error);
        this.updateJobStatus(jobId, 'failed', 0, error);
        return { success: false, compiledPath: null, selectedSegments: [], totalDuration: 0, error };
      }

      // Calculate original video duration
      const originalDuration = segmentRows.reduce((max, seg) => Math.max(max, seg.end_time), 0);

      // Short video logic: original duration < 60s and no severely low quality segments → skip
      // Requirements: 1.4, 3.3
      const hasSeverelyLowQuality = segmentRows.some(seg =>
        SEVERELY_LOW_QUALITY_LABELS.has(seg.label)
      );

      if (originalDuration < 60 && !hasSeverelyLowQuality) {
        // Skip compilation for short videos without severe quality issues
        this.updateJobStatus(jobId, 'completed', 100);
        return {
          success: true,
          compiledPath: null,
          selectedSegments: [],
          totalDuration: 0,
        };
      }

      // Convert to SegmentCandidate format
      const candidates: SegmentCandidate[] = segmentRows.map(row => ({
        index: row.segment_index,
        startTime: row.start_time,
        endTime: row.end_time,
        duration: row.duration,
        overallScore: row.overall_score ?? 0,
        label: row.label,
      }));

      // Calculate target duration
      const targetDuration = options?.targetDuration ?? calculateTargetDuration(originalDuration) ?? originalDuration;

      // Select segments
      this.updateJobStatus(jobId, 'running', 30);
      const selection = selectSegments(candidates, targetDuration);

      if (selection.selectedIndices.length === 0) {
        // No valid segments after filtering
        const error = '无有效片段';
        this.setProcessingError(mediaId, error);
        this.updateJobStatus(jobId, 'failed', 0, error);
        return { success: false, compiledPath: null, selectedSegments: [], totalDuration: 0, error };
      }

      // Update job with segment info
      db.prepare(
        'UPDATE compile_jobs SET segment_indices = ?, target_duration = ? WHERE id = ?'
      ).run(JSON.stringify(selection.selectedIndices), targetDuration, jobId);

      // Prepare segments for ffmpeg
      this.updateJobStatus(jobId, 'running', 50);
      const selectedSegments = this.getSegmentInputs(segmentRows, selection.selectedIndices);

      // Get video file path
      const mediaRow = db.prepare(
        'SELECT file_path, trip_id FROM media_items WHERE id = ?'
      ).get(mediaId) as { file_path: string; trip_id: string } | undefined;

      if (!mediaRow) {
        const error = '媒体项不存在';
        this.updateJobStatus(jobId, 'failed', 0, error);
        return { success: false, compiledPath: null, selectedSegments: [], totalDuration: 0, error };
      }

      // Resolve video path via storage provider
      const storageProvider = getStorageProvider();
      const videoPath = await storageProvider.downloadToTemp(mediaRow.file_path);

      // Determine output directory
      const outputDir = path.dirname(videoPath).replace(/originals/, 'compiled');

      // Compile segments
      this.updateJobStatus(jobId, 'running', 60);
      const compileResult = await compileSegments(videoPath, selectedSegments, outputDir, {
        timeoutMs: options?.timeout ?? 300_000,
      });

      if (compileResult.error || !compileResult.outputPath) {
        // FFmpeg failed — record error, do NOT update compiled_path
        const errorMsg = truncateError(compileResult.error ?? 'FFmpeg 编译失败');
        this.setProcessingError(mediaId, errorMsg);
        this.updateJobStatus(jobId, 'failed', 0, errorMsg);

        const warnings = compileResult.missingSegments
          ? [`缺失片段: ${compileResult.missingSegments.join(', ')}`]
          : undefined;

        return {
          success: false,
          compiledPath: null,
          selectedSegments: selection.selectedIndices,
          totalDuration: 0,
          error: errorMsg,
          warnings,
        };
      }

      // Compute relative path for storage
      const storagePath = this.computeStoragePath(compileResult.outputPath, mediaRow.trip_id, mediaId);

      // Upload compiled file to storage provider
      await storageProvider.save(storagePath, fs.createReadStream(compileResult.outputPath));

      // Update compiled_path in media_items
      db.prepare('UPDATE media_items SET compiled_path = ?, processing_error = NULL WHERE id = ?')
        .run(storagePath, mediaId);

      // Mark job completed
      this.updateJobStatus(jobId, 'completed', 100, undefined, undefined, storagePath);

      return {
        success: true,
        compiledPath: storagePath,
        selectedSegments: selection.selectedIndices,
        totalDuration: compileResult.duration,
      };
    } catch (err: unknown) {
      const errorMsg = truncateError(
        err instanceof Error ? err.message : String(err)
      );
      this.setProcessingError(mediaId, errorMsg);
      this.updateJobStatus(jobId, 'failed', 0, errorMsg);
      return {
        success: false,
        compiledPath: null,
        selectedSegments: [],
        totalDuration: 0,
        error: errorMsg,
      };
    }
  }

  /**
   * 手动编译：按用户指定片段和顺序调用 ffmpegCompiler → 更新 compiled_path
   *
   * Requirements: 5.5, 5.6, 5.7, 5.8, 5.9
   */
  async manualCompile(
    mediaId: string,
    segmentIndices: number[],
    options?: CompileOptions,
  ): Promise<CompileResult> {
    const db = getDb();

    // Create compile job
    const jobId = uuidv4();
    const now = new Date().toISOString();
    this.createJob(jobId, mediaId, now);

    try {
      // Mark job as running
      this.updateJobStatus(jobId, 'running', 10, undefined, now);

      // Read video_segments from DB
      const segmentRows = db.prepare(
        'SELECT * FROM video_segments WHERE media_id = ? ORDER BY segment_index ASC'
      ).all(mediaId) as Array<{
        id: string;
        media_id: string;
        segment_index: number;
        start_time: number;
        end_time: number;
        duration: number;
        overall_score: number | null;
        label: string;
      }>;

      if (segmentRows.length === 0) {
        const error = '无有效片段';
        this.updateJobStatus(jobId, 'failed', 0, error);
        return { success: false, compiledPath: null, selectedSegments: [], totalDuration: 0, error };
      }

      // Update job with segment info
      db.prepare(
        'UPDATE compile_jobs SET segment_indices = ?, target_duration = ? WHERE id = ?'
      ).run(JSON.stringify(segmentIndices), options?.targetDuration ?? null, jobId);

      // Prepare segments for ffmpeg — use user-specified order
      this.updateJobStatus(jobId, 'running', 30);
      const selectedSegments = this.getSegmentInputsByOrder(segmentRows, segmentIndices);

      // Get video file path
      const mediaRow = db.prepare(
        'SELECT file_path, trip_id, compiled_path FROM media_items WHERE id = ?'
      ).get(mediaId) as { file_path: string; trip_id: string; compiled_path: string | null } | undefined;

      if (!mediaRow) {
        const error = '媒体项不存在';
        this.updateJobStatus(jobId, 'failed', 0, error);
        return { success: false, compiledPath: null, selectedSegments: [], totalDuration: 0, error };
      }

      // Resolve video path via storage provider
      const storageProvider = getStorageProvider();
      const videoPath = await storageProvider.downloadToTemp(mediaRow.file_path);

      // Determine output directory
      const outputDir = path.dirname(videoPath).replace(/originals/, 'compiled');

      // Compile segments
      this.updateJobStatus(jobId, 'running', 50);
      const compileResult = await compileSegments(videoPath, selectedSegments, outputDir, {
        timeoutMs: options?.timeout ?? 300_000,
      });

      if (compileResult.error || !compileResult.outputPath) {
        // FFmpeg failed — preserve original compiled_path (regeneration failure logic)
        // Requirements: 5.8
        const errorMsg = truncateError(compileResult.error ?? 'FFmpeg 编译失败');
        this.setProcessingError(mediaId, errorMsg);
        this.updateJobStatus(jobId, 'failed', 0, errorMsg);

        const warnings = compileResult.missingSegments
          ? [`缺失片段: ${compileResult.missingSegments.join(', ')}`]
          : undefined;

        return {
          success: false,
          compiledPath: mediaRow.compiled_path,  // Preserve original
          selectedSegments: segmentIndices,
          totalDuration: 0,
          error: errorMsg,
          warnings,
        };
      }

      // Compute relative path for storage
      const storagePath = this.computeStoragePath(compileResult.outputPath, mediaRow.trip_id, mediaId);

      // Upload compiled file to storage provider
      await storageProvider.save(storagePath, fs.createReadStream(compileResult.outputPath));

      // Replace compiled_path with new version (Requirements: 5.6)
      db.prepare('UPDATE media_items SET compiled_path = ?, processing_error = NULL WHERE id = ?')
        .run(storagePath, mediaId);

      // Mark job completed
      this.updateJobStatus(jobId, 'completed', 100, undefined, undefined, storagePath);

      return {
        success: true,
        compiledPath: storagePath,
        selectedSegments: segmentIndices,
        totalDuration: compileResult.duration,
      };
    } catch (err: unknown) {
      const errorMsg = truncateError(
        err instanceof Error ? err.message : String(err)
      );

      // Preserve original compiled_path on failure (Requirements: 5.8)
      const existingMedia = db.prepare(
        'SELECT compiled_path FROM media_items WHERE id = ?'
      ).get(mediaId) as { compiled_path: string | null } | undefined;

      this.setProcessingError(mediaId, errorMsg);
      this.updateJobStatus(jobId, 'failed', 0, errorMsg);

      return {
        success: false,
        compiledPath: existingMedia?.compiled_path ?? null,
        selectedSegments: segmentIndices,
        totalDuration: 0,
        error: errorMsg,
      };
    }
  }

  /**
   * 获取编译任务状态
   */
  getJobStatus(mediaId: string): CompileJobStatus | null {
    const db = getDb();
    const row = db.prepare(
      'SELECT id, media_id, status, percent, error_message, created_at FROM compile_jobs WHERE media_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(mediaId) as {
      id: string;
      media_id: string;
      status: string;
      percent: number;
      error_message: string | null;
      created_at: string;
    } | undefined;

    if (!row) return null;

    return {
      jobId: row.id,
      mediaId: row.media_id,
      status: row.status as CompileJobStatus['status'],
      percent: row.percent,
      error: row.error_message ?? undefined,
      createdAt: row.created_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private createJob(jobId: string, mediaId: string, createdAt: string): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO compile_jobs (id, media_id, status, percent, created_at)
       VALUES (?, ?, 'queued', 0, ?)`
    ).run(jobId, mediaId, createdAt);
  }

  private updateJobStatus(
    jobId: string,
    status: string,
    percent: number,
    errorMessage?: string,
    startedAt?: string,
    resultPath?: string,
  ): void {
    const db = getDb();
    const now = new Date().toISOString();

    if (status === 'running' && startedAt) {
      db.prepare(
        'UPDATE compile_jobs SET status = ?, percent = ?, started_at = ? WHERE id = ?'
      ).run(status, percent, startedAt, jobId);
    } else if (status === 'completed') {
      db.prepare(
        'UPDATE compile_jobs SET status = ?, percent = ?, result_path = ?, finished_at = ? WHERE id = ?'
      ).run(status, percent, resultPath ?? null, now, jobId);
    } else if (status === 'failed') {
      db.prepare(
        'UPDATE compile_jobs SET status = ?, percent = ?, error_message = ?, finished_at = ? WHERE id = ?'
      ).run(status, percent, errorMessage ?? null, now, jobId);
    } else {
      db.prepare(
        'UPDATE compile_jobs SET status = ?, percent = ? WHERE id = ?'
      ).run(status, percent, jobId);
    }
  }

  private setProcessingError(mediaId: string, error: string): void {
    const db = getDb();
    const truncated = truncateError(error);
    db.prepare('UPDATE media_items SET processing_error = ? WHERE id = ?')
      .run(truncated, mediaId);
  }

  private getSegmentInputs(
    segmentRows: Array<{ segment_index: number; start_time: number; end_time: number; duration: number }>,
    selectedIndices: number[],
  ): SegmentInput[] {
    // Return segments in the order of selectedIndices (which is already sorted by startTime from selector)
    const indexMap = new Map(segmentRows.map(row => [row.segment_index, row]));
    return selectedIndices
      .map(idx => indexMap.get(idx))
      .filter((row): row is NonNullable<typeof row> => row != null)
      .map(row => ({
        startTime: row.start_time,
        endTime: row.end_time,
        duration: row.duration,
      }));
  }

  private getSegmentInputsByOrder(
    segmentRows: Array<{ segment_index: number; start_time: number; end_time: number; duration: number }>,
    segmentIndices: number[],
  ): SegmentInput[] {
    // Return segments in user-specified order
    const indexMap = new Map(segmentRows.map(row => [row.segment_index, row]));
    return segmentIndices
      .map(idx => indexMap.get(idx))
      .filter((row): row is NonNullable<typeof row> => row != null)
      .map(row => ({
        startTime: row.start_time,
        endTime: row.end_time,
        duration: row.duration,
      }));
  }

  private computeStoragePath(outputPath: string, tripId: string, mediaId: string): string {
    // If the output path is already relative or contains the trip structure, use the filename
    const filename = path.basename(outputPath);
    return `${tripId}/compiled/${mediaId}_${filename}`;
  }
}
