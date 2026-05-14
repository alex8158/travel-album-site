/**
 * FFmpeg Runner — 带超时保护的 FFmpeg 命令执行器
 *
 * 防止 FFmpeg 进程因大文件处理而无限挂起导致 OOM。
 * 超时后强制 kill 进程并抛出明确错误。
 */

import ffmpeg from 'fluent-ffmpeg';

const DEFAULT_FFMPEG_TIMEOUT_MS = parseInt(process.env.VIDEO_FFMPEG_TIMEOUT_MS || '120000', 10);
const DEFAULT_COMPILE_TIMEOUT_MS = parseInt(process.env.VIDEO_COMPILE_TIMEOUT_MS || '600000', 10);

export { DEFAULT_FFMPEG_TIMEOUT_MS, DEFAULT_COMPILE_TIMEOUT_MS };

/**
 * Run an ffmpeg command with a timeout guard.
 * If the command does not finish within timeoutMs, the ffmpeg process is killed with SIGKILL.
 *
 * @param command - A fluent-ffmpeg command (already configured with input/output/options)
 * @param timeoutMs - Maximum allowed execution time in milliseconds
 * @param taskName - Human-readable task name for error messages
 */
export function runFfmpegWithTimeout(
  command: ffmpeg.FfmpegCommand,
  timeoutMs: number,
  taskName: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { command.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`[ffmpeg] ${taskName} timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    command
      .on('end', () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      })
      .on('error', (err: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(err);
      })
      .run();
  });
}
