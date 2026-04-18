/**
 * 四层混合去重流水线 — 阈值常量单一真相源
 *
 * 所有去重阈值集中在此文件定义，Python 端通过 CLI 参数接收，不硬编码任何数值。
 */

/**
 * Layer 0: pHash 汉明距离 ≤ 4 且 dHash 汉明距离 ≤ 4 时直接确认重复。
 * 两者均为闭区间，含边界值 4（即距离恰好为 4 也算重复）。
 */
export const HASH_HAMMING_THRESHOLD = 4;

/**
 * Layer 1 tier 1: CLIP 余弦相似度 ≥ 0.94 → confirmed（直接确认重复）。
 * 闭下界：相似度恰好为 0.94 归入 confirmed。
 */
export const CLIP_CONFIRMED_THRESHOLD = 0.94;

/**
 * Layer 1 tier 2: 0.90 ≤ similarity < 0.94 → gray zone。
 * 左闭右开区间：相似度恰好为 0.90 归入 gray，恰好为 0.94 归入 confirmed。
 */
export const CLIP_GRAY_HIGH_THRESHOLD = 0.90;

/**
 * Layer 1 tier 3: 0.85 ≤ similarity < 0.90 + 额外条件 → gray zone。
 * 左闭右开区间：相似度恰好为 0.85 归入 gray（需满足条件），恰好为 0.90 归入上档 gray。
 */
export const CLIP_GRAY_LOW_THRESHOLD = 0.85;

/**
 * 无 LLM 回退阈值: similarity ≥ 0.955 → confirmed。
 * 闭下界：相似度恰好为 0.955 判定为重复。
 */
export const CLIP_STRICT_THRESHOLD = 0.955;

/** top-k 近邻搜索的 k 值。 */
export const CLIP_TOP_K = 15;

/**
 * [0.85, 0.90) 档序列位置差限制: abs(i-j) ≤ 12。
 * 闭区间：位置差恰好为 12 满足条件。
 */
export const GRAY_LOW_SEQ_DISTANCE = 12;

/**
 * [0.85, 0.90) 档哈希距离限制: pHash ≤ 16 或 dHash ≤ 16。
 * 闭区间：距离恰好为 16 满足条件。
 */
export const GRAY_LOW_HASH_DISTANCE = 16;

/**
 * 对一对图片的 CLIP 相似度进行三档分层分类。
 *
 * - similarity ≥ 0.94 → 'confirmed'
 * - 0.90 ≤ similarity < 0.94 → 'gray'
 * - 0.85 ≤ similarity < 0.90 且 abs(seqDistance) ≤ 12 且 (pHashDist ≤ 16 或 dHashDist ≤ 16) → 'gray'
 * - 否则 → 'skip'
 */
export function classifyClipPair(
  similarity: number,
  seqDistance: number,
  pHashDist: number,
  dHashDist: number,
): 'confirmed' | 'gray' | 'skip' {
  if (similarity >= CLIP_CONFIRMED_THRESHOLD) {
    return 'confirmed';
  }
  if (similarity >= CLIP_GRAY_HIGH_THRESHOLD) {
    return 'gray';
  }
  if (
    similarity >= CLIP_GRAY_LOW_THRESHOLD &&
    Math.abs(seqDistance) <= GRAY_LOW_SEQ_DISTANCE &&
    (pHashDist <= GRAY_LOW_HASH_DISTANCE || dHashDist <= GRAY_LOW_HASH_DISTANCE)
  ) {
    return 'gray';
  }
  return 'skip';
}

/**
 * 严格阈值回退判定：无 LLM 或所有 provider 均失败时使用。
 *
 * @returns `true` 当 similarity ≥ 0.955（确认重复），`false` 否则。
 */
export function applyStrictThreshold(similarity: number): boolean {
  return similarity >= CLIP_STRICT_THRESHOLD;
}
