import OpenAI from 'openai';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';
import { TempPathCache } from '../helpers/tempPathCache';
import { resizeForAnalysis } from './bedrockClient';
import { extractEmbeddings, isMLServiceAvailable } from './mlQualityService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScreeningResult {
  keep: number[];
  remove: number[];
  reason: string;
}

export interface AiScreeningResult {
  totalProcessed: number;
  totalRemoved: number;
  batchResults: Array<{ batch: number; removed: number; reason: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 10;
export const GROUPING_THRESHOLD = 0.75; // DINOv2 余弦相似度分组阈值

// ---------------------------------------------------------------------------
// Similarity Grouping Types
// ---------------------------------------------------------------------------

export interface SimilarityGroup {
  imageIds: string[];
  centroidIdx: number; // 组内代表图片的索引
}

const SCREENING_PROMPT = `You are a photo curator. I'm showing you a batch of photos from an underwater dive trip.

Your tasks:
1. If you see 2+ photos of the SAME subject/scene (same fish, same coral, same angle), keep only the BEST one (sharpest, best framing) and remove the rest
2. Remove any photo that is clearly blurry, severely out-of-focus, or completely dark/unrecognizable
3. Photos of DIFFERENT subjects should ALL be kept — even if they look visually similar (e.g. two different fish of the same species)

Return a JSON object:
{"keep": [0, 2, 4, 5], "remove": [1, 3], "reason": "Photo 1 is a duplicate angle of photo 0 (same parrotfish); Photo 3 is blurry"}

Rules:
- "keep": indices of photos to keep
- "remove": indices of photos to remove
- If all photos are unique and clear, return {"keep": [0,1,2,...,9], "remove": [], "reason": "All photos are unique and clear"}
- Typically remove 1-4 photos per batch, but 0 is fine if all are unique`;

// ---------------------------------------------------------------------------
// DashScope client (reuses pattern from llmPairReviewer)
// ---------------------------------------------------------------------------

function createScreeningClient(): OpenAI {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY environment variable is required');

  const baseURL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  return new OpenAI({ apiKey, baseURL });
}

// ---------------------------------------------------------------------------
// Cosine similarity helper
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
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

// ---------------------------------------------------------------------------
// Union-Find for similarity grouping
// ---------------------------------------------------------------------------

class UnionFind {
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

  getGroups(n: number): Map<number, number[]> {
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const root = this.find(i);
      if (!groups.has(root)) {
        groups.set(root, []);
      }
      groups.get(root)!.push(i);
    }
    return groups;
  }
}

// ---------------------------------------------------------------------------
// Similarity grouping via DINOv2 embeddings
// ---------------------------------------------------------------------------

/**
 * 利用 DINOv2 嵌入向量对图片进行相似度预分组。
 * 使用 Union-Find 将相似度 >= threshold 的图片归入同一组。
 */
export async function groupBySimilarity(
  images: Array<{ id: string; file_path: string }>,
  threshold: number = GROUPING_THRESHOLD
): Promise<SimilarityGroup[]> {
  if (images.length < 2) {
    return images.map((img) => ({ imageIds: [img.id], centroidIdx: 0 }));
  }

  // Check if ML service is available
  const mlAvailable = await isMLServiceAvailable();
  if (!mlAvailable) {
    console.warn('[aiScreening] DINOv2 service unavailable, returning individual groups');
    return images.map((img) => ({ imageIds: [img.id], centroidIdx: 0 }));
  }

  // Download images to temp paths for embedding extraction
  const storageProvider = getStorageProvider();
  const tempCache = new TempPathCache(storageProvider);

  try {
    const tempPaths: string[] = [];
    const validIndices: number[] = [];

    for (let i = 0; i < images.length; i++) {
      try {
        const localPath = await tempCache.get(images[i].file_path);
        tempPaths.push(localPath);
        validIndices.push(i);
      } catch (err) {
        console.warn(`[aiScreening] groupBySimilarity: failed to download ${images[i].id}: ${err}`);
      }
    }

    if (validIndices.length < 2) {
      // Not enough images to compare, return individual groups
      return images.map((img) => ({ imageIds: [img.id], centroidIdx: 0 }));
    }

    // Extract DINOv2 embeddings
    console.log(`[aiScreening] groupBySimilarity: extracting embeddings for ${validIndices.length} images...`);
    const embeddingResults = await extractEmbeddings(tempPaths);
    const embeddings: Array<number[] | null> = embeddingResults.map(r => r.embedding);

    // Build Union-Find over valid images with embeddings
    const uf = new UnionFind(validIndices.length);

    // Compute pairwise cosine similarity and union images above threshold
    for (let i = 0; i < validIndices.length; i++) {
      if (!embeddings[i]) continue;
      for (let j = i + 1; j < validIndices.length; j++) {
        if (!embeddings[j]) continue;
        const sim = cosineSimilarity(embeddings[i]!, embeddings[j]!);
        if (sim >= threshold) {
          uf.union(i, j);
        }
      }
    }

    // Collect groups from Union-Find
    const ufGroups = uf.getGroups(validIndices.length);
    const result: SimilarityGroup[] = [];

    const groupEntries = Array.from(ufGroups.entries());
    for (const [, members] of groupEntries) {
      const imageIds = members.map(localIdx => images[validIndices[localIdx]].id);

      // Select centroid: the image with the highest average similarity to others in the group
      let centroidIdx = 0;
      if (members.length > 1) {
        let maxAvgSim = -1;
        for (let i = 0; i < members.length; i++) {
          const emb = embeddings[members[i]];
          if (!emb) continue;
          let totalSim = 0;
          let count = 0;
          for (let j = 0; j < members.length; j++) {
            if (i === j) continue;
            const otherEmb = embeddings[members[j]];
            if (!otherEmb) continue;
            totalSim += cosineSimilarity(emb, otherEmb);
            count++;
          }
          const avgSim = count > 0 ? totalSim / count : 0;
          if (avgSim > maxAvgSim) {
            maxAvgSim = avgSim;
            centroidIdx = i;
          }
        }
      }

      result.push({ imageIds, centroidIdx });
    }

    // Add images that failed to download as individual groups
    const validSet = new Set(validIndices);
    for (let i = 0; i < images.length; i++) {
      if (!validSet.has(i)) {
        result.push({ imageIds: [images[i].id], centroidIdx: 0 });
      }
    }

    console.log(`[aiScreening] groupBySimilarity: ${result.length} groups formed (threshold=${threshold})`);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[aiScreening] groupBySimilarity failed: ${msg}, returning individual groups`);
    return images.map((img) => ({ imageIds: [img.id], centroidIdx: 0 }));
  } finally {
    tempCache.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Smart batch construction
// ---------------------------------------------------------------------------

/**
 * 基于相似度分组构建 AI 筛选批次。
 * 优先将同组图片放入同一批次，不足时用相邻组或未分组图片填充。
 */
export function buildSmartBatches(
  images: Array<{ id: string; file_path: string }>,
  groups: SimilarityGroup[],
  batchSize: number
): Array<Array<{ id: string; file_path: string }>> {
  if (images.length === 0 || batchSize <= 0) return [];

  // Build a lookup from image id to image object
  const imageMap = new Map<string, { id: string; file_path: string }>();
  for (const img of images) {
    imageMap.set(img.id, img);
  }

  // Separate groups into large (> batchSize), small (2..batchSize), and ungrouped (size 1)
  const sortedGroups = [...groups].sort((a, b) => b.imageIds.length - a.imageIds.length);

  const largeGroups: SimilarityGroup[] = [];
  const smallGroups: SimilarityGroup[] = [];
  const ungroupedImages: Array<{ id: string; file_path: string }> = [];

  for (const group of sortedGroups) {
    // Filter to only include images that exist in the input images array
    const validIds = group.imageIds.filter(id => imageMap.has(id));
    if (validIds.length === 0) continue;

    if (validIds.length === 1) {
      const img = imageMap.get(validIds[0]);
      if (img) ungroupedImages.push(img);
    } else if (validIds.length > batchSize) {
      largeGroups.push({ ...group, imageIds: validIds });
    } else {
      smallGroups.push({ ...group, imageIds: validIds });
    }
  }

  const batches: Array<Array<{ id: string; file_path: string }>> = [];
  const assignedIds = new Set<string>();

  // Step 1: Large groups — split into multiple batches of at most batchSize
  for (const group of largeGroups) {
    const groupImages = group.imageIds
      .filter(id => !assignedIds.has(id))
      .map(id => imageMap.get(id)!)
      .filter(Boolean);

    for (let i = 0; i < groupImages.length; i += batchSize) {
      const batch = groupImages.slice(i, i + batchSize);
      for (const img of batch) assignedIds.add(img.id);
      batches.push(batch);
    }
  }

  // Step 2: Small groups — merge/fill batches
  // Process small groups in order (already sorted by size descending)
  const usedSmallGroups = new Set<number>();

  for (let i = 0; i < smallGroups.length; i++) {
    if (usedSmallGroups.has(i)) continue;

    const group = smallGroups[i];
    const groupImages = group.imageIds
      .filter(id => !assignedIds.has(id))
      .map(id => imageMap.get(id)!)
      .filter(Boolean);

    if (groupImages.length === 0) {
      usedSmallGroups.add(i);
      continue;
    }

    const currentBatch: Array<{ id: string; file_path: string }> = [...groupImages];
    for (const img of groupImages) assignedIds.add(img.id);
    usedSmallGroups.add(i);

    // Fill remaining space with other small groups that fit
    const remaining = batchSize - currentBatch.length;
    if (remaining > 0) {
      for (let j = i + 1; j < smallGroups.length && currentBatch.length < batchSize; j++) {
        if (usedSmallGroups.has(j)) continue;

        const otherGroup = smallGroups[j];
        const otherImages = otherGroup.imageIds
          .filter(id => !assignedIds.has(id))
          .map(id => imageMap.get(id)!)
          .filter(Boolean);

        if (otherImages.length === 0) {
          usedSmallGroups.add(j);
          continue;
        }

        // Only merge if the entire group fits in the remaining space
        if (otherImages.length <= batchSize - currentBatch.length) {
          for (const img of otherImages) {
            currentBatch.push(img);
            assignedIds.add(img.id);
          }
          usedSmallGroups.add(j);
        }
      }

      // Fill remaining space with ungrouped images
      while (currentBatch.length < batchSize && ungroupedImages.length > 0) {
        const img = ungroupedImages[0];
        if (!assignedIds.has(img.id)) {
          currentBatch.push(img);
          assignedIds.add(img.id);
        }
        ungroupedImages.shift();
      }
    }

    batches.push(currentBatch);
  }

  // Step 3: Remaining ungrouped images — fill into batches of batchSize
  const remainingUngrouped = ungroupedImages.filter(img => !assignedIds.has(img.id));
  for (let i = 0; i < remainingUngrouped.length; i += batchSize) {
    const batch = remainingUngrouped.slice(i, i + batchSize);
    for (const img of batch) assignedIds.add(img.id);
    batches.push(batch);
  }

  return batches;
}

// ---------------------------------------------------------------------------
// Main screening function
// ---------------------------------------------------------------------------

export async function runAiScreening(tripId: string): Promise<AiScreeningResult> {
  const db = getDb();
  const storageProvider = getStorageProvider();

  // Get all active, non-blurry images for this trip (after dedup has already removed duplicates)
  const activeImages = db.prepare(
    `SELECT id, file_path FROM media_items
     WHERE trip_id = ? AND media_type = 'image' AND status = 'active'
       AND (blur_status IS NULL OR blur_status != 'blurry')
     ORDER BY created_at ASC`
  ).all(tripId) as Array<{ id: string; file_path: string }>;

  if (activeImages.length <= 1) {
    return { totalProcessed: 0, totalRemoved: 0, batchResults: [] };
  }

  const model = process.env.DASHSCOPE_MODEL || 'qwen-vl-max';
  const client = createScreeningClient();

  // Smart batching: try similarity grouping first, fall back to time-ordered
  let batches: Array<Array<{ id: string; file_path: string }>>;
  let usedSmartBatching = false;

  try {
    const groups = await groupBySimilarity(activeImages, GROUPING_THRESHOLD);

    // Detect fallback: if ALL groups have exactly 1 image, DINOv2 wasn't available
    const hasMultiImageGroups = groups.some(g => g.imageIds.length > 1);

    if (hasMultiImageGroups) {
      // Use smart batching
      batches = buildSmartBatches(activeImages, groups, BATCH_SIZE);
      usedSmartBatching = true;

      // Log grouping statistics
      const totalGroups = groups.length;
      const maxGroupSize = Math.max(...groups.map(g => g.imageIds.length));
      const ungroupedCount = groups.filter(g => g.imageIds.length === 1).length;
      console.log(
        `[pipeline] aiScreening: smart batching enabled — ` +
        `${totalGroups} groups, max group size ${maxGroupSize}, ` +
        `${ungroupedCount} ungrouped images`
      );
    } else {
      // All groups are single-image: DINOv2 unavailable or no similarities found
      console.log('[pipeline] aiScreening: no multi-image groups found, falling back to time-ordered batching');
      batches = [];
      for (let i = 0; i < activeImages.length; i += BATCH_SIZE) {
        batches.push(activeImages.slice(i, i + BATCH_SIZE));
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[pipeline] aiScreening: groupBySimilarity failed (${errMsg}), falling back to time-ordered batching`);
    batches = [];
    for (let i = 0; i < activeImages.length; i += BATCH_SIZE) {
      batches.push(activeImages.slice(i, i + BATCH_SIZE));
    }
  }

  const result: AiScreeningResult = {
    totalProcessed: activeImages.length,
    totalRemoved: 0,
    batchResults: [],
  };

  const trashStmt = db.prepare(
    `UPDATE media_items SET status = 'trashed', trashed_reason = 'ai_screening' WHERE id = ?`
  );

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];

    try {
      // Prepare images as base64 thumbnails
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

      let prepFailed = false;
      for (let imgIdx = 0; imgIdx < batch.length; imgIdx++) {
        const img = batch[imgIdx];
        try {
          const localPath = await storageProvider.downloadToTemp(img.file_path);
          const base64 = await resizeForAnalysis(localPath);
          content.push({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[pipeline] aiScreening: failed to prepare image ${img.id}: ${msg}`);
          prepFailed = true;
          break;
        }
      }

      if (prepFailed || content.length === 0) {
        console.log(`[pipeline] aiScreening: batch ${batchIdx + 1}/${batches.length} skipped (prep failed)`);
        continue;
      }

      content.push({ type: 'text', text: SCREENING_PROMPT });

      // Call qwen-vl-max
      const response = await client.chat.completions.create({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content }],
      });

      const responseText = response.choices[0]?.message?.content ?? '';

      // Parse response
      const screening = parseScreeningResponse(responseText, batch.length);

      if (screening && screening.remove.length > 0) {
        // Mark removed images as trashed
        for (const removeIdx of screening.remove) {
          if (removeIdx >= 0 && removeIdx < batch.length) {
            trashStmt.run(batch[removeIdx].id);
          }
        }
        const removedCount = screening.remove.filter(i => i >= 0 && i < batch.length).length;
        result.totalRemoved += removedCount;
        result.batchResults.push({
          batch: batchIdx + 1,
          removed: removedCount,
          reason: screening.reason,
        });
        console.log(`[pipeline] aiScreening: batch ${batchIdx + 1}/${batches.length}, removed ${removedCount} images`);
      } else {
        console.log(`[pipeline] aiScreening: batch ${batchIdx + 1}/${batches.length}, no removals`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[pipeline] aiScreening: batch ${batchIdx + 1}/${batches.length} failed: ${msg}`);
      // Skip failed batch and continue
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Response parsing helper
// ---------------------------------------------------------------------------

function parseScreeningResponse(text: string, batchSize: number): ScreeningResult | null {
  try {
    // Try to extract JSON from markdown code blocks
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    let jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : text.trim();

    // Try to find JSON object in the text
    if (!jsonStr.startsWith('{')) {
      const objectMatch = jsonStr.match(/(\{[\s\S]*\})/);
      if (objectMatch) {
        jsonStr = objectMatch[1];
      }
    }

    const parsed = JSON.parse(jsonStr) as ScreeningResult;

    // Validate the response
    if (!Array.isArray(parsed.keep) || !Array.isArray(parsed.remove)) {
      return null;
    }

    // Filter out invalid indices
    parsed.keep = parsed.keep.filter(i => typeof i === 'number' && i >= 0 && i < batchSize);
    parsed.remove = parsed.remove.filter(i => typeof i === 'number' && i >= 0 && i < batchSize);

    // Ensure no overlap between keep and remove
    const keepSet = new Set(parsed.keep);
    parsed.remove = parsed.remove.filter(i => !keepSet.has(i));

    if (!parsed.reason || typeof parsed.reason !== 'string') {
      parsed.reason = 'AI screening';
    }

    return parsed;
  } catch {
    return null;
  }
}
