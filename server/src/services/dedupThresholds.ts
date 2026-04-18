/**
 * 统一阈值配置 — 所有处理阈值的单一真相源
 *
 * 每个阈值支持 process.env 覆盖，Python 端通过 CLI 参数接收，不硬编码任何数值。
 */

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const env = (key: string, def: number): number => {
  const v = process.env[key];
  return v !== undefined ? parseFloat(v) : def;
};

// ---------------------------------------------------------------------------
// ProcessThresholds interface
// ---------------------------------------------------------------------------

export interface ProcessThresholds {
  // Blur thresholds
  blurThreshold: number;
  clearThreshold: number;
  musiqBlurThreshold: number;
  // Dedup thresholds
  hashHammingThreshold: number;
  clipConfirmedThreshold: number;
  clipGrayHighThreshold: number;
  clipGrayLowThreshold: number;
  clipStrictThreshold: number;
  clipTopK: number;
  grayLowSeqDistance: number;
  grayLowHashDistance: number;
  // DINOv2 threshold
  dinov2DedupThreshold: number;
}

// ---------------------------------------------------------------------------
// Unified frozen config object
// ---------------------------------------------------------------------------

export const PROCESS_THRESHOLDS: Readonly<ProcessThresholds> = Object.freeze({
  blurThreshold:          env('BLUR_THRESHOLD', 15),
  clearThreshold:         env('CLEAR_THRESHOLD', 50),
  musiqBlurThreshold:     env('MUSIQ_BLUR_THRESHOLD', 30),
  hashHammingThreshold:   env('HASH_HAMMING_THRESHOLD', 4),
  clipConfirmedThreshold: env('CLIP_CONFIRMED_THRESHOLD', 0.90),
  clipGrayHighThreshold:  env('CLIP_GRAY_HIGH_THRESHOLD', 0.85),
  clipGrayLowThreshold:   env('CLIP_GRAY_LOW_THRESHOLD', 0.80),
  clipStrictThreshold:    env('CLIP_STRICT_THRESHOLD', 0.92),
  clipTopK:               env('CLIP_TOP_K', 15),
  grayLowSeqDistance:     env('GRAY_LOW_SEQ_DISTANCE', 12),
  grayLowHashDistance:    env('GRAY_LOW_HASH_DISTANCE', 16),
  dinov2DedupThreshold:   env('DINOV2_DEDUP_THRESHOLD', 0.80),
});

// ---------------------------------------------------------------------------
// Legacy named exports (backward compatibility)
// ---------------------------------------------------------------------------

/** @deprecated Use PROCESS_THRESHOLDS.hashHammingThreshold */
export const HASH_HAMMING_THRESHOLD = PROCESS_THRESHOLDS.hashHammingThreshold;

/** @deprecated Use PROCESS_THRESHOLDS.clipConfirmedThreshold */
export const CLIP_CONFIRMED_THRESHOLD = PROCESS_THRESHOLDS.clipConfirmedThreshold;

/** @deprecated Use PROCESS_THRESHOLDS.clipGrayHighThreshold */
export const CLIP_GRAY_HIGH_THRESHOLD = PROCESS_THRESHOLDS.clipGrayHighThreshold;

/** @deprecated Use PROCESS_THRESHOLDS.clipGrayLowThreshold */
export const CLIP_GRAY_LOW_THRESHOLD = PROCESS_THRESHOLDS.clipGrayLowThreshold;

/** @deprecated Use PROCESS_THRESHOLDS.clipStrictThreshold */
export const CLIP_STRICT_THRESHOLD = PROCESS_THRESHOLDS.clipStrictThreshold;

/** @deprecated Use PROCESS_THRESHOLDS.clipTopK */
export const CLIP_TOP_K = PROCESS_THRESHOLDS.clipTopK;

/** @deprecated Use PROCESS_THRESHOLDS.grayLowSeqDistance */
export const GRAY_LOW_SEQ_DISTANCE = PROCESS_THRESHOLDS.grayLowSeqDistance;

/** @deprecated Use PROCESS_THRESHOLDS.grayLowHashDistance */
export const GRAY_LOW_HASH_DISTANCE = PROCESS_THRESHOLDS.grayLowHashDistance;

// ---------------------------------------------------------------------------
// Classification & strict-threshold helpers (read from PROCESS_THRESHOLDS)
// ---------------------------------------------------------------------------

/**
 * 对一对图片的 CLIP 相似度进行三档分层分类。
 *
 * - similarity ≥ confirmed → 'confirmed'
 * - grayHigh ≤ similarity < confirmed → 'gray'
 * - grayLow ≤ similarity < grayHigh 且 abs(seqDistance) ≤ limit 且 hash ≤ limit → 'gray'
 * - 否则 → 'skip'
 */
export function classifyClipPair(
  similarity: number,
  seqDistance: number,
  pHashDist: number,
  dHashDist: number,
): 'confirmed' | 'gray' | 'skip' {
  if (similarity >= PROCESS_THRESHOLDS.clipConfirmedThreshold) {
    return 'confirmed';
  }
  if (similarity >= PROCESS_THRESHOLDS.clipGrayHighThreshold) {
    return 'gray';
  }
  if (
    similarity >= PROCESS_THRESHOLDS.clipGrayLowThreshold &&
    Math.abs(seqDistance) <= PROCESS_THRESHOLDS.grayLowSeqDistance &&
    (pHashDist <= PROCESS_THRESHOLDS.grayLowHashDistance || dHashDist <= PROCESS_THRESHOLDS.grayLowHashDistance)
  ) {
    return 'gray';
  }
  return 'skip';
}

/**
 * 严格阈值回退判定：无 LLM 或所有 provider 均失败时使用。
 *
 * @returns `true` 当 similarity ≥ clipStrictThreshold（确认重复），`false` 否则。
 */
export function applyStrictThreshold(similarity: number): boolean {
  return similarity >= PROCESS_THRESHOLDS.clipStrictThreshold;
}
