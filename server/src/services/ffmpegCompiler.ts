/**
 * FFmpeg Compiler — 将多个视频片段拼接为单一 MP4 文件
 *
 * 功能：
 * - 使用 ffmpeg concat demuxer 拼接多个片段
 * - 输出格式: MP4 容器 + H.264 视频 + AAC 音频
 * - 分辨率限制: 不超过 1080p（1920×1080），不放大低于 1080p 的原始分辨率
 * - 内存限制: 从 VIDEO_MEMORY_LIMIT_MB 环境变量读取（使用 compilationConfig.ts 中的 getVideoMemoryLimitMB()）
 * - 超时机制: 300 秒后强制终止 ffmpeg 进程
 * - 片段验证: 拼接前验证所有源片段文件存在且可读
 * - 容错: 部分片段缺失时跳过缺失片段继续拼接
 * - 资源清理: 确保临时文件在任何情况下都被清理（使用 try/finally）
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getTempDir } from '../helpers/tempDir';
import { getVideoMemoryLimitMB } from './compilationConfig';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompilerOptions {
  /** FFmpeg 进程内存限制 (MB)，默认从 VIDEO_MEMORY_LIMIT_MB 读取 */
  memoryLimitMB?: number;
  /** 超时时间 (毫秒)，默认 300000 (300秒) */
  timeoutMs?: number;
  /** 最大输出分辨率，默认 1080 */
  maxResolution?: number;
}

export interface SegmentInput {
  startTime: number;
  endTime: number;
  duration: number;
}

export interface CompilerResult {
  /** 输出文件路径，失败时为 null */
  outputPath: string | null;
  /** 输出视频总时长 (秒) */
  duration: number;
  /** 错误信息 */
  error?: string;
  /** 缺失的片段索引列表 */
  missingSegments?: number[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 300_000; // 300 seconds
const DEFAULT_MAX_RESOLUTION = 1080;

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * 将多个视频片段拼接为单一 MP4 文件。
 *
 * 使用 ffmpeg concat demuxer 方式：
 * 1. 从源视频中按 -ss/-to 提取各片段为临时文件
 * 2. 生成 concat list 文件
 * 3. 使用 -f concat -safe 0 -i list.txt 拼接
 *
 * @param videoPath - 源视频文件路径
 * @param segments - 片段列表（startTime, endTime, duration）
 * @param outputDir - 输出目录
 * @param options - 编译选项
 */
export async function compileSegments(
  videoPath: string,
  segments: SegmentInput[],
  outputDir: string,
  options?: CompilerOptions,
): Promise<CompilerResult> {
  // 空片段列表 → 参数错误
  if (!segments || segments.length === 0) {
    return {
      outputPath: null,
      duration: 0,
      error: '参数错误: 片段列表为空',
    };
  }

  const memoryLimitMB = options?.memoryLimitMB ?? getVideoMemoryLimitMB();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResolution = options?.maxResolution ?? DEFAULT_MAX_RESOLUTION;

  // 创建临时目录
  const tempDir = fs.mkdtempSync(path.join(getTempDir(), 'compile-'));

  try {
    // 验证源视频文件存在
    if (!fileIsReadable(videoPath)) {
      return {
        outputPath: null,
        duration: 0,
        error: `源视频文件不存在或不可读: ${videoPath}`,
      };
    }

    // 提取各片段为临时文件，同时验证可用性
    const { segmentPaths, missingIndices } = await extractAllSegments(
      videoPath,
      segments,
      tempDir,
      timeoutMs,
      memoryLimitMB,
    );

    // 全部片段缺失 → 返回错误
    if (segmentPaths.length === 0) {
      return {
        outputPath: null,
        duration: 0,
        error: '所有片段均不可用，无法执行拼接',
        missingSegments: missingIndices,
      };
    }

    // 生成 concat list 文件
    const concatListPath = path.join(tempDir, 'concat_list.txt');
    const listContent = segmentPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(concatListPath, listContent);

    // 确保输出目录存在
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `compiled_${Date.now()}.mp4`);

    // 执行拼接
    await concatSegments(concatListPath, outputPath, maxResolution, timeoutMs, memoryLimitMB);

    // 计算输出时长
    const totalDuration = segments
      .filter((_, i) => !missingIndices.includes(i))
      .reduce((sum, seg) => sum + seg.duration, 0);

    const result: CompilerResult = {
      outputPath,
      duration: totalDuration,
    };

    if (missingIndices.length > 0) {
      result.missingSegments = missingIndices;
    }

    return result;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      outputPath: null,
      duration: 0,
      error: errorMessage,
    };
  } finally {
    // 确保临时文件在任何情况下都被清理
    cleanupTempDir(tempDir);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * 检查文件是否存在且可读
 */
function fileIsReadable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 清理临时目录
 */
function cleanupTempDir(tempDir: string): void {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // 忽略清理错误
  }
}

/**
 * 提取所有片段为临时文件。
 * 跳过提取失败的片段，返回成功提取的路径列表和缺失索引。
 */
async function extractAllSegments(
  videoPath: string,
  segments: SegmentInput[],
  tempDir: string,
  timeoutMs: number,
  memoryLimitMB: number,
): Promise<{ segmentPaths: string[]; missingIndices: number[] }> {
  const segmentPaths: string[] = [];
  const missingIndices: number[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segmentPath = path.join(tempDir, `segment_${i}.mp4`);

    try {
      await extractSegment(videoPath, seg.startTime, seg.endTime, segmentPath, timeoutMs, memoryLimitMB);
      // 验证提取后的文件存在且可读
      if (fileIsReadable(segmentPath)) {
        segmentPaths.push(segmentPath);
      } else {
        missingIndices.push(i);
      }
    } catch {
      missingIndices.push(i);
    }
  }

  return { segmentPaths, missingIndices };
}

/**
 * 从源视频中提取单个片段
 */
function extractSegment(
  videoPath: string,
  startTime: number,
  endTime: number,
  outputPath: string,
  timeoutMs: number,
  memoryLimitMB: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = buildExtractArgs(videoPath, startTime, endTime, outputPath, memoryLimitMB);

    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg 进程启动失败: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error('片段提取超时'));
      } else if (code !== 0) {
        reject(new Error(`ffmpeg 片段提取失败，退出码: ${code}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * 构建片段提取的 ffmpeg 参数
 */
function buildExtractArgs(
  videoPath: string,
  startTime: number,
  endTime: number,
  outputPath: string,
  memoryLimitMB: number,
): string[] {
  return [
    '-y',
    '-ss', String(startTime),
    '-to', String(endTime),
    '-i', videoPath,
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-async', '1',                          // 音视频同步
    '-max_muxing_queue_size', '1024',       // 避免 muxing 队列溢出
    '-movflags', '+faststart',
    outputPath,
  ];
}

/**
 * 使用 concat demuxer 拼接所有片段
 */
function concatSegments(
  concatListPath: string,
  outputPath: string,
  maxResolution: number,
  timeoutMs: number,
  memoryLimitMB: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = buildConcatArgs(concatListPath, outputPath, maxResolution, memoryLimitMB);

    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg 拼接进程启动失败: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error('ffmpeg 拼接超时 (超过 300 秒)'));
      } else if (code !== 0) {
        // 提取 stderr 最后几行作为错误信息
        const lastLines = stderr.split('\n').slice(-5).join('\n');
        reject(new Error(`ffmpeg 拼接失败，退出码: ${code}。${lastLines}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * 构建 concat 拼接的 ffmpeg 参数
 * - 分辨率限制: 不超过 1080p（1920×1080），不放大低于 1080p 的原始分辨率
 * - 内存限制: 通过 -threads 和 buffer size 控制
 * - 音视频同步: 使用 -async 1
 */
function buildConcatArgs(
  concatListPath: string,
  outputPath: string,
  maxResolution: number,
  memoryLimitMB: number,
): string[] {
  // 计算最大宽高（保持 16:9 比例下的最大值）
  const maxWidth = Math.round(maxResolution * 16 / 9);  // 1920 for 1080p
  const maxHeight = maxResolution;                       // 1080 for 1080p

  // 分辨率限制 filter：不超过 maxResolution，不放大
  // 使用 min(maxWidth, iw) 和 min(maxHeight, ih) 确保不放大
  const scaleFilter = `scale='min(${maxWidth}\\,iw)':'min(${maxHeight}\\,ih)':force_original_aspect_ratio=decrease`;

  // 根据内存限制计算线程数（粗略估算：每线程约 512MB）
  const threads = Math.max(1, Math.min(4, Math.floor(memoryLimitMB / 512)));

  return [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
    '-vf', scaleFilter,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-c:a', 'aac',
    '-async', '1',                          // 音视频同步
    '-threads', String(threads),            // 线程数限制（基于内存限制）
    '-max_muxing_queue_size', '1024',       // 避免 muxing 队列溢出
    '-movflags', '+faststart',
    outputPath,
  ];
}
