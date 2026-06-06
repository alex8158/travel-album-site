/**
 * Two-Phase Union-Find Clustering with Chain-Merge Safeguards
 *
 * Implements the clustering algorithm for global similarity candidate generation.
 *
 * Design (Constraint 2: Union-Find Chain Merge Safeguards):
 * 1. Gray-zone pairs do NOT expand confirmed clusters
 * 2. Cluster size cap of 8 — split at weakest intra-cluster edge
 * 3. Direct edge requirement for trash decisions
 * 4. Two-phase Union-Find:
 *    - Phase 1: Build clusters from confirmed pairs only
 *    - Phase 2: Gray-zone pairs add evidence (same cluster) or flag VLM review (bridging)
 */

// --- Types ---

export type PairClassification = 'confirmed' | 'gray_zone';

export interface SimilarityPair {
  i: string;
  j: string;
  similarity: number;
  classification: PairClassification;
}

export interface ClusterMetadata {
  /** Unique cluster identifier (root node mediaId) */
  clusterId: string;
  /** All member media IDs in this cluster */
  members: string[];
  /** Confirmed pairs within this cluster */
  confirmedPairs: SimilarityPair[];
  /** Gray-zone pairs within this cluster (both endpoints in same cluster) */
  grayZonePairs: SimilarityPair[];
  /** Gray-zone pairs that tried to bridge TO this cluster from another */
  vlmReviewPairs: SimilarityPair[];
  /** Whether this cluster needs VLM review (has bridging gray-zone pairs) */
  needsVLMReview: boolean;
  /** Whether this cluster is confirmed-only (can use local quality selector) */
  isConfirmedOnly: boolean;
}

export interface BuildClustersResult {
  /** All clusters formed */
  clusters: ClusterMetadata[];
  /** Gray-zone pairs that bridge different clusters — flagged for VLM review */
  bridgingPairs: SimilarityPair[];
}

// --- Union-Find Data Structure ---

/**
 * Standard Union-Find (Disjoint Set Union) with path compression and union by rank.
 */
export class UnionFind {
  private parent: Map<string, string>;
  private rank: Map<string, number>;

  constructor() {
    this.parent = new Map();
    this.rank = new Map();
  }

  /** Ensure a node exists in the structure */
  makeSet(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  /** Find the root representative with path compression */
  find(x: string): string {
    this.makeSet(x);
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.find(this.parent.get(x)!));
    }
    return this.parent.get(x)!;
  }

  /** Union two sets by rank */
  union(x: string, y: string): void {
    const rootX = this.find(x);
    const rootY = this.find(y);
    if (rootX === rootY) return;

    const rankX = this.rank.get(rootX)!;
    const rankY = this.rank.get(rootY)!;

    if (rankX < rankY) {
      this.parent.set(rootX, rootY);
    } else if (rankX > rankY) {
      this.parent.set(rootY, rootX);
    } else {
      this.parent.set(rootY, rootX);
      this.rank.set(rootX, rankX + 1);
    }
  }

  /** Check if two elements are in the same set */
  connected(x: string, y: string): boolean {
    return this.find(x) === this.find(y);
  }

  /** Get all distinct groups */
  getGroups(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    const nodes = Array.from(this.parent.keys());
    for (const node of nodes) {
      const root = this.find(node);
      if (!groups.has(root)) {
        groups.set(root, []);
      }
      groups.get(root)!.push(node);
    }
    return groups;
  }

  /** Get the size of the set containing x */
  getSetSize(x: string): number {
    const root = this.find(x);
    let count = 0;
    const nodes = Array.from(this.parent.keys());
    for (const node of nodes) {
      if (this.find(node) === root) count++;
    }
    return count;
  }

  /** Get all nodes */
  getAllNodes(): string[] {
    return Array.from(this.parent.keys());
  }
}

// --- Cluster Size Cap ---

/** Maximum allowed cluster size before splitting */
export const CLUSTER_SIZE_CAP = 8;

/**
 * Split an oversized cluster at the weakest intra-cluster edge.
 *
 * Strategy: Remove the weakest (lowest similarity) confirmed edge from the cluster,
 * then rebuild sub-clusters from the remaining edges. Repeat until all sub-clusters
 * are within the size cap.
 *
 * @param members - all member IDs in the oversized cluster
 * @param confirmedPairs - confirmed pairs within the cluster
 * @returns Array of sub-cluster member arrays
 */
export function splitOversizedCluster(
  members: string[],
  confirmedPairs: SimilarityPair[],
): string[][] {
  if (members.length <= CLUSTER_SIZE_CAP) {
    return [members];
  }

  // Sort pairs by similarity ascending (weakest first)
  const sortedPairs = [...confirmedPairs].sort((a, b) => a.similarity - b.similarity);

  // Iteratively remove weakest edges until all components are within cap
  let edgesToUse = [...sortedPairs];

  while (true) {
    // Build sub-clusters from current edges
    const subUf = new UnionFind();
    for (const m of members) {
      subUf.makeSet(m);
    }
    for (const pair of edgesToUse) {
      subUf.union(pair.i, pair.j);
    }

    const groups = subUf.getGroups();
    const subClusters = Array.from(groups.values());

    // Check if all sub-clusters are within cap
    const oversized = subClusters.find((sc) => sc.length > CLUSTER_SIZE_CAP);
    if (!oversized) {
      // Filter out singleton clusters (they're not really clusters)
      return subClusters.filter((sc) => sc.length > 1);
    }

    // Remove weakest edge that's within the oversized sub-cluster
    const oversizedSet = new Set(oversized);
    const weakestIdx = edgesToUse.findIndex(
      (p) => oversizedSet.has(p.i) && oversizedSet.has(p.j),
    );

    if (weakestIdx === -1) {
      // No more edges to remove — force split by returning as-is
      return subClusters.filter((sc) => sc.length > 1);
    }

    edgesToUse.splice(weakestIdx, 1);
  }
}

// --- Direct Edge Requirement ---

/**
 * Check if a candidate has a direct confirmed edge to the selected media or medoid.
 *
 * Per Constraint 3: Every image trashed MUST have a direct confirmed edge
 * (similarity ≥ dinov2ConfirmedThreshold) to either selectedMediaId or cluster medoid.
 * If an image only connects via chain intermediaries, it MUST NOT be auto-trashed.
 *
 * @param candidateId - the media ID to check
 * @param targetIds - selectedMediaId and/or medoid ID(s)
 * @param confirmedPairs - confirmed pairs in the cluster
 * @returns true if candidate has a direct confirmed edge to any target
 */
export function hasDirectConfirmedEdge(
  candidateId: string,
  targetIds: string[],
  confirmedPairs: SimilarityPair[],
): boolean {
  const targetSet = new Set(targetIds);
  return confirmedPairs.some(
    (p) =>
      (p.i === candidateId && targetSet.has(p.j)) ||
      (p.j === candidateId && targetSet.has(p.i)),
  );
}

/**
 * Find the medoid of a cluster — the member with highest average similarity to all others.
 *
 * @param members - cluster member IDs
 * @param confirmedPairs - confirmed pairs for computing similarity
 * @returns mediaId of the medoid
 */
export function findClusterMedoid(
  members: string[],
  confirmedPairs: SimilarityPair[],
): string {
  if (members.length === 1) return members[0];

  // Build adjacency with similarity weights
  const simMap = new Map<string, Map<string, number>>();
  for (const m of members) {
    simMap.set(m, new Map());
  }
  for (const pair of confirmedPairs) {
    if (simMap.has(pair.i) && simMap.has(pair.j)) {
      simMap.get(pair.i)!.set(pair.j, pair.similarity);
      simMap.get(pair.j)!.set(pair.i, pair.similarity);
    }
  }

  // Find member with highest average similarity to all others
  let bestMember = members[0];
  let bestAvg = -1;

  for (const member of members) {
    const edges = simMap.get(member)!;
    if (edges.size === 0) continue;

    let sum = 0;
    const sims = Array.from(edges.values());
    for (const sim of sims) {
      sum += sim;
    }
    // Average over all other members (use 0 for missing edges)
    const avg = sum / (members.length - 1);

    if (avg > bestAvg) {
      bestAvg = avg;
      bestMember = member;
    }
  }

  return bestMember;
}

// --- Two-Phase Cluster Building ---

/**
 * Build clusters using two-phase Union-Find with chain-merge safeguards.
 *
 * Phase 1: Build clusters from confirmed pairs only via standard Union-Find.
 * Phase 2: For each gray-zone pair:
 *   - If both endpoints in same cluster → add as intra-cluster evidence
 *   - If bridging two different clusters → flag for VLM review, do NOT auto-merge
 *
 * After building, any cluster exceeding CLUSTER_SIZE_CAP (8) is split at the
 * weakest intra-cluster edge.
 *
 * @param confirmedPairs - pairs with similarity ≥ dinov2ConfirmedThreshold
 * @param grayZonePairs - pairs with similarity in [dinov2GrayLowThreshold, dinov2ConfirmedThreshold)
 * @returns BuildClustersResult with cluster metadata and bridging pairs
 */
export function buildClusters(
  confirmedPairs: SimilarityPair[],
  grayZonePairs: SimilarityPair[],
): BuildClustersResult {
  // --- Phase 1: Build clusters from confirmed pairs only ---
  const uf = new UnionFind();

  // Register all nodes from confirmed pairs
  for (const pair of confirmedPairs) {
    uf.makeSet(pair.i);
    uf.makeSet(pair.j);
    uf.union(pair.i, pair.j);
  }

  // Also register gray-zone pair endpoints (they exist as isolated nodes if not confirmed)
  for (const pair of grayZonePairs) {
    uf.makeSet(pair.i);
    uf.makeSet(pair.j);
  }

  // --- Phase 2: Process gray-zone pairs ---
  const bridgingPairs: SimilarityPair[] = [];
  const intraClusterGrayPairs: SimilarityPair[] = [];

  for (const pair of grayZonePairs) {
    const rootI = uf.find(pair.i);
    const rootJ = uf.find(pair.j);

    if (rootI === rootJ) {
      // Both endpoints in same confirmed cluster → add evidence
      intraClusterGrayPairs.push(pair);
    } else {
      // Bridging two different clusters → flag for VLM review, do NOT merge
      bridgingPairs.push(pair);
    }
  }

  // --- Build cluster metadata ---
  const groups = uf.getGroups();
  const rawClusters: ClusterMetadata[] = [];

  for (const [clusterId, members] of Array.from(groups.entries())) {
    // Skip singletons — they're not clusters
    if (members.length < 2) {
      // But check if this singleton has bridging pairs
      const singletonBridging = bridgingPairs.filter(
        (p) => p.i === members[0] || p.j === members[0],
      );
      if (singletonBridging.length > 0) {
        // Singleton with bridging pairs needs VLM review
        rawClusters.push({
          clusterId,
          members,
          confirmedPairs: [],
          grayZonePairs: [],
          vlmReviewPairs: singletonBridging,
          needsVLMReview: true,
          isConfirmedOnly: false,
        });
      }
      continue;
    }

    // Find confirmed pairs within this cluster
    const memberSet = new Set(members);
    const clusterConfirmedPairs = confirmedPairs.filter(
      (p) => memberSet.has(p.i) && memberSet.has(p.j),
    );
    const clusterGrayPairs = intraClusterGrayPairs.filter(
      (p) => memberSet.has(p.i) && memberSet.has(p.j),
    );
    const clusterBridgingPairs = bridgingPairs.filter(
      (p) =>
        (memberSet.has(p.i) && !memberSet.has(p.j)) ||
        (!memberSet.has(p.i) && memberSet.has(p.j)),
    );

    const needsVLMReview =
      clusterBridgingPairs.length > 0 || clusterGrayPairs.length > 0;
    const isConfirmedOnly =
      clusterGrayPairs.length === 0 && clusterBridgingPairs.length === 0;

    rawClusters.push({
      clusterId,
      members,
      confirmedPairs: clusterConfirmedPairs,
      grayZonePairs: clusterGrayPairs,
      vlmReviewPairs: clusterBridgingPairs,
      needsVLMReview,
      isConfirmedOnly,
    });
  }

  // --- Enforce cluster size cap ---
  const finalClusters: ClusterMetadata[] = [];

  for (const cluster of rawClusters) {
    if (cluster.members.length <= CLUSTER_SIZE_CAP) {
      finalClusters.push(cluster);
    } else {
      // Split oversized cluster
      const subGroups = splitOversizedCluster(
        cluster.members,
        cluster.confirmedPairs,
      );

      for (const subMembers of subGroups) {
        const subMemberSet = new Set(subMembers);
        const subConfirmed = cluster.confirmedPairs.filter(
          (p) => subMemberSet.has(p.i) && subMemberSet.has(p.j),
        );
        const subGray = cluster.grayZonePairs.filter(
          (p) => subMemberSet.has(p.i) && subMemberSet.has(p.j),
        );
        const subBridging = cluster.vlmReviewPairs.filter(
          (p) =>
            (subMemberSet.has(p.i) && !subMemberSet.has(p.j)) ||
            (!subMemberSet.has(p.i) && subMemberSet.has(p.j)),
        );

        const needsVLMReview = subBridging.length > 0 || subGray.length > 0;
        const isConfirmedOnly = subGray.length === 0 && subBridging.length === 0;

        finalClusters.push({
          clusterId: subMembers[0], // Use first member as cluster ID for sub-clusters
          members: subMembers,
          confirmedPairs: subConfirmed,
          grayZonePairs: subGray,
          vlmReviewPairs: subBridging,
          needsVLMReview,
          isConfirmedOnly,
        });
      }
    }
  }

  return {
    clusters: finalClusters,
    bridgingPairs,
  };
}

/**
 * Filter trash candidates based on direct edge requirement.
 *
 * Per Constraint 3: Only trash if candidate has a direct confirmed edge
 * to selectedMediaId or medoid. Images reachable only via chain intermediaries
 * get fallback_keep_all treatment.
 *
 * @param selectedMediaId - the chosen best image in the cluster
 * @param allMembers - all cluster member IDs
 * @param confirmedPairs - confirmed pairs in the cluster
 * @returns Object with trashable IDs and skipped IDs (no direct edge)
 */
export function filterTrashCandidates(
  selectedMediaId: string,
  allMembers: string[],
  confirmedPairs: SimilarityPair[],
): { trashable: string[]; skipped: string[] } {
  const medoid = findClusterMedoid(allMembers, confirmedPairs);
  const targetIds = [selectedMediaId];
  if (medoid !== selectedMediaId) {
    targetIds.push(medoid);
  }

  const trashable: string[] = [];
  const skipped: string[] = [];

  for (const member of allMembers) {
    if (member === selectedMediaId) continue; // Don't trash the selected one

    if (hasDirectConfirmedEdge(member, targetIds, confirmedPairs)) {
      trashable.push(member);
    } else {
      skipped.push(member);
    }
  }

  return { trashable, skipped };
}
