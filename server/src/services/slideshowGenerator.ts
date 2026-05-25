/**
 * SlideshowGenerator — 将照片序列拼接为幻灯片视频（每张照片固定显示时长）
 *
 * 功能：
 * - 使用 ffmpeg filter_complex 将多张照片拼接为视频
 * - 输出格式: MP4 容器 + H.264 视频 + yuv420p
 * - 分辨率限制: 不超过 1920×1080，保持比例，黑边填充
 * - 超时机制: 默认 300 秒后强制终止 ffmpeg 进程
 * - 照片验证: 拼接前验证所有照片文件存在且可读
 * - 容错: 部分照片不可读时跳过并记录警告
 * - 可选音频混合: 音频短于视频时循环，长于视频时截断
 * - 资源清理: 确保临时文件在任何情况下都被清理
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { getTempDir } from '../helpers/tempDir';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlideshowOptions {
  /** 照片文件路径列表（按用户选择顺序） */
  photoPaths: string[];
  /** 音频文件路径（可选） */
  audioPath?: string | null;
  /** 输出目录 */
  outputDir: string;
  /** 每张照片显示时长（秒），默认 2 */
  photoDuration?: number;
  /** 最大输出宽度，默认 1920 */
  maxWidth?: number;
  /** 最大输出高度，默认 1080 */
  maxHeight?: number;
  /** 超时时间（毫秒），默认 300000 */
  timeoutMs?: number;
  /** 进度回调 */
  onProgress?: (percent: number) => void;
}

export interface SlideshowResult {
  success: boolean;
  outputPath: string | null;
  totalDuration: number;
  /** 被跳过的照片索引（文件不存在或不可读） */
  skippedPhotos: number[];
  error?: string;
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PHOTO_DURATION = 2;
const DEFAULT_MAX_WIDTH = 1920;
const DEFAULT_MAX_HEIGHT = 1080;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Exported helper functions (for property testing)
// ---------------------------------------------------------------------------

/**
 * 计算输出分辨率：
 * 1. 找到所有照片中的最大宽度和最大高度
 * 2. 如果超过 maxWidth x maxHeight，按比例缩小
 * 3. 确保宽高为偶数（H.264 要求）
 */
export function calculateOutputResolution(
  photoDimensions: Array<{ width: number; height: number }>,
  maxWidth: number = DEFAULT_MAX_WIDTH,
  maxHeight: number = DEFAULT_MAX_HEIGHT,
): { width: number; height: number } {
  if (photoDimensions.length === 0) {
    return { width: maxWidth, height: maxHeight };
  }

  let targetW = Math.max(...photoDimensions.map((d) => d.width));
  let targetH = Math.max(...photoDimensions.map((d) => d.height));

  // Ensure minimum dimensions
  targetW = Math.max(targetW, 2);
  targetH = Math.max(targetH, 2);

  // Cap at max resolution (scale down proportionally)
  if (targetW > maxWidth || targetH > maxHeight) {
    const scale = Math.min(maxWidth / targetW, maxHeight / targetH);
    targetW = Math.floor(targetW * scale);
    targetH = Math.floor(targetH * scale);
  }

  // Ensure even dimensions (H.264 requirement)
  targetW = targetW % 2 === 0 ? targetW : targetW - 1;
  targetH = targetH % 2 === 0 ? targetH : targetH - 1;

  // Ensure minimum of 2 after rounding
  targetW = Math.max(targetW, 2);
  targetH = Math.max(targetH, 2);

  return { width: targetW, height: targetH };
}

/**
 * 构建照片→视频的 ffmpeg 参数
 * 使用 filter_complex: scale+pad per photo, then concat
 */
export function buildSlideshowArgs(
  photoPaths: string[],
  outputPath: string,
  resolution: { width: number; height: number },
  photoDuration: number = DEFAULT_PHOTO_DURATION,
): string[] {
  const inputArgs: string[] = [];
  const filterParts: string[] = [];

  for (let i = 0; i < photoPaths.length; i++) {
    // Each photo as input with loop and duration
    inputArgs.push('-loop', '1', '-t', String(photoDuration), '-i', photoPaths[i]);
    // Scale to fit within target resolution, pad with black to exact size
    filterParts.push(
      `[${i}:v]scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=decrease,` +
        `pad=${resolution.width}:${resolution.height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `setsar=1[v${i}]`,
    );
  }

  // Concat all scaled streams
  const concatInputs = photoPaths.map((_, i) => `[v${i}]`).join('');
  const concatFilter = `${concatInputs}concat=n=${photoPaths.length}:v=1:a=0[outv]`;

  const filterComplex = [...filterParts, concatFilter].join(';');

  return [
    '-y',
    ...inputArgs,
    '-filter_complex',
    filterComplex,
    '-map',
    '[outv]',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    outputPath,
  ];
}

/**
 * 构建音频混合的 ffmpeg 参数
 * - 音频短于视频时循环 (-stream_loop -1)
 * - 音频长于视频时截断 (-t videoDuration)
 */
export function buildAudioMixArgs(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  videoDuration: number,
  audioDuration: number,
): string[] {
  const needsLoop = audioDuration < videoDuration;

  const args: string[] = ['-y'];

  // Video input
  args.push('-i', videoPath);

  // Audio input (with loop if needed)
  if (needsLoop) {
    args.push('-stream_loop', '-1');
  }
  args.push('-i', audioPath);

  // Map video from first input, audio from second
  args.push('-map', '0:v', '-map', '1:a');

  // Copy video codec (no re-encoding), encode audio
  args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k');

  // Truncate at video duration
  args.push('-t', String(videoDuration));

  args.push('-movflags', '+faststart');
  args.push(outputPath);

  return args;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * 将照片序列拼接为幻灯片视频，可选混合音频。
 */
export async function generateSlideshow(options: SlideshowOptions): Promise<SlideshowResult> {
  const {
    photoPaths,
    audioPath,
    outputDir,
    photoDuration = DEFAULT_PHOTO_DURATION,
    maxWidth = DEFAULT_MAX_WIDTH,
    maxHeight = DEFAULT_MAX_HEIGHT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onProgress,
  } = options;

  const warnings: string[] = [];
  const skippedPhotos: number[] = [];

  // 1. Validate photo paths — check each file exists and is readable
  const validPhotoPaths: string[] = [];
  for (let i = 0; i < photoPaths.length; i++) {
    try {
      await fs.promises.access(photoPaths[i], fs.constants.R_OK);
      validPhotoPaths.push(photoPaths[i]);
    } catch {
      skippedPhotos.push(i);
      warnings.push(`照片 ${i} 不可读，已跳过: ${photoPaths[i]}`);
    }
  }

  // If all photos are unreadable, return failure
  if (validPhotoPaths.length === 0) {
    return {
      success: false,
      outputPath: null,
      totalDuration: 0,
      skippedPhotos,
      error: '所有照片均无法读取',
      warnings,
    };
  }

  // 2. Get dimensions of valid photos
  const photoDimensions: Array<{ width: number; height: number }> = [];
  for (const photoPath of validPhotoPaths) {
    try {
      const meta = await sharp(photoPath, { failOn: 'none' }).metadata();
      photoDimensions.push({
        width: meta.width ?? 800,
        height: meta.height ?? 600,
      });
    } catch {
      // If we can't read metadata, use a default dimension
      photoDimensions.push({ width: 800, height: 600 });
    }
  }

  // 3. Calculate output resolution
  const resolution = calculateOutputResolution(photoDimensions, maxWidth, maxHeight);

  // 4. Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  const silentVideoPath = path.join(outputDir, `slideshow_silent_${Date.now()}.mp4`);
  const finalOutputPath = path.join(outputDir, `slideshow_${Date.now()}.mp4`);

  const totalDuration = validPhotoPaths.length * photoDuration;

  try {
    // 5. Build ffmpeg args and spawn process for slideshow
    const slideshowArgs = buildSlideshowArgs(validPhotoPaths, silentVideoPath, resolution, photoDuration);

    await runFfmpegProcess(slideshowArgs, timeoutMs, totalDuration, onProgress);

    // 6. If audio provided, do second pass for audio mixing
    if (audioPath) {
      let audioValid = false;
      try {
        await fs.promises.access(audioPath, fs.constants.R_OK);
        audioValid = true;
      } catch {
        warnings.push(`音频文件不可读，已忽略: ${audioPath}`);
      }

      if (audioValid) {
        try {
          const audioDuration = await getAudioDuration(audioPath);
          const audioMixArgs = buildAudioMixArgs(
            silentVideoPath,
            audioPath,
            finalOutputPath,
            totalDuration,
            audioDuration,
          );

          await runFfmpegProcess(audioMixArgs, timeoutMs);

          // Clean up silent video
          try {
            fs.unlinkSync(silentVideoPath);
          } catch {
            // Ignore cleanup errors
          }

          return {
            success: true,
            outputPath: finalOutputPath,
            totalDuration,
            skippedPhotos,
            warnings: warnings.length > 0 ? warnings : undefined,
          };
        } catch (err) {
          // Audio mixing failed — fall back to silent video
          const errorMsg = err instanceof Error ? err.message : String(err);
          warnings.push(`音频混合失败，输出无音轨视频: ${errorMsg}`);
        }
      }
    }

    // No audio or audio failed — rename silent video to final output
    if (fs.existsSync(silentVideoPath)) {
      fs.renameSync(silentVideoPath, finalOutputPath);
    }

    return {
      success: true,
      outputPath: finalOutputPath,
      totalDuration,
      skippedPhotos,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Clean up any partial output
    try {
      if (fs.existsSync(silentVideoPath)) fs.unlinkSync(silentVideoPath);
    } catch { /* ignore */ }
    try {
      if (fs.existsSync(finalOutputPath)) fs.unlinkSync(finalOutputPath);
    } catch { /* ignore */ }

    return {
      success: false,
      outputPath: null,
      totalDuration: 0,
      skippedPhotos,
      error: errorMessage,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Get audio duration using ffprobe
 */
function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(new Error(`Failed to probe audio file: ${err.message}`));
        return;
      }
      const duration = metadata.format?.duration ?? 0;
      resolve(duration);
    });
  });
}

/**
 * Run an ffmpeg process with timeout and optional progress parsing.
 *
 * Progress is parsed from stderr by looking for `time=HH:MM:SS.ms` patterns.
 */
function runFfmpegProcess(
  args: string[],
  timeoutMs: number,
  totalDuration?: number,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
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
      const text = chunk.toString();
      stderr += text;

      // Parse progress from stderr (time=HH:MM:SS.ms pattern)
      if (onProgress && totalDuration && totalDuration > 0) {
        const timeMatch = text.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
        if (timeMatch) {
          const hours = parseInt(timeMatch[1], 10);
          const minutes = parseInt(timeMatch[2], 10);
          const seconds = parseInt(timeMatch[3], 10);
          const centiseconds = parseInt(timeMatch[4], 10);
          const currentTime = hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
          const percent = Math.min(99, Math.round((currentTime / totalDuration) * 100));
          onProgress(percent);
        }
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg 进程启动失败: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error('视频生成超时'));
      } else if (code !== 0) {
        const lastLines = stderr.split('\n').slice(-5).join('\n');
        reject(new Error(`ffmpeg 处理失败，退出码: ${code}。${lastLines}`));
      } else {
        resolve();
      }
    });
  });
}
