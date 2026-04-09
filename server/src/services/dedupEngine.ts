import sharp from 'sharp';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';
import { createBedrockClient, resizeForAnalysis, extractJSON, type BedrockClient } from './bedrockClient';

/**
 * Compute a 64-bit dHash (difference hash) for an image.
 * Resizes to 9x8 grayscale, compares adjacent pixels per row.
 * Returns a 16-character hex string.
 */
export async function computeHash(imagePath: string): Promise<string> {
  const { data } = await sharp(imagePath)
    .resize(9, 8, { fit: 'cover' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 8 rows × 8 bits = 64 bits
  const bits: number[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const idx = row * 9 + col;
      bits.push(data[idx] > data[idx + 1] ? 1 : 0);
    }
  }

  // Convert 64 bits to 16-char hex string
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    const nibble = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
    hex += nibble.toString(16);
  }
  return hex;
}

/**
 * Compute a 64-bit pHash (perceptual hash) for an image using mean-binarization.
 * Resizes to 32×32 grayscale, computes global mean, then binarizes the 8×8
 * top-left block against that mean. Returns a 16-character hex string.
 */
export async function computePHash(imagePath: string): Promise<string> {
  const { data } = await sharp(imagePath)
    .resize(32, 32, { fit: 'cover' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Compute mean of all 1024 pixel values
  let sum = 0;
  for (let i = 0; i < 1024; i++) {
    sum += data[i];
  }
  const mean = sum / 1024;

  // Binarize first 64 pixels (8×8 top-left block)
  const bits: number[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const idx = row * 32 + col;
      bits.push(data[idx] > mean ? 1 : 0);
    }
  }

  // Pack 64 bits into 16-char hex string
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    const nibble = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
    hex += nibble.toString(16);
  }
  return hex;
}

/**
 * Compute the Hamming distance between two hex hash strings.
 * Counts the number of differing bits.
 */
export function hammingDistance(hash1: string, hash2: string): number {
  if (hash1.length !== hash2.length) {
    throw new Error('Hash strings must be the same length');
  }

  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    const xor = parseInt(hash1[i], 16) ^ parseInt(hash2[i], 16);
    // Count set bits in xor (Brian Kernighan's algorithm for 4-bit nibble)
    let bits = xor;
    while (bits) {
      bits &= bits - 1;
      distance++;
    }
  }
  return distance;
}

export interface SlidingWindowDedupOptions {
  windowSize?: number;         // default 5, max 10
  hammingThreshold?: number;   // kept for backward compat, not used by Bedrock
  bedrockClient?: BedrockClient; // optional, created internally if not provided
}

export interface DedupResult {
  kept: string[];              // kept mediaId list
  removed: string[];           // removed mediaId list
  removedCount: number;
}

/**
 * Deduplicate images for a trip using Bedrock vision model with sliding windows.
 * Queries all images (active + trashed) ordered by created_at, sends each window
 * to Bedrock for duplicate detection, and trashes duplicates keeping the best.
 */
export async function deduplicate(
  tripId: string,
  options?: SlidingWindowDedupOptions
): Promise<DedupResult> {
  const windowSize = Math.min(options?.windowSize ?? 5, 10);
  const bedrockClient = options?.bedrockClient ?? createBedrockClient();

  const db = getDb();
  const storageProvider = getStorageProvider();

  // Query ALL images (active + trashed) ordered by created_at
  const rows = db.prepare(
    `SELECT id, file_path, sharpness_score, width, height, status, trashed_reason, created_at
     FROM media_items
     WHERE trip_id = ? AND media_type = 'image' AND status IN ('active', 'trashed')
     ORDER BY created_at ASC`
  ).all(tripId) as Array<{
    id: string;
    file_path: string;
    sharpness_score: number | null;
    width: number | null;
    height: number | null;
    status: string;
    trashed_reason: string | null;
    created_at: string;
  }>;

  if (rows.length === 0) return { kept: [], removed: [], removedCount: 0 };

  const removedSet = new Set<number>();

  // Sliding window — step by windowSize
  for (let start = 0; start < rows.length - 1; start += windowSize) {
    const end = Math.min(start + windowSize, rows.length);
    const windowRows = rows.slice(start, end);

    // Skip windows with only 1 image
    if (windowRows.length < 2) continue;

    // Skip if all images in window are already removed
    const activeIndices = windowRows.map((_, i) => start + i).filter(i => !removedSet.has(i));
    if (activeIndices.length < 2) continue;

    try {
      // Resize all images in window to 512px base64
      const images: Array<{ base64: string; mediaType: string }> = [];
      for (const row of windowRows) {
        const localPath = await storageProvider.downloadToTemp(row.file_path);
        const base64 = await resizeForAnalysis(localPath);
        images.push({ base64, mediaType: 'image/jpeg' });
      }

      const prompt = `I'm showing you ${windowRows.length} images from a photo sequence. Identify which images are duplicate shots of the same scene (same location, same subject, just slightly different angle, timing, or framing).

For each duplicate group, also tell me which image is the BEST one to keep (sharpest, best composition, best exposure).

Return a JSON object with a "duplicate_groups" field. Each group is an object with:
- "indices": array of image indices (0-based) that are duplicates
- "keep": the index of the best image to keep

Return ONLY a JSON object, no other text:
{"duplicate_groups": [{"indices": [0, 2, 5], "keep": 5}, {"indices": [3, 4], "keep": 3}]}

If no duplicates are found, return:
{"duplicate_groups": []}`;

      const response = await bedrockClient.invokeModel({ images, prompt });
      const result = extractJSON<{ duplicate_groups: Array<{ indices: number[]; keep: number } | number[]> }>(response);

      if (!Array.isArray(result.duplicate_groups)) continue;

      // Process each duplicate group
      for (const group of result.duplicate_groups) {
        // Support both formats: {indices, keep} or plain array
        let indices: number[];
        let keepIdx: number | null = null;

        if (Array.isArray(group)) {
          indices = group;
        } else if (group && Array.isArray(group.indices)) {
          indices = group.indices;
          keepIdx = typeof group.keep === 'number' ? group.keep : null;
        } else {
          continue;
        }

        if (indices.length < 2) continue;

        // Map window-local indices to global indices
        const globalIndices = indices
          .filter(i => i >= 0 && i < windowRows.length)
          .map(i => start + i)
          .filter(i => !removedSet.has(i));

        if (globalIndices.length < 2) continue;

        // Determine winner: use model's recommendation if valid, otherwise fallback to pickLoser
        let winnerIdx: number;
        if (keepIdx !== null && keepIdx >= 0 && keepIdx < windowRows.length) {
          const globalKeep = start + keepIdx;
          if (globalIndices.includes(globalKeep) && !removedSet.has(globalKeep)) {
            winnerIdx = globalKeep;
          } else {
            winnerIdx = globalIndices[0];
            for (let k = 1; k < globalIndices.length; k++) {
              const loserIdx = pickLoser(rows, winnerIdx, globalIndices[k]);
              if (loserIdx === winnerIdx) winnerIdx = globalIndices[k];
            }
          }
        } else {
          winnerIdx = globalIndices[0];
          for (let k = 1; k < globalIndices.length; k++) {
            const loserIdx = pickLoser(rows, winnerIdx, globalIndices[k]);
            if (loserIdx === winnerIdx) winnerIdx = globalIndices[k];
          }
        }

        // Trash all except winner
        for (const idx of globalIndices) {
          if (idx === winnerIdx) continue;
          removedSet.add(idx);
          const loser = rows[idx];
          if (loser.status === 'trashed') {
            const newReason = loser.trashed_reason
              ? `${loser.trashed_reason},duplicate`
              : 'duplicate';
            db.prepare("UPDATE media_items SET trashed_reason = ? WHERE id = ?").run(newReason, loser.id);
          } else {
            db.prepare("UPDATE media_items SET status = 'trashed', trashed_reason = 'duplicate' WHERE id = ?").run(loser.id);
          }
        }
      }
    } catch (err) {
      console.error(`[bedrockDedup] Window ${start}-${end} failed:`, err);
      // Skip this window on error
    }
  }

  // Build result
  const kept: string[] = [];
  const removed: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (removedSet.has(i)) {
      removed.push(rows[i].id);
    } else {
      kept.push(rows[i].id);
    }
  }

  return { kept, removed, removedCount: removed.length };
}

/**
 * Retention priority to pick the loser between two duplicate images:
 * ① higher sharpness_score wins
 * ② if sharpness diff < 10, higher resolution (w*h) wins
 * ③ earlier in sequence wins (lower index)
 * Returns the index of the loser (the one to remove).
 */
function pickLoser(
  rows: Array<{ sharpness_score: number | null; width: number | null; height: number | null }>,
  i: number,
  j: number
): number {
  const sharpI = rows[i].sharpness_score ?? 0;
  const sharpJ = rows[j].sharpness_score ?? 0;
  const sharpDiff = Math.abs(sharpI - sharpJ);

  if (sharpDiff >= 10) {
    // Clear winner by sharpness
    return sharpI >= sharpJ ? j : i;
  }

  // Sharpness is close (diff < 10), compare resolution
  const resI = (rows[i].width ?? 0) * (rows[i].height ?? 0);
  const resJ = (rows[j].width ?? 0) * (rows[j].height ?? 0);

  if (resI !== resJ) {
    return resI >= resJ ? j : i;
  }

  // Same resolution — keep earlier in sequence (lower index)
  return j;
}
