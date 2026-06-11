/**
 * Global Similarity Candidate Generation
 *
 * Finds similar photo pairs across an entire trip using DINOv2 embeddings
 * regardless of capture-time proximity, then resolves clusters using a tiered
 * approach: local quality for high-confidence matches, VLM for gray-zone, and
 * conservative fallback (keep all) when VLM fails on uncertain clusters.
 */

import type { PipelineProgressCallback, VLMCallStats as SharedVLMCallStats } from '../pipeline/types';
import { recordVLMSuccess, recordVLMFailure, createVLMCallStatsTracker } from '../pipeline/types';
import { getDb } from '../../database';
import { getStorageProvider } from '../../storage/factory';
import { resizeForAnalysis } from '../bedrockClient';
import {
  extractEmbeddings,
  isMLServiceAvailable,
} from '../mlQualityService';
import { PROCESS_THRESHOLDS } from '../dedupThresholds';
import { callVLM, isVLMAvailable } from './vlmClient';
import {
  buildClusters,
  filterTrashCandidates,
  findClusterMedoid,
  type ClusterMetadata,
  type BuildClustersResult,
  type SimilarityPair,
} from './unionFind';

// Re-export Union-Find types for downstream use (e.g., tiered resolution in task 6.4)
export type { ClusterMetadata, BuildClustersResult, SimilarityPair };
export { filterTrashCandidates, findClusterMedoid };

// --- Types ---

export type SelectorSource = 'local_quality' | 'vlm' | 'fallback_keep_all';

export interface ClusterDecision {
  clusterId: string;
  selectedMediaId: string | null; // null when selectorSource='fallback_keep_all'
  trashedMediaIds: string[];
  keepReasons: string[]; // e.g. ["highest_quality_score", "sharpest"]
  trashReasons: string[]; // e.g. ["near_duplicate_worse"]
  selectorSource: SelectorSource;
  confidence: number; // 0.0-1.0
  maxSimilarity: number;
  pairEvidence: Array<{ i: string; j: string; similarity: number }>;
  warnings: string[]; // e.g. ["vlm_failed_using_quality_fallback"]
}

export interface GlobalSimilarityResult {
  clusters: ClusterDecision[];
  totalPairsFound: number;
  embeddingsUsed: boolean;
  vlmCallsMade: number;
  vlmCallsFailed: number;
  localQualityResolved: number; // clusters resolved without VLM
  vlmResolved: number; // clusters resolved by VLM
  fallbackKeptAll: number; // clusters where VLM failed on gray-zone
}

// --- Quality Selection Types ---

export interface CurationCandidate {
  mediaId: string;
  sharpnessScore: number;
  aestheticScore: number;
  exposureScore: number;
  overexposureQualityPenalty: number; // 0 normally, -0.15 for mild overexposure
}

// --- Pair Classification Types ---

export type PairClassification = 'confirmed' | 'gray_zone' | 'skip';

export interface ClassifiedPair {
  i: string; // mediaId of first image
  j: string; // mediaId of second image
  similarity: number;
  classification: PairClassification;
}

// --- Quality Selector ---

/**
 * Select the best quality candidate from a cluster.
 * Composite score: sharpness*0.4 + aesthetic*0.3 + exposure*0.3 + overexposureQualityPenalty
 * Ties broken by: higher resolution > newer capture time (not available here, so first in array wins)
 *
 * @param candidates - non-empty array of candidates to evaluate
 * @returns mediaId of the highest-scoring candidate
 * @throws if candidates array is empty
 */
export function selectBestByQuality(candidates: CurationCandidate[]): string {
  if (candidates.length === 0) {
    throw new Error('selectBestByQuality requires a non-empty candidate list');
  }

  let bestMediaId = candidates[0].mediaId;
  let bestScore = computeCompositeScore(candidates[0]);

  for (let i = 1; i < candidates.length; i++) {
    const score = computeCompositeScore(candidates[i]);
    if (score > bestScore) {
      bestScore = score;
      bestMediaId = candidates[i].mediaId;
    }
  }

  return bestMediaId;
}

/**
 * Compute the composite quality score for a candidate.
 * Formula: sharpness*0.4 + aesthetic*0.3 + exposure*0.3 + overexposureQualityPenalty
 */
export function computeCompositeScore(candidate: CurationCandidate): number {
  return (
    candidate.sharpnessScore * 0.4 +
    candidate.aestheticScore * 0.3 +
    candidate.exposureScore * 0.3 +
    candidate.overexposureQualityPenalty
  );
}

// --- Cosine Similarity ---

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// --- Top-K Nearest Neighbor ---

export interface NeighborPair {
  i: number; // index into mediaIds array
  j: number; // index into mediaIds array
  similarity: number;
}

/**
 * Compute top-K nearest neighbors for each embedding using cosine similarity.
 * Returns deduplicated pairs (i < j) sorted by descending similarity.
 *
 * @param embeddings - array of embedding vectors (null entries are skipped)
 * @param topK - max neighbors per image
 * @returns deduplicated neighbor pairs
 */
export function computeTopKNeighbors(
  embeddings: (number[] | null)[],
  topK: number,
): NeighborPair[] {
  const n = embeddings.length;
  // For each image, keep track of its top-K neighbors
  const topKPerImage: Array<Array<{ idx: number; sim: number }>> = Array.from(
    { length: n },
    () => [],
  );

  // Compute all pairwise similarities
  for (let i = 0; i < n; i++) {
    if (!embeddings[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (!embeddings[j]) continue;
      const sim = cosineSimilarity(embeddings[i]!, embeddings[j]!);

      // Insert into i's top-K
      insertTopK(topKPerImage[i], { idx: j, sim }, topK);
      // Insert into j's top-K
      insertTopK(topKPerImage[j], { idx: i, sim }, topK);
    }
  }

  // Deduplicate: collect unique pairs (i < j)
  const pairSet = new Set<string>();
  const result: NeighborPair[] = [];

  for (let i = 0; i < n; i++) {
    for (const neighbor of topKPerImage[i]) {
      const lo = Math.min(i, neighbor.idx);
      const hi = Math.max(i, neighbor.idx);
      const key = `${lo}:${hi}`;
      if (!pairSet.has(key)) {
        pairSet.add(key);
        result.push({ i: lo, j: hi, similarity: neighbor.sim });
      }
    }
  }

  // Sort by descending similarity
  result.sort((a, b) => b.similarity - a.similarity);
  return result;
}

/**
 * Insert a neighbor into a sorted top-K list (descending by similarity).
 * Maintains at most `k` entries.
 */
function insertTopK(
  list: Array<{ idx: number; sim: number }>,
  entry: { idx: number; sim: number },
  k: number,
): void {
  // If list is not full, insert and sort
  if (list.length < k) {
    list.push(entry);
    list.sort((a, b) => b.sim - a.sim);
    return;
  }
  // If new entry is better than worst in list, replace worst
  if (entry.sim > list[list.length - 1].sim) {
    list[list.length - 1] = entry;
    list.sort((a, b) => b.sim - a.sim);
  }
}

// --- Pair Classification ---

/**
 * Classify neighbor pairs into confirmed, gray-zone, or skip based on
 * DINOv2 thresholds from PROCESS_THRESHOLDS.
 *
 * - Confirmed: similarity ≥ dinov2ConfirmedThreshold (default 0.88)
 * - Gray-zone: similarity between dinov2GrayLowThreshold (default 0.75) and confirmed
 * - Skip: below dinov2GrayLowThreshold
 *
 * @param pairs - neighbor pairs with similarity values
 * @param mediaIds - mapping from index to mediaId
 * @returns classified pairs (only confirmed and gray-zone, skips are filtered out)
 */
export function classifyPairs(
  pairs: NeighborPair[],
  mediaIds: string[],
): ClassifiedPair[] {
  const { dinov2ConfirmedThreshold, dinov2GrayLowThreshold } = PROCESS_THRESHOLDS;
  const classified: ClassifiedPair[] = [];

  for (const pair of pairs) {
    let classification: PairClassification;

    if (pair.similarity >= dinov2ConfirmedThreshold) {
      classification = 'confirmed';
    } else if (pair.similarity >= dinov2GrayLowThreshold) {
      classification = 'gray_zone';
    } else {
      // Below threshold — skip entirely
      continue;
    }

    classified.push({
      i: mediaIds[pair.i],
      j: mediaIds[pair.j],
      similarity: pair.similarity,
      classification,
    });
  }

  return classified;
}

// --- VLM Call Stats Tracker ---

/**
 * VLMCallStats type alias — uses the shared tracker from pipeline/types.ts.
 * AI stages increment the shared tracker in real-time during VLM calls.
 */
export type VLMCallStats = SharedVLMCallStats;

/**
 * Create a new VLMCallStats tracker with all counters at zero.
 * Re-exports from pipeline/types for backward compatibility.
 */
export function createVLMCallStats(): VLMCallStats {
  return createVLMCallStatsTracker();
}

// --- VLM Selection for Global Similarity ---

/** Maximum parallel image downloads within a single VLM call */
const VLM_IMAGE_CONCURRENCY = 5;

/**
 * Build a VLM prompt for selecting the best photo from a cluster of similar images.
 */
function buildClusterSelectionPrompt(imageCount: number): string {
  return `You are a professional photo curator. You are shown ${imageCount} very similar photos of the same subject or scene.

Select EXACTLY 1 best photo to keep. The rest will be trashed as near-duplicates.

SELECTION CRITERIA (in priority order):
1. Sharpness and clarity - subject in focus, no motion blur
2. Subject completeness - main subject fully visible, not cut off
3. Exposure quality - well-exposed, not blown out or too dark
4. Composition - good framing, rule of thirds
5. Color quality - natural colors, good white balance

FOR UNDERWATER PHOTOS:
- Blue/green color cast is NORMAL, do not penalize
- Evaluate based on subject visibility and sharpness
- Prefer shots where marine life is most clearly visible

RESPOND IN THIS EXACT JSON FORMAT:
{
  "keep": <0-based index of the best photo>,
  "reason": "<brief reason for selection>"
}

IMPORTANT:
- Index is 0-based (first photo is 0, last is ${imageCount - 1})
- You must select exactly 1 photo to keep`;
}

/**
 * Parse the VLM response for cluster best-selection.
 * Returns the 0-based index of the selected image, or null if parsing fails.
 */
function parseClusterVLMResponse(responseText: string, imageCount: number): number | null {
  // Try extracting JSON from markdown fences or raw text
  let jsonStr: string | null = null;

  const fenceMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  } else {
    const trimmed = responseText.trim();
    if (trimmed.startsWith('{')) {
      jsonStr = trimmed;
    } else {
      // Scan for first balanced {}
      const firstBrace = responseText.indexOf('{');
      if (firstBrace !== -1) {
        let depth = 0;
        for (let i = firstBrace; i < responseText.length; i++) {
          if (responseText[i] === '{') depth++;
          else if (responseText[i] === '}') {
            depth--;
            if (depth === 0) {
              jsonStr = responseText.slice(firstBrace, i + 1);
              break;
            }
          }
        }
      }
    }
  }

  if (!jsonStr) return null;

  try {
    const raw = JSON.parse(jsonStr);
    if (raw && typeof raw === 'object' && typeof raw.keep === 'number') {
      const idx = raw.keep;
      if (Number.isInteger(idx) && idx >= 0 && idx < imageCount) {
        return idx;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Call VLM to select the best image from a cluster.
 * Downloads images, resizes them, and sends to the VLM provider.
 *
 * @param memberMediaIds - mediaIds in the cluster
 * @param filePaths - corresponding file paths (from DB)
 * @param vlmStats - shared stats tracker to increment
 * @returns index of selected image, or null on failure
 */
async function callVLMForCluster(
  memberMediaIds: string[],
  filePaths: Map<string, string>,
  vlmStats: VLMCallStats | null,
): Promise<number | null> {
  const storageProvider = getStorageProvider();

  try {
    // Download and resize images in parallel
    const images: Array<{ base64: string; mediaType: string }> = [];
    for (let batch = 0; batch < memberMediaIds.length; batch += VLM_IMAGE_CONCURRENCY) {
      const chunk = memberMediaIds.slice(batch, batch + VLM_IMAGE_CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (mediaId) => {
          const filePath = filePaths.get(mediaId);
          if (!filePath) throw new Error(`No file_path for ${mediaId}`);
          const localPath = await storageProvider.downloadToTemp(filePath);
          const base64 = await resizeForAnalysis(localPath);
          return { base64, mediaType: 'image/jpeg' };
        }),
      );
      images.push(...chunkResults);
    }

    const prompt = buildClusterSelectionPrompt(memberMediaIds.length);
    const response = await callVLM({ images, prompt, maxTokens: 512 });

    const selectedIdx = parseClusterVLMResponse(response.text, memberMediaIds.length);
    if (selectedIdx === null) {
      // Parse failure
      if (vlmStats) recordVLMFailure(vlmStats, 'globalSimilarity', 'parse');
      console.warn(
        `[globalSimilarity] VLM parse failure for cluster, response: ${response.text.slice(0, 200)}`,
      );
      return null;
    }

    // Success
    if (vlmStats) recordVLMSuccess(vlmStats, 'globalSimilarity');
    return selectedIdx;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Categorize failure type
    if (vlmStats) {
      const lower = msg.toLowerCase();
      if (lower.includes('timeout') || lower.includes('timed out')) {
        recordVLMFailure(vlmStats, 'globalSimilarity', 'timeout');
      } else if (
        lower.includes('401') || lower.includes('403') ||
        lower.includes('authentication') || lower.includes('unauthorized')
      ) {
        recordVLMFailure(vlmStats, 'globalSimilarity', 'auth');
      } else {
        recordVLMFailure(vlmStats, 'globalSimilarity', 'other');
      }
    }

    console.warn(`[globalSimilarity] VLM call failed: ${msg}`);
    return null;
  }
}

// --- Quality Score Fetch ---

/** DB row shape for quality scores. */
interface QualityRow {
  id: string;
  file_path: string;
  sharpness_score: number | null;
  quality_score: number | null;
  exposure_score: number | null;
}

/**
 * Fetch quality scores and file paths for cluster members from the database.
 * Returns a map of mediaId → CurationCandidate with quality scores.
 *
 * For missing quality scores, defaults to 0.5 (neutral midpoint).
 */
function fetchQualityScores(
  mediaIds: string[],
  overexposurePenalties: Map<string, number>,
): { candidates: Map<string, CurationCandidate>; filePaths: Map<string, string> } {
  const db = getDb();
  const placeholders = mediaIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, file_path, sharpness_score, quality_score, exposure_score
       FROM media_items WHERE id IN (${placeholders})`,
    )
    .all(...mediaIds) as QualityRow[];

  const candidates = new Map<string, CurationCandidate>();
  const filePaths = new Map<string, string>();

  for (const row of rows) {
    filePaths.set(row.id, row.file_path);

    // Use available scores, default to 0.5 for missing values
    const sharpness = row.sharpness_score ?? 0.5;
    // quality_score is a composite already; use it as aesthetic proxy
    const aesthetic = row.quality_score ?? 0.5;
    const exposure = row.exposure_score ?? 0.5;
    const penalty = overexposurePenalties.get(row.id) ?? 0;

    candidates.set(row.id, {
      mediaId: row.id,
      sharpnessScore: sharpness,
      aestheticScore: aesthetic,
      exposureScore: exposure,
      overexposureQualityPenalty: penalty,
    });
  }

  return { candidates, filePaths };
}

// --- Cluster Resolution ---

/**
 * Resolve a single cluster using tiered resolution logic.
 *
 * Tiered resolution table:
 * - Confirmed-only cluster → local quality selector (with direct-edge validation)
 * - Mixed/gray-zone clusters → VLM selection
 * - VLM failure on confirmed cluster → still use local quality
 * - VLM failure on gray-zone cluster → fallback_keep_all, log warning
 *
 * @param cluster - cluster metadata from Union-Find
 * @param candidates - quality scores for all members
 * @param filePaths - file paths for VLM image loading
 * @param vlmStats - shared VLM call stats tracker (incremented in real-time)
 * @returns ClusterDecision with full metadata
 */
async function resolveCluster(
  cluster: ClusterMetadata,
  candidates: Map<string, CurationCandidate>,
  filePaths: Map<string, string>,
  vlmStats: VLMCallStats | null,
): Promise<ClusterDecision> {
  const { clusterId, members, confirmedPairs, isConfirmedOnly } = cluster;
  const maxSim = confirmedPairs.length > 0
    ? Math.max(...confirmedPairs.map((p) => p.similarity))
    : 0;
  const pairEvidence = [
    ...confirmedPairs.map((p) => ({ i: p.i, j: p.j, similarity: p.similarity })),
    ...cluster.grayZonePairs.map((p) => ({ i: p.i, j: p.j, similarity: p.similarity })),
  ];

  // Helper: build a decision from local quality selection
  function resolveLocalQuality(warnings: string[] = []): ClusterDecision {
    const memberCandidates = members
      .map((m) => candidates.get(m))
      .filter((c): c is CurationCandidate => c !== undefined);

    if (memberCandidates.length === 0) {
      // No quality data — fallback keep all
      return {
        clusterId,
        selectedMediaId: null,
        trashedMediaIds: [],
        keepReasons: ['no_quality_data_available'],
        trashReasons: [],
        selectorSource: 'fallback_keep_all',
        confidence: 0,
        maxSimilarity: maxSim,
        pairEvidence,
        warnings: [...warnings, 'no_quality_data_fallback_keep_all'],
      };
    }

    const selectedMediaId = selectBestByQuality(memberCandidates);

    // Apply direct-edge validation (Constraint 3)
    const { trashable, skipped } = filterTrashCandidates(
      selectedMediaId,
      members,
      confirmedPairs,
    );

    if (skipped.length > 0) {
      console.log(
        `[globalSimilarity] Skipped trash for ${skipped.join(', ')}: no direct edge to selected/medoid`,
      );
    }

    return {
      clusterId,
      selectedMediaId,
      trashedMediaIds: trashable,
      keepReasons: ['highest_quality_score'],
      trashReasons: trashable.map(() => 'near_duplicate_worse'),
      selectorSource: 'local_quality',
      confidence: maxSim,
      maxSimilarity: maxSim,
      pairEvidence,
      warnings: [
        ...warnings,
        ...(skipped.length > 0
          ? [`skipped_no_direct_edge: ${skipped.join(', ')}`]
          : []),
      ],
    };
  }

  // --- Tiered resolution ---

  if (isConfirmedOnly) {
    // Confirmed-only cluster: use local quality selector directly
    // Even if VLM is available, we don't need it for high-confidence matches
    return resolveLocalQuality();
  }

  // Mixed or gray-zone cluster: try VLM
  const vlmAvailable = isVLMAvailable();
  if (!vlmAvailable) {
    if (confirmedPairs.length > 0) {
      // Has some confirmed pairs — safe to use local quality
      return resolveLocalQuality(['vlm_unavailable_using_local_quality']);
    }
    // Pure gray-zone with no VLM — conservative keep all
    return {
      clusterId,
      selectedMediaId: null,
      trashedMediaIds: [],
      keepReasons: ['vlm_unavailable_conservative_keep'],
      trashReasons: [],
      selectorSource: 'fallback_keep_all',
      confidence: 0,
      maxSimilarity: maxSim,
      pairEvidence,
      warnings: ['vlm_unavailable_fallback_keep_all'],
    };
  }

  // Call VLM for selection
  const selectedIdx = await callVLMForCluster(members, filePaths, vlmStats);

  if (selectedIdx !== null) {
    // VLM succeeded
    const selectedMediaId = members[selectedIdx];

    // Still apply direct-edge validation (Constraint 3)
    const { trashable, skipped } = filterTrashCandidates(
      selectedMediaId,
      members,
      confirmedPairs,
    );

    if (skipped.length > 0) {
      console.log(
        `[globalSimilarity] VLM selected ${selectedMediaId}, skipped trash for ${skipped.join(', ')}: no direct edge`,
      );
    }

    return {
      clusterId,
      selectedMediaId,
      trashedMediaIds: trashable,
      keepReasons: ['vlm_selected_best'],
      trashReasons: trashable.map(() => 'near_duplicate_worse'),
      selectorSource: 'vlm',
      confidence: maxSim,
      maxSimilarity: maxSim,
      pairEvidence,
      warnings: skipped.length > 0
        ? [`skipped_no_direct_edge: ${skipped.join(', ')}`]
        : [],
    };
  }

  // VLM failed — apply fallback based on cluster type
  if (confirmedPairs.length > 0) {
    // Has confirmed pairs — safe to fall back to local quality
    return resolveLocalQuality(['vlm_failed_using_quality_fallback']);
  }

  // VLM failed on gray-zone cluster — conservative keep all
  console.warn(
    `[globalSimilarity] VLM failed on gray-zone cluster ${clusterId} (${members.length} members) — keeping all`,
  );
  return {
    clusterId,
    selectedMediaId: null,
    trashedMediaIds: [],
    keepReasons: ['vlm_failed_conservative_keep'],
    trashReasons: [],
    selectorSource: 'fallback_keep_all',
    confidence: 0,
    maxSimilarity: maxSim,
    pairEvidence,
    warnings: ['vlm_failed_on_gray_zone_cluster'],
  };
}

// --- Embedding Fetch ---

/** Mirrors the (non-exported) EmbeddingResult type from mlQualityService. */
interface EmbeddingResultShape {
  path: string;
  embedding: number[] | null;
  error: string | null;
}

/** DB row shape for media item lookup. */
interface MediaRow {
  id: string;
  file_path: string;
}

/** Concurrency limit for downloading images to temp paths. */
const DOWNLOAD_CONCURRENCY = 5;

/**
 * Fetch DINOv2 embeddings for the given media IDs.
 *
 * Steps:
 * 1. Check ML service availability
 * 2. Look up file_path for each media ID from the database
 * 3. Download images to local temp paths via storage provider
 * 4. Call extractEmbeddings on valid local paths
 * 5. Return aligned array (null for failed downloads or extraction errors)
 *
 * @returns null if ML service is unavailable; otherwise an aligned array of embeddings
 */
export async function fetchEmbeddings(
  mediaIds: string[],
): Promise<(number[] | null)[] | null> {
  // Check ML service availability first
  const available = await isMLServiceAvailable();
  if (!available) {
    console.log('[globalDedup] ML service unavailable — skipping global similarity detection');
    return null;
  }

  if (mediaIds.length === 0) {
    return [];
  }

  // Look up file paths from database
  const db = getDb();
  const placeholders = mediaIds.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT id, file_path FROM media_items WHERE id IN (${placeholders})`)
    .all(...mediaIds) as MediaRow[];

  const filePathMap = new Map(rows.map((r) => [r.id, r.file_path]));

  // Download images to temp paths
  const storage = getStorageProvider();
  const localPaths: (string | null)[] = [];
  const validIndices: number[] = [];

  // Download with concurrency control
  for (let batch = 0; batch < mediaIds.length; batch += DOWNLOAD_CONCURRENCY) {
    const chunk = mediaIds.slice(batch, batch + DOWNLOAD_CONCURRENCY);
    const chunkResults = await Promise.allSettled(
      chunk.map(async (mediaId, offsetIdx) => {
        const idx = batch + offsetIdx;
        const filePath = filePathMap.get(mediaId);
        if (!filePath) {
          console.warn(`[globalDedup] No file_path found for mediaId=${mediaId}`);
          return null;
        }
        try {
          return await storage.downloadToTemp(filePath);
        } catch (err) {
          console.warn(`[globalDedup] Download failed for ${mediaId}: ${err}`);
          return null;
        }
      }),
    );

    for (let offsetIdx = 0; offsetIdx < chunkResults.length; offsetIdx++) {
      const idx = batch + offsetIdx;
      const result = chunkResults[offsetIdx];
      if (result.status === 'fulfilled' && result.value) {
        localPaths[idx] = result.value;
        validIndices.push(idx);
      } else {
        localPaths[idx] = null;
      }
    }
  }

  if (validIndices.length === 0) {
    console.warn('[globalDedup] No images could be downloaded for embedding extraction');
    return new Array(mediaIds.length).fill(null);
  }

  // Extract embeddings from valid paths
  const validPaths = validIndices.map((idx) => localPaths[idx] as string);

  let extracted: EmbeddingResultShape[];
  try {
    extracted = (await extractEmbeddings(validPaths)) as EmbeddingResultShape[];
  } catch (err) {
    console.warn(`[globalDedup] extractEmbeddings failed: ${err}`);
    return null;
  }

  // Align results back to original mediaIds order
  const aligned: (number[] | null)[] = new Array(mediaIds.length).fill(null);
  for (let k = 0; k < extracted.length; k++) {
    aligned[validIndices[k]] = extracted[k].embedding ?? null;
  }

  return aligned;
}

// --- Main Entry Point ---

/**
 * Run global similarity candidate generation and resolution for a trip.
 *
 * Algorithm (tiered resolution):
 * 1. Fetch DINOv2 embeddings for prelimActiveMediaIds
 * 2. Compute top-K nearest neighbors using cosine similarity
 * 3. Classify pairs: confirmed / gray-zone / skip
 * 4. Build clusters via two-phase Union-Find (confirmed only, then gray-zone evidence)
 * 5. Resolve each cluster: local quality / VLM / fallback_keep_all
 * 6. Return GlobalSimilarityResult with full per-cluster metadata
 *
 * @param tripId - the trip being processed
 * @param prelimActiveMediaIds - images not already trashed by blur/overexposure/dedup
 * @param options - optional progress callback and shared VLM stats tracker
 * @param options.onProgress - pipeline progress callback
 * @param options.vlmStats - shared VLMCallStats tracker (real-time increment, not retroactive)
 */
export async function runGlobalSimilarity(
  tripId: string,
  prelimActiveMediaIds: string[],
  options?: { onProgress?: PipelineProgressCallback; vlmStats?: VLMCallStats },
): Promise<GlobalSimilarityResult> {
  const emptyResult: GlobalSimilarityResult = {
    clusters: [],
    totalPairsFound: 0,
    embeddingsUsed: false,
    vlmCallsMade: 0,
    vlmCallsFailed: 0,
    localQualityResolved: 0,
    vlmResolved: 0,
    fallbackKeptAll: 0,
  };

  // Need at least 2 images to compare
  if (prelimActiveMediaIds.length < 2) {
    return emptyResult;
  }

  // Step 1: Fetch DINOv2 embeddings
  const embeddings = await fetchEmbeddings(prelimActiveMediaIds);
  if (!embeddings) {
    // ML service unavailable — skip entirely (log already emitted by fetchEmbeddings)
    return emptyResult;
  }

  // Step 2: Compute top-K nearest neighbors
  const topK = PROCESS_THRESHOLDS.globalSimilarityTopK;
  const neighborPairs = computeTopKNeighbors(embeddings, topK);

  // Step 3: Classify pairs into confirmed / gray-zone / skip
  const classifiedPairs = classifyPairs(neighborPairs, prelimActiveMediaIds);

  if (classifiedPairs.length === 0) {
    return { ...emptyResult, embeddingsUsed: true };
  }

  const confirmedPairs = classifiedPairs.filter((p) => p.classification === 'confirmed');
  const grayZonePairs = classifiedPairs.filter((p) => p.classification === 'gray_zone');

  console.log(
    `[globalDedup] Found ${classifiedPairs.length} candidate pairs ` +
    `(confirmed: ${confirmedPairs.length}, ` +
    `gray-zone: ${grayZonePairs.length})`,
  );

  // Step 4: Build clusters via two-phase Union-Find with chain-merge safeguards
  const confirmedSimilarityPairs: SimilarityPair[] = confirmedPairs.map((p) => ({
    i: p.i,
    j: p.j,
    similarity: p.similarity,
    classification: 'confirmed' as const,
  }));
  const grayZoneSimilarityPairs: SimilarityPair[] = grayZonePairs.map((p) => ({
    i: p.i,
    j: p.j,
    similarity: p.similarity,
    classification: 'gray_zone' as const,
  }));

  const clusterResult = buildClusters(confirmedSimilarityPairs, grayZoneSimilarityPairs);

  console.log(
    `[globalDedup] Built ${clusterResult.clusters.length} clusters ` +
    `(bridging pairs flagged for VLM: ${clusterResult.bridgingPairs.length})`,
  );

  // Log cluster details at debug level
  for (const cluster of clusterResult.clusters) {
    const type = cluster.isConfirmedOnly ? 'confirmed-only' : 'mixed/gray-zone';
    console.log(
      `[globalDedup]   cluster=${cluster.clusterId} members=${cluster.members.length} ` +
      `type=${type} confirmedPairs=${cluster.confirmedPairs.length} ` +
      `grayPairs=${cluster.grayZonePairs.length} vlmReviewPairs=${cluster.vlmReviewPairs.length}`,
    );
  }

  if (clusterResult.clusters.length === 0) {
    return { ...emptyResult, totalPairsFound: classifiedPairs.length, embeddingsUsed: true };
  }

  // Step 5-6: Tiered resolution per cluster
  // Collect all media IDs from clusters for quality score fetch
  const allClusterMembers = new Set<string>();
  for (const cluster of clusterResult.clusters) {
    for (const member of cluster.members) {
      allClusterMembers.add(member);
    }
  }

  // Fetch overexposure quality penalties from the processing contexts
  // (stored during overexposure detection stage). These are stored in DB
  // as part of the pipeline. We don't have direct access to ImageProcessContext
  // here, so we use 0 as default (the penalty is minor and only affects mild cases).
  const overexposurePenalties = new Map<string, number>();

  // Fetch quality scores and file paths from DB
  const { candidates, filePaths } = fetchQualityScores(
    Array.from(allClusterMembers),
    overexposurePenalties,
  );

  // Create VLM stats tracker for this stage (use shared if provided)
  const vlmStats = options?.vlmStats ?? null;

  // Resolve each cluster using tiered resolution
  const decisions: ClusterDecision[] = [];
  let localQualityResolved = 0;
  let vlmResolved = 0;
  let fallbackKeptAll = 0;

  for (const cluster of clusterResult.clusters) {
    const decision = await resolveCluster(cluster, candidates, filePaths, vlmStats);
    decisions.push(decision);

    switch (decision.selectorSource) {
      case 'local_quality':
        localQualityResolved++;
        break;
      case 'vlm':
        vlmResolved++;
        break;
      case 'fallback_keep_all':
        fallbackKeptAll++;
        break;
    }
  }

  const totalTrashed = decisions.reduce((sum, d) => sum + d.trashedMediaIds.length, 0);
  console.log(
    `[globalDedup] Resolution complete: ${decisions.length} clusters resolved ` +
    `(local_quality=${localQualityResolved}, vlm=${vlmResolved}, ` +
    `fallback_keep_all=${fallbackKeptAll}), ${totalTrashed} images trashed, ` +
    `VLM calls: ${vlmStats?.totalCalls ?? 0} total, ${vlmStats?.successfulCalls ?? 0} success, ` +
    `${vlmStats?.failedCalls ?? 0} failed`,
  );

  return {
    clusters: decisions,
    totalPairsFound: classifiedPairs.length,
    embeddingsUsed: true,
    vlmCallsMade: vlmStats?.totalCalls ?? 0,
    vlmCallsFailed: vlmStats?.failedCalls ?? 0,
    localQualityResolved,
    vlmResolved,
    fallbackKeptAll,
  };
}
