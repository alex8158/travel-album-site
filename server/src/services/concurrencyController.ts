/**
 * ConcurrencyController — 基于信号量模式的并发控制器
 *
 * 用于限制同时进行的视频片段处理任务数量，防止多任务并行导致内存叠加。
 * 支持动态调整并发上限，FIFO 等待队列保证公平性。
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

// ---------------------------------------------------------------------------
// Types & Interface
// ---------------------------------------------------------------------------

export interface ConcurrencyController {
  /** 获取信号量，返回 Promise 在有空位时 resolve */
  acquire(): Promise<void>;
  /** 释放信号量 */
  release(): void;

  /** 动态调整最大并发数 */
  setMaxConcurrency(max: number): void;
  /** 获取当前最大并发数 */
  getMaxConcurrency(): number;
  /** 获取当前正在执行的任务数 */
  getCurrentCount(): number;
  /** 获取等待队列长度 */
  getQueueLength(): number;
}

// ---------------------------------------------------------------------------
// FIFO Queue Entry
// ---------------------------------------------------------------------------

interface QueueEntry {
  resolve: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * 创建并发控制器实例
 * @param maxConcurrency 最大并发数，必须为正整数
 */
export function createConcurrencyController(maxConcurrency: number): ConcurrencyController {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(`maxConcurrency must be a positive integer, got: ${maxConcurrency}`);
  }

  let max = maxConcurrency;
  let currentCount = 0;
  const queue: QueueEntry[] = [];

  function acquire(): Promise<void> {
    if (currentCount < max) {
      currentCount++;
      return Promise.resolve();
    }

    // 信号量已满，加入 FIFO 等待队列
    return new Promise<void>((resolve) => {
      queue.push({ resolve });
    });
  }

  function release(): void {
    if (queue.length > 0) {
      // FIFO: 从队列头部取出等待者
      const next = queue.shift()!;
      // 不减少 currentCount，因为信号量直接转移给下一个等待者
      next.resolve();
    } else {
      currentCount--;
      if (currentCount < 0) {
        currentCount = 0;
      }
    }
  }

  function setMaxConcurrency(newMax: number): void {
    if (!Number.isInteger(newMax) || newMax < 1) {
      return; // 忽略无效值
    }
    const oldMax = max;
    max = newMax;

    // 如果新上限大于旧上限，可能可以释放一些等待者
    if (newMax > oldMax) {
      while (queue.length > 0 && currentCount < max) {
        const next = queue.shift()!;
        currentCount++;
        next.resolve();
      }
    }
    // 如果新上限小于旧上限，不中断正在运行的任务
    // 只是后续 acquire 会等待直到 currentCount 降到新上限以下
  }

  function getMaxConcurrency(): number {
    return max;
  }

  function getCurrentCount(): number {
    return currentCount;
  }

  function getQueueLength(): number {
    return queue.length;
  }

  return {
    acquire,
    release,
    setMaxConcurrency,
    getMaxConcurrency,
    getCurrentCount,
    getQueueLength,
  };
}

// ---------------------------------------------------------------------------
// Environment Variable Parsing
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCURRENT_SEGMENTS = 3;
const MIN_CONCURRENT = 1;
const MAX_CONCURRENT = 16;

/**
 * 从环境变量 VIDEO_MAX_CONCURRENT_SEGMENTS 解析最大并发片段数
 * 无效值（非正整数或超出范围 1-16）使用默认值 3 并记录警告日志
 */
export function parseMaxConcurrentSegments(): number {
  const raw = process.env.VIDEO_MAX_CONCURRENT_SEGMENTS;
  if (raw === undefined || raw === '') {
    return DEFAULT_MAX_CONCURRENT_SEGMENTS;
  }

  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    isNaN(parsed) ||
    parsed < MIN_CONCURRENT ||
    parsed > MAX_CONCURRENT
  ) {
    console.warn(
      `[ConcurrencyController] Invalid VIDEO_MAX_CONCURRENT_SEGMENTS="${raw}" ` +
      `(must be integer in range ${MIN_CONCURRENT}-${MAX_CONCURRENT}). Using default: ${DEFAULT_MAX_CONCURRENT_SEGMENTS}`
    );
    return DEFAULT_MAX_CONCURRENT_SEGMENTS;
  }

  return parsed;
}

/**
 * 创建使用环境变量配置的并发控制器
 */
export function createDefaultConcurrencyController(): ConcurrencyController {
  const max = parseMaxConcurrentSegments();
  return createConcurrencyController(max);
}
