/**
 * Similarity Grouper
 *
 * Phase 1 of the Smart Curation engine. Groups CurationCandidates by visual
 * similarity using DINOv2 embeddings with tiered cosine-similarity thresholds:
 *
 *   - similarity >= EXACT_DUPLICATE_THRESHOLD (0.94)   → `exact_duplicate`
 *   - similarity >= NEAR_DUPLICATE_THRESHOLD (0.86) and < 0.94 → `near_duplicate_candidate`
 *   - similarity < 0.86                                → not grouped
 *
 * The grouping uses a Union-Find (disjoint-set) structure so transitive chains
 * (A~B, B~C ⇒ A,B,C in same group) are merged correctly. The group's type is
 * decided by the **maximum** similarity observed within the group: a single
 * exact-duplicate edge promotes the whole group to `exact_duplicate`.
 *
 * Supplementary hash signal (Requirement 1.6)
 * --------------------------------------------
 * Even when the DINOv2 cosine similarity for a pair lies in the near-duplicate
 * range, we additionally check pHash and dHash. If **both** hash hamming
 * distances are at or below the project-wide `HASH_HAMMING_THRESHOLD` then
 * the pair is treated as an exact duplicate (the pair's effective similarity
 * is bumped to 0.95). This catches "byte-different but pixel-identical"
 * pairs that the embedding model rates slightly below 0.94.
 *
 * Fallback path (Requirement 1.5)
 * --------------------------------
 * When the ML quality service is unavailable (or DINOv2 extraction fails),
 * the grouper degrades to pHash/dHash. A synthetic similarity is derived
 * from the smaller of the two hamming distances:
 *
 *   syntheticSimilarity = 1 - minHamming / 64
 *
 * The same tiered thresholds (0.94 / 0.86) are applied against the synthetic
 * similarity so the rest of the pipeline behaves identically. The returned
 * `similaritySource` is `phash` or `dhash` to flag the degraded mode.
 */

import fs from 'fs';
import {
  extractEmbeddings,
  findDuplicatePairs,
  isMLServiceAvailable,
} from '../mlQualityService';
import { computeHash, computePHash, hammingDistance } from '../dedupEngine';
import { HASH_HAMMING_THRESHOLD } from '../dedupThresholds';
import { UnionFind } from '../hybridDedupEngine';
import { getStorageProvider } from '../../storage/factory';
import type {
  CurationCandidate,
  CurationGroup,
  GroupType,
  SimilaritySource,
} from './smartCurationEngine';

// ---------------------------------------------------------------------------
// Public thresholds
// ---------------------------------------------------------------------------

/** Pairs at or above this cosine similarity are treated as exact duplicates. */
export const EXACT_DUPLICATE_THRESHOLD = 0.94;

/** Pairs at or above this similarity (but below the exact tier) are near-duplicates. */
export const NEAR_DUPLICATE_THRESHOLD = 0.86;

/** Synthetic similarity assigned when hashes confirm an exact duplicate. */
const HASH_CONFIRMED_SIMILARITY = 0.95;

/** Number of bits in a 64-bit pHash/dHash; used for hamming-to-similarity conversion. */
const HASH_BIT_COUNT = 64;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Raw similarity edge between two candidates, used internally for clustering. */
export interface SimilarityEdge {
  i: number;
  j: number;
  similarity: number;
  source: SimilaritySource;
}

interface DownloadedCandidate {
  index: number;
  candidate: CurationCandidate;
  localPath: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a stable, run-local group id. Group ids are not persisted so a
 * counter-based scheme is sufficient and keeps debug reports readable.
 */
function makeGroupId(seq: number): string {
  return `g-${String(seq + 1).padStart(3, '0')}`;
}

/**
 * Convert a hash hamming distance into a [0, 1] similarity value where 0
 * hamming = 1.0 and HASH_BIT_COUNT hamming = 0.0.
 */
function hammingToSimilarity(hamming: number): number {
  if (hamming < 0) return 1;
  if (hamming >= HASH_BIT_COUNT) return 0;
  return 1 - hamming / HASH_BIT_COUNT;
}

/**
 * Download every candidate's file to a local temp path, returning a parallel
 * array. Failures are tolerated — the corresponding entry's `localPath` is
 * `null` and the candidate effectively becomes ungrouped.
 *
 * The caller is responsible for cleaning up the returned temp paths via
 * `cleanupDownloads`.
 */
async function downloadCandidates(
  candidates: CurationCandidate[]
): Promise<DownloadedCandidate[]> {
  const provider = getStorageProvider();
  const results: DownloadedCandidate[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const localPath = await provider.downloadToTemp(candidate.filePath);
      results.push({ index: i, candidate, localPath });
    } catch (err) {
      console.warn(
        `[similarityGrouper] download failed for ${candidate.mediaId}: ${err}`
      );
      results.push({ index: i, candidate, localPath: null });
    }
  }

  return results;
}

/**
 * Best-effort cleanup of temp paths produced by `downloadCandidates`.
 * Skips entries where the local path equals the storage-relative path
 * (the local provider returns the original file path, which must not be
 * deleted).
 */
function cleanupDownloads(
  downloads: DownloadedCandidate[]
): void {
  for (const d of downloads) {
    if (!d.localPath) continue;
    if (d.localPath === d.candidate.filePath) continue;
    try {
      fs.unlinkSync(d.localPath);
    } catch {
      // ignore
    }
  }
}

/**
 * Compute pHash and dHash for every candidate that successfully downloaded.
 * Returns parallel arrays aligned with the original `candidates` ordering;
 * entries that could not be hashed (or could not be downloaded) are `null`.
 */
async function computeHashes(
  downloads: DownloadedCandidate[]
): Promise<{ pHashes: (string | null)[]; dHashes: (string | null)[] }> {
  const n = downloads.length;
  const pHashes: (string | null)[] = new Array(n).fill(null);
  const dHashes: (string | null)[] = new Array(n).fill(null);

  for (const d of downloads) {
    if (!d.localPath) continue;
    try {
      const [p, dh] = await Promise.all([
        computePHash(d.localPath),
        computeHash(d.localPath),
      ]);
      pHashes[d.index] = p;
      dHashes[d.index] = dh;
    } catch (err) {
      console.warn(
        `[similarityGrouper] hash compute failed for ${d.candidate.mediaId}: ${err}`
      );
    }
  }

  return { pHashes, dHashes };
}

/**
 * Apply the supplementary pHash/dHash signal to a DINOv2 edge. If both hashes
 * are available and both hamming distances are at or below
 * HASH_HAMMING_THRESHOLD, the edge is promoted to the exact tier by raising
 * its similarity to HASH_CONFIRMED_SIMILARITY (only when not already there).
 */
function maybeBoostByHashes(
  edge: SimilarityEdge,
  pHashes: (string | null)[],
  dHashes: (string | null)[]
): SimilarityEdge {
  if (edge.similarity >= EXACT_DUPLICATE_THRESHOLD) return edge;

  const pi = pHashes[edge.i];
  const pj = pHashes[edge.j];
  const di = dHashes[edge.i];
  const dj = dHashes[edge.j];

  if (!pi || !pj || !di || !dj) return edge;

  const pDist = hammingDistance(pi, pj);
  const dDist = hammingDistance(di, dj);

  if (pDist <= HASH_HAMMING_THRESHOLD && dDist <= HASH_HAMMING_THRESHOLD) {
    return { ...edge, similarity: HASH_CONFIRMED_SIMILARITY };
  }
  return edge;
}

/**
 * Produce similarity edges from pHash/dHash hamming distances.
 *
 * For each pair (i, j) with both hash kinds available we compute the smaller
 * hamming distance (more lenient), convert it to a synthetic similarity, and
 * emit an edge if the synthetic similarity is at or above the near-duplicate
 * threshold. The `source` reflects which hash family produced the smaller
 * distance — useful for the debug report.
 */
function buildHashEdges(
  pHashes: (string | null)[],
  dHashes: (string | null)[]
): SimilarityEdge[] {
  const edges: SimilarityEdge[] = [];
  const n = pHashes.length;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const pi = pHashes[i];
      const pj = pHashes[j];
      const di = dHashes[i];
      const dj = dHashes[j];

      // Need at least one hash kind in common to score this pair.
      const hasP = pi !== null && pj !== null;
      const hasD = di !== null && dj !== null;
      if (!hasP && !hasD) continue;

      const pDist = hasP ? hammingDistance(pi as string, pj as string) : Infinity;
      const dDist = hasD ? hammingDistance(di as string, dj as string) : Infinity;

      const minDist = Math.min(pDist, dDist);
      const sim = hammingToSimilarity(minDist);
      if (sim < NEAR_DUPLICATE_THRESHOLD) continue;

      const source: SimilaritySource = pDist <= dDist ? 'phash' : 'dhash';
      edges.push({ i, j, similarity: sim, source });
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Groups candidates by visual similarity using DINOv2 embeddings with
 * Union-Find clustering. Falls back to pHash/dHash if the ML service is
 * unavailable.
 *
 * Behaviour notes:
 *   - Returns groups of **2 or more** candidates only.
 *   - Singletons (and any candidate that did not match any edge) are returned
 *     in `ungrouped`. Their order matches the input order, filtered by
 *     non-membership.
 *   - The top-level `similaritySource` reflects the path actually used to
 *     produce the edges. Each group additionally carries the source of the
 *     edge that determined its `maxSimilarity`.
 */
export async function groupBySimilarity(
  candidates: CurationCandidate[]
): Promise<{
  groups: CurationGroup[];
  ungrouped: CurationCandidate[];
  similaritySource: SimilaritySource;
}> {
  // Trivial input — nothing to group.
  if (candidates.length < 2) {
    return {
      groups: [],
      ungrouped: [...candidates],
      similaritySource: 'dinov2',
    };
  }

  const downloads = await downloadCandidates(candidates);

  try {
    // Always compute hashes — they serve as either the fallback signal or as
    // a supplementary confirmation for DINOv2 edges in the exact tier.
    const { pHashes, dHashes } = await computeHashes(downloads);

    let edges: SimilarityEdge[] = [];
    let topLevelSource: SimilaritySource = 'dinov2';
    let mlSucceeded = false;

    const mlAvailable = await isMLServiceAvailable();
    if (mlAvailable) {
      const validForEmbedding = downloads.filter((d) => d.localPath !== null);
      if (validForEmbedding.length >= 2) {
        try {
          const paths = validForEmbedding.map((d) => d.localPath as string);
          const embeddingResults = await extractEmbeddings(paths);

          // Re-align embeddings to the original candidate index space.
          // `extractEmbeddings` preserves input order, so result[k] corresponds
          // to validForEmbedding[k].
          const embeddingsByOriginalIdx: (number[] | null)[] = new Array(
            candidates.length
          ).fill(null);
          for (let k = 0; k < embeddingResults.length; k++) {
            const originalIdx = validForEmbedding[k].index;
            embeddingsByOriginalIdx[originalIdx] =
              embeddingResults[k].embedding ?? null;
          }

          const pairs = await findDuplicatePairs(
            embeddingsByOriginalIdx,
            NEAR_DUPLICATE_THRESHOLD
          );

          edges = pairs.map<SimilarityEdge>((p) => ({
            i: p.i,
            j: p.j,
            similarity: p.similarity,
            source: 'dinov2',
          }));

          // Supplementary hash signal: promote near-duplicate edges to exact
          // when both pHash and dHash agree they are byte-identical.
          edges = edges.map((e) => maybeBoostByHashes(e, pHashes, dHashes));

          topLevelSource = 'dinov2';
          mlSucceeded = true;
        } catch (err) {
          console.warn(
            `[similarityGrouper] DINOv2 path failed, falling back to hash: ${err}`
          );
        }
      }
    } else {
      console.warn(
        '[similarityGrouper] ML service unavailable — using pHash/dHash fallback'
      );
    }

    if (!mlSucceeded) {
      edges = buildHashEdges(pHashes, dHashes);
      // Pick the source that contributed the largest share of edges, defaulting
      // to 'phash' when pHash is at least as good as dHash.
      let pCount = 0;
      let dCount = 0;
      for (const e of edges) {
        if (e.source === 'phash') pCount++;
        else if (e.source === 'dhash') dCount++;
      }
      topLevelSource = dCount > pCount ? 'dhash' : 'phash';
    }

    const { groups, memberIndices } = clusterEdges(candidates, edges);

    // Build ungrouped list: any candidate index not in a group, preserving
    // input order.
    const ungrouped: CurationCandidate[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (!memberIndices.has(i)) ungrouped.push(candidates[i]);
    }

    return {
      groups,
      ungrouped,
      similaritySource: topLevelSource,
    };
  } finally {
    cleanupDownloads(downloads);
  }
}

// ---------------------------------------------------------------------------
// Clustering — Union-Find over similarity edges
// ---------------------------------------------------------------------------

/**
 * Build CurationGroups from a flat list of similarity edges.
 *
 * Steps:
 *   1. Run Union-Find over all edges (regardless of tier). Any pair with
 *      similarity >= NEAR_DUPLICATE_THRESHOLD links the two candidates.
 *   2. For each connected component of size >= 2, find the maximum-similarity
 *      edge inside it. The group's type is determined by that maximum:
 *      `exact_duplicate` if max >= 0.94, otherwise `near_duplicate_candidate`.
 *   3. The group's `similaritySource` mirrors the source of the maximum edge,
 *      so debug reports surface which signal triggered the classification.
 *
 * Exported for unit testing of the pure clustering logic without touching
 * the embedding/hash pipeline.
 */
export function clusterEdges(
  candidates: CurationCandidate[],
  edges: SimilarityEdge[]
): { groups: CurationGroup[]; memberIndices: Set<number> } {
  const n = candidates.length;
  if (n === 0 || edges.length === 0) {
    return { groups: [], memberIndices: new Set() };
  }

  const uf = new UnionFind(n);
  for (const e of edges) {
    uf.union(e.i, e.j);
  }

  // Index edges by their connected-component root for max-similarity lookup.
  const edgesByRoot = new Map<number, SimilarityEdge[]>();
  for (const e of edges) {
    const root = uf.find(e.i);
    const list = edgesByRoot.get(root);
    if (list) list.push(e);
    else edgesByRoot.set(root, [e]);
  }

  // Collect connected components of size >= 2.
  const components = uf.getGroups(n);

  const groups: CurationGroup[] = [];
  const memberIndices = new Set<number>();
  let groupSeq = 0;

  for (const componentIndices of components) {
    const root = uf.find(componentIndices[0]);
    const componentEdges = edgesByRoot.get(root) ?? [];

    // Determine the maximum-similarity edge inside this component.
    let maxEdge: SimilarityEdge | null = null;
    for (const e of componentEdges) {
      if (!maxEdge || e.similarity > maxEdge.similarity) {
        maxEdge = e;
      }
    }

    // No edge inside the component should never happen (a component of size
    // >= 2 implies at least one union, which implies at least one edge).
    // Guard anyway to keep the function total.
    if (!maxEdge) continue;

    const groupType: GroupType =
      maxEdge.similarity >= EXACT_DUPLICATE_THRESHOLD
        ? 'exact_duplicate'
        : 'near_duplicate_candidate';

    // Preserve original input order within the group so the orchestrator and
    // debug report see candidates in a stable sequence.
    const sortedIndices = [...componentIndices].sort((a, b) => a - b);
    const groupCandidates = sortedIndices.map((idx) => candidates[idx]);
    for (const idx of sortedIndices) memberIndices.add(idx);

    groups.push({
      groupId: makeGroupId(groupSeq++),
      groupType,
      similaritySource: maxEdge.source,
      maxSimilarity: maxEdge.similarity,
      candidates: groupCandidates,
    });
  }

  return { groups, memberIndices };
}
