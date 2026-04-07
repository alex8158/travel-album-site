import sharp from 'sharp';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';
import { deleteMediaItemFromDb } from '../helpers/deleteMediaItem';

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
  windowSize?: number;         // default 10
  hammingThreshold?: number;   // default 5 (Hamming distance, 0-64)
}

export interface DedupResult {
  kept: string[];              // kept mediaId list
  removed: string[];           // removed mediaId list
  removedCount: number;
}

/**
 * Deduplicate images for a trip using a sliding window approach.
 * Queries all active images ordered by created_at, computes pHash,
 * and compares each image with the next windowSize images.
 * Duplicates are permanently deleted (DB first, then storage).
 */
export async function deduplicate(
  tripId: string,
  options?: SlidingWindowDedupOptions
): Promise<DedupResult> {
  const windowSize = options?.windowSize ?? 10;
  const hammingThreshold = options?.hammingThreshold ?? 5;

  const db = getDb();
  const storageProvider = getStorageProvider();

  // 1. Query all active images for the trip, ordered by created_at
  const rows = db.prepare(
    `SELECT id, file_path, sharpness_score, width, height, created_at
     FROM media_items
     WHERE trip_id = ? AND status = 'active' AND media_type = 'image'
     ORDER BY created_at ASC`
  ).all(tripId) as Array<{
    id: string;
    file_path: string;
    sharpness_score: number | null;
    width: number | null;
    height: number | null;
    created_at: string;
  }>;

  if (rows.length === 0) {
    return { kept: [], removed: [], removedCount: 0 };
  }

  // 2. Compute pHash for each image
  const pHashes: (string | null)[] = [];
  for (const row of rows) {
    try {
      const localPath = await storageProvider.downloadToTemp(row.file_path);
      const pHash = await computePHash(localPath);
      pHashes.push(pHash);
    } catch {
      // If hash computation fails, mark as null (won't participate in dedup)
      pHashes.push(null);
    }
  }

  // 3. Track removed set so already-removed images are skipped
  const removedSet = new Set<number>();

  // 4. Sliding window comparison
  for (let i = 0; i < rows.length; i++) {
    if (removedSet.has(i)) continue;
    if (pHashes[i] === null) continue;

    const end = Math.min(i + windowSize, rows.length - 1);
    for (let j = i + 1; j <= end; j++) {
      if (removedSet.has(j)) continue;
      if (pHashes[j] === null) continue;

      const dist = hammingDistance(pHashes[i]!, pHashes[j]!);
      if (dist <= hammingThreshold) {
        // They're duplicates — decide who to remove
        const loserIdx = pickLoser(rows, i, j);
        removedSet.add(loserIdx);

        // Permanently delete the loser: DB first, then storage
        const loserId = rows[loserIdx].id;
        const loserPath = rows[loserIdx].file_path;
        deleteMediaItemFromDb(loserId);
        try {
          await storageProvider.delete(loserPath);
        } catch {
          // Storage delete failure is acceptable (orphan file)
        }
      }
    }
  }

  // 5. Build result
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
