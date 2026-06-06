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

/**
 * 解析范围受限的环境变量。当值不是有效数字或超出 [min, max] 范围时，
 * 使用默认值并在 stderr 输出警告日志。
 */
const envBounded = (key: string, def: number, min: number, max: number): number => {
  const v = process.env[key];
  if (v === undefined) return def;
  const parsed = parseFloat(v);
  if (isNaN(parsed) || parsed < min || parsed > max) {
    console.warn(
      `[dedupThresholds] Invalid ${key}="${v}" (must be a number in [${min}, ${max}]). Using default ${def}.`
    );
    return def;
  }
  return parsed;
};

/**
 * 解析正整数环境变量。当值不是有效正整数时，使用默认值并输出警告日志。
 */
const envPositiveInt = (key: string, def: number): number => {
  const v = process.env[key];
  if (v === undefined) return def;
  const parsed = parseInt(v, 10);
  if (isNaN(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    console.warn(
      `[dedupThresholds] Invalid ${key}="${v}" (must be a positive integer). Using default ${def}.`
    );
    return def;
  }
  return parsed;
};

/**
 * 解析正数环境变量（允许浮点数）。当值不是有效正数时，使用默认值并输出警告日志。
 */
const envPositiveNumber = (key: string, def: number): number => {
  const v = process.env[key];
  if (v === undefined) return def;
  const parsed = parseFloat(v);
  if (isNaN(parsed) || parsed <= 0) {
    console.warn(
      `[dedupThresholds] Invalid ${key}="${v}" (must be a positive number). Using default ${def}.`
    );
    return def;
  }
  return parsed;
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
  clipStrictThreshold: number;
  clipTopK: number;
  grayLowSeqDistance: number;
  grayLowHashDistance: number;

  // Overexposure thresholds
  overexposureGlobalRatio: number;                 // default 0.40
  overexposureSubjectVThreshold: number;           // default 245
  overexposureSubjectSThreshold: number;           // default 45
  overexposureSubjectMinAreaRatio: number;         // default 0.006
  overexposureSubjectMaxAreaRatio: number;         // default 0.015
  overexposureSubjectSevereTotalAreaRatio: number; // default 0.012
  overexposureMinComponentPixels: number;          // default 300
  overexposureTextureGradientThreshold: number;    // default 5.0

  // DINOv2 (global similarity — used with 384-dim DINOv2-small vectors)
  dinov2ConfirmedThreshold: number;                // default 0.88
  dinov2GrayLowThreshold: number;                  // default 0.75
  dinov2DedupThreshold: number;                    // default 0.82

  // CLIP (legacy hybrid dedup — used with 512-dim CLIP vectors)
  clipConfirmedThreshold: number;                  // default 0.93
  clipGrayHighThreshold: number;                   // default 0.90
  clipGrayLowThreshold: number;                    // default 0.86

  // Global similarity
  globalSimilarityTopK: number;                    // default 10
}

// ---------------------------------------------------------------------------
// Unified frozen config object
// ---------------------------------------------------------------------------

export const PROCESS_THRESHOLDS: Readonly<ProcessThresholds> = Object.freeze({
  // Blur
  blurThreshold:          env('BLUR_THRESHOLD', 15),
  clearThreshold:         env('CLEAR_THRESHOLD', 50),
  musiqBlurThreshold:     env('MUSIQ_BLUR_THRESHOLD', 25),

  // Dedup (hash / structural)
  hashHammingThreshold:   env('HASH_HAMMING_THRESHOLD', 4),
  clipStrictThreshold:    envBounded('CLIP_STRICT_THRESHOLD', 0.92, 0, 1),
  clipTopK:               env('CLIP_TOP_K', 50),
  grayLowSeqDistance:     env('GRAY_LOW_SEQ_DISTANCE', 6),
  grayLowHashDistance:    env('GRAY_LOW_HASH_DISTANCE', 8),

  // Overexposure
  overexposureGlobalRatio:                envBounded('OVEREXPOSURE_GLOBAL_RATIO', 0.40, 0, 1),
  overexposureSubjectVThreshold:          envPositiveInt('OVEREXPOSURE_SUBJECT_V_THRESHOLD', 245),
  overexposureSubjectSThreshold:          envPositiveInt('OVEREXPOSURE_SUBJECT_S_THRESHOLD', 45),
  overexposureSubjectMinAreaRatio:        envBounded('OVEREXPOSURE_SUBJECT_MIN_AREA_RATIO', 0.006, 0, 1),
  overexposureSubjectMaxAreaRatio:        envBounded('OVEREXPOSURE_SUBJECT_MAX_AREA_RATIO', 0.015, 0, 1),
  overexposureSubjectSevereTotalAreaRatio: envBounded('OVEREXPOSURE_SUBJECT_SEVERE_TOTAL_AREA_RATIO', 0.012, 0, 1),
  overexposureMinComponentPixels:         envPositiveInt('OVEREXPOSURE_MIN_COMPONENT_PIXELS', 300),
  overexposureTextureGradientThreshold:   envPositiveNumber('OVEREXPOSURE_TEXTURE_GRADIENT_THRESHOLD', 5.0),

  // DINOv2 (global similarity — used with 384-dim DINOv2-small vectors)
  dinov2ConfirmedThreshold: envBounded('DINOV2_CONFIRMED_THRESHOLD', 0.88, 0, 1),
  dinov2GrayLowThreshold:   envBounded('DINOV2_GRAY_LOW_THRESHOLD', 0.75, 0, 1),
  dinov2DedupThreshold:     envBounded('DINOV2_DEDUP_THRESHOLD', 0.82, 0, 1),

  // CLIP (legacy hybrid dedup — used with 512-dim CLIP vectors)
  clipConfirmedThreshold: envBounded('CLIP_CONFIRMED_THRESHOLD', 0.93, 0, 1),
  clipGrayHighThreshold:  envBounded('CLIP_GRAY_HIGH_THRESHOLD', 0.90, 0, 1),
  clipGrayLowThreshold:   envBounded('CLIP_GRAY_LOW_THRESHOLD', 0.86, 0, 1),

  // Global similarity
  globalSimilarityTopK:   envPositiveInt('GLOBAL_SIMILARITY_TOP_K', 10),
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
