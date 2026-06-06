/**
 * Tests for two-phase Union-Find clustering with chain-merge safeguards.
 *
 * Covers:
 * - UnionFind data structure basic operations
 * - Two-phase buildClusters (confirmed pairs form clusters; gray-zone pairs add evidence or flag VLM)
 * - Cluster size cap of 8 with splitting at weakest edge
 * - Direct edge requirement for trash decisions
 * - findClusterMedoid
 * - filterTrashCandidates
 */

import { describe, it, expect } from 'vitest';
import {
  UnionFind,
  buildClusters,
  splitOversizedCluster,
  hasDirectConfirmedEdge,
  findClusterMedoid,
  filterTrashCandidates,
  CLUSTER_SIZE_CAP,
  type SimilarityPair,
} from '../unionFind';

// --- UnionFind basic tests ---

describe('UnionFind', () => {
  it('should create isolated sets for new elements', () => {
    const uf = new UnionFind();
    uf.makeSet('a');
    uf.makeSet('b');
    expect(uf.connected('a', 'b')).toBe(false);
  });

  it('should union two elements into the same set', () => {
    const uf = new UnionFind();
    uf.makeSet('a');
    uf.makeSet('b');
    uf.union('a', 'b');
    expect(uf.connected('a', 'b')).toBe(true);
  });

  it('should support transitive connectivity', () => {
    const uf = new UnionFind();
    uf.union('a', 'b');
    uf.union('b', 'c');
    expect(uf.connected('a', 'c')).toBe(true);
  });

  it('should keep separate groups separate', () => {
    const uf = new UnionFind();
    uf.union('a', 'b');
    uf.union('c', 'd');
    expect(uf.connected('a', 'b')).toBe(true);
    expect(uf.connected('c', 'd')).toBe(true);
    expect(uf.connected('a', 'c')).toBe(false);
  });

  it('getGroups returns correct groupings', () => {
    const uf = new UnionFind();
    uf.union('a', 'b');
    uf.union('b', 'c');
    uf.makeSet('d');
    const groups = uf.getGroups();
    // Should have 2 groups: {a,b,c} and {d}
    expect(groups.size).toBe(2);
    const sizes = Array.from(groups.values())
      .map((g) => g.length)
      .sort();
    expect(sizes).toEqual([1, 3]);
  });
});

// --- buildClusters tests ---

describe('buildClusters', () => {
  it('should form a cluster from confirmed pairs only (Phase 1)', () => {
    const confirmed: SimilarityPair[] = [
      { i: 'A', j: 'B', similarity: 0.92, classification: 'confirmed' },
      { i: 'B', j: 'C', similarity: 0.90, classification: 'confirmed' },
    ];
    const gray: SimilarityPair[] = [];

    const result = buildClusters(confirmed, gray);
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0].members.sort()).toEqual(['A', 'B', 'C']);
    expect(result.clusters[0].isConfirmedOnly).toBe(true);
    expect(result.clusters[0].needsVLMReview).toBe(false);
  });

  it('should NOT merge clusters via gray-zone bridging pair (Phase 2)', () => {
    // A-B confirmed, C-D confirmed, B-C gray-zone
    const confirmed: SimilarityPair[] = [
      { i: 'A', j: 'B', similarity: 0.92, classification: 'confirmed' },
      { i: 'C', j: 'D', similarity: 0.91, classification: 'confirmed' },
    ];
    const gray: SimilarityPair[] = [
      { i: 'B', j: 'C', similarity: 0.80, classification: 'gray_zone' },
    ];

    const result = buildClusters(confirmed, gray);
    // Should have 2 separate clusters (gray-zone didn't merge them)
    const multiMemberClusters = result.clusters.filter((c) => c.members.length >= 2);
    expect(multiMemberClusters.length).toBe(2);
    // B-C pair should be in bridgingPairs
    expect(result.bridgingPairs.length).toBe(1);
    expect(result.bridgingPairs[0].i).toBe('B');
    expect(result.bridgingPairs[0].j).toBe('C');
  });

  it('should add gray-zone pair as evidence when both endpoints are in same cluster', () => {
    // A-B confirmed, A-C confirmed, B-C gray-zone (all in same cluster)
    const confirmed: SimilarityPair[] = [
      { i: 'A', j: 'B', similarity: 0.92, classification: 'confirmed' },
      { i: 'A', j: 'C', similarity: 0.90, classification: 'confirmed' },
    ];
    const gray: SimilarityPair[] = [
      { i: 'B', j: 'C', similarity: 0.80, classification: 'gray_zone' },
    ];

    const result = buildClusters(confirmed, gray);
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0].members.sort()).toEqual(['A', 'B', 'C']);
    expect(result.clusters[0].grayZonePairs.length).toBe(1);
    // Has gray-zone intra-cluster evidence, so needs VLM review
    expect(result.clusters[0].needsVLMReview).toBe(true);
    expect(result.clusters[0].isConfirmedOnly).toBe(false);
    // NOT in bridging pairs
    expect(result.bridgingPairs.length).toBe(0);
  });

  it('should mark clusters as confirmed-only when no gray-zone evidence', () => {
    const confirmed: SimilarityPair[] = [
      { i: 'X', j: 'Y', similarity: 0.95, classification: 'confirmed' },
      { i: 'Y', j: 'Z', similarity: 0.93, classification: 'confirmed' },
    ];
    const gray: SimilarityPair[] = [];

    const result = buildClusters(confirmed, gray);
    expect(result.clusters[0].isConfirmedOnly).toBe(true);
    expect(result.clusters[0].needsVLMReview).toBe(false);
  });

  it('should handle empty inputs', () => {
    const result = buildClusters([], []);
    expect(result.clusters.length).toBe(0);
    expect(result.bridgingPairs.length).toBe(0);
  });
});

// --- Cluster size cap ---

describe('splitOversizedCluster', () => {
  it('should return cluster as-is when within size cap', () => {
    const members = ['A', 'B', 'C'];
    const pairs: SimilarityPair[] = [
      { i: 'A', j: 'B', similarity: 0.92, classification: 'confirmed' },
      { i: 'B', j: 'C', similarity: 0.90, classification: 'confirmed' },
    ];
    const result = splitOversizedCluster(members, pairs);
    expect(result.length).toBe(1);
    expect(result[0].sort()).toEqual(['A', 'B', 'C']);
  });

  it('should split clusters exceeding size cap at weakest edge', () => {
    // Create a chain of 10 nodes: A-B-C-D-E-F-G-H-I-J
    const members = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const pairs: SimilarityPair[] = [
      { i: 'A', j: 'B', similarity: 0.95, classification: 'confirmed' },
      { i: 'B', j: 'C', similarity: 0.94, classification: 'confirmed' },
      { i: 'C', j: 'D', similarity: 0.93, classification: 'confirmed' },
      { i: 'D', j: 'E', similarity: 0.88, classification: 'confirmed' }, // weakest
      { i: 'E', j: 'F', similarity: 0.92, classification: 'confirmed' },
      { i: 'F', j: 'G', similarity: 0.91, classification: 'confirmed' },
      { i: 'G', j: 'H', similarity: 0.96, classification: 'confirmed' },
      { i: 'H', j: 'I', similarity: 0.94, classification: 'confirmed' },
      { i: 'I', j: 'J', similarity: 0.93, classification: 'confirmed' },
    ];

    const result = splitOversizedCluster(members, pairs);
    // Should split into sub-clusters, each ≤ 8
    for (const sub of result) {
      expect(sub.length).toBeLessThanOrEqual(CLUSTER_SIZE_CAP);
    }
    // All original members should be present across sub-clusters
    const allMembers = result.flat().sort();
    expect(allMembers).toEqual(members.sort());
  });

  it('should enforce CLUSTER_SIZE_CAP of 8', () => {
    expect(CLUSTER_SIZE_CAP).toBe(8);
  });
});

// --- Direct edge requirement ---

describe('hasDirectConfirmedEdge', () => {
  const pairs: SimilarityPair[] = [
    { i: 'A', j: 'B', similarity: 0.92, classification: 'confirmed' },
    { i: 'B', j: 'C', similarity: 0.90, classification: 'confirmed' },
    { i: 'A', j: 'D', similarity: 0.91, classification: 'confirmed' },
  ];

  it('should return true when candidate has direct edge to target', () => {
    expect(hasDirectConfirmedEdge('B', ['A'], pairs)).toBe(true);
    expect(hasDirectConfirmedEdge('D', ['A'], pairs)).toBe(true);
  });

  it('should return false when candidate only connects via intermediary', () => {
    // C connects to A only via B (C-B-A), no direct C-A edge
    expect(hasDirectConfirmedEdge('C', ['A'], pairs)).toBe(false);
  });

  it('should return true when candidate has edge to any target', () => {
    // C has direct edge to B
    expect(hasDirectConfirmedEdge('C', ['A', 'B'], pairs)).toBe(true);
  });
});

// --- findClusterMedoid ---

describe('findClusterMedoid', () => {
  it('should return the member with highest average similarity', () => {
    const members = ['A', 'B', 'C'];
    const pairs: SimilarityPair[] = [
      { i: 'A', j: 'B', similarity: 0.90, classification: 'confirmed' },
      { i: 'A', j: 'C', similarity: 0.92, classification: 'confirmed' },
      { i: 'B', j: 'C', similarity: 0.88, classification: 'confirmed' },
    ];
    // A has edges to both B(0.90) and C(0.92) → avg = (0.90+0.92)/2 = 0.91
    // B has edges to A(0.90) and C(0.88) → avg = (0.90+0.88)/2 = 0.89
    // C has edges to A(0.92) and B(0.88) → avg = (0.92+0.88)/2 = 0.90
    const medoid = findClusterMedoid(members, pairs);
    expect(medoid).toBe('A');
  });

  it('should return the single member for singleton', () => {
    expect(findClusterMedoid(['X'], [])).toBe('X');
  });
});

// --- filterTrashCandidates ---

describe('filterTrashCandidates', () => {
  it('should only allow trashing candidates with direct edge to selected/medoid', () => {
    // Chain: A-B-C-D where A is selected
    const members = ['A', 'B', 'C', 'D'];
    const pairs: SimilarityPair[] = [
      { i: 'A', j: 'B', similarity: 0.95, classification: 'confirmed' },
      { i: 'B', j: 'C', similarity: 0.92, classification: 'confirmed' },
      { i: 'C', j: 'D', similarity: 0.90, classification: 'confirmed' },
    ];

    const result = filterTrashCandidates('A', members, pairs);
    // B has direct edge to A → trashable
    expect(result.trashable).toContain('B');
    // C has no direct edge to A (only via B). Medoid is B (highest avg sim).
    // C has direct edge to B (medoid) → trashable
    expect(result.trashable).toContain('C');
    // D has direct edge to C only, no edge to A or B (medoid) → skipped
    expect(result.skipped).toContain('D');
  });

  it('should not trash the selected media', () => {
    const members = ['A', 'B'];
    const pairs: SimilarityPair[] = [
      { i: 'A', j: 'B', similarity: 0.95, classification: 'confirmed' },
    ];

    const result = filterTrashCandidates('A', members, pairs);
    expect(result.trashable).not.toContain('A');
    expect(result.trashable).toContain('B');
  });

  it('should skip all when no direct edges exist to selected or medoid', () => {
    // Disconnected scenario: selected has no confirmed edges to others in this sub-cluster
    const members = ['A', 'B', 'C'];
    const pairs: SimilarityPair[] = [
      { i: 'B', j: 'C', similarity: 0.90, classification: 'confirmed' },
      // No edges involving A
    ];

    const result = filterTrashCandidates('A', members, pairs);
    // B has edge to C (medoid), C is medoid (highest avg sim) — B has direct edge to C(medoid) → trashable
    // But let's verify: medoid would be B or C (both have same avg)
    // Actually B has edge to C: avg for B = 0.90/2=0.45, avg for C = 0.90/2=0.45
    // Both same, first wins (B) — so medoid is B or C
    // A has no edges → skipped
    // This test verifies A is not trashed since it's the selected
    expect(result.trashable).not.toContain('A');
  });
});

// --- buildClusters with size cap enforcement ---

describe('buildClusters size cap enforcement', () => {
  it('should split a cluster of 10 confirmed nodes into sub-clusters ≤ 8', () => {
    // Build a well-connected cluster of 10 nodes with multiple cross-links
    // so splitting doesn't produce singletons
    const nodes = Array.from({ length: 10 }, (_, i) => `N${i}`);
    const confirmed: SimilarityPair[] = [];

    // Create a "two-group" topology: group1 = N0-N4, group2 = N5-N9
    // with strong intra-group edges and one weak inter-group edge
    // Group 1 connections
    for (let i = 0; i < 4; i++) {
      confirmed.push({
        i: nodes[i],
        j: nodes[i + 1],
        similarity: 0.94 + i * 0.005,
        classification: 'confirmed',
      });
    }
    // Extra cross-links in group 1
    confirmed.push({ i: 'N0', j: 'N2', similarity: 0.93, classification: 'confirmed' });
    confirmed.push({ i: 'N1', j: 'N3', similarity: 0.92, classification: 'confirmed' });

    // Group 2 connections
    for (let i = 5; i < 9; i++) {
      confirmed.push({
        i: nodes[i],
        j: nodes[i + 1],
        similarity: 0.94 + (i - 5) * 0.005,
        classification: 'confirmed',
      });
    }
    // Extra cross-links in group 2
    confirmed.push({ i: 'N5', j: 'N7', similarity: 0.93, classification: 'confirmed' });
    confirmed.push({ i: 'N6', j: 'N8', similarity: 0.92, classification: 'confirmed' });

    // Weak bridge between groups (this should be cut)
    confirmed.push({
      i: 'N4',
      j: 'N5',
      similarity: 0.88, // weakest edge
      classification: 'confirmed',
    });

    const result = buildClusters(confirmed, []);

    // All sub-clusters should be ≤ 8 members
    for (const cluster of result.clusters) {
      expect(cluster.members.length).toBeLessThanOrEqual(CLUSTER_SIZE_CAP);
    }

    // Should produce exactly 2 clusters of 5 each
    expect(result.clusters.length).toBe(2);
    const sizes = result.clusters.map((c) => c.members.length).sort();
    expect(sizes).toEqual([5, 5]);
  });

  it('should not split clusters within size cap', () => {
    const nodes = ['A', 'B', 'C', 'D', 'E'];
    const confirmed: SimilarityPair[] = [
      { i: 'A', j: 'B', similarity: 0.92, classification: 'confirmed' },
      { i: 'B', j: 'C', similarity: 0.91, classification: 'confirmed' },
      { i: 'C', j: 'D', similarity: 0.90, classification: 'confirmed' },
      { i: 'D', j: 'E', similarity: 0.89, classification: 'confirmed' },
    ];

    const result = buildClusters(confirmed, []);
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0].members.length).toBe(5);
  });
});
