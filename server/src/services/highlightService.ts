/**
 * Highlight Service — AI 照片精华挑选与相似组识别
 *
 * 核心编排服务：将技术合格照片分批发送给视觉大模型，从构图美感、独特瞬间、
 * 故事性、多样性等维度评选约 30-40% 的精华照片，并识别相似照片组。
 *
 * 本文件目前包含接口定义、分批工具函数（createBatches）以及单个 batch 的
 * 视觉大模型调用与 provider 级联（evaluateBatch）。其余功能（持久化、
 * 查询、整体编排）将在后续任务中实现。
 */

// ---------------------------------------------------------------------------
// Types / Interfaces
// ---------------------------------------------------------------------------

/**
 * 一次完整精华评估的汇总结果。
 */
export interface HighlightEvaluation {
  tripId: string;
  totalPhotos: number;
  highlightCount: number;
  similarGroupCount: number;
  batchesProcessed: number;
  batchesFailed: number;
  /** 实际使用的（最后一个成功的）provider 标识 */
  usedProvider?: string;
  /** Number of photos trashed by the post-VLM global survivor dedup stage */
  globalSimilarityAfterVlmDeletedCount?: number;
}

/**
 * 单张照片的精华评估持久化记录。
 */
export interface HighlightPhoto {
  photoId: string;
  tripId: string;
  isHighlight: boolean;
  /** 精华原因，最多 100 字符 */
  reason: string;
  evaluatedAt: string;
}

/**
 * 一组相似照片及其推荐的最佳照片。
 */
export interface SimilarGroup {
  groupId: string;
  tripId: string;
  memberPhotoIds: string[];
  bestPhotoId: string;
  evaluatedAt: string;
}

/**
 * 单个 batch 经 LLM 评估并解析后的结果。
 */
export interface BatchResult {
  highlights: Array<{ photoId: string; reason: string }>;
  similarGroups: Array<{ memberIds: string[]; bestId: string }>;
  overexposedIds: string[];
}

/**
 * 触发评估时可选的回调与参数。
 */
export interface HighlightServiceOptions {
  /**
   * 进度回调：在每个 batch 处理后调用。
   * @param batchIndex 已处理的 batch 索引（从 1 开始计数更直观，调用者自行决定）
   * @param totalBatches 该次评估的 batch 总数
   */
  onProgress?: (batchIndex: number, totalBatches: number) => void;
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

/**
 * 单张照片在 batch 中的最小信息载体。
 */
export interface BatchablePhoto {
  id: string;
  filePath: string;
}

/**
 * 将照片列表切分为 LLM 评估用的 batch。
 *
 * - 默认 batch 大小为 6，允许范围 4-8。
 * - 若末尾 batch 少于 4 张，则与前一个 batch 合并以避免 LLM 评估上下文过小。
 * - 当输入列表本身就少于 batchSize 时，直接返回单个 batch（即使其大小 < 4）。
 *
 * @param photos 待分批的照片列表
 * @param batchSize 每批照片数量，默认 6
 * @returns 分批后的照片二维数组
 */
export function createBatches<T extends BatchablePhoto>(
  photos: T[],
  batchSize: number = 6,
): T[][] {
  if (!Array.isArray(photos) || photos.length === 0) {
    return [];
  }

  // 限制 batchSize 在合理范围 [4, 8]
  const size = Math.max(4, Math.min(8, Math.floor(batchSize)));

  const batches: T[][] = [];
  for (let i = 0; i < photos.length; i += size) {
    batches.push(photos.slice(i, i + size));
  }

  // 若末尾 batch 少于 4 张，则与前一个 batch 合并
  if (batches.length > 1 && batches[batches.length - 1].length < 4) {
    const last = batches.pop()!;
    batches[batches.length - 1].push(...last);
  }

  return batches;
}

// ---------------------------------------------------------------------------
// Provider cascade & batch evaluation
// ---------------------------------------------------------------------------

import {
  detectConfiguredProviders,
  ProviderConfig,
  LLMProviderType,
} from './llmPairReviewer';
import { resizeForAnalysis, extractJSON } from './bedrockClient';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';

// Re-export so callers don't need to reach into llmPairReviewer for the helper.
export { detectConfiguredProviders };

/**
 * 一次发送给视觉大模型的 batch 评审 prompt。
 *
 * 该 prompt 要求 LLM 完成两件事：
 *   1) 选出约 30%-40% 的精华照片（构图美感、独特瞬间、故事性、多样性）。
 *   2) 识别相似照片组并在每组中推荐一张最佳。
 *
 * 索引（index）为照片在 batch 中的 0-based 位置。
 */
export const HIGHLIGHT_BATCH_PROMPT = `You are a professional travel photography curator. Evaluate these photos as a batch.

Your tasks:
1. SELECT HIGHLIGHTS: Choose the best photos (approximately 30-40% of the batch) based on:
   - Composition aesthetics (rule of thirds, leading lines, framing)
   - Unique moments (candid expressions, rare wildlife behavior, dramatic lighting)
   - Storytelling value (captures the essence of the travel experience)
   - Diversity (prefer variety in subjects and scenes over similar shots)

2. IDENTIFY SIMILAR GROUPS: Find photos that are visually similar (same scene, same angle, burst shots, minor variations). For each group, recommend the single best photo.

3. IDENTIFY OVEREXPOSED PHOTOS: Mark photos where the MAIN SUBJECT has blown highlights or overexposure (washed out details, white/bright areas on the subject that should have detail). Background overexposure (e.g. bright sky) is acceptable if the subject is well-exposed.

Return ONLY a JSON object in this exact format:
{
  "highlights": [
    {"index": 0, "reason": "Stunning golden hour composition with leading lines"},
    {"index": 2, "reason": "Rare candid moment capturing genuine emotion"}
  ],
  "similar_groups": [
    {"indices": [1, 3, 4], "best_index": 3}
  ],
  "overexposed": [5, 6]
}

Rules:
- "index" refers to the 0-based position of the photo in this batch
- "reason" must be concise (max 100 characters) explaining why the photo is a highlight
- A photo can be both a highlight AND part of a similar group
- If no similar groups exist, return an empty array for "similar_groups"
- "overexposed" is an array of indices where the main subject has blown highlights. Empty array if none.
- Do NOT select overexposed photos as highlights
- Select approximately 30-40% of photos as highlights`;

/**
 * LLM 返回的原始 batch 响应结构（基于 0-based 索引）。
 */
interface RawBatchResponse {
  highlights?: Array<{ index: number; reason?: string }>;
  similar_groups?: Array<{ indices: number[]; best_index: number }>;
  overexposed?: number[];
}

/**
 * 校验 LLM 返回的对象结构是否符合 RawBatchResponse 的最低要求。
 * 不通过校验时抛错，由调用方根据错误触发重试或级联。
 */
function validateRawBatchResponse(raw: unknown): RawBatchResponse {
  if (!raw || typeof raw !== 'object') {
    throw new Error('LLM response is not a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const highlights = obj.highlights;
  if (highlights !== undefined && !Array.isArray(highlights)) {
    throw new Error('"highlights" field must be an array');
  }
  if (Array.isArray(highlights)) {
    for (const h of highlights) {
      if (!h || typeof h !== 'object') {
        throw new Error('Each highlight entry must be an object');
      }
      const entry = h as Record<string, unknown>;
      if (typeof entry.index !== 'number' || !Number.isInteger(entry.index)) {
        throw new Error('Highlight "index" must be an integer');
      }
      if (entry.reason !== undefined && typeof entry.reason !== 'string') {
        throw new Error('Highlight "reason" must be a string when present');
      }
    }
  }

  const similar = obj.similar_groups;
  if (similar !== undefined && !Array.isArray(similar)) {
    throw new Error('"similar_groups" field must be an array');
  }
  if (Array.isArray(similar)) {
    for (const g of similar) {
      if (!g || typeof g !== 'object') {
        throw new Error('Each similar_groups entry must be an object');
      }
      const grp = g as Record<string, unknown>;
      if (!Array.isArray(grp.indices) || !grp.indices.every((i) => Number.isInteger(i))) {
        throw new Error('Similar group "indices" must be an array of integers');
      }
      if (typeof grp.best_index !== 'number' || !Number.isInteger(grp.best_index)) {
        throw new Error('Similar group "best_index" must be an integer');
      }
    }
  }

  return obj as RawBatchResponse;
}

/**
 * 把 LLM 返回的（基于 batch 内索引的）原始结果映射回真实 photo id 的 BatchResult。
 *
 * - 越界索引会被忽略并打印 warning。
 * - 相似组成员若过滤后 < 2 张，则丢弃整个组。
 * - 推荐最佳照片若不在组成员中，则回退为组成员的第一张。
 */
function mapRawToBatchResult(
  raw: RawBatchResponse,
  photos: BatchablePhoto[],
): BatchResult {
  const highlights: BatchResult['highlights'] = [];
  for (const h of raw.highlights ?? []) {
    if (h.index < 0 || h.index >= photos.length) {
      console.warn(
        `[highlightService] LLM returned out-of-range highlight index ${h.index} (batch size ${photos.length})`,
      );
      continue;
    }
    highlights.push({
      photoId: photos[h.index].id,
      reason: typeof h.reason === 'string' ? h.reason : '',
    });
  }

  const similarGroups: BatchResult['similarGroups'] = [];
  for (const g of raw.similar_groups ?? []) {
    const memberIds: string[] = [];
    for (const idx of g.indices) {
      if (idx < 0 || idx >= photos.length) {
        console.warn(
          `[highlightService] LLM returned out-of-range similar-group index ${idx} (batch size ${photos.length})`,
        );
        continue;
      }
      const id = photos[idx].id;
      if (!memberIds.includes(id)) memberIds.push(id);
    }
    if (memberIds.length < 2) {
      // A group with fewer than 2 valid members is meaningless; skip it.
      continue;
    }

    let bestId: string;
    if (
      g.best_index >= 0 &&
      g.best_index < photos.length &&
      memberIds.includes(photos[g.best_index].id)
    ) {
      bestId = photos[g.best_index].id;
    } else {
      console.warn(
        `[highlightService] LLM best_index ${g.best_index} not in group members; falling back to first member`,
      );
      bestId = memberIds[0];
    }

    similarGroups.push({ memberIds, bestId });
  }

  // Extract overexposed photo IDs
  const overexposedIds: string[] = [];
  if (Array.isArray(raw.overexposed)) {
    for (const idx of raw.overexposed) {
      if (typeof idx === 'number' && idx >= 0 && idx < photos.length) {
        overexposedIds.push(photos[idx].id);
      }
    }
  }

  return { highlights, similarGroups, overexposedIds };
}

/**
 * 调用单个 provider 评估一个 batch；解析失败/响应非法时抛错给调用方处理。
 */
async function invokeProviderForBatch(
  provider: ProviderConfig,
  images: Array<{ base64: string; mediaType: 'image/jpeg' }>,
  photos: BatchablePhoto[],
): Promise<BatchResult> {
  const responseText = await provider.client.invokeModel({
    images,
    prompt: HIGHLIGHT_BATCH_PROMPT,
    maxTokens: 2048,
  });
  const raw = extractJSON<unknown>(responseText);
  const validated = validateRawBatchResponse(raw);
  return mapRawToBatchResult(validated, photos);
}

/**
 * 判断一个 provider 抛出的错误是否属于"无效/不可解析的响应"
 * （需要进行单次重试）。其他错误（网络 / 鉴权 / 限流）直接级联到下一个 provider。
 */
function isInvalidResponseError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message || '';
  return (
    msg.startsWith('Failed to extract JSON') ||
    msg.includes('LLM response is not a JSON object') ||
    msg.includes('"highlights" field must be an array') ||
    msg.includes('Each highlight entry must be an object') ||
    msg.includes('Highlight "index" must be an integer') ||
    msg.includes('Highlight "reason" must be a string when present') ||
    msg.includes('"similar_groups" field must be an array') ||
    msg.includes('Each similar_groups entry must be an object') ||
    msg.includes('Similar group "indices" must be an array of integers') ||
    msg.includes('Similar group "best_index" must be an integer')
  );
}

/**
 * 评估单个 batch：将照片 resize 为 768x768、依次尝试 provider 链。
 *
 * 行为：
 *   - 对每个 provider，遇到 invalid/unparseable response 时在同一 provider 上重试一次；
 *     仍失败则级联到下一个 provider。
 *   - 其他错误（网络、超时、鉴权等）直接级联到下一个 provider。
 *   - 所有 provider 均失败时返回 null。
 *   - LLM 返回的索引（0-based）会被映射回真实的 photo id。
 *
 * @param photos 一个 batch 内的照片（最少 1 张）。
 * @param providerChain 已检测到的 provider 列表，按优先级排序。
 * @returns BatchResult 或 null（全部 provider 失败）。
 */
export async function evaluateBatch(
  photos: BatchablePhoto[],
  providerChain: ProviderConfig[],
): Promise<BatchResult | null> {
  if (!Array.isArray(photos) || photos.length === 0) {
    return { highlights: [], similarGroups: [], overexposedIds: [] };
  }
  if (!Array.isArray(providerChain) || providerChain.length === 0) {
    console.error('[highlightService] evaluateBatch called with empty provider chain');
    return null;
  }

  // 1) Resize all photos to 768x768 once; reuse for each provider attempt.
  // Keep photos and their resized images aligned in parallel arrays so that
  // LLM-returned indices map back to the correct photo IDs even if some
  // photos failed to resize.
  const usablePhotos: BatchablePhoto[] = [];
  const images: Array<{ base64: string; mediaType: 'image/jpeg' }> = [];
  for (const p of photos) {
    try {
      const base64 = await resizeForAnalysis(p.filePath);
      usablePhotos.push(p);
      images.push({ base64, mediaType: 'image/jpeg' });
    } catch (err) {
      console.error(
        `[highlightService] Failed to resize photo ${p.id} (${p.filePath}): ${err}`,
      );
    }
  }
  if (images.length === 0) {
    console.error(
      `[highlightService] All ${photos.length} photo(s) in batch failed to resize; aborting batch`,
    );
    return null;
  }

  // 2) Cascade through providers. For each provider, retry once on invalid response.
  for (const provider of providerChain) {
    const providerLabel: LLMProviderType = provider.type;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await invokeProviderForBatch(provider, images, usablePhotos);
        console.log(
          `[highlightService] Batch evaluated successfully via provider '${providerLabel}'` +
            (attempt > 1 ? ` (attempt ${attempt})` : ''),
        );
        return result;
      } catch (err) {
        const invalid = isInvalidResponseError(err);
        if (invalid && attempt === 1) {
          console.warn(
            `[highlightService] Provider '${providerLabel}' returned invalid response — retrying once: ${err}`,
          );
          continue; // retry same provider once
        }
        console.error(
          `[highlightService] Provider '${providerLabel}' failed${
            invalid ? ' (invalid response after retry)' : ''
          }: ${err}`,
        );
        break; // fall through to next provider
      }
    }
  }

  console.error('[highlightService] All providers failed for this batch');
  return null;
}

// ---------------------------------------------------------------------------
// Reason truncation & highlight ratio helpers
// ---------------------------------------------------------------------------

/**
 * 单条精华原因（reason）的最大字符长度。
 * 与设计文档 Property 4 保持一致：超过该长度时截断为恰好 MAX_REASON_LENGTH 字符。
 */
export const MAX_REASON_LENGTH = 100;

/**
 * 精华挑选目标比例区间 [30%, 40%]。
 * 全部 batch 处理完毕后若最终比例超出此范围，将记录警告日志，便于运维诊断。
 */
export const HIGHLIGHT_RATIO_MIN = 0.3;
export const HIGHLIGHT_RATIO_MAX = 0.4;

/**
 * 将精华原因字符串截断到不超过 {@link MAX_REASON_LENGTH} 个字符。
 *
 * - 输入长度 <= 100：原样返回（包括空字符串）。
 * - 输入长度 > 100：返回 `input.slice(0, 100)`，长度恰好为 100。
 * - 输入为 `null` / `undefined` / 非字符串：返回空字符串（容错处理）。
 *
 * 该函数仅做截断，不做 trim、不做省略号填充，以保证可逆且与
 * Property 4 “For any reason string of length 0..500, truncated output length
 * === min(input.length, 100)” 严格对应。
 *
 * @param reason 由 LLM 返回的原始 reason 字符串
 * @returns 长度 <= 100 的安全字符串
 */
export function truncateReason(reason: string): string {
  // 容错处理：LLM 响应虽经校验，但 reason 仍可能在某些路径上为非字符串。
  if (typeof reason !== 'string') {
    return '';
  }
  if (reason.length > MAX_REASON_LENGTH) {
    return reason.slice(0, MAX_REASON_LENGTH);
  }
  return reason;
}

/**
 * 计算精华照片选中比例。
 *
 * @param totalHighlights 已选精华照片总数
 * @param totalPhotos 参与评估的技术合格照片总数
 * @returns `totalHighlights / totalPhotos`；当 `totalPhotos <= 0` 时返回 0。
 *          结果范围理论上为 [0, 1]，目标区间为 [{@link HIGHLIGHT_RATIO_MIN},
 *          {@link HIGHLIGHT_RATIO_MAX}]。
 */
export function computeHighlightRatio(
  totalHighlights: number,
  totalPhotos: number,
): number {
  if (
    !Number.isFinite(totalHighlights) ||
    !Number.isFinite(totalPhotos) ||
    totalPhotos <= 0
  ) {
    return 0;
  }
  if (totalHighlights <= 0) return 0;
  return totalHighlights / totalPhotos;
}

/**
 * 若最终精华比例超出目标区间 [30%, 40%]，记录一条警告日志，便于排查
 * prompt 调优 / provider 行为差异等问题。
 *
 * 该函数无副作用以外的返回值，调用方可在评估收尾阶段直接调用：
 *
 * ```ts
 * const ratio = computeHighlightRatio(highlightCount, totalPhotos);
 * logRatioWarningIfOutOfRange(ratio);
 * ```
 */
export function logRatioWarningIfOutOfRange(ratio: number): void {
  if (!Number.isFinite(ratio)) return;
  if (ratio < HIGHLIGHT_RATIO_MIN || ratio > HIGHLIGHT_RATIO_MAX) {
    const pct = (ratio * 100).toFixed(1);
    console.warn(
      `[highlightService] Highlight selection ratio ${pct}% is outside the target range ` +
        `${(HIGHLIGHT_RATIO_MIN * 100).toFixed(0)}%-${(HIGHLIGHT_RATIO_MAX * 100).toFixed(0)}%`,
    );
  }
}


// ---------------------------------------------------------------------------
// Result persistence
// ---------------------------------------------------------------------------

/**
 * 一张参与评估（即被发送给 LLM）的照片的最小信息载体。
 *
 * `batchIndex` 为该照片所在 batch 的 0-based 序号（由调用方分配）。
 * 即使照片最终未被选为精华，也需要持久化为 `is_highlight = 0` 的
 * `highlight_results` 行，以便后续查询统计 / 区分"未评估" vs "已评估但未入选"。
 */
export interface EvaluatedPhotoInput {
  photoId: string;
  batchIndex: number;
}

/**
 * 单张精华照片的持久化输入。`reason` 在写库前会经过 {@link truncateReason}。
 */
export interface HighlightInput {
  photoId: string;
  reason: string;
}

/**
 * 单个相似照片组的持久化输入。
 *
 * - `memberIds` 中允许出现重复，函数内部会去重。
 * - `bestId` 必须出现在 `memberIds` 中（Property 5）；否则该组会被跳过。
 */
export interface SimilarGroupInput {
  memberIds: string[];
  bestId: string;
}

/**
 * `persistResults` 的可选参数。
 */
export interface PersistResultsOptions {
  /**
   * 当遇到 SQLite 约束错误（外键不存在、唯一索引重复等）时，调用此回调。
   * 默认行为是 `console.warn` 并跳过该条记录。
   */
  onConstraintViolation?: (
    table: 'highlight_results' | 'similar_groups' | 'similar_group_members',
    detail: { id?: string; tripId: string; reason: string },
  ) => void;
}

/**
 * 判断错误是否属于 SQLite 约束违规（外键 / 唯一索引等）。
 *
 * `better-sqlite3` 在约束违规时会抛出 `code` 以 `SQLITE_CONSTRAINT` 开头的
 * `SqliteError`；其他错误（IO、schema 缺失、类型错误等）应继续向上抛出，
 * 触发整个事务回滚。
 */
function isSqliteConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown };
  return typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT');
}

/**
 * 原子地替换某次旅行的所有精华评估结果。
 *
 * 步骤（在单个 `db.transaction(...)` 内）：
 *   1) 删除该 `tripId` 下所有 `highlight_results` 行。
 *   2) 删除该 `tripId` 下所有 `similar_groups` 行；ON DELETE CASCADE 会
 *      自动清理对应的 `similar_group_members`。
 *   3) 为每张参与评估的照片插入一条 `highlight_results`：
 *      - 若该照片在 `highlights` 中出现，`is_highlight = 1`，`reason` 使用
 *        {@link truncateReason} 截断后写入；
 *      - 否则 `is_highlight = 0`，`reason` 写入 `NULL`。
 *   4) 为每个 `similarGroups[i]` 生成新的 `groupId`（UUID v4），插入
 *      `similar_groups`，再插入对应的 `similar_group_members`。`bestPhotoId`
 *      必须在成员列表中，否则跳过整组。
 *
 * 错误处理：
 *   - 单条记录的 SQLite 约束违规（例如 FK 指向已被删除的 photo）会被捕获并
 *     跳过（仅打印 warning），其它记录继续插入；这与 design.md 的
 *     "Constraint violation (deleted photo) → Skip the offending record,
 *     log warning, persist remaining" 行为一致。
 *   - 任何其他错误（IO / schema / 类型）会向上抛出，better-sqlite3 会回滚
 *     整个事务，已存在的旧数据保持不变（满足 Requirement 5.5）。
 *
 * @param tripId        旅行 ID（外键指向 trips.id）
 * @param evaluatedPhotos 参与本次评估的所有照片（含 batch 序号），是
 *                        `highlights` 的超集；写入 `highlight_results`。
 * @param highlights    被 LLM 选为精华的照片及其原因（reason 会被截断到 100 字符）。
 * @param similarGroups LLM 识别的相似照片组及每组的最佳照片。
 * @param evaluatedAt   评估时间戳（ISO 8601）。
 * @param opts          可选参数，例如约束违规回调。
 * @returns             实际成功写入的 highlight 数量与 similar group 数量。
 */
export function persistResults(
  tripId: string,
  evaluatedPhotos: EvaluatedPhotoInput[],
  highlights: HighlightInput[],
  similarGroups: SimilarGroupInput[],
  evaluatedAt: string,
  opts: PersistResultsOptions = {},
): { highlightCount: number; similarGroupCount: number } {
  if (!tripId || typeof tripId !== 'string') {
    throw new Error('persistResults: tripId is required');
  }
  if (!evaluatedAt || typeof evaluatedAt !== 'string') {
    throw new Error('persistResults: evaluatedAt is required');
  }

  const db = getDb();

  // photoId -> truncated reason  (only contains true highlights)
  const reasonByPhotoId = new Map<string, string>();
  for (const h of highlights ?? []) {
    if (!h || typeof h.photoId !== 'string') continue;
    reasonByPhotoId.set(h.photoId, truncateReason(h.reason ?? ''));
  }

  const onConstraint =
    opts.onConstraintViolation ??
    ((table, detail) => {
      console.warn(
        `[highlightService] Skipping ${table} row (trip=${detail.tripId}` +
          (detail.id ? `, id=${detail.id}` : '') +
          `): ${detail.reason}`,
      );
    });

  let highlightCount = 0;
  let similarGroupCount = 0;

  const persist = db.transaction(() => {
    // 1) Wipe previous results for this trip. similar_group_members has
    //    FK ... ON DELETE CASCADE so it follows similar_groups automatically.
    //    NOTE: Deleting all rows implicitly enforces the cascade invariant
    //    (is_highlight_tier = 1 ⟹ is_highlight = 1) because re-inserted rows
    //    do not include is_highlight_tier and default to 0. Tier status is
    //    re-established separately by runTierSelection() after evaluation.
    db.prepare('DELETE FROM highlight_results WHERE trip_id = ?').run(tripId);
    db.prepare('DELETE FROM similar_groups WHERE trip_id = ?').run(tripId);

    // 2) Insert highlight_results for every evaluated photo.
    const insertHighlight = db.prepare(
      `INSERT INTO highlight_results
         (id, trip_id, photo_id, is_highlight, reason, batch_index, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const ep of evaluatedPhotos ?? []) {
      if (!ep || typeof ep.photoId !== 'string') continue;
      const isHighlight = reasonByPhotoId.has(ep.photoId);
      const reason = isHighlight ? reasonByPhotoId.get(ep.photoId)! : null;
      const batchIndex = Number.isInteger(ep.batchIndex) ? ep.batchIndex : 0;
      const id = uuidv4();
      try {
        insertHighlight.run(
          id,
          tripId,
          ep.photoId,
          isHighlight ? 1 : 0,
          reason,
          batchIndex,
          evaluatedAt,
        );
        if (isHighlight) highlightCount += 1;
      } catch (err) {
        if (isSqliteConstraintError(err)) {
          onConstraint('highlight_results', {
            id,
            tripId,
            reason: `photo_id=${ep.photoId}: ${(err as Error).message}`,
          });
          continue;
        }
        throw err;
      }
    }

    // 3) Insert similar_groups and their members.
    const insertGroup = db.prepare(
      `INSERT INTO similar_groups (id, trip_id, best_photo_id, evaluated_at)
       VALUES (?, ?, ?, ?)`,
    );
    const insertMember = db.prepare(
      `INSERT INTO similar_group_members (id, group_id, photo_id)
       VALUES (?, ?, ?)`,
    );
    const deleteGroup = db.prepare('DELETE FROM similar_groups WHERE id = ?');

    for (const sg of similarGroups ?? []) {
      if (!sg || !Array.isArray(sg.memberIds) || typeof sg.bestId !== 'string') {
        continue;
      }

      // Defensive: enforce Property 5 (bestId must be a group member).
      // evaluateBatch already guarantees this, but persistResults is a public
      // boundary and should not silently violate the invariant.
      if (!sg.memberIds.includes(sg.bestId)) {
        console.warn(
          `[highlightService] Skipping similar group: bestId ${sg.bestId} ` +
            `is not in memberIds (${sg.memberIds.length} members)`,
        );
        continue;
      }

      const groupId = uuidv4();
      try {
        insertGroup.run(groupId, tripId, sg.bestId, evaluatedAt);
      } catch (err) {
        if (isSqliteConstraintError(err)) {
          onConstraint('similar_groups', {
            id: groupId,
            tripId,
            reason: `best_photo_id=${sg.bestId}: ${(err as Error).message}`,
          });
          continue;
        }
        throw err;
      }

      // Insert members with per-row try/catch so a single missing photo doesn't
      // doom the entire group.
      const persistedMembers = new Set<string>();
      for (const memberId of sg.memberIds) {
        if (typeof memberId !== 'string' || !memberId) continue;
        if (persistedMembers.has(memberId)) continue; // dedupe input
        const memberRowId = uuidv4();
        try {
          insertMember.run(memberRowId, groupId, memberId);
          persistedMembers.add(memberId);
        } catch (err) {
          if (isSqliteConstraintError(err)) {
            onConstraint('similar_group_members', {
              id: memberRowId,
              tripId,
              reason: `group=${groupId}, photo=${memberId}: ${(err as Error).message}`,
            });
            continue;
          }
          throw err;
        }
      }

      // After per-member skips, ensure the group is still meaningful:
      //   - at least 2 members remain
      //   - bestId is among the persisted members
      if (persistedMembers.size < 2 || !persistedMembers.has(sg.bestId)) {
        console.warn(
          `[highlightService] Dropping similar group ${groupId}: ` +
            `${persistedMembers.size} valid member(s), bestId persisted=${persistedMembers.has(sg.bestId)}`,
        );
        // Cascading delete also removes any inserted members.
        deleteGroup.run(groupId);
        continue;
      }

      similarGroupCount += 1;
    }
  });

  persist();

  return { highlightCount, similarGroupCount };
}


// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * 单条 `highlight_results` <> `media_items` JOIN 查询的行结构。
 */
interface HighlightResultRow {
  photo_id: string;
  trip_id: string;
  is_highlight: number; // SQLite 存储 0 / 1
  reason: string | null;
  evaluated_at: string;
}

/**
 * 查询指定旅行的所有精华评估结果。
 *
 * 通过 INNER JOIN `media_items` 过滤掉 photo_id 已不存在（被删除或孤立）的
 * `highlight_results` 行。虽然外键 ON DELETE CASCADE 已能保证一致性，
 * 此处再次 JOIN 仅作为防御措施，避免极端情况下出现孤立记录。
 *
 * 默认返回该旅行下所有已评估的照片（包括 `is_highlight = 0` 的非精华行），
 * 当 `onlyHighlights` 为 true 时仅返回 `is_highlight = 1` 的行。
 *
 * @param tripId         旅行 ID
 * @param onlyHighlights 是否仅返回精华照片；默认 false
 * @returns              按 `evaluated_at DESC, photo_id ASC` 排序的 {@link HighlightPhoto} 数组
 */
export function getHighlightsForTrip(
  tripId: string,
  onlyHighlights: boolean = false,
): HighlightPhoto[] {
  if (!tripId || typeof tripId !== 'string') return [];

  const db = getDb();
  const sql =
    `SELECT
       hr.photo_id     AS photo_id,
       hr.trip_id      AS trip_id,
       hr.is_highlight AS is_highlight,
       hr.reason       AS reason,
       hr.evaluated_at AS evaluated_at
     FROM highlight_results AS hr
     INNER JOIN media_items AS mi ON mi.id = hr.photo_id
     WHERE hr.trip_id = ?` +
    (onlyHighlights ? ' AND hr.is_highlight = 1' : '') +
    ` ORDER BY hr.evaluated_at DESC, hr.photo_id ASC`;

  const rows = db.prepare(sql).all(tripId) as HighlightResultRow[];
  return rows.map((row) => ({
    photoId: row.photo_id,
    tripId: row.trip_id,
    isHighlight: row.is_highlight === 1,
    reason: row.reason ?? '',
    evaluatedAt: row.evaluated_at,
  }));
}

/**
 * 单条 `similar_groups` <> `similar_group_members` <> `media_items` JOIN 查询的行结构。
 */
interface SimilarGroupRow {
  group_id: string;
  trip_id: string;
  best_photo_id: string;
  evaluated_at: string;
  member_photo_id: string;
}

/**
 * 查询指定旅行的所有相似照片组及其成员。
 *
 * 使用 INNER JOIN `similar_group_members` 与 `media_items`，过滤掉成员照片
 * 已被删除的孤立行（外键 CASCADE 已能保证大多数情况下的一致性，仅作防御）。
 *
 * SQL 层面按 `evaluated_at DESC, group_id ASC, photo_id ASC` 排序，
 * 因此按行顺序聚合得到的每组 `memberPhotoIds` 即为 photo_id 升序，
 * 组之间的顺序为 evaluated_at 降序、group_id 升序。
 *
 * 经成员过滤后若某组的有效成员少于 2 张，则将该组从结果中剔除
 * （与 design.md 一致：相似组至少包含 2 张照片才有意义）。
 *
 * @param tripId 旅行 ID
 * @returns      按 `evaluated_at DESC, group_id ASC` 排序的 {@link SimilarGroup} 数组；
 *               每组的 `memberPhotoIds` 按 photo_id 升序排列。
 */
export function getSimilarGroupsForTrip(tripId: string): SimilarGroup[] {
  if (!tripId || typeof tripId !== 'string') return [];

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         sg.id            AS group_id,
         sg.trip_id       AS trip_id,
         sg.best_photo_id AS best_photo_id,
         sg.evaluated_at  AS evaluated_at,
         sgm.photo_id     AS member_photo_id
       FROM similar_groups AS sg
       INNER JOIN similar_group_members AS sgm ON sgm.group_id = sg.id
       INNER JOIN media_items AS mi ON mi.id = sgm.photo_id
       WHERE sg.trip_id = ?
       ORDER BY sg.evaluated_at DESC, sg.id ASC, sgm.photo_id ASC`,
    )
    .all(tripId) as SimilarGroupRow[];

  // Aggregate members by group_id while preserving SQL-determined ordering.
  const groupOrder: string[] = [];
  const groupMap = new Map<
    string,
    {
      groupId: string;
      tripId: string;
      bestPhotoId: string;
      evaluatedAt: string;
      memberPhotoIds: string[];
    }
  >();

  for (const row of rows) {
    let group = groupMap.get(row.group_id);
    if (!group) {
      group = {
        groupId: row.group_id,
        tripId: row.trip_id,
        bestPhotoId: row.best_photo_id,
        evaluatedAt: row.evaluated_at,
        memberPhotoIds: [],
      };
      groupMap.set(row.group_id, group);
      groupOrder.push(row.group_id);
    }
    group.memberPhotoIds.push(row.member_photo_id);
  }

  const result: SimilarGroup[] = [];
  for (const id of groupOrder) {
    const g = groupMap.get(id)!;
    // Drop groups whose remaining valid members are fewer than 2.
    if (g.memberPhotoIds.length < 2) continue;
    result.push({
      groupId: g.groupId,
      tripId: g.tripId,
      memberPhotoIds: g.memberPhotoIds, // already sorted ASC by SQL
      bestPhotoId: g.bestPhotoId,
      evaluatedAt: g.evaluatedAt,
    });
  }

  return result;
}


// ---------------------------------------------------------------------------
// Cascade: clearing is_highlight auto-clears is_highlight_tier
// ---------------------------------------------------------------------------

/**
 * Clear `is_highlight` for one or more photos, cascading `is_highlight_tier = 0`
 * to preserve the subset invariant:
 *   `is_highlight_tier = 1` ⟹ `is_highlight = 1`
 *
 * When `is_highlight` is set to 0, `is_highlight_tier` MUST also be set to 0.
 * This function atomically performs both updates in a single statement.
 *
 * Use this function (or the equivalent combined UPDATE) **wherever** highlight
 * status is removed from individual photos outside of `persistResults`
 * (which handles the cascade implicitly via DELETE + re-INSERT).
 *
 * @param tripId   The trip the photos belong to
 * @param photoIds One or more photo IDs whose highlight status should be cleared
 *
 * @example
 *   // Clear highlight for a single photo
 *   clearHighlightWithCascade('trip-1', ['photo-1']);
 *
 *   // Batch clear after similar-group dedup
 *   clearHighlightWithCascade('trip-1', ['photo-2', 'photo-3']);
 *
 * Requirements: 10.2, 10.3
 */
export function clearHighlightWithCascade(tripId: string, photoIds: string[]): void {
  if (!tripId || !Array.isArray(photoIds) || photoIds.length === 0) return;

  const db = getDb();
  const placeholders = photoIds.map(() => '?').join(',');

  // Atomically clear both is_highlight and is_highlight_tier in a single UPDATE.
  // This guarantees the subset invariant is never transiently violated.
  db.prepare(
    `UPDATE highlight_results
        SET is_highlight = 0,
            is_highlight_tier = 0,
            reason = NULL
      WHERE trip_id = ?
        AND photo_id IN (${placeholders})`,
  ).run(tripId, ...photoIds);
}

/**
 * Clear `is_highlight_tier` for one or more photos without changing `is_highlight`.
 *
 * Use this when a photo remains a highlight but should be removed from the tier
 * (e.g., when the photo is trashed — its highlight row may still exist briefly,
 * or during manual tier removal).
 *
 * @param photoIds One or more photo IDs whose tier status should be cleared
 *
 * Requirements: 10.2
 */
export function clearHighlightTierForPhotos(photoIds: string[]): void {
  if (!Array.isArray(photoIds) || photoIds.length === 0) return;

  const db = getDb();
  const placeholders = photoIds.map(() => '?').join(',');
  db.prepare(
    `UPDATE highlight_results SET is_highlight_tier = 0 WHERE photo_id IN (${placeholders})`,
  ).run(...photoIds);
}

// ---------------------------------------------------------------------------
// Orchestrator: runHighlightEvaluation
// ---------------------------------------------------------------------------

import { getStorageProvider } from '../storage/factory';
import { runTierSelection } from './highlightTierSelector';

/**
 * 显式的 service 层错误，包含 `code` 字段供 API 层映射 HTTP 状态码：
 *
 * - `TRIP_NOT_FOUND`        → HTTP 404
 * - `NO_PROVIDERS_CONFIGURED` → HTTP 500 (服务端配置缺失)
 * - `ALREADY_RUNNING`       → HTTP 409 (并发评估冲突)
 * - `EVALUATION_FAILED`     → HTTP 500 (所有 batch 均失败)
 */
export class HighlightServiceError extends Error {
  public readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'HighlightServiceError';
    Object.setPrototypeOf(this, HighlightServiceError.prototype);
  }
}

interface MediaItemForHighlightRow {
  id: string;
  file_path: string;
}

/**
 * 触发 trip 的精华评估完整流程：
 *
 *   1) 校验 trip 存在 (`TRIP_NOT_FOUND` 否则)
 *   2) 检测可用的 LLM provider (`NO_PROVIDERS_CONFIGURED` 否则)
 *   3) 在 `highlight_jobs` 中插入 `status='running'` 行；唯一索引冲突时
 *      抛 `ALREADY_RUNNING`，由 API 层转 409
 *   4) 收集"技术合格"照片：`status='active'` AND `media_type='image'`
 *      AND (`blur_status` 为 NULL 或 != 'blurry')。零张时直接 persist 空结果
 *      并把 job 标 `completed`
 *   5) 经 storage provider 解析每张照片的本地路径，跳过解析失败的
 *   6) `createBatches` 切批，写回 `total_batches`
 *   7) 依次 `evaluateBatch`：失败计入 `failed_batches`，成功累积 highlights
 *      （带 batchIndex）和 similar groups；每个 batch 后更新 `processed_batches`
 *      并触发 `onProgress`
 *   8) 全部 batch 失败 → job 标 `failed` 并抛 `EVALUATION_FAILED`
 *      否则 → 调用 `persistResults`、记录比例 warning、把 job 标 `completed`
 *   9) 任何意外错误 → job 标 `failed`（带 error_message），原样向上抛
 *
 * 设计细节：
 *
 * - "usedProvider" 字段在 `evaluateBatch` 内部级联时无法直接观测到；为了
 *   保留语义又不修改 `evaluateBatch` 签名，这里取 `providerChain[0].type`
 *   作为"首选 / 期望 provider"上报。后续若需要精确的"成功 provider"，
 *   可在 evaluateBatch 出参中扩展。
 *
 * - "Skip missing photos"：在向 `evaluateBatch` 喂入前先经
 *   `storageProvider.downloadToTemp()` 解析；解析失败的整张被跳过；
 *   `evaluateBatch` 内部的 `resizeForAnalysis` 失败也会保持 photo/image
 *   parallel-array 一致，已由该函数自行处理。
 *
 * - "Continue processing remaining batches"：单 batch 失败不影响其它 batch；
 *   仅当全部 batch 失败时整个评估才视为失败。
 *
 * @param tripId  待评估的 trip ID
 * @param options 可选回调（如进度上报）
 * @returns       本次评估的汇总结果
 * @throws        {@link HighlightServiceError} 见上方各 code 含义
 */
export async function runHighlightEvaluation(
  tripId: string,
  options: HighlightServiceOptions = {},
): Promise<HighlightEvaluation> {
  if (!tripId || typeof tripId !== 'string') {
    throw new HighlightServiceError('TRIP_NOT_FOUND', 'tripId is required');
  }

  const db = getDb();

  // 1) Validate trip exists.
  const trip = db
    .prepare('SELECT id FROM trips WHERE id = ?')
    .get(tripId) as { id: string } | undefined;
  if (!trip) {
    throw new HighlightServiceError(
      'TRIP_NOT_FOUND',
      `Trip ${tripId} does not exist`,
    );
  }

  // 2) Detect configured providers.
  const providerChain = detectConfiguredProviders();
  if (!providerChain || providerChain.length === 0) {
    throw new HighlightServiceError(
      'NO_PROVIDERS_CONFIGURED',
      'No LLM providers are configured for highlight evaluation',
    );
  }
  const usedProvider = providerChain[0].type;

  // 3) Insert highlight_jobs row with status='running'. The unique partial
  //    index `idx_highlight_jobs_active` enforces at most one running job
  //    per trip; concurrent triggers will fail the INSERT with a
  //    SQLITE_CONSTRAINT_UNIQUE error which we map to ALREADY_RUNNING.
  const jobId = uuidv4();
  const startedAt = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO highlight_jobs
         (id, trip_id, status, total_batches, processed_batches, failed_batches, error_message, created_at, finished_at)
       VALUES (?, ?, 'running', 0, 0, 0, NULL, ?, NULL)`,
    ).run(jobId, tripId, startedAt);
  } catch (err) {
    if (isSqliteConstraintError(err)) {
      throw new HighlightServiceError(
        'ALREADY_RUNNING',
        `Highlight evaluation already in progress for trip ${tripId}`,
      );
    }
    throw err;
  }

  // Helpers to update job state.
  const markJobFailed = (errorMessage: string): void => {
    try {
      db.prepare(
        `UPDATE highlight_jobs
            SET status = 'failed',
                error_message = ?,
                finished_at = ?
          WHERE id = ?`,
      ).run(errorMessage.slice(0, 1000), new Date().toISOString(), jobId);
    } catch (updateErr) {
      console.error(
        `[highlightService] Failed to mark job ${jobId} as failed: ${updateErr}`,
      );
    }
  };

  const markJobCompleted = (): void => {
    db.prepare(
      `UPDATE highlight_jobs
          SET status = 'completed',
              finished_at = ?
        WHERE id = ?`,
    ).run(new Date().toISOString(), jobId);
  };

  try {
    // 4) Collect technical-qualified photos for the trip.
    const rawPhotos = db
      .prepare(
        `SELECT id, file_path
           FROM media_items
          WHERE trip_id = ?
            AND media_type = 'image'
            AND status = 'active'
            AND (blur_status IS NULL OR blur_status != 'blurry')
            AND file_path IS NOT NULL
          ORDER BY created_at ASC, id ASC`,
      )
      .all(tripId) as MediaItemForHighlightRow[];

    // 5) Resolve each photo's storage path to a usable local path.
    //    Photos whose backing file cannot be located are skipped (logged).
    const storageProvider = getStorageProvider();
    const usablePhotos: BatchablePhoto[] = [];
    for (const row of rawPhotos) {
      try {
        const localPath = await storageProvider.downloadToTemp(row.file_path);
        usablePhotos.push({ id: row.id, filePath: localPath });
      } catch (err) {
        console.warn(
          `[highlightService] Skipping photo ${row.id} (${row.file_path}): ${err}`,
        );
      }
    }

    const totalPhotos = usablePhotos.length;
    const evaluatedAt = new Date().toISOString();

    // Zero-photo short circuit: persist empty results (clears any prior
    // highlight data for this trip) and complete the job successfully.
    if (totalPhotos === 0) {
      persistResults(tripId, [], [], [], evaluatedAt);
      markJobCompleted();
      return {
        tripId,
        totalPhotos: 0,
        highlightCount: 0,
        similarGroupCount: 0,
        batchesProcessed: 0,
        batchesFailed: 0,
        usedProvider,
      };
    }

    // 6) Smart batching: use DINOv2 embeddings to group similar photos together
    //    so the AI can see them side-by-side and identify similar groups.
    let batches: BatchablePhoto[][];
    try {
      const { groupBySimilarity, buildSmartBatches } = await import('./aiImageScreener');
      // Use original storage keys (not local temp paths) since groupBySimilarity downloads internally
      const usableIds = new Set(usablePhotos.map(p => p.id));
      const imagesForGrouping = rawPhotos
        .filter(r => usableIds.has(r.id))
        .map(r => ({ id: r.id, file_path: r.file_path }));
      const groups = await groupBySimilarity(imagesForGrouping, 0.75);
      const smartBatches = buildSmartBatches(imagesForGrouping, groups, 6);
      // Map back to BatchablePhoto format
      const photoMap = new Map(usablePhotos.map(p => [p.id, p]));
      batches = smartBatches.map(batch =>
        batch.map(img => photoMap.get(img.id)!).filter(Boolean)
      ).filter(b => b.length > 0);
      console.log(
        `[highlightService] Smart batching: ${groups.length} similarity groups → ${batches.length} batches`,
      );
    } catch (err) {
      // Fallback to simple sequential batching if embedding extraction fails
      console.warn(`[highlightService] Smart batching failed, falling back to sequential: ${err}`);
      batches = createBatches(usablePhotos);
    }

    const totalBatches = batches.length;
    db.prepare('UPDATE highlight_jobs SET total_batches = ? WHERE id = ?').run(
      totalBatches,
      jobId,
    );

    // 7) Evaluate each batch. Accumulate results in memory; persist atomically
    //    at the end so partial failures don't corrupt prior data.
    const allEvaluatedPhotos: EvaluatedPhotoInput[] = [];
    const allHighlights: HighlightInput[] = [];
    const allSimilarGroups: SimilarGroupInput[] = [];
    const allOverexposedIds: string[] = [];

    let batchesProcessed = 0;
    let batchesFailed = 0;

    const incrementProcessed = db.prepare(
      'UPDATE highlight_jobs SET processed_batches = processed_batches + 1 WHERE id = ?',
    );
    const incrementFailed = db.prepare(
      'UPDATE highlight_jobs SET failed_batches = failed_batches + 1 WHERE id = ?',
    );

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      let result: BatchResult | null = null;
      try {
        result = await evaluateBatch(batch, providerChain);
      } catch (err) {
        // evaluateBatch is designed to swallow provider errors and return
        // null on total failure; an uncaught throw here is unexpected, but
        // we still treat the batch as failed and continue.
        console.error(
          `[highlightService] Unexpected error from evaluateBatch (batch ${batchIndex}): ${err}`,
        );
        result = null;
      }

      // Always record every photo in this batch as "evaluated" so that
      // non-highlight rows (is_highlight = 0) are persisted. Failed batches
      // contribute their photos as evaluated-but-not-highlight as well; this
      // matches the design's expectation that re-evaluation REPLACES prior
      // results without losing track of which photos were considered.
      for (const p of batch) {
        allEvaluatedPhotos.push({ photoId: p.id, batchIndex });
      }

      if (result === null) {
        batchesFailed += 1;
        incrementFailed.run(jobId);
        console.error(
          `[highlightService] Batch ${batchIndex + 1}/${totalBatches} failed (all providers exhausted)`,
        );
      } else {
        for (const h of result.highlights) {
          allHighlights.push({ photoId: h.photoId, reason: h.reason });
        }
        for (const sg of result.similarGroups) {
          allSimilarGroups.push({
            memberIds: sg.memberIds,
            bestId: sg.bestId,
          });
        }
        for (const id of result.overexposedIds) {
          allOverexposedIds.push(id);
        }
      }

      batchesProcessed += 1;
      incrementProcessed.run(jobId);

      if (typeof options.onProgress === 'function') {
        try {
          options.onProgress(batchIndex + 1, totalBatches);
        } catch (cbErr) {
          console.warn(
            `[highlightService] onProgress callback threw: ${cbErr}`,
          );
        }
      }
    }

    // 8) If every batch failed, mark the whole job as failed.
    if (batchesFailed === totalBatches && totalBatches > 0) {
      const errorMessage = `All ${totalBatches} batch(es) failed during highlight evaluation`;
      markJobFailed(errorMessage);
      throw new HighlightServiceError('EVALUATION_FAILED', errorMessage);
    }

    // 9) Persist aggregated results atomically (replaces prior data).
    const { highlightCount, similarGroupCount } = persistResults(
      tripId,
      allEvaluatedPhotos,
      allHighlights,
      allSimilarGroups,
      evaluatedAt,
    );

    // 10) Auto-trash similar group non-best photos.
    //     For each similar group, keep only the bestId; trash the rest.
    let similarGroupTrashedCount = 0;
    const similarGroupTrashedIds: string[] = [];
    if (allSimilarGroups.length > 0) {
      const trashStmt = db.prepare(
        `UPDATE media_items
         SET status = 'trashed',
             trashed_reason = CASE
               WHEN trashed_reason IS NULL THEN 'duplicate'
               ELSE trashed_reason || ',duplicate'
             END
         WHERE id = ? AND status = 'active'`
      );
      for (const sg of allSimilarGroups) {
        for (const memberId of sg.memberIds) {
          if (memberId !== sg.bestId) {
            const info = trashStmt.run(memberId);
            if (info.changes > 0) {
              similarGroupTrashedCount++;
              similarGroupTrashedIds.push(memberId);
            }
          }
        }
      }
      // Cascade: clear is_highlight_tier for trashed photos (subset invariant)
      if (similarGroupTrashedIds.length > 0) {
        clearHighlightTierForPhotos(similarGroupTrashedIds);
        console.log(
          `[highlightService] Auto-trashed ${similarGroupTrashedCount} similar-group non-best photos for trip ${tripId}`,
        );
      }
    }

    // 10.5) Global survivor dedup — cross-group near-duplicate elimination
    let globalSimilarityAfterVlmDeletedCount = 0;
    try {
      const { runSurvivorDedup } = await import('./smartCuration/survivorDedup');
      const dedupResult = await runSurvivorDedup(tripId);
      globalSimilarityAfterVlmDeletedCount = dedupResult.globalSimilarityAfterVlmDeletedCount;
    } catch (err) {
      console.error(`[highlightService] Global survivor dedup error: ${err}`);
    }

    // 11) Auto-trash overexposed photos identified by AI.
    let overexposedTrashedCount = 0;
    if (allOverexposedIds.length > 0) {
      const trashOverexposedStmt = db.prepare(
        `UPDATE media_items
         SET status = 'trashed',
             trashed_reason = CASE
               WHEN trashed_reason IS NULL THEN 'overexposure'
               ELSE trashed_reason || ',overexposure'
             END
         WHERE id = ? AND status = 'active'`
      );
      const overexposedTrashedIds: string[] = [];
      for (const photoId of allOverexposedIds) {
        const info = trashOverexposedStmt.run(photoId);
        if (info.changes > 0) {
          overexposedTrashedCount++;
          overexposedTrashedIds.push(photoId);
        }
      }
      // Cascade: clear is_highlight_tier for trashed photos (subset invariant)
      if (overexposedTrashedIds.length > 0) {
        clearHighlightTierForPhotos(overexposedTrashedIds);
        console.log(
          `[highlightService] Auto-trashed ${overexposedTrashedCount} overexposed photos for trip ${tripId}`,
        );
      }
    }

    // 12) Log a warning if the highlight ratio drifted out of [30%, 40%].
    const ratio = computeHighlightRatio(highlightCount, totalPhotos);
    logRatioWarningIfOutOfRange(ratio);

    // 13) Run highlight tier selection (精华) as fire-and-forget.
    //     Does NOT block the response — runs in the background after evaluation returns.
    runTierSelection(tripId)
      .then((tierResult) => {
        console.log(`[highlight] Tier selection completed: ${tierResult.tierCount} photos selected`);
      })
      .catch((err) => {
        console.error(`[highlight] Tier selection failed (non-fatal): ${err}`);
      });

    markJobCompleted();

    return {
      tripId,
      totalPhotos,
      highlightCount,
      similarGroupCount,
      batchesProcessed,
      batchesFailed,
      usedProvider,
      globalSimilarityAfterVlmDeletedCount,
    };
  } catch (err) {
    // Don't double-mark if we already marked the job failed above.
    if (!(err instanceof HighlightServiceError && err.code === 'EVALUATION_FAILED')) {
      const message = err instanceof Error ? err.message : String(err);
      markJobFailed(message);
    }
    throw err;
  }
}
