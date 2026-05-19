/**
 * MergeEngine — 视频合并引擎
 *
 * 包含两个功能：
 * 1. mergeSegments: 将单个视频的多个片段合并为一个输出视频（已有功能）
 * 2. MergeEngine.merge: 将多个已编译视频合并为一个新视频（新功能）
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3
 */

import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';
import { concatenateSegments, buildTransitionFilters } from './videoEditor';
import { getTempDir } from '../helpers/tempDir';
import { VideoSegment } from './videoAnalyzer';
import { VIDEO_THRESHOLDS } from './videoThresholds';

// ---------------------------------------------------------------------------
// Types — mergeSegments (existing)
// ---------------------------------------------------------------------------

export interface SegmentMergeRequest {
  mediaId: string;
  tripId: string;
  segmentIndices: number[];
  transitionType?: 'none' | 'fade' | 'crossfade';
  transitionDuration?: number;
}

export interface SegmentMergeResult {
  success: boolean;
  mergedPath: string | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// Types — MergeEngine (new multi-video merge)
// ---------------------------------------------------------------------------

export interface MergeRequest {
  userId: string;
  tripId: string;
  sourceMediaIds: string[];  // 按顺序排列的源视频 ID
  name?: string;             // 可选自定义名称
}

export interface MergeResult {
  success: boolean;
  mediaId: string | null;    // 新创建的 media_items.id
  filePath: string | null;   // 合并后文件的存储路径
  error?: string;
}


// ---------------------------------------------------------------------------
// mergeSegments — merge segments from a single video (existing functionality)
// ---------------------------------------------------------------------------

/**
 * Merge user-selected video segments into a single output video.
 *
 * - Extracts each selected segment from the source video
 * - Applies optional transition effects between segments
 * - Concatenates and saves the result via StorageProvider
 * - Returns error for empty segment list
 * - Cleans up temp files on error
 */
export async function mergeSegments(
  videoPath: string,
  segments: VideoSegment[],
  request: SegmentMergeRequest,
): Promise<SegmentMergeResult> {
  if (request.segmentIndices.length === 0) {
    return { success: false, mergedPath: null, error: '片段选择列表不能为空' };
  }

  // Resolve selected segments in the requested order
  const segmentMap = new Map(segments.map((s) => [s.index, s]));
  const selected: VideoSegment[] = [];
  for (const idx of request.segmentIndices) {
    const seg = segmentMap.get(idx);
    if (!seg) {
      return { success: false, mergedPath: null, error: `片段索引 ${idx} 不存在` };
    }
    selected.push(seg);
  }

  const tempDir = fs.mkdtempSync(path.join(getTempDir(), `video-merge-${request.mediaId}-`));

  try {
    // Detect audio
    const withAudio = await hasAudioStream(videoPath);

    // Extract each segment to a temp file
    const segmentPaths: string[] = [];
    for (let i = 0; i < selected.length; i++) {
      const seg = selected[i];
      const segPath = path.join(tempDir, `merge_seg_${i}.mp4`);
      await extractSegment(videoPath, seg.startTime, seg.duration, segPath);
      segmentPaths.push(segPath);
    }

    const mergedTempPath = path.join(tempDir, `${request.mediaId}_merged.mp4`);
    const transitionType = request.transitionType ?? 'none';
    const transitionDuration = request.transitionDuration ?? VIDEO_THRESHOLDS.defaultTransitionDuration;

    if (transitionType !== 'none' && segmentPaths.length > 1) {
      const filters = buildTransitionFilters(selected, transitionType, transitionDuration, withAudio);
      await concatenateWithTransitions(segmentPaths, mergedTempPath, filters, withAudio);
    } else {
      await concatenateSimple(segmentPaths, mergedTempPath, tempDir);
    }

    // Save via StorageProvider
    const mergedRelativePath = `${request.tripId}/merged/${request.mediaId}_merged.mp4`;
    const storageProvider = getStorageProvider();
    const mergedBuffer = fs.readFileSync(mergedTempPath);
    await storageProvider.save(mergedRelativePath, mergedBuffer);

    return { success: true, mergedPath: mergedRelativePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, mergedPath: null, error: message };
  } finally {
    // Clean up temp files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}

// ---------------------------------------------------------------------------
// MergeEngine Class — multi-video merge (new functionality)
// ---------------------------------------------------------------------------

export class MergeEngine {
  /**
   * 合并多个已编译视频为一个新视频。
   *
   * 流程：
   * 1. 验证所有源视频存在且有 compiled_path
   * 2. 下载所有 compiled 文件到临时目录
   * 3. 调用 concatenateSegments 拼接
   * 4. 上传结果到存储
   * 5. 创建 media_items 记录 (media_source='merged')
   * 6. 写入 merged_video_sources 关联记录
   *
   * Requirements: 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3
   */
  async merge(request: MergeRequest): Promise<MergeResult> {
    const { userId, tripId, sourceMediaIds, name } = request;
    const db = getDb();
    const storageProvider = getStorageProvider();

    // Temp directory for this merge operation
    const mergeTempDir = path.join(getTempDir(), `merge_${uuidv4()}`);
    fs.mkdirSync(mergeTempDir, { recursive: true });

    try {
      // Step 1: Validate all source videos exist and have compiled_path
      const sourceRows = this.validateSources(sourceMediaIds);

      // Step 2: Download compiled files to temp directory
      const downloadedPaths: string[] = [];
      for (let i = 0; i < sourceRows.length; i++) {
        const row = sourceRows[i];
        const tempPath = await storageProvider.downloadToTemp(row.compiled_path);
        downloadedPaths.push(tempPath);
      }

      // Step 3: Concatenate using ffmpeg via videoEditor's concatenateSegments
      const mergedId = uuidv4();
      const outputFilename = `${mergedId}_merged.mp4`;
      const outputPath = path.join(mergeTempDir, outputFilename);

      await concatenateSegments(downloadedPaths, outputPath, mergeTempDir);

      // Step 4: Upload result to storage
      const storagePath = `${tripId}/merged/${outputFilename}`;
      await storageProvider.save(storagePath, fs.createReadStream(outputPath));

      // Step 5: Create media_items record with media_source='merged'
      const mergedName = name || this.generateDefaultName(tripId);
      const now = new Date().toISOString();
      const fileSize = fs.statSync(outputPath).size;

      db.prepare(`
        INSERT INTO media_items (
          id, trip_id, file_path, media_type, mime_type,
          original_filename, file_size, status, visibility,
          user_id, media_source, compiled_path, created_at
        ) VALUES (?, ?, ?, 'video', 'video/mp4', ?, ?, 'active', 'public', ?, 'merged', ?, ?)
      `).run(
        mergedId,
        tripId,
        storagePath,
        mergedName,
        fileSize,
        userId,
        storagePath,
        now,
      );

      // Step 6: Write merged_video_sources relation records
      const insertSource = db.prepare(`
        INSERT INTO merged_video_sources (id, merged_media_id, source_media_id, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (let i = 0; i < sourceMediaIds.length; i++) {
        insertSource.run(uuidv4(), mergedId, sourceMediaIds[i], i, now);
      }

      return {
        success: true,
        mediaId: mergedId,
        filePath: storagePath,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[MergeEngine] merge failed: ${errorMsg}`);
      return {
        success: false,
        mediaId: null,
        filePath: null,
        error: errorMsg,
      };
    } finally {
      // Clean up temp directory
      try {
        fs.rmSync(mergeTempDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    }
  }

  /**
   * Validate that all source media IDs exist and have compiled_path.
   * Returns the rows in the same order as sourceMediaIds.
   * Throws if any source is invalid.
   *
   * Requirements: 4.1
   */
  private validateSources(sourceMediaIds: string[]): Array<{ id: string; compiled_path: string; trip_id: string }> {
    const db = getDb();
    const results: Array<{ id: string; compiled_path: string; trip_id: string }> = [];

    for (const mediaId of sourceMediaIds) {
      const row = db.prepare(
        'SELECT id, compiled_path, trip_id FROM media_items WHERE id = ? AND status = ?'
      ).get(mediaId, 'active') as { id: string; compiled_path: string | null; trip_id: string } | undefined;

      if (!row) {
        throw new Error(`源视频不存在: ${mediaId}`);
      }

      if (!row.compiled_path) {
        throw new Error(`源视频未完成编译: ${mediaId}`);
      }

      results.push({ id: row.id, compiled_path: row.compiled_path, trip_id: row.trip_id });
    }

    return results;
  }

  /**
   * 生成默认名称：相册标题 + 4位随机数
   *
   * Requirements: 5.2
   */
  private generateDefaultName(tripId: string): string {
    const db = getDb();
    const trip = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
    const title = trip?.title || '合并视频';
    const randomSuffix = Math.floor(1000 + Math.random() * 9000).toString();
    return `${title}${randomSuffix}`;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (for mergeSegments)
// ---------------------------------------------------------------------------

function hasAudioStream(videoPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) { resolve(false); return; }
      const audio = metadata.streams?.find((s) => s.codec_type === 'audio');
      resolve(!!audio);
    });
  });
}

function extractSegment(
  videoPath: string,
  startTime: number,
  duration: number,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    ffmpeg(videoPath)
      .seekInput(startTime)
      .duration(duration)
      .output(outputPath)
      .outputOptions(['-c', 'copy'])
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}

function concatenateSimple(
  segmentPaths: string[],
  outputPath: string,
  tempDir: string,
): Promise<void> {
  const concatListPath = path.join(tempDir, 'concat_list.txt');
  const listContent = segmentPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(concatListPath, listContent);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy'])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}

interface TransitionFilter {
  videoFilter: string | null;
  audioFilter: string | null;
}

function concatenateWithTransitions(
  segmentPaths: string[],
  outputPath: string,
  filters: TransitionFilter,
  withAudio: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    let cmd = ffmpeg();
    for (const segPath of segmentPaths) {
      cmd = cmd.input(segPath);
    }

    const filterParts: string[] = [];
    if (filters.videoFilter) filterParts.push(filters.videoFilter);
    if (filters.audioFilter) filterParts.push(filters.audioFilter);

    const outputOptions: string[] = [
      '-c:v', 'libx264',
      '-movflags', '+faststart',
    ];

    if (withAudio) {
      outputOptions.push('-c:a', 'aac');
    } else {
      outputOptions.push('-an');
    }

    if (filterParts.length > 0) {
      cmd = cmd.complexFilter(filterParts.join(';'));
      outputOptions.push('-map', '[vout]');
      if (withAudio && filters.audioFilter) {
        outputOptions.push('-map', '[aout]');
      }
    }

    cmd
      .outputOptions(outputOptions)
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}
