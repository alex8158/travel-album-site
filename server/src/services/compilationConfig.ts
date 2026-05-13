/**
 * compilationConfig — 视频编译功能的配置读取模块
 *
 * 从环境变量读取 FFmpeg 编译相关配置，提供合理默认值。
 */

export interface CompilationConfig {
  /** FFmpeg 进程内存限制 (MB)，默认 4096 */
  videoMemoryLimitMB: number;
}

const DEFAULT_VIDEO_MEMORY_LIMIT_MB = 4096;
const MIN_VIDEO_MEMORY_LIMIT_MB = 128;
const MAX_VIDEO_MEMORY_LIMIT_MB = 65536;

/**
 * 从环境变量 VIDEO_MEMORY_LIMIT_MB 读取 FFmpeg 内存限制配置。
 * 无效值或超出范围时返回默认值 4096。
 */
export function getVideoMemoryLimitMB(): number {
  const raw = process.env.VIDEO_MEMORY_LIMIT_MB;
  if (raw === undefined || raw === '') return DEFAULT_VIDEO_MEMORY_LIMIT_MB;

  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < MIN_VIDEO_MEMORY_LIMIT_MB || parsed > MAX_VIDEO_MEMORY_LIMIT_MB) {
    return DEFAULT_VIDEO_MEMORY_LIMIT_MB;
  }
  return parsed;
}

/**
 * 获取完整的编译配置
 */
export function getCompilationConfig(): CompilationConfig {
  return {
    videoMemoryLimitMB: getVideoMemoryLimitMB(),
  };
}
