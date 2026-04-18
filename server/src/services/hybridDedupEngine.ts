/**
 * 四层混合去重引擎
 *
 * Layer 0: Hash 预过滤（文件 MD5 + pHash/dHash）
 * Layer 1: CLIP 三档粗筛（via pythonAnalyzer.clipNeighborSearch）
 * Layer 2: LLM 逐对精判（有已配置 provider 时）/ Strict Threshold 回退（无 provider 时）
 * Layer 3: Union-Find 分组 + 质量选择
 *
 * 所有阈值从 dedupThresholds.ts 导入，不在本文件定义任何阈值数值。
 */

import crypto from 'crypto';
import fs from 'fs';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';
import { TempPathCache } from '../helpers/tempPathCache';
import {
  HASH_HAMMING_THRESHOLD,
  applyStrictThreshold,
} from './dedupThresholds';
import { computePHash, computeHash, hammingDistance, DedupResult } from './dedupEngine';
import { clipNeighborSearch, ClipCandidatePair } from './pythonAnalyzer';
import { computeQualityScore, computeMLEnhancedQuality } from './qualitySelector';
import { detectConfiguredProviders, reviewPairs, PairReviewRequest } from './llmPairReviewer';
import { extractEmbeddings, findDuplicateGroups, isMLServiceAvailable } from './mlQualityService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HybridDedupLayer = 'layer0' | 'layer1' | 'layer2' | 'strictThreshold' | 'layer3';

export interface HybridDedupOptions {
  /** Layer 0: pHash/dHash 汉明距离阈值，默认从 dedupThresholds 导入 */
  hashHammingThreshold?: number;
  /** Layer 1: CLIP top-k 近邻数，默认从 dedupThresholds 导入 */
  clipTopK?: number;
  /** Layer 2: 首选 LLM provider（Phase B 使用） */
  preferredProvider?: string;
  /** 进度回调：每个层级开始/完成时调用 */
  onProgress?: (layer: HybridDedupLayer, status: 'start' | 'complete', detail?: string) => void;
  /** 当 false 时跳过 Layer 1 和 Layer 2，仅执行 Layer 0 + Layer 3 */
  pythonAvailable?: boolean;
  /** Optional per-run temp path cache for reusing downloaded files */
  tempCache?: TempPathCache;
}

export interface Layer0Result {
  /** 文件哈希/pHash/dHash 确认的重复对（索引对） */
  confirmedPairs: Array<{ i: number; j: number }>;
  /** Computed pHashes for all images (null if computation failed) */
  pHashes: (string | null)[];
  /** Computed dHashes for all images (null if computation failed) */
  dHashes: (string | null)[];
}

export interface Layer1Result {
  /** CLIP ≥ confirmed threshold 直接确认的重复对 */
  confirmedPairs: ClipCandidatePair[];
  /** 灰区候选对（需 Strict Threshold 或 LLM 判定） */
  grayZonePairs: ClipCandidatePair[];
}

export interface DedupGroup {
  /** 组内所有图片索引 */
  indices: number[];
  /** 选中保留的图片索引 */
  keepIndex: number;
}

export interface ImageRow {
  id: string;
  file_path: string;
  original_filename: string;
  sharpness_score: number | null;
  blur_status: string | null;
  width: number | null;
  height: number | null;
  file_size: number;
  status: string;
  trashed_reason: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// UnionFind
// ---------------------------------------------------------------------------

export class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]);
    }
    return this.parent[x];
  }

  union(x: number, y: number): void {
    const px = this.find(x);
    const py = this.find(y);
    if (px === py) return;
    if (this.rank[px] < this.rank[py]) {
      this.parent[px] = py;
    } else if (this.rank[px] > this.rank[py]) {
      this.parent[py] = px;
    } else {
      this.parent[py] = px;
      this.rank[px]++;
    }
  }

  /** 返回所有大小 ≥ 2 的连通分量 */
  getGroups(n: number): number[][] {
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const root = this.find(i);
      if (!groups.has(root)) {
        groups.set(root, []);
      }
      groups.get(root)!.push(i);
    }
    return Array.from(groups.values()).filter(g => g.length >= 2);
  }
}


// ---------------------------------------------------------------------------
// Layer 0 — Hash 预过滤
// ---------------------------------------------------------------------------

/**
 * 计算文件 MD5 哈希。
 */
function computeFileMD5(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Layer 0: 文件哈希精确匹配 + pHash/dHash 低距离匹配。
 *
 * - 文件 MD5 相同 → confirmedPairs
 * - pHash ≤ threshold 且 dHash ≤ threshold → confirmedPairs
 * - 哈希计算失败的图片跳过 Layer 0，传递给 Layer 1
 */
export async function runLayer0(
  rows: ImageRow[],
  options?: { hashHammingThreshold?: number; tempCache?: TempPathCache }
): Promise<Layer0Result> {
  const threshold = options?.hashHammingThreshold ?? HASH_HAMMING_THRESHOLD;
  const storageProvider = getStorageProvider();
  const tempCache = options?.tempCache;
  const n = rows.length;

  // Compute hashes for all images
  const fileMD5s: (string | null)[] = new Array(n).fill(null);
  const pHashes: (string | null)[] = new Array(n).fill(null);
  const dHashes: (string | null)[] = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    try {
      const localPath = tempCache
        ? await tempCache.get(rows[i].file_path)
        : await storageProvider.downloadToTemp(rows[i].file_path);
      try {
        fileMD5s[i] = computeFileMD5(localPath);
        const [pHash, dHash] = await Promise.all([
          computePHash(localPath),
          computeHash(localPath),
        ]);
        pHashes[i] = pHash;
        dHashes[i] = dHash;
      } finally {
        // Only clean up if not using cache (cache handles cleanup)
        if (!tempCache) {
          try { fs.unlinkSync(localPath); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      console.warn(`[hybridDedup] Layer 0: hash computation failed for ${rows[i].id}: ${err}`);
      // Leave all hashes as null — this image will pass through to Layer 1
    }
  }

  const confirmedPairs: Array<{ i: number; j: number }> = [];
  const confirmedIndices = new Set<number>();

  // Compare all pairs
  for (let i = 0; i < n; i++) {
    // Skip images with no hashes at all
    if (fileMD5s[i] === null && pHashes[i] === null && dHashes[i] === null) continue;

    for (let j = i + 1; j < n; j++) {
      if (fileMD5s[j] === null && pHashes[j] === null && dHashes[j] === null) continue;

      let isConfirmed = false;

      // Check file MD5 exact match
      if (fileMD5s[i] !== null && fileMD5s[j] !== null && fileMD5s[i] === fileMD5s[j]) {
        isConfirmed = true;
      }

      // Check pHash + dHash dual match
      if (!isConfirmed && pHashes[i] !== null && pHashes[j] !== null &&
          dHashes[i] !== null && dHashes[j] !== null) {
        const pDist = hammingDistance(pHashes[i]!, pHashes[j]!);
        const dDist = hammingDistance(dHashes[i]!, dHashes[j]!);
        if (pDist <= threshold && dDist <= threshold) {
          isConfirmed = true;
        }
      }

      if (isConfirmed) {
        confirmedPairs.push({ i, j });
        confirmedIndices.add(i);
        confirmedIndices.add(j);
      }
    }
  }

  return { confirmedPairs, pHashes, dHashes };
}


// ---------------------------------------------------------------------------
// Layer 1 — CLIP 三档粗筛
// ---------------------------------------------------------------------------

/**
 * Layer 1: 调用 Python CLIP 近邻搜索，返回确认对和灰区对。
 *
 * 对所有图片索引执行 CLIP 搜索（Layer 0 不再过滤索引）。
 * 返回的索引是相对于原始 rows 数组的全局索引。
 */
export async function runLayer1(
  rows: ImageRow[],
  remainingIndices: number[],
  pHashes: (string | null)[],
  dHashes: (string | null)[],
  options?: { clipTopK?: number; tempCache?: TempPathCache }
): Promise<Layer1Result> {
  if (remainingIndices.length < 2) {
    return { confirmedPairs: [], grayZonePairs: [] };
  }

  const storageProvider = getStorageProvider();
  const tempCache = options?.tempCache;

  // Download remaining images to temp paths for CLIP processing
  const tempPaths: string[] = [];
  const validIndices: number[] = [];

  for (const idx of remainingIndices) {
    try {
      const localPath = tempCache
        ? await tempCache.get(rows[idx].file_path)
        : await storageProvider.downloadToTemp(rows[idx].file_path);
      tempPaths.push(localPath);
      validIndices.push(idx);
    } catch (err) {
      console.warn(`[hybridDedup] Layer 1: failed to download ${rows[idx].id}: ${err}`);
    }
  }

  if (validIndices.length < 2) {
    // Clean up temp files only if not using cache
    if (!tempCache) {
      for (const p of tempPaths) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    }
    return { confirmedPairs: [], grayZonePairs: [] };
  }

  // Build hash data for Python (local indices → hash info)
  const hashData: Record<number, { pHash: string | null; dHash: string | null; seqIndex: number }> = {};
  for (let localIdx = 0; localIdx < validIndices.length; localIdx++) {
    const globalIdx = validIndices[localIdx];
    hashData[localIdx] = {
      pHash: pHashes[globalIdx] ?? null,
      dHash: dHashes[globalIdx] ?? null,
      seqIndex: globalIdx,
    };
  }

  try {
    const clipResult = await clipNeighborSearch(tempPaths, hashData, {
      topK: options?.clipTopK,
    });

    // Map local indices back to global indices
    const confirmedPairs: ClipCandidatePair[] = clipResult.confirmedPairs.map(p => ({
      i: validIndices[p.i],
      j: validIndices[p.j],
      similarity: p.similarity,
    }));

    const grayZonePairs: ClipCandidatePair[] = clipResult.grayZonePairs.map(p => ({
      i: validIndices[p.i],
      j: validIndices[p.j],
      similarity: p.similarity,
    }));

    return { confirmedPairs, grayZonePairs };
  } finally {
    // Clean up temp files only if not using cache
    if (!tempCache) {
      for (const p of tempPaths) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// DINOv2 + FAISS dedup (ML-enhanced Layer 1 alternative)
// ---------------------------------------------------------------------------

/**
 * ML-enhanced dedup using DINOv2 embeddings + FAISS cosine similarity.
 * Returns confirmed duplicate pairs directly (no gray zone — FAISS threshold is definitive).
 * Falls back to CLIP Layer 1 if ML service is unavailable.
 */
async function runDINOv2Dedup(
  rows: ImageRow[],
  indices: number[],
  options?: { tempCache?: TempPathCache; threshold?: number }
): Promise<Array<{ i: number; j: number }>> {
  if (indices.length < 2) return [];

  const storageProvider = getStorageProvider();
  const tempCache = options?.tempCache;
  const threshold = options?.threshold ?? 0.92;

  // Download images to temp paths
  const tempPaths: string[] = [];
  const validIndices: number[] = [];

  for (const idx of indices) {
    try {
      const localPath = tempCache
        ? await tempCache.get(rows[idx].file_path)
        : await storageProvider.downloadToTemp(rows[idx].file_path);
      tempPaths.push(localPath);
      validIndices.push(idx);
    } catch (err) {
      console.warn(`[hybridDedup] DINOv2: failed to download ${rows[idx].id}: ${err}`);
    }
  }

  if (validIndices.length < 2) return [];

  try {
    // Extract DINOv2 embeddings
    console.log(`[hybridDedup] DINOv2: extracting embeddings for ${validIndices.length} images...`);
    const embeddingResults = await extractEmbeddings(tempPaths);
    const embeddings = embeddingResults.map(r => r.embedding);

    // Find duplicate groups via FAISS
    console.log(`[hybridDedup] DINOv2: FAISS duplicate detection (threshold=${threshold})...`);
    const groups = await findDuplicateGroups(embeddings, threshold);

    // Convert groups to pairs (all pairs within each group)
    const confirmedPairs: Array<{ i: number; j: number }> = [];
    for (const group of groups) {
      for (let a = 0; a < group.length; a++) {
        for (let b = a + 1; b < group.length; b++) {
          // Map local indices back to global indices
          confirmedPairs.push({
            i: validIndices[group[a]],
            j: validIndices[group[b]],
          });
        }
      }
    }

    console.log(`[hybridDedup] DINOv2: ${groups.length} groups, ${confirmedPairs.length} confirmed pairs`);
    return confirmedPairs;
  } finally {
    if (!tempCache) {
      for (const p of tempPaths) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Strict Threshold 回退
// ---------------------------------------------------------------------------

/**
 * 对所有灰区对应用严格阈值回退。
 * similarity ≥ 0.955 → confirmed，否则丢弃。
 */
export function applyStrictThresholdToGrayPairs(
  grayZonePairs: ClipCandidatePair[]
): Array<{ i: number; j: number }> {
  const confirmed: Array<{ i: number; j: number }> = [];
  for (const pair of grayZonePairs) {
    if (applyStrictThreshold(pair.similarity)) {
      confirmed.push({ i: pair.i, j: pair.j });
    }
  }
  return confirmed;
}


// ---------------------------------------------------------------------------
// Layer 3 — Union-Find 分组 + 质量选择
// ---------------------------------------------------------------------------

/**
 * Layer 3: 合并所有确认对为重复组，选出每组最佳保留，更新数据库状态。
 *
 * @param rows - 所有图片行
 * @param allConfirmedPairs - 来自 Layer 0 + Layer 1 confirmed + Strict Threshold 确认的所有对
 * @returns DedupGroup 列表
 */
export async function runLayer3(
  rows: ImageRow[],
  allConfirmedPairs: Array<{ i: number; j: number }>,
  options?: { tempCache?: TempPathCache }
): Promise<{ groups: DedupGroup[]; kept: string[]; removed: string[] }> {
  const n = rows.length;
  const tempCache = options?.tempCache;

  if (allConfirmedPairs.length === 0) {
    return {
      groups: [],
      kept: rows.map(r => r.id),
      removed: [],
    };
  }

  // Union-Find merge
  const uf = new UnionFind(n);
  for (const pair of allConfirmedPairs) {
    uf.union(pair.i, pair.j);
  }

  const rawGroups = uf.getGroups(n);
  const storageProvider = getStorageProvider();
  const db = getDb();

  const dedupGroups: DedupGroup[] = [];
  const removedSet = new Set<number>();

  for (const groupIndices of rawGroups) {
    // Partition into active and trashed indices
    const activeIndices = groupIndices.filter(idx => rows[idx].status === 'active');
    const candidateIndices = activeIndices.length > 0 ? activeIndices : groupIndices;

    // If exactly one active image exists, select it directly without quality scoring
    let keepIndex: number;
    if (activeIndices.length === 1) {
      keepIndex = activeIndices[0];
    } else {
      // Compute quality scores for candidates — try ML-enhanced first
      const candidatePaths: string[] = [];
      const candidateIds: string[] = [];
      for (const idx of candidateIndices) {
        try {
          const localPath = tempCache
            ? await tempCache.get(rows[idx].file_path)
            : await storageProvider.downloadToTemp(rows[idx].file_path);
          candidatePaths.push(localPath);
          candidateIds.push(rows[idx].id);
        } catch {
          candidatePaths.push('');
          candidateIds.push(rows[idx].id);
        }
      }

      const mlScores = await computeMLEnhancedQuality(
        candidatePaths.filter(p => p !== ''),
        candidateIds.filter((_, i) => candidatePaths[i] !== '')
      );
      const scoreMap = new Map(mlScores.map(s => [s.mediaId, s.score]));

      const scores: number[] = candidateIds.map(id => scoreMap.get(id) ?? 0);

      // Find best (highest quality score) among candidates
      let bestCandidateIdx = 0;
      for (let k = 1; k < candidateIndices.length; k++) {
        if (scores[k] > scores[bestCandidateIdx]) {
          bestCandidateIdx = k;
        } else if (scores[k] === scores[bestCandidateIdx]) {
          // Tie-break: higher resolution
          const resA = (rows[candidateIndices[bestCandidateIdx]].width ?? 0) * (rows[candidateIndices[bestCandidateIdx]].height ?? 0);
          const resB = (rows[candidateIndices[k]].width ?? 0) * (rows[candidateIndices[k]].height ?? 0);
          if (resB > resA) {
            bestCandidateIdx = k;
          } else if (resB === resA) {
            // Tie-break: larger file size
            if (rows[candidateIndices[k]].file_size > rows[candidateIndices[bestCandidateIdx]].file_size) {
              bestCandidateIdx = k;
            } else if (rows[candidateIndices[k]].file_size === rows[candidateIndices[bestCandidateIdx]].file_size) {
              // Tie-break: earlier in sequence (lower index)
              if (candidateIndices[k] < candidateIndices[bestCandidateIdx]) {
                bestCandidateIdx = k;
              }
            }
          }
        }
      }

      keepIndex = candidateIndices[bestCandidateIdx];
    }
    dedupGroups.push({ indices: groupIndices, keepIndex });

    // Mark non-best as removed
    for (let k = 0; k < groupIndices.length; k++) {
      const idx = groupIndices[k];
      if (idx === keepIndex) continue;
      removedSet.add(idx);

      const row = rows[idx];
      if (row.status === 'trashed') {
        // Already trashed → append ',duplicate' to reason
        const newReason = row.trashed_reason
          ? `${row.trashed_reason},duplicate`
          : 'duplicate';
        db.prepare(
          'UPDATE media_items SET trashed_reason = ? WHERE id = ?'
        ).run(newReason, row.id);
      } else {
        // Active → trash with reason 'duplicate'
        db.prepare(
          "UPDATE media_items SET status = 'trashed', trashed_reason = 'duplicate' WHERE id = ?"
        ).run(row.id);
      }
    }
  }

  // Build kept/removed lists
  const kept: string[] = [];
  const removed: string[] = [];
  for (let i = 0; i < n; i++) {
    if (removedSet.has(i)) {
      removed.push(rows[i].id);
    } else {
      kept.push(rows[i].id);
    }
  }

  return { groups: dedupGroups, kept, removed };
}


// ---------------------------------------------------------------------------
// Main Entry — hybridDeduplicate
// ---------------------------------------------------------------------------

/**
 * 四层混合去重入口。
 *
 * Layer 0: Hash 预过滤
 * Layer 1: CLIP 三档粗筛
 * Layer 2: LLM 逐对精判（有已配置 provider 时）/ Strict Threshold 回退（无 provider 时）
 * Layer 3: Union-Find 分组 + 质量选择
 *
 * 自动检测已配置的 LLM provider，支持级联回退。
 * 无 provider 时保持 MVP 行为（Strict Threshold 回退）。
 * 返回与现有 DedupResult 兼容的结果。
 */
export async function hybridDeduplicate(
  tripId: string,
  options?: HybridDedupOptions
): Promise<DedupResult> {
  const db = getDb();

  // Query all active + trashed images for the trip, ordered by created_at
  const rows = db.prepare(
    `SELECT id, file_path, original_filename, sharpness_score, blur_status, width, height,
            file_size, status, trashed_reason, created_at
     FROM media_items
     WHERE trip_id = ? AND media_type = 'image' AND status = 'active'
     ORDER BY created_at ASC`
  ).all(tripId) as ImageRow[];

  if (rows.length < 2) {
    return {
      kept: rows.map(r => r.id),
      removed: [],
      removedCount: 0,
    };
  }

  const onProgress = options?.onProgress;
  const tempCache = options?.tempCache;

  console.log(`[hybridDedup] Starting hybrid dedup for trip ${tripId} with ${rows.length} images`);

  // ---- Layer 0: Hash 预过滤 ----
  onProgress?.('layer0', 'start');
  console.log('[hybridDedup] Layer 0: Hash pre-filter...');
  const layer0Result = await runLayer0(rows, {
    hashHammingThreshold: options?.hashHammingThreshold,
    tempCache,
  });
  console.log(`[hybridDedup] Layer 0: ${layer0Result.confirmedPairs.length} confirmed pairs, ${rows.length} total passed to Layer 1`);
  onProgress?.('layer0', 'complete', `${layer0Result.confirmedPairs.length} confirmed, ${rows.length} total passed to Layer 1`);

  // ---- Python unavailable fallback: skip Layer 1 & 2, go straight to Layer 3 ----
  if (options?.pythonAvailable === false) {
    console.log('[hybridDedup] Python unavailable — skipping Layer 1 & 2, proceeding to Layer 3 with Layer 0 results only');

    onProgress?.('layer3', 'start');
    console.log('[hybridDedup] Layer 3: Union-Find grouping + quality selection...');
    const layer3Result = await runLayer3(rows, [...layer0Result.confirmedPairs], { tempCache });
    console.log(`[hybridDedup] Layer 3: ${layer3Result.groups.length} groups, ${layer3Result.removed.length} removed`);
    onProgress?.('layer3', 'complete', `${layer3Result.groups.length} groups, ${layer3Result.removed.length} removed`);

    return {
      kept: layer3Result.kept,
      removed: layer3Result.removed,
      removedCount: layer3Result.removed.length,
    };
  }

  // Reuse pHash/dHash from Layer 0 for Layer 1
  const allIndices = Array.from({ length: rows.length }, (_, i) => i);

  // ---- Try ML-enhanced dedup (DINOv2 + FAISS) first, fall back to CLIP ----
  let mlDedupPairs: Array<{ i: number; j: number }> | null = null;
  let usedMLDedup = false;

  const mlAvailable = await isMLServiceAvailable();
  if (mlAvailable) {
    try {
      onProgress?.('layer1', 'start');
      console.log('[hybridDedup] Layer 1 (ML): DINOv2 + FAISS dedup...');
      const dinoThreshold = parseFloat(process.env.DINOV2_DEDUP_THRESHOLD ?? '0.92');
      mlDedupPairs = await runDINOv2Dedup(rows, allIndices, { tempCache, threshold: dinoThreshold });
      usedMLDedup = true;
      console.log(`[hybridDedup] Layer 1 (ML): ${mlDedupPairs.length} confirmed pairs via DINOv2`);
      onProgress?.('layer1', 'complete', `${mlDedupPairs.length} confirmed pairs (DINOv2+FAISS)`);
    } catch (err) {
      console.warn(`[hybridDedup] DINOv2 dedup failed, falling back to CLIP: ${err}`);
      mlDedupPairs = null;
    }
  }

  if (!usedMLDedup) {
    // ---- Layer 1: CLIP 三档粗筛 (fallback) ----
    onProgress?.('layer1', 'start');
    console.log('[hybridDedup] Layer 1: CLIP coarse filter...');
    const layer1Result = await runLayer1(rows, allIndices, layer0Result.pHashes, layer0Result.dHashes, {
      clipTopK: options?.clipTopK,
      tempCache,
    });
    console.log(`[hybridDedup] Layer 1: ${layer1Result.confirmedPairs.length} confirmed, ${layer1Result.grayZonePairs.length} gray zone`);
    onProgress?.('layer1', 'complete', `${layer1Result.confirmedPairs.length} confirmed, ${layer1Result.grayZonePairs.length} gray zone`);

    // ---- Layer 2 / Strict Threshold: 灰区对判定 ----
    let grayConfirmedPairs: Array<{ i: number; j: number }> = [];

    if (layer1Result.grayZonePairs.length > 0) {
      // Detect configured LLM providers
      const providers = detectConfiguredProviders(options?.preferredProvider);

      if (providers.length > 0) {
        // Layer 2: LLM 逐对精判
        onProgress?.('layer2', 'start');
        console.log(`[hybridDedup] Layer 2: LLM pair review with ${providers.length} provider(s) [${providers.map(p => p.type).join(', ')}]...`);

        // Build PairReviewRequest list — download images to temp for LLM review
        const pairRequests: PairReviewRequest[] = [];
        const tempFilePaths: string[] = [];
        const pairIndexMap: Array<{ i: number; j: number }> = [];

        for (const grayPair of layer1Result.grayZonePairs) {
          try {
            const sp = getStorageProvider();
            const localPathA = tempCache
              ? await tempCache.get(rows[grayPair.i].file_path)
              : await sp.downloadToTemp(rows[grayPair.i].file_path);
            const localPathB = tempCache
              ? await tempCache.get(rows[grayPair.j].file_path)
              : await sp.downloadToTemp(rows[grayPair.j].file_path);
            if (!tempCache) {
              tempFilePaths.push(localPathA, localPathB);
            }

            pairRequests.push({
              imageA: { id: rows[grayPair.i].id, filePath: localPathA },
              imageB: { id: rows[grayPair.j].id, filePath: localPathB },
              clipSimilarity: grayPair.similarity,
            });
            pairIndexMap.push({ i: grayPair.i, j: grayPair.j });
          } catch (err) {
            console.warn(`[hybridDedup] Layer 2: failed to download images for pair (${rows[grayPair.i].id}, ${rows[grayPair.j].id}): ${err}`);
            // Fall back to strict threshold for this pair
            if (applyStrictThreshold(grayPair.similarity)) {
              grayConfirmedPairs.push({ i: grayPair.i, j: grayPair.j });
            }
          }
        }

        try {
          if (pairRequests.length > 0) {
            const reviewResults = await reviewPairs(pairRequests, providers);

            let llmSuccessCount = 0;
            let llmFallbackCount = 0;

            for (let k = 0; k < reviewResults.length; k++) {
              const result = reviewResults[k];
              if (result.isDuplicate) {
                grayConfirmedPairs.push(pairIndexMap[k]);
              }
              if (result.fellBackToThreshold) {
                llmFallbackCount++;
              } else {
                llmSuccessCount++;
              }
            }

            // Check if all LLM calls failed (all fell back to threshold)
            if (llmSuccessCount === 0 && llmFallbackCount > 0) {
              console.warn(
                `[hybridDedup] Layer 2: All LLM providers failed for all ${llmFallbackCount} gray zone pairs. ` +
                `Results are based on Strict Threshold fallback. LLM dedup is currently unavailable.`
              );
            } else {
              console.log(
                `[hybridDedup] Layer 2: ${llmSuccessCount} pairs reviewed by LLM, ${llmFallbackCount} fell back to threshold, ` +
                `${grayConfirmedPairs.length} confirmed as duplicates`
              );
            }
          }
        } finally {
          // Clean up temp files only if not using cache
          if (!tempCache) {
            for (const p of tempFilePaths) {
              try { fs.unlinkSync(p); } catch { /* ignore */ }
            }
          }
        }

        onProgress?.('layer2', 'complete', `${grayConfirmedPairs.length} confirmed from ${layer1Result.grayZonePairs.length} gray zone pairs`);
      } else {
        // No providers available — Strict Threshold 回退 (MVP behavior)
        onProgress?.('strictThreshold', 'start');
        console.log('[hybridDedup] No LLM providers configured. Strict Threshold fallback for gray zone pairs...');
        grayConfirmedPairs = applyStrictThresholdToGrayPairs(layer1Result.grayZonePairs);
        console.log(`[hybridDedup] Strict Threshold: ${grayConfirmedPairs.length} confirmed from ${layer1Result.grayZonePairs.length} gray zone pairs`);
        onProgress?.('strictThreshold', 'complete', `${grayConfirmedPairs.length} confirmed from ${layer1Result.grayZonePairs.length} gray zone pairs`);
      }
    }

    // Combine CLIP results
    mlDedupPairs = [
      ...layer1Result.confirmedPairs.map(p => ({ i: p.i, j: p.j })),
      ...grayConfirmedPairs,
    ];
  }

  // ---- Layer 3: Union-Find 分组 + 质量选择 ----
  onProgress?.('layer3', 'start');
  console.log('[hybridDedup] Layer 3: Union-Find grouping + quality selection...');
  const allConfirmedPairs: Array<{ i: number; j: number }> = [
    ...layer0Result.confirmedPairs,
    ...(mlDedupPairs ?? []),
  ];

  const layer3Result = await runLayer3(rows, allConfirmedPairs, { tempCache });
  console.log(`[hybridDedup] Layer 3: ${layer3Result.groups.length} groups, ${layer3Result.removed.length} removed`);
  onProgress?.('layer3', 'complete', `${layer3Result.groups.length} groups, ${layer3Result.removed.length} removed`);

  return {
    kept: layer3Result.kept,
    removed: layer3Result.removed,
    removedCount: layer3Result.removed.length,
  };
}
