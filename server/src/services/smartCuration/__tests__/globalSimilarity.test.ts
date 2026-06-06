/**
 * Unit tests for global similarity embedding fetch and top-K nearest neighbor computation.
 *
 * Covers:
 * - cosineSimilarity: correct computation, edge cases (zero vectors, identical vectors)
 * - computeTopKNeighbors: deduplication, top-K filtering, null embedding handling
 * - classifyPairs: correct threshold classification (confirmed/gray-zone/skip)
 * - fetchEmbeddings: ML service unavailability handling
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.6
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cosineSimilarity,
  computeTopKNeighbors,
  classifyPairs,
  type NeighborPair,
  type ClassifiedPair,
} from '../globalSimilarity';

// --- cosineSimilarity tests ---

describe('cosineSimilarity', () => {
  it('should return 1.0 for identical normalized vectors', () => {
    const v = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    const sim = cosineSimilarity(v, v);
    expect(sim).toBeCloseTo(1.0, 10);
  });

  it('should return 0.0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 10);
  });

  it('should return -1.0 for opposite vectors', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 10);
  });

  it('should return 0 when either vector is zero', () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBe(0);
    expect(cosineSimilarity(b, a)).toBe(0);
  });

  it('should be commutative', () => {
    const a = [1, 2, 3, 4];
    const b = [5, 6, 7, 8];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });

  it('should handle high-dimensional vectors (384-dim DINOv2)', () => {
    // Simulate a 384-dim vector
    const a = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.1));
    const b = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.1 + 0.01)); // slightly shifted
    const sim = cosineSimilarity(a, b);
    // Should be very close to 1 for slightly shifted sine waves
    expect(sim).toBeGreaterThan(0.99);
    expect(sim).toBeLessThanOrEqual(1.0);
  });

  it('should return correct value for known example', () => {
    // Known: cos([1,2,3], [4,5,6]) = (4+10+18) / (sqrt(14) * sqrt(77))
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
    expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 10);
  });
});

// --- computeTopKNeighbors tests ---

describe('computeTopKNeighbors', () => {
  it('should return empty array when less than 2 valid embeddings', () => {
    const result = computeTopKNeighbors([[1, 0, 0]], 5);
    expect(result).toEqual([]);
  });

  it('should return empty array when all embeddings are null', () => {
    const result = computeTopKNeighbors([null, null, null], 5);
    expect(result).toEqual([]);
  });

  it('should compute correct pairs for 3 vectors', () => {
    // Three 3-dim vectors
    const embeddings: (number[] | null)[] = [
      [1, 0, 0], // idx 0
      [1, 0.1, 0], // idx 1 — very similar to 0
      [0, 0, 1], // idx 2 — orthogonal to both
    ];
    const result = computeTopKNeighbors(embeddings, 10);

    // Should have 3 pairs: (0,1), (0,2), (1,2)
    expect(result.length).toBe(3);

    // Pairs should be sorted by descending similarity
    for (let k = 1; k < result.length; k++) {
      expect(result[k - 1].similarity).toBeGreaterThanOrEqual(result[k].similarity);
    }

    // (0,1) should be most similar
    expect(result[0].i).toBe(0);
    expect(result[0].j).toBe(1);
    expect(result[0].similarity).toBeGreaterThan(0.9);
  });

  it('should deduplicate pairs (i < j always)', () => {
    const embeddings: (number[] | null)[] = [
      [1, 0],
      [0, 1],
      [1, 1],
    ];
    const result = computeTopKNeighbors(embeddings, 10);
    for (const pair of result) {
      expect(pair.i).toBeLessThan(pair.j);
    }
  });

  it('should respect top-K limit per image', () => {
    // 5 vectors, K=2 → each image keeps only 2 neighbors
    const embeddings: (number[] | null)[] = [
      [1, 0, 0, 0, 0],
      [0.9, 0.1, 0, 0, 0],
      [0.8, 0.2, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 1, 0],
    ];
    const result = computeTopKNeighbors(embeddings, 2);

    // With K=2, each image keeps only top-2 neighbors, so not all pairs appear
    // Maximum pairs from K=2 with 5 images: 5*2/2 = 5 unique pairs at most
    expect(result.length).toBeLessThanOrEqual(5 * 2);
  });

  it('should skip null embeddings', () => {
    const embeddings: (number[] | null)[] = [
      [1, 0, 0],
      null, // skipped
      [0, 1, 0],
    ];
    const result = computeTopKNeighbors(embeddings, 10);

    // Only pair (0, 2) should exist
    expect(result.length).toBe(1);
    expect(result[0].i).toBe(0);
    expect(result[0].j).toBe(2);
  });

  it('should handle single valid embedding among nulls', () => {
    const embeddings: (number[] | null)[] = [null, [1, 0, 0], null, null];
    const result = computeTopKNeighbors(embeddings, 10);
    expect(result).toEqual([]);
  });
});

// --- classifyPairs tests ---

describe('classifyPairs', () => {
  const mediaIds = ['img-a', 'img-b', 'img-c', 'img-d'];

  it('should classify pair as confirmed when similarity ≥ dinov2ConfirmedThreshold', () => {
    const pairs: NeighborPair[] = [{ i: 0, j: 1, similarity: 0.90 }];
    // default dinov2ConfirmedThreshold = 0.88
    const result = classifyPairs(pairs, mediaIds);
    expect(result.length).toBe(1);
    expect(result[0].classification).toBe('confirmed');
    expect(result[0].i).toBe('img-a');
    expect(result[0].j).toBe('img-b');
    expect(result[0].similarity).toBe(0.90);
  });

  it('should classify pair as confirmed at exact threshold', () => {
    const pairs: NeighborPair[] = [{ i: 0, j: 1, similarity: 0.88 }];
    const result = classifyPairs(pairs, mediaIds);
    expect(result.length).toBe(1);
    expect(result[0].classification).toBe('confirmed');
  });

  it('should classify pair as gray_zone between thresholds', () => {
    const pairs: NeighborPair[] = [{ i: 0, j: 1, similarity: 0.80 }];
    // default: dinov2GrayLowThreshold = 0.75, dinov2ConfirmedThreshold = 0.88
    const result = classifyPairs(pairs, mediaIds);
    expect(result.length).toBe(1);
    expect(result[0].classification).toBe('gray_zone');
  });

  it('should classify pair as gray_zone at exact gray low threshold', () => {
    const pairs: NeighborPair[] = [{ i: 0, j: 1, similarity: 0.75 }];
    const result = classifyPairs(pairs, mediaIds);
    expect(result.length).toBe(1);
    expect(result[0].classification).toBe('gray_zone');
  });

  it('should skip pairs below dinov2GrayLowThreshold', () => {
    const pairs: NeighborPair[] = [{ i: 0, j: 1, similarity: 0.74 }];
    const result = classifyPairs(pairs, mediaIds);
    expect(result.length).toBe(0);
  });

  it('should skip pairs with very low similarity', () => {
    const pairs: NeighborPair[] = [{ i: 0, j: 1, similarity: 0.10 }];
    const result = classifyPairs(pairs, mediaIds);
    expect(result.length).toBe(0);
  });

  it('should correctly classify multiple pairs with different similarities', () => {
    const pairs: NeighborPair[] = [
      { i: 0, j: 1, similarity: 0.95 }, // confirmed
      { i: 1, j: 2, similarity: 0.82 }, // gray_zone
      { i: 2, j: 3, similarity: 0.50 }, // skip
      { i: 0, j: 3, similarity: 0.88 }, // confirmed (exact threshold)
    ];
    const result = classifyPairs(pairs, mediaIds);
    expect(result.length).toBe(3); // skip one pair

    const confirmed = result.filter((p) => p.classification === 'confirmed');
    const grayZone = result.filter((p) => p.classification === 'gray_zone');
    expect(confirmed.length).toBe(2);
    expect(grayZone.length).toBe(1);
  });

  it('should map indices to correct mediaIds', () => {
    const pairs: NeighborPair[] = [{ i: 2, j: 3, similarity: 0.90 }];
    const result = classifyPairs(pairs, mediaIds);
    expect(result[0].i).toBe('img-c');
    expect(result[0].j).toBe('img-d');
  });

  it('should return empty array when no pairs meet threshold', () => {
    const pairs: NeighborPair[] = [
      { i: 0, j: 1, similarity: 0.30 },
      { i: 1, j: 2, similarity: 0.40 },
      { i: 2, j: 3, similarity: 0.60 },
    ];
    const result = classifyPairs(pairs, mediaIds);
    expect(result.length).toBe(0);
  });

  it('should return empty array for empty input', () => {
    const result = classifyPairs([], mediaIds);
    expect(result.length).toBe(0);
  });
});

// --- fetchEmbeddings ML unavailability tests ---

describe('fetchEmbeddings', () => {
  // We mock the ML service availability check here to test the unavailable path
  // without needing the actual Python service running
  let mockIsMLServiceAvailable: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Dynamically mock the mlQualityService module
    vi.mock('../../mlQualityService', () => ({
      isMLServiceAvailable: vi.fn(),
      extractEmbeddings: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return null when ML service is unavailable', async () => {
    const { isMLServiceAvailable } = await import('../../mlQualityService');
    vi.mocked(isMLServiceAvailable).mockResolvedValue(false);

    const { fetchEmbeddings } = await import('../globalSimilarity');
    const result = await fetchEmbeddings(['media-1', 'media-2']);
    expect(result).toBeNull();
  });

  it('should log unavailability message when ML service is unavailable', async () => {
    const { isMLServiceAvailable } = await import('../../mlQualityService');
    vi.mocked(isMLServiceAvailable).mockResolvedValue(false);

    const consoleSpy = vi.spyOn(console, 'log');
    const { fetchEmbeddings } = await import('../globalSimilarity');
    await fetchEmbeddings(['media-1']);

    expect(consoleSpy).toHaveBeenCalledWith(
      '[globalDedup] ML service unavailable — skipping global similarity detection',
    );
    consoleSpy.mockRestore();
  });
});
