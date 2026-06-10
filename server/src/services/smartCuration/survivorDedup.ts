/**
 * Global Survivor Dedup
 *
 * Post-VLM deduplication stage that detects cross-group near-duplicates among
 * surviving active photos using pre-computed DINOv2 embeddings. Makes zero VLM
 * calls — resolution is purely quality-score-based with temporal proximity as
 * gray-zone evidence.
 *
 * Inserted between step 10 (similar-group trashing) and step 11 (overexposure
 * trashing) in the highlight evaluation flow.
 */

import {
  computeTopKNeighbors,
  selectBestByQuality,
  computeCompositeScore,
  type CurationCandidate,
  type NeighborPair,
} from './globalSimilarity';
import { UnionFind } from './unionFind';
import { PROCESS_THRESHOLDS } from '../dedupThresholds';
import { getDb } from '../../database';

// --- Interfaces ---

/** A photo surviving after VLM similar-group trashing */
export interface SurvivorPhoto {
  mediaId: string;
  embedding: number[] | null; // DINOv2 384-dim, null if missing
  createdAt: string; // ISO 8601 timestamp
  sharpnessScore: number;
  aestheticScore: number;
  exposureScore: number;
  overexposureQualityPenalty: number;
}

/** Result of the survivor dedup stage */
export interface SurvivorDedupResult {
  trashedMediaIds: string[];
  globalSimilarityAfterVlmDeletedCount: number;
}

/** A pair eligible for elimination */
export interface EligiblePair {
  i: string; // mediaId
  j: string; // mediaId
  similarity: number;
  type: 'confirmed' | 'gray_zone_temporal';
}

// --- Helper Functions ---

/**
 * Classify neighbor pairs into confirmed or gray-zone-eligible pairs.
 *
 * - Confirmed: similarity >= dinov2ConfirmedThreshold (0.88) — no additional evidence needed
 * - Gray zone temporal: similarity in [dinov2DedupThreshold, dinov2ConfirmedThreshold) AND
 *   |createdAt_i - createdAt_j| <= 30 seconds
 * - Below dinov2DedupThreshold: skipped entirely
 *
 * @param neighbors - neighbor pairs from computeTopKNeighbors (indices into mediaIds)
 * @param survivors - all survivor photos with metadata
 * @param mediaIds - mapping from index to mediaId (parallel to embeddings array)
 * @returns array of eligible pairs ready for clustering
 */
export function buildEligiblePairs(
  neighbors: NeighborPair[],
  survivors: SurvivorPhoto[],
  mediaIds: string[],
): EligiblePair[] {
  const { dinov2ConfirmedThreshold, dinov2DedupThreshold } = PROCESS_THRESHOLDS;
  const eligible: EligiblePair[] = [];

  // Build a lookup map for fast access to survivors by mediaId
  const survivorMap = new Map<string, SurvivorPhoto>();
  for (const s of survivors) {
    survivorMap.set(s.mediaId, s);
  }

  for (const pair of neighbors) {
    const mediaIdI = mediaIds[pair.i];
    const mediaIdJ = mediaIds[pair.j];

    if (pair.similarity >= dinov2ConfirmedThreshold) {
      // Confirmed: no additional evidence needed
      eligible.push({
        i: mediaIdI,
        j: mediaIdJ,
        similarity: pair.similarity,
        type: 'confirmed',
      });
    } else if (pair.similarity >= dinov2DedupThreshold) {
      // Gray zone: require temporal proximity (<= 30 seconds)
      const photoI = survivorMap.get(mediaIdI);
      const photoJ = survivorMap.get(mediaIdJ);

      if (photoI && photoJ) {
        const timeDiffMs = Math.abs(
          new Date(photoI.createdAt).getTime() - new Date(photoJ.createdAt).getTime(),
        );
        if (timeDiffMs <= 30_000) {
          eligible.push({
            i: mediaIdI,
            j: mediaIdJ,
            similarity: pair.similarity,
            type: 'gray_zone_temporal',
          });
        }
      }
    }
    // Below dinov2DedupThreshold: skip entirely
  }

  return eligible;
}

/**
 * Cluster eligible pairs via Union-Find and resolve each cluster by selecting
 * the best-quality keeper. All non-keeper members are returned as trashed IDs.
 *
 * Resolution logic:
 * - Build clusters (connected components) from eligible pairs
 * - For each cluster with >= 2 members, compute composite quality score for each
 * - Keeper = highest composite score
 * - Tie-breaking: when scores are equal, keep the photo with earliest createdAt
 * - All non-keepers are trashed
 *
 * @param eligiblePairs - pairs classified as confirmed or gray-zone-temporal eligible
 * @param survivors - all survivor photos with quality scores and timestamps
 * @returns array of mediaIds to trash
 */
export function clusterAndResolve(
  eligiblePairs: EligiblePair[],
  survivors: SurvivorPhoto[],
): string[] {
  // Build clusters via Union-Find
  const uf = new UnionFind();
  for (const pair of eligiblePairs) {
    uf.makeSet(pair.i);
    uf.makeSet(pair.j);
    uf.union(pair.i, pair.j);
  }

  const groups = uf.getGroups();
  const trashedIds: string[] = [];

  // Build a lookup map for fast access to survivors by mediaId
  const survivorMap = new Map<string, SurvivorPhoto>();
  for (const s of survivors) {
    survivorMap.set(s.mediaId, s);
  }

  for (const [_root, members] of groups.entries()) {
    if (members.length < 2) continue;

    // Build candidates for selectBestByQuality
    const candidates: CurationCandidate[] = members.map((id) => {
      const photo = survivorMap.get(id)!;
      return {
        mediaId: id,
        sharpnessScore: photo.sharpnessScore,
        aestheticScore: photo.aestheticScore,
        exposureScore: photo.exposureScore,
        overexposureQualityPenalty: photo.overexposureQualityPenalty,
      };
    });

    // Select keeper (highest composite score)
    const keeperId = selectBestByQuality(candidates);
    const keeperScore = computeCompositeScore(candidates.find((c) => c.mediaId === keeperId)!);

    // Tie-breaking: if multiple have same score, keep earliest createdAt
    const tiedCandidates = candidates.filter(
      (c) => computeCompositeScore(c) === keeperScore,
    );
    let finalKeeperId = keeperId;
    if (tiedCandidates.length > 1) {
      tiedCandidates.sort((a, b) => {
        const timeA = new Date(survivorMap.get(a.mediaId)!.createdAt).getTime();
        const timeB = new Date(survivorMap.get(b.mediaId)!.createdAt).getTime();
        return timeA - timeB;
      });
      finalKeeperId = tiedCandidates[0].mediaId;
    }

    // Trash everyone else
    for (const member of members) {
      if (member !== finalKeeperId) {
        trashedIds.push(member);
      }
    }
  }

  return trashedIds;
}

// --- DB Row Type ---

/** Raw row shape returned from the SQL query */
interface SurvivorRow {
  id: string;
  created_at: string;
  dinov2_embedding: string | null;
  sharpness_score: number | null;
  quality_score: number | null;
  exposure_score: number | null;
}

// --- Entry Point ---

/**
 * Run global survivor dedup for a trip.
 *
 * Detects cross-group near-duplicates among surviving active photos using
 * pre-computed DINOv2 embeddings, clusters eligible pairs via Union-Find,
 * and keeps only the best photo per cluster.
 *
 * Makes zero VLM calls — resolution is purely quality-score-based with
 * temporal proximity as gray-zone evidence.
 */
export async function runSurvivorDedup(tripId: string): Promise<SurvivorDedupResult> {
  try {
    const db = getDb();

    // 1. Load active survivors with embeddings and quality scores
    const rows = db.prepare(`
      SELECT m.id, m.created_at, m.dinov2_embedding,
             m.sharpness_score, m.quality_score, m.exposure_score
      FROM media_items m
      WHERE m.trip_id = ? AND m.status = 'active'
        AND m.media_type = 'image'
      ORDER BY m.created_at ASC
    `).all(tripId) as SurvivorRow[];

    // 2. Early exit: 0 or 1 survivors means nothing to dedup
    if (rows.length <= 1) {
      return { trashedMediaIds: [], globalSimilarityAfterVlmDeletedCount: 0 };
    }

    // 3. Parse embeddings, build survivor list (filter out null embeddings for neighbor computation)
    const survivors: SurvivorPhoto[] = rows.map(r => ({
      mediaId: r.id,
      embedding: r.dinov2_embedding ? JSON.parse(r.dinov2_embedding) : null,
      createdAt: r.created_at,
      sharpnessScore: r.sharpness_score ?? 0,
      aestheticScore: r.quality_score ?? 0,
      exposureScore: r.exposure_score ?? 0,
      overexposureQualityPenalty: 0,
    }));

    const mediaIds = survivors.map(s => s.mediaId);
    const embeddings = survivors.map(s => s.embedding);

    // 4. Compute top-K neighbors
    const neighbors = computeTopKNeighbors(
      embeddings,
      PROCESS_THRESHOLDS.globalSimilarityTopK,
    );

    if (neighbors.length === 0) {
      return { trashedMediaIds: [], globalSimilarityAfterVlmDeletedCount: 0 };
    }

    // 5. Classify pairs and apply temporal gate
    const eligiblePairs = buildEligiblePairs(neighbors, survivors, mediaIds);

    if (eligiblePairs.length === 0) {
      return { trashedMediaIds: [], globalSimilarityAfterVlmDeletedCount: 0 };
    }

    // 6. Cluster and resolve
    const trashedIds = clusterAndResolve(eligiblePairs, survivors);

    if (trashedIds.length === 0) {
      return { trashedMediaIds: [], globalSimilarityAfterVlmDeletedCount: 0 };
    }

    // 7. Apply DB updates
    const trashStmt = db.prepare(`
      UPDATE media_items
      SET status = 'trashed',
          trashed_reason = CASE
            WHEN trashed_reason IS NULL THEN 'global_similarity_after_vlm'
            ELSE trashed_reason || ',global_similarity_after_vlm'
          END
      WHERE id = ? AND status = 'active'
    `);

    let actualTrashed = 0;
    for (const id of trashedIds) {
      const info = trashStmt.run(id);
      if (info.changes > 0) actualTrashed++;
    }

    // 8. Log
    if (actualTrashed > 0) {
      console.log(
        `[highlightService] Auto-trashed ${actualTrashed} global-survivor-dedup photos for trip ${tripId}`,
      );
    }

    return {
      trashedMediaIds: trashedIds.slice(0, actualTrashed),
      globalSimilarityAfterVlmDeletedCount: actualTrashed,
    };
  } catch (err) {
    console.error(`[highlightService] Global survivor dedup failed for trip ${tripId}:`, err);
    return { trashedMediaIds: [], globalSimilarityAfterVlmDeletedCount: 0 };
  }
}
