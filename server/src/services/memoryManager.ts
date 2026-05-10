/**
 * MemoryManager — 进程内存监控、压力等级计算、降级策略执行
 *
 * 核心职责：
 * - 监控进程 RSS 内存使用
 * - 计算内存压力等级（normal / warning / critical）
 * - 提供降级参数（帧采样数、最大并发数）
 * - 阶段间阻塞等待（critical 时轮询等待恢复）
 * - 任务暂停/恢复控制
 * - critical 超时后触发 GC 和任务取消
 * - 输出 MemorySummary（峰值 RSS、各阶段平均 RSS、GC 触发次数、跳过视频列表）
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryPressureLevel = 'normal' | 'warning' | 'critical';

export interface MemoryManagerConfig {
  memoryLimitMB: number;       // 默认 1024，范围 128-65536
  warningRatio: number;        // 默认 0.7，范围 0.1-0.9
  criticalRatio: number;       // 默认 0.85，范围 0.2-0.99，必须 > warningRatio
  checkIntervalMs: number;     // 默认 5000
  debounceDurationMs: number;  // 默认 5000（防抖）
}

export interface MemoryStatus {
  rssBytes: number;
  rssMB: number;
  pressureLevel: MemoryPressureLevel;
  limitMB: number;
  usageRatio: number;
}

export interface MemorySummary {
  peakRssMB: number;
  avgRssMBByStage: Record<string, number>;
  gcTriggerCount: number;
  skippedVideos: Array<{ mediaId: string; stage: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

const DEFAULTS: MemoryManagerConfig = {
  memoryLimitMB: 1024,
  warningRatio: 0.7,
  criticalRatio: 0.85,
  checkIntervalMs: 5000,
  debounceDurationMs: 5000,
};

/**
 * Parse a numeric environment variable with range validation.
 * Returns the default if the value is invalid or out of range.
 */
function parseEnvNumber(
  envValue: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (envValue === undefined || envValue === '') return defaultValue;
  const parsed = parseFloat(envValue);
  if (isNaN(parsed) || parsed < min || parsed > max) return defaultValue;
  return parsed;
}

/**
 * Parse MemoryManagerConfig from environment variables with validation.
 * Invalid values fall back to defaults. criticalRatio must be > warningRatio.
 */
export function parseMemoryManagerConfig(): MemoryManagerConfig {
  const memoryLimitMB = parseEnvNumber(
    process.env.VIDEO_MEMORY_LIMIT_MB,
    DEFAULTS.memoryLimitMB,
    128,
    65536,
  );

  const warningRatio = parseEnvNumber(
    process.env.VIDEO_MEMORY_WARNING_RATIO,
    DEFAULTS.warningRatio,
    0.1,
    0.9,
  );

  let criticalRatio = parseEnvNumber(
    process.env.VIDEO_MEMORY_CRITICAL_RATIO,
    DEFAULTS.criticalRatio,
    0.2,
    0.99,
  );

  // criticalRatio must be > warningRatio; if not, fall back to default
  if (criticalRatio <= warningRatio) {
    criticalRatio = DEFAULTS.criticalRatio;
    // If default is also not > warningRatio (edge case with custom warningRatio),
    // ensure criticalRatio is at least warningRatio + 0.01
    if (criticalRatio <= warningRatio) {
      criticalRatio = Math.min(warningRatio + 0.1, 0.99);
    }
  }

  return {
    memoryLimitMB,
    warningRatio,
    criticalRatio,
    checkIntervalMs: DEFAULTS.checkIntervalMs,
    debounceDurationMs: DEFAULTS.debounceDurationMs,
  };
}

// ---------------------------------------------------------------------------
// Pressure level calculation (pure function)
// ---------------------------------------------------------------------------

/**
 * Calculate the memory pressure level based on RSS and config thresholds.
 * This is a pure function for easy testing.
 */
export function calculatePressureLevel(
  rssMB: number,
  config: MemoryManagerConfig,
): MemoryPressureLevel {
  const warningThresholdMB = config.memoryLimitMB * config.warningRatio;
  const criticalThresholdMB = config.memoryLimitMB * config.criticalRatio;

  if (rssMB >= criticalThresholdMB) return 'critical';
  if (rssMB >= warningThresholdMB) return 'warning';
  return 'normal';
}

// ---------------------------------------------------------------------------
// MemoryManager implementation
// ---------------------------------------------------------------------------

export interface MemoryManager {
  getConfig(): MemoryManagerConfig;
  getCurrentStatus(): MemoryStatus;
  getPressureLevel(): MemoryPressureLevel;
  getRssMB(): number;
  startMonitoring(): void;
  stopMonitoring(): MemorySummary;
  checkBetweenStages(stage: string): Promise<void>;
  getFrameSampleCount(defaultCount: number): number;
  getMaxConcurrency(configuredMax: number): number;
  shouldPauseTasks(): boolean;
  waitForRecovery(timeoutMs: number): Promise<boolean>;
  recordSkippedVideo(mediaId: string, stage: string, reason: string): void;
  notifyTaskCompleted(): void;
}

interface StageRecord {
  samples: number[];
}

interface DebounceState {
  pendingLevel: MemoryPressureLevel | null;
  pendingSince: number | null;
}

export function createMemoryManager(
  configOverride?: Partial<MemoryManagerConfig>,
  /** For testing: override the RSS reading function */
  getRssOverride?: () => number,
): MemoryManager {
  const config: MemoryManagerConfig = {
    ...parseMemoryManagerConfig(),
    ...configOverride,
  };

  // State
  let currentLevel: MemoryPressureLevel = 'normal';
  let monitoringTimer: ReturnType<typeof setInterval> | null = null;
  let isMonitoring = false;

  // Debounce state
  const debounce: DebounceState = {
    pendingLevel: null,
    pendingSince: null,
  };

  // Summary tracking
  let peakRssMB = 0;
  const stageRecords: Record<string, StageRecord> = {};
  let gcTriggerCount = 0;
  const skippedVideos: Array<{ mediaId: string; stage: string; reason: string }> = [];
  let currentStage = '';

  // Critical timeout tracking
  let criticalSince: number | null = null;
  let lastTaskCompletionTime: number | null = null;
  let gcTriggeredForCurrentCritical = false;
  let tasksCancelled = false;

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  function getRssMB(): number {
    if (getRssOverride) return getRssOverride();
    return process.memoryUsage().rss / (1024 * 1024);
  }

  function getRssBytes(): number {
    if (getRssOverride) return getRssOverride() * 1024 * 1024;
    return process.memoryUsage().rss;
  }

  function recordRss(rssMB: number): void {
    if (rssMB > peakRssMB) peakRssMB = rssMB;
    if (currentStage) {
      if (!stageRecords[currentStage]) {
        stageRecords[currentStage] = { samples: [] };
      }
      stageRecords[currentStage].samples.push(rssMB);
    }
  }

  function computeRawLevel(rssMB: number): MemoryPressureLevel {
    return calculatePressureLevel(rssMB, config);
  }

  /**
   * Apply debounce logic for level transitions.
   * - Critical transitions are immediate (no debounce needed for entering critical)
   * - Recovery from critical is immediate
   * - Transitions between normal and warning require 5s debounce
   */
  function applyDebounce(rawLevel: MemoryPressureLevel, now: number): MemoryPressureLevel {
    // If raw level equals current level, clear any pending transition
    if (rawLevel === currentLevel) {
      debounce.pendingLevel = null;
      debounce.pendingSince = null;
      return currentLevel;
    }

    // Entering critical: immediate (no debounce)
    if (rawLevel === 'critical') {
      debounce.pendingLevel = null;
      debounce.pendingSince = null;
      return 'critical';
    }

    // Recovery from critical: immediate (no debounce)
    if (currentLevel === 'critical') {
      debounce.pendingLevel = null;
      debounce.pendingSince = null;
      return rawLevel;
    }

    // Transitions between normal and warning: require debounce
    if (debounce.pendingLevel === rawLevel && debounce.pendingSince !== null) {
      if (now - debounce.pendingSince >= config.debounceDurationMs) {
        // Debounce period elapsed, commit the transition
        debounce.pendingLevel = null;
        debounce.pendingSince = null;
        return rawLevel;
      }
      // Still waiting
      return currentLevel;
    }

    // Start new debounce period
    debounce.pendingLevel = rawLevel;
    debounce.pendingSince = now;
    return currentLevel;
  }

  function updateLevel(): void {
    const rssMB_val = getRssMB();
    recordRss(rssMB_val);

    const rawLevel = computeRawLevel(rssMB_val);
    const now = Date.now();
    const newLevel = applyDebounce(rawLevel, now);

    if (newLevel !== currentLevel) {
      const prevLevel = currentLevel;
      currentLevel = newLevel;

      // Log level change
      console.log(
        `[MemoryManager] Pressure level changed: ${prevLevel} → ${newLevel} (RSS: ${rssMB_val.toFixed(1)} MB)`,
      );

      // Track critical state
      if (newLevel === 'critical') {
        criticalSince = now;
        gcTriggeredForCurrentCritical = false;
        tasksCancelled = false;
      } else {
        criticalSince = null;
        gcTriggeredForCurrentCritical = false;
        tasksCancelled = false;
      }
    }

    // Handle critical timeout logic
    if (currentLevel === 'critical' && criticalSince !== null) {
      const criticalDuration = now - criticalSince;
      const noTaskCompletion =
        lastTaskCompletionTime === null || lastTaskCompletionTime < criticalSince;

      // After 30s critical with no task completion: trigger GC
      if (criticalDuration >= 30000 && noTaskCompletion && !gcTriggeredForCurrentCritical) {
        gcTriggeredForCurrentCritical = true;
        gcTriggerCount++;
        console.warn(
          `[MemoryManager] Critical for ${(criticalDuration / 1000).toFixed(0)}s with no task completion. Triggering global.gc(). RSS: ${rssMB_val.toFixed(1)} MB`,
        );
        if (typeof global.gc === 'function') {
          global.gc();
        }
      }

      // After GC + 10s still critical: cancel tasks
      if (
        gcTriggeredForCurrentCritical &&
        !tasksCancelled &&
        criticalDuration >= 40000 &&
        noTaskCompletion
      ) {
        tasksCancelled = true;
        console.error(
          `[MemoryManager] Still critical after GC + 10s. Cancelling all pending tasks. RSS: ${rssMB_val.toFixed(1)} MB`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const manager: MemoryManager = {
    getConfig(): MemoryManagerConfig {
      return { ...config };
    },

    getCurrentStatus(): MemoryStatus {
      const rssBytes = getRssBytes();
      const rssMB_val = rssBytes / (1024 * 1024);
      return {
        rssBytes,
        rssMB: rssMB_val,
        pressureLevel: currentLevel,
        limitMB: config.memoryLimitMB,
        usageRatio: rssMB_val / config.memoryLimitMB,
      };
    },

    getPressureLevel(): MemoryPressureLevel {
      return currentLevel;
    },

    getRssMB(): number {
      return getRssMB();
    },

    startMonitoring(): void {
      if (isMonitoring) return;
      isMonitoring = true;
      peakRssMB = 0;
      // Clear stage records
      Object.keys(stageRecords).forEach((k) => delete stageRecords[k]);
      gcTriggerCount = 0;
      skippedVideos.length = 0;
      criticalSince = null;
      lastTaskCompletionTime = null;
      gcTriggeredForCurrentCritical = false;
      tasksCancelled = false;

      // Initial check
      updateLevel();

      // Start periodic monitoring
      monitoringTimer = setInterval(() => {
        updateLevel();
      }, config.checkIntervalMs);
    },

    stopMonitoring(): MemorySummary {
      if (monitoringTimer !== null) {
        clearInterval(monitoringTimer);
        monitoringTimer = null;
      }
      isMonitoring = false;

      // Compute average RSS by stage
      const avgRssMBByStage: Record<string, number> = {};
      for (const [stage, record] of Object.entries(stageRecords)) {
        if (record.samples.length > 0) {
          const sum = record.samples.reduce((a, b) => a + b, 0);
          avgRssMBByStage[stage] = Math.round((sum / record.samples.length) * 100) / 100;
        }
      }

      const summary: MemorySummary = {
        peakRssMB: Math.round(peakRssMB * 100) / 100,
        avgRssMBByStage,
        gcTriggerCount,
        skippedVideos: [...skippedVideos],
      };

      console.log('[MemoryManager] Memory summary:', JSON.stringify(summary, null, 2));
      return summary;
    },

    async checkBetweenStages(stage: string): Promise<void> {
      currentStage = stage;
      const rssMB_val = getRssMB();
      recordRss(rssMB_val);

      // Update level immediately
      updateLevel();

      if (currentLevel !== 'critical') return;

      // Poll every 5s, wait up to 60s for recovery
      const maxWaitMs = 60000;
      const pollIntervalMs = 5000;
      const startTime = Date.now();

      while (currentLevel === 'critical') {
        const elapsed = Date.now() - startTime;
        if (elapsed >= maxWaitMs) {
          const errorMsg = `Memory pressure critical for ${(elapsed / 1000).toFixed(0)}s during stage "${stage}". RSS: ${getRssMB().toFixed(1)} MB. Skipping.`;
          console.error(`[MemoryManager] ${errorMsg}`);
          throw new Error(errorMsg);
        }

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        updateLevel();
      }
    },

    getFrameSampleCount(defaultCount: number): number {
      if (currentLevel === 'warning') return 3;
      return defaultCount;
    },

    getMaxConcurrency(configuredMax: number): number {
      if (currentLevel === 'warning') return 1;
      if (currentLevel === 'critical') return 0;
      return configuredMax;
    },

    shouldPauseTasks(): boolean {
      return currentLevel === 'critical' || tasksCancelled;
    },

    async waitForRecovery(timeoutMs: number): Promise<boolean> {
      if (currentLevel !== 'critical') return true;

      const startTime = Date.now();
      const pollIntervalMs = 5000;

      while (currentLevel === 'critical') {
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeoutMs) {
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        updateLevel();
      }

      return true;
    },

    recordSkippedVideo(mediaId: string, stage: string, reason: string): void {
      skippedVideos.push({ mediaId, stage, reason });
    },

    notifyTaskCompleted(): void {
      lastTaskCompletionTime = Date.now();
    },
  };

  return manager;
}

// ---------------------------------------------------------------------------
// Singleton instance (lazy)
// ---------------------------------------------------------------------------

let defaultInstance: MemoryManager | null = null;

export function getMemoryManager(): MemoryManager {
  if (!defaultInstance) {
    defaultInstance = createMemoryManager();
  }
  return defaultInstance;
}

/**
 * Reset the singleton instance (for testing).
 */
export function resetMemoryManager(): void {
  if (defaultInstance) {
    defaultInstance.stopMonitoring();
  }
  defaultInstance = null;
}
