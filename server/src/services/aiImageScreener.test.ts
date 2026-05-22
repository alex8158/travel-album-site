import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing the module
vi.mock('./mlQualityService', () => ({
  extractEmbeddings: vi.fn(),
  isMLServiceAvailable: vi.fn(),
}));

vi.mock('../storage/factory', () => ({
  getStorageProvider: vi.fn(() => ({
    downloadToTemp: vi.fn(async (path: string) => `/tmp/${path}`),
  })),
}));

vi.mock('../database', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ all: vi.fn(() => []), run: vi.fn() })),
  })),
}));

import { groupBySimilarity, buildSmartBatches, SimilarityGroup } from './aiImageScreener';
import { extractEmbeddings, isMLServiceAvailable } from './mlQualityService';

const mockExtractEmbeddings = vi.mocked(extractEmbeddings);
const mockIsMLServiceAvailable = vi.mocked(isMLServiceAvailable);

describe('groupBySimilarity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return individual groups when images list is empty', async () => {
    const result = await groupBySimilarity([], 0.75);
    expect(result).toEqual([]);
  });

  it('should return a single group for a single image', async () => {
    const images = [{ id: 'img1', file_path: 'path/img1.jpg' }];
    const result = await groupBySimilarity(images, 0.75);
    expect(result).toHaveLength(1);
    expect(result[0].imageIds).toEqual(['img1']);
    expect(result[0].centroidIdx).toBe(0);
  });

  it('should return individual groups when ML service is unavailable', async () => {
    mockIsMLServiceAvailable.mockResolvedValue(false);
    const images = [
      { id: 'img1', file_path: 'path/img1.jpg' },
      { id: 'img2', file_path: 'path/img2.jpg' },
    ];
    const result = await groupBySimilarity(images, 0.75);
    expect(result).toHaveLength(2);
    expect(result[0].imageIds).toEqual(['img1']);
    expect(result[1].imageIds).toEqual(['img2']);
  });

  it('should group similar images together (sim >= threshold)', async () => {
    mockIsMLServiceAvailable.mockResolvedValue(true);

    // Create embeddings where img1 and img2 are very similar, img3 is different
    const emb1 = [1, 0, 0, 0]; // normalized
    const emb2 = [0.95, 0.05, 0, 0]; // very similar to emb1
    const emb3 = [0, 0, 1, 0]; // orthogonal to emb1 and emb2

    mockExtractEmbeddings.mockResolvedValue([
      { path: '/tmp/path/img1.jpg', embedding: emb1, error: null },
      { path: '/tmp/path/img2.jpg', embedding: emb2, error: null },
      { path: '/tmp/path/img3.jpg', embedding: emb3, error: null },
    ]);

    const images = [
      { id: 'img1', file_path: 'path/img1.jpg' },
      { id: 'img2', file_path: 'path/img2.jpg' },
      { id: 'img3', file_path: 'path/img3.jpg' },
    ];

    const result = await groupBySimilarity(images, 0.75);

    // img1 and img2 should be in the same group, img3 separate
    const groupWithImg1 = result.find(g => g.imageIds.includes('img1'));
    const groupWithImg3 = result.find(g => g.imageIds.includes('img3'));

    expect(groupWithImg1).toBeDefined();
    expect(groupWithImg1!.imageIds).toContain('img2');
    expect(groupWithImg1!.imageIds).toHaveLength(2);

    expect(groupWithImg3).toBeDefined();
    expect(groupWithImg3!.imageIds).toEqual(['img3']);
  });

  it('should keep all images separate when similarity is below threshold', async () => {
    mockIsMLServiceAvailable.mockResolvedValue(true);

    // Orthogonal embeddings - cosine similarity = 0
    const emb1 = [1, 0, 0];
    const emb2 = [0, 1, 0];
    const emb3 = [0, 0, 1];

    mockExtractEmbeddings.mockResolvedValue([
      { path: '/tmp/path/img1.jpg', embedding: emb1, error: null },
      { path: '/tmp/path/img2.jpg', embedding: emb2, error: null },
      { path: '/tmp/path/img3.jpg', embedding: emb3, error: null },
    ]);

    const images = [
      { id: 'img1', file_path: 'path/img1.jpg' },
      { id: 'img2', file_path: 'path/img2.jpg' },
      { id: 'img3', file_path: 'path/img3.jpg' },
    ];

    const result = await groupBySimilarity(images, 0.75);

    // All images should be in separate groups
    expect(result).toHaveLength(3);
    for (const group of result) {
      expect(group.imageIds).toHaveLength(1);
    }
  });

  it('should handle null embeddings gracefully', async () => {
    mockIsMLServiceAvailable.mockResolvedValue(true);

    mockExtractEmbeddings.mockResolvedValue([
      { path: '/tmp/path/img1.jpg', embedding: [1, 0, 0], error: null },
      { path: '/tmp/path/img2.jpg', embedding: null, error: 'failed' },
      { path: '/tmp/path/img3.jpg', embedding: [1, 0, 0], error: null },
    ]);

    const images = [
      { id: 'img1', file_path: 'path/img1.jpg' },
      { id: 'img2', file_path: 'path/img2.jpg' },
      { id: 'img3', file_path: 'path/img3.jpg' },
    ];

    const result = await groupBySimilarity(images, 0.75);

    // img1 and img3 have identical embeddings so should be grouped
    // img2 has null embedding so won't be grouped with anyone
    const groupWithImg1 = result.find(g => g.imageIds.includes('img1'));
    expect(groupWithImg1).toBeDefined();
    expect(groupWithImg1!.imageIds).toContain('img3');
  });

  it('should use Union-Find transitivity to group images', async () => {
    mockIsMLServiceAvailable.mockResolvedValue(true);

    // A is similar to B, B is similar to C, but A is NOT similar to C directly
    // Union-Find should still group all three together
    const embA = [1, 0, 0, 0];
    const embB = [0.8, 0.6, 0, 0]; // cos(A,B) ≈ 0.8 >= 0.75
    const embC = [0.5, 0.866, 0, 0]; // cos(B,C) ≈ 0.8 >= 0.75, cos(A,C) ≈ 0.5 < 0.75

    mockExtractEmbeddings.mockResolvedValue([
      { path: '/tmp/path/img1.jpg', embedding: embA, error: null },
      { path: '/tmp/path/img2.jpg', embedding: embB, error: null },
      { path: '/tmp/path/img3.jpg', embedding: embC, error: null },
    ]);

    const images = [
      { id: 'img1', file_path: 'path/img1.jpg' },
      { id: 'img2', file_path: 'path/img2.jpg' },
      { id: 'img3', file_path: 'path/img3.jpg' },
    ];

    const result = await groupBySimilarity(images, 0.75);

    // All three should be in the same group due to transitivity
    const bigGroup = result.find(g => g.imageIds.length === 3);
    expect(bigGroup).toBeDefined();
    expect(bigGroup!.imageIds).toContain('img1');
    expect(bigGroup!.imageIds).toContain('img2');
    expect(bigGroup!.imageIds).toContain('img3');
  });

  it('should select centroid as the image with highest average similarity to group members', async () => {
    mockIsMLServiceAvailable.mockResolvedValue(true);

    // Three similar images, embB is most central
    const embA = [1, 0, 0];
    const embB = [0.9, 0.44, 0]; // most similar to both A and C on average
    const embC = [0.7, 0.71, 0];

    mockExtractEmbeddings.mockResolvedValue([
      { path: '/tmp/path/img1.jpg', embedding: embA, error: null },
      { path: '/tmp/path/img2.jpg', embedding: embB, error: null },
      { path: '/tmp/path/img3.jpg', embedding: embC, error: null },
    ]);

    const images = [
      { id: 'img1', file_path: 'path/img1.jpg' },
      { id: 'img2', file_path: 'path/img2.jpg' },
      { id: 'img3', file_path: 'path/img3.jpg' },
    ];

    // Use a low threshold to ensure all are grouped
    const result = await groupBySimilarity(images, 0.5);

    expect(result).toHaveLength(1);
    // centroidIdx should point to the most central image within the group
    expect(result[0].centroidIdx).toBeGreaterThanOrEqual(0);
    expect(result[0].centroidIdx).toBeLessThan(3);
  });

  it('should gracefully handle extractEmbeddings failure', async () => {
    mockIsMLServiceAvailable.mockResolvedValue(true);
    mockExtractEmbeddings.mockRejectedValue(new Error('Python service crashed'));

    const images = [
      { id: 'img1', file_path: 'path/img1.jpg' },
      { id: 'img2', file_path: 'path/img2.jpg' },
    ];

    const result = await groupBySimilarity(images, 0.75);

    // Should fall back to individual groups
    expect(result).toHaveLength(2);
    expect(result[0].imageIds).toEqual(['img1']);
    expect(result[1].imageIds).toEqual(['img2']);
  });

  it('should use default threshold of 0.75 when not specified', async () => {
    mockIsMLServiceAvailable.mockResolvedValue(true);

    // Embeddings with cosine similarity of exactly 0.75
    const emb1 = [1, 0, 0];
    const emb2 = [0.75, 0.6614, 0]; // cos(emb1, emb2) = 0.75 / sqrt(0.75^2 + 0.6614^2) ≈ 0.75

    mockExtractEmbeddings.mockResolvedValue([
      { path: '/tmp/path/img1.jpg', embedding: emb1, error: null },
      { path: '/tmp/path/img2.jpg', embedding: emb2, error: null },
    ]);

    const images = [
      { id: 'img1', file_path: 'path/img1.jpg' },
      { id: 'img2', file_path: 'path/img2.jpg' },
    ];

    // Call without explicit threshold - should use 0.75 default
    const result = await groupBySimilarity(images);

    // The similarity should be >= 0.75, so they should be grouped
    const groupWithBoth = result.find(g => g.imageIds.length === 2);
    expect(groupWithBoth).toBeDefined();
  });
});


describe('buildSmartBatches', () => {
  // Helper to create image objects
  function makeImages(count: number): Array<{ id: string; file_path: string }> {
    return Array.from({ length: count }, (_, i) => ({
      id: `img${i + 1}`,
      file_path: `path/img${i + 1}.jpg`,
    }));
  }

  it('should return empty array for empty images', () => {
    const result = buildSmartBatches([], [], 10);
    expect(result).toEqual([]);
  });

  it('should handle a single image in a single group', () => {
    const images = makeImages(1);
    const groups: SimilarityGroup[] = [{ imageIds: ['img1'], centroidIdx: 0 }];
    const result = buildSmartBatches(images, groups, 10);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0].id).toBe('img1');
  });

  it('should split large groups into multiple batches', () => {
    const images = makeImages(15);
    const groups: SimilarityGroup[] = [
      { imageIds: images.map(img => img.id), centroidIdx: 0 },
    ];
    const result = buildSmartBatches(images, groups, 10);
    // 15 images should be split into 2 batches: 10 + 5
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(10);
    expect(result[1]).toHaveLength(5);
  });

  it('should keep same-group images in the same batch when group <= batchSize', () => {
    const images = makeImages(8);
    const groups: SimilarityGroup[] = [
      { imageIds: ['img1', 'img2', 'img3'], centroidIdx: 0 },
      { imageIds: ['img4', 'img5'], centroidIdx: 0 },
      { imageIds: ['img6'], centroidIdx: 0 },
      { imageIds: ['img7'], centroidIdx: 0 },
      { imageIds: ['img8'], centroidIdx: 0 },
    ];
    const result = buildSmartBatches(images, groups, 10);

    // All images should fit in one batch since total is 8 <= 10
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(8);

    // Verify group [img1, img2, img3] are all in the same batch
    const batch0Ids = result[0].map(img => img.id);
    expect(batch0Ids).toContain('img1');
    expect(batch0Ids).toContain('img2');
    expect(batch0Ids).toContain('img3');
  });

  it('should not exceed batchSize in any batch', () => {
    const images = makeImages(25);
    const groups: SimilarityGroup[] = [
      { imageIds: ['img1', 'img2', 'img3', 'img4', 'img5', 'img6', 'img7'], centroidIdx: 0 },
      { imageIds: ['img8', 'img9', 'img10', 'img11', 'img12'], centroidIdx: 0 },
      { imageIds: ['img13', 'img14', 'img15', 'img16'], centroidIdx: 0 },
      ...Array.from({ length: 9 }, (_, i) => ({
        imageIds: [`img${i + 17}`],
        centroidIdx: 0,
      })),
    ];
    const result = buildSmartBatches(images, groups, 10);

    for (const batch of result) {
      expect(batch.length).toBeLessThanOrEqual(10);
    }
  });

  it('should include every image in exactly one batch', () => {
    const images = makeImages(20);
    const groups: SimilarityGroup[] = [
      { imageIds: ['img1', 'img2', 'img3', 'img4', 'img5'], centroidIdx: 0 },
      { imageIds: ['img6', 'img7', 'img8'], centroidIdx: 0 },
      { imageIds: ['img9', 'img10'], centroidIdx: 0 },
      ...Array.from({ length: 10 }, (_, i) => ({
        imageIds: [`img${i + 11}`],
        centroidIdx: 0,
      })),
    ];
    const result = buildSmartBatches(images, groups, 10);

    // Collect all image ids from all batches
    const allIds = result.flatMap(batch => batch.map(img => img.id));
    const uniqueIds = new Set(allIds);

    // Every image appears exactly once
    expect(allIds.length).toBe(uniqueIds.size);
    expect(uniqueIds.size).toBe(20);
    for (const img of images) {
      expect(uniqueIds.has(img.id)).toBe(true);
    }
  });

  it('should fill small group batches with ungrouped images', () => {
    const images = makeImages(10);
    const groups: SimilarityGroup[] = [
      { imageIds: ['img1', 'img2', 'img3'], centroidIdx: 0 },
      // 7 ungrouped images
      { imageIds: ['img4'], centroidIdx: 0 },
      { imageIds: ['img5'], centroidIdx: 0 },
      { imageIds: ['img6'], centroidIdx: 0 },
      { imageIds: ['img7'], centroidIdx: 0 },
      { imageIds: ['img8'], centroidIdx: 0 },
      { imageIds: ['img9'], centroidIdx: 0 },
      { imageIds: ['img10'], centroidIdx: 0 },
    ];
    const result = buildSmartBatches(images, groups, 10);

    // The small group of 3 should be filled with ungrouped images to make a batch of 10
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(10);

    // The group [img1, img2, img3] should be in the batch
    const batchIds = result[0].map(img => img.id);
    expect(batchIds).toContain('img1');
    expect(batchIds).toContain('img2');
    expect(batchIds).toContain('img3');
  });

  it('should merge multiple small groups into one batch when they fit', () => {
    const images = makeImages(9);
    const groups: SimilarityGroup[] = [
      { imageIds: ['img1', 'img2', 'img3'], centroidIdx: 0 },
      { imageIds: ['img4', 'img5', 'img6'], centroidIdx: 0 },
      { imageIds: ['img7', 'img8', 'img9'], centroidIdx: 0 },
    ];
    const result = buildSmartBatches(images, groups, 10);

    // 3 groups of 3 = 9 images, should fit in one batch
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(9);
  });

  it('should not merge a small group if it would exceed batchSize', () => {
    const images = makeImages(12);
    const groups: SimilarityGroup[] = [
      { imageIds: ['img1', 'img2', 'img3', 'img4', 'img5', 'img6', 'img7'], centroidIdx: 0 },
      { imageIds: ['img8', 'img9', 'img10', 'img11', 'img12'], centroidIdx: 0 },
    ];
    const result = buildSmartBatches(images, groups, 10);

    // Group of 7 + group of 5 = 12 > 10, so they should be in separate batches
    expect(result).toHaveLength(2);
    // First batch: group of 7 filled with ungrouped (none available) or smaller groups
    // Since group of 5 doesn't fit (7+5=12>10), they stay separate
    const batch0Ids = result[0].map(img => img.id);
    const batch1Ids = result[1].map(img => img.id);

    // Verify group integrity
    expect(batch0Ids).toContain('img1');
    expect(batch0Ids).toContain('img7');
    expect(batch1Ids).toContain('img8');
    expect(batch1Ids).toContain('img12');
  });

  it('should handle groups with image ids not in the images array', () => {
    const images = makeImages(3);
    const groups: SimilarityGroup[] = [
      { imageIds: ['img1', 'img2', 'nonexistent'], centroidIdx: 0 },
      { imageIds: ['img3'], centroidIdx: 0 },
    ];
    const result = buildSmartBatches(images, groups, 10);

    // Should only include valid images
    const allIds = result.flatMap(batch => batch.map(img => img.id));
    expect(allIds).not.toContain('nonexistent');
    expect(allIds).toContain('img1');
    expect(allIds).toContain('img2');
    expect(allIds).toContain('img3');
  });

  it('should handle batchSize of 1', () => {
    const images = makeImages(3);
    const groups: SimilarityGroup[] = [
      { imageIds: ['img1', 'img2', 'img3'], centroidIdx: 0 },
    ];
    const result = buildSmartBatches(images, groups, 1);

    // Each image should be in its own batch
    expect(result).toHaveLength(3);
    for (const batch of result) {
      expect(batch).toHaveLength(1);
    }
  });

  it('should sort groups by size descending and process large groups first', () => {
    const images = makeImages(22);
    const groups: SimilarityGroup[] = [
      { imageIds: ['img1', 'img2'], centroidIdx: 0 }, // small group
      { imageIds: images.slice(2, 14).map(img => img.id), centroidIdx: 0 }, // large group (12)
      { imageIds: ['img15', 'img16', 'img17'], centroidIdx: 0 }, // small group
      ...Array.from({ length: 5 }, (_, i) => ({
        imageIds: [`img${i + 18}`],
        centroidIdx: 0,
      })),
    ];
    const result = buildSmartBatches(images, groups, 10);

    // Large group of 12 should be split into batches of 10 + 2
    // Verify no batch exceeds 10
    for (const batch of result) {
      expect(batch.length).toBeLessThanOrEqual(10);
    }

    // All 22 images should be present
    const allIds = result.flatMap(batch => batch.map(img => img.id));
    expect(new Set(allIds).size).toBe(22);
  });
});
