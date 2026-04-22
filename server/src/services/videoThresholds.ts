/**
 * 视频剪辑阈值配置 — 所有视频处理阈值的单一真相源
 *
 * 每个阈值支持 process.env 覆盖，遵循 dedupThresholds.ts 的 env() 模式。
 */

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const env = (key: string, def: number): number => {
  const v = process.env[key];
  return v !== undefined ? parseFloat(v) : def;
};

// ---------------------------------------------------------------------------
// VideoThresholds interface
// ---------------------------------------------------------------------------

export interface VideoThresholds {
  /** 严重模糊阈值（Sharpness_Score 下限） */
  severeBlurThreshold: number;
  /** 严重抖动阈值（Stability_Score 下限） */
  severeShakeThreshold: number;
  /** 严重曝光异常阈值（下限） */
  severeExposureLow: number;
  /** 严重曝光异常阈值（上限） */
  severeExposureHigh: number;
  /** 最小片段时长（秒） */
  minSegmentDuration: number;
  /** 短视频时长分档边界（秒） */
  shortVideoCutoff: number;
  /** 中等视频时长分档边界（秒） */
  mediumVideoCutoff: number;
  /** 中等视频目标时长（秒） */
  mediumTargetDuration: number;
  /** 长视频目标时长（秒） */
  longTargetDuration: number;
  /** 场景检测阈值 */
  sceneDetectThreshold: number;
  /** 默认过渡时长（秒） */
  defaultTransitionDuration: number;
  /** 相邻片段间隔阈值（秒） */
  adjacencyGapThreshold: number;
  /** 评分相近判定比例 */
  scoreProximityRatio: number;
  /** 切点前后动作缓冲时间（秒） */
  cutBufferDuration: number;
}

// ---------------------------------------------------------------------------
// Unified frozen config object
// ---------------------------------------------------------------------------

export const VIDEO_THRESHOLDS: Readonly<VideoThresholds> = Object.freeze({
  severeBlurThreshold:       env('VIDEO_SEVERE_BLUR', 20),
  severeShakeThreshold:      env('VIDEO_SEVERE_SHAKE', 15),
  severeExposureLow:         env('VIDEO_SEVERE_EXPOSURE_LOW', 10),
  severeExposureHigh:        env('VIDEO_SEVERE_EXPOSURE_HIGH', 100),
  minSegmentDuration:        env('VIDEO_MIN_SEGMENT_DURATION', 2),
  shortVideoCutoff:          env('VIDEO_SHORT_CUTOFF', 60),
  mediumVideoCutoff:         env('VIDEO_MEDIUM_CUTOFF', 600),
  mediumTargetDuration:      env('VIDEO_MEDIUM_TARGET', 60),
  longTargetDuration:        env('VIDEO_LONG_TARGET', 300),
  sceneDetectThreshold:      env('VIDEO_SCENE_THRESHOLD', 0.3),
  defaultTransitionDuration: env('VIDEO_TRANSITION_DURATION', 0.5),
  adjacencyGapThreshold:     env('VIDEO_ADJACENCY_GAP', 2),
  scoreProximityRatio:       env('VIDEO_SCORE_PROXIMITY', 0.1),
  cutBufferDuration:         env('VIDEO_CUT_BUFFER', 0.5),
});
