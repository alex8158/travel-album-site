/**
 * AudioMixer — 将背景音乐混入编译后的视频
 *
 * 功能：
 * - 自动裁剪模式：音频 ≥ 视频时截断，音频 < 视频时循环后截断
 * - 手动裁剪模式：按用户指定的 trimStart/trimEnd 裁剪
 * - 淡入淡出：默认 1 秒淡入 + 2 秒淡出
 * - 原始音频音量控制（Task 3.4）
 */

import { spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioMixOptions {
  audioTrackPath: string;       // Local path to audio file
  videoPath: string;            // Local path to compiled video
  outputPath: string;           // Output path for mixed video
  videoDuration: number;        // Video duration in seconds
  trimStart?: number;           // Manual trim start (seconds)
  trimEnd?: number;             // Manual trim end (seconds)
  fadeInDuration?: number;      // Fade-in duration (default: 1s)
  fadeOutDuration?: number;     // Fade-out duration (default: 2s)
  originalAudioVolume?: number; // Original audio volume (0-0.2, default: 0)
}

export interface TrimCalculation {
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Clamp the originalAudioVolume to the valid range [0, 0.2].
 * Returns 0 if undefined/null.
 */
export function clampVolume(volume: number | undefined | null): number {
  if (volume == null) return 0;
  return Math.max(0, Math.min(0.2, volume));
}

/**
 * Calculate the trim window for manual trim mode.
 *
 * Rules:
 * - Setting startPoint → end = startPoint + videoDuration
 * - Setting endPoint → start = endPoint - videoDuration
 * - Constraints: start ≥ 0, end ≤ audioDuration, end - start = videoDuration
 *
 * If both startPoint and endPoint are provided, startPoint takes precedence.
 * If neither is provided, defaults to start=0.
 */
export function calculateTrimWindow(
  videoDuration: number,
  audioDuration: number,
  startPoint?: number,
  endPoint?: number
): TrimCalculation {
  let start: number;
  let end: number;

  if (startPoint != null) {
    // Setting start → end = start + videoDuration
    start = startPoint;
    end = start + videoDuration;
  } else if (endPoint != null) {
    // Setting end → start = end - videoDuration
    end = endPoint;
    start = end - videoDuration;
  } else {
    // Default: start from beginning
    start = 0;
    end = videoDuration;
  }

  // Constraint: start ≥ 0
  if (start < 0) {
    start = 0;
    end = start + videoDuration;
  }

  // Constraint: end ≤ audioDuration
  if (end > audioDuration) {
    end = audioDuration;
    start = end - videoDuration;
  }

  // Final safety: ensure start ≥ 0 after adjustment
  if (start < 0) {
    start = 0;
    end = start + videoDuration;
  }

  return { start, end };
}

/**
 * Mix background audio into a compiled video.
 *
 * Auto-trim mode (when trimStart/trimEnd are not provided):
 * - If audio duration >= video duration: truncate audio at video end point
 * - If audio duration < video duration: loop audio (-stream_loop -1) then truncate
 * - Apply fade-in (1s) and fade-out (2s)
 *
 * Manual trim mode (when trimStart or trimEnd is provided):
 * - Extract [start, end] segment from audio
 * - Duration equals video duration
 * - Apply fade-in (1s) and fade-out (2s)
 *
 * @returns The output path on success
 * @throws Error on ffmpeg failure
 */
export async function mixAudioToVideo(options: AudioMixOptions): Promise<string> {
  const {
    audioTrackPath,
    videoPath,
    outputPath,
    videoDuration,
    trimStart,
    trimEnd,
    fadeInDuration = 1,
    fadeOutDuration = 2,
    originalAudioVolume,
  } = options;

  // Get audio duration
  const audioDuration = await getAudioDuration(audioTrackPath);

  // Clamp volume to [0, 0.2]
  const clampedVolume = clampVolume(originalAudioVolume);

  // Determine mode: manual trim vs auto-trim
  const isManualTrim = trimStart != null || trimEnd != null;

  let args: string[];

  if (isManualTrim) {
    // Manual trim mode
    const trimWindow = calculateTrimWindow(
      videoDuration,
      audioDuration,
      trimStart,
      trimEnd
    );

    args = buildManualTrimArgs({
      audioTrackPath,
      videoPath,
      outputPath,
      videoDuration,
      fadeInDuration,
      fadeOutDuration,
      trimStart: trimWindow.start,
      trimEnd: trimWindow.end,
      originalAudioVolume: clampedVolume,
    });
  } else {
    // Auto-trim mode
    const needsLoop = audioDuration < videoDuration;

    args = buildAutoTrimArgs({
      audioTrackPath,
      videoPath,
      outputPath,
      videoDuration,
      fadeInDuration,
      fadeOutDuration,
      needsLoop,
      originalAudioVolume: clampedVolume,
    });
  }

  // Execute ffmpeg
  await runFfmpeg(args);

  return outputPath;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface AutoTrimBuildOptions {
  audioTrackPath: string;
  videoPath: string;
  outputPath: string;
  videoDuration: number;
  fadeInDuration: number;
  fadeOutDuration: number;
  needsLoop: boolean;
  originalAudioVolume: number;
}

/**
 * Build ffmpeg arguments for auto-trim mode.
 *
 * Filter chain (volume = 0, default):
 *   [1:a]atrim=0:{videoDuration},asetpts=PTS-STARTPTS,afade=t=in:d={fadeIn},afade=t=out:st={videoDuration-fadeOut}:d={fadeOut}[bgm]
 *
 * Filter chain (volume > 0):
 *   [1:a]atrim=0:{videoDuration},asetpts=PTS-STARTPTS,afade=t=in:d={fadeIn},afade=t=out:st={videoDuration-fadeOut}:d={fadeOut}[bgm];
 *   [0:a]volume={originalVolume}[orig];
 *   [orig][bgm]amix=inputs=2:duration=first[aout]
 *
 * For looping case, adds -stream_loop -1 on the audio input.
 */
function buildAutoTrimArgs(opts: AutoTrimBuildOptions): string[] {
  const {
    audioTrackPath,
    videoPath,
    outputPath,
    videoDuration,
    fadeInDuration,
    fadeOutDuration,
    needsLoop,
    originalAudioVolume,
  } = opts;

  const fadeOutStart = videoDuration - fadeOutDuration;

  // Build the bgm filter chain
  const bgmFilter =
    `[1:a]atrim=0:${videoDuration},asetpts=PTS-STARTPTS,` +
    `afade=t=in:d=${fadeInDuration},` +
    `afade=t=out:st=${fadeOutStart}:d=${fadeOutDuration}[bgm]`;

  // Determine if we need amix (original audio volume > 0)
  let filterChain: string;
  let audioMapLabel: string;

  if (originalAudioVolume > 0) {
    // Mix original audio with background music
    filterChain =
      `${bgmFilter};` +
      `[0:a]volume=${originalAudioVolume}[orig];` +
      `[orig][bgm]amix=inputs=2:duration=first[aout]`;
    audioMapLabel = '[aout]';
  } else {
    // Only background music (default behavior)
    filterChain = bgmFilter;
    audioMapLabel = '[bgm]';
  }

  const args: string[] = [
    '-y',
    // Input 0: video
    '-i', videoPath,
  ];

  // Input 1: audio (with optional looping)
  if (needsLoop) {
    args.push('-stream_loop', '-1');
  }
  args.push('-i', audioTrackPath);

  // Filter and output options
  args.push(
    '-filter_complex', filterChain,
    '-map', '0:v',
    '-map', audioMapLabel,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-shortest',
    outputPath,
  );

  return args;
}

// ---------------------------------------------------------------------------

interface ManualTrimBuildOptions {
  audioTrackPath: string;
  videoPath: string;
  outputPath: string;
  videoDuration: number;
  fadeInDuration: number;
  fadeOutDuration: number;
  trimStart: number;
  trimEnd: number;
  originalAudioVolume: number;
}

/**
 * Build ffmpeg arguments for manual trim mode.
 *
 * Filter chain (volume = 0, default):
 *   [1:a]atrim={start}:{end},asetpts=PTS-STARTPTS,afade=t=in:d={fadeIn},afade=t=out:st={duration-fadeOut}:d={fadeOut}[bgm]
 *
 * Filter chain (volume > 0):
 *   [1:a]atrim={start}:{end},asetpts=PTS-STARTPTS,afade=t=in:d={fadeIn},afade=t=out:st={duration-fadeOut}:d={fadeOut}[bgm];
 *   [0:a]volume={originalVolume}[orig];
 *   [orig][bgm]amix=inputs=2:duration=first[aout]
 *
 * No looping is needed since the user selects a specific segment.
 */
function buildManualTrimArgs(opts: ManualTrimBuildOptions): string[] {
  const {
    audioTrackPath,
    videoPath,
    outputPath,
    videoDuration,
    fadeInDuration,
    fadeOutDuration,
    trimStart,
    trimEnd,
    originalAudioVolume,
  } = opts;

  const fadeOutStart = videoDuration - fadeOutDuration;

  // Build the bgm filter chain for manual trim
  const bgmFilter =
    `[1:a]atrim=${trimStart}:${trimEnd},asetpts=PTS-STARTPTS,` +
    `afade=t=in:d=${fadeInDuration},` +
    `afade=t=out:st=${fadeOutStart}:d=${fadeOutDuration}[bgm]`;

  // Determine if we need amix (original audio volume > 0)
  let filterChain: string;
  let audioMapLabel: string;

  if (originalAudioVolume > 0) {
    // Mix original audio with background music
    filterChain =
      `${bgmFilter};` +
      `[0:a]volume=${originalAudioVolume}[orig];` +
      `[orig][bgm]amix=inputs=2:duration=first[aout]`;
    audioMapLabel = '[aout]';
  } else {
    // Only background music (default behavior)
    filterChain = bgmFilter;
    audioMapLabel = '[bgm]';
  }

  const args: string[] = [
    '-y',
    // Input 0: video
    '-i', videoPath,
    // Input 1: audio (no looping for manual trim)
    '-i', audioTrackPath,
    // Filter and output options
    '-filter_complex', filterChain,
    '-map', '0:v',
    '-map', audioMapLabel,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-shortest',
    outputPath,
  ];

  return args;
}

/**
 * Get audio file duration using ffprobe.
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
 * Execute ffmpeg with the given arguments.
 * Returns a promise that resolves on success or rejects on failure.
 */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`ffmpeg process failed to start: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        const lastLines = stderr.split('\n').slice(-5).join('\n');
        reject(new Error(`Audio mixing failed (exit code ${code}): ${lastLines}`));
      } else {
        resolve();
      }
    });
  });
}
