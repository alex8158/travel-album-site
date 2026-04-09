import sharp from 'sharp';
import fs from 'fs';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';

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
  const hammingThreshold = options?.hammingThreshold ?? 12;

  const db = getDb();
  const storageProvider = getStorageProvider();

  // 1. Query ALL images for the trip (including trashed), ordered by created_at
  // We include trashed images so we can detect duplicates across blur-trashed items
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

  if (rows.length === 0) {
    return { kept: [], removed: [], removedCount: 0 };
  }

  // 2. Compute pHash AND dHash for each image (dual hash for better accuracy)
  const pHashes: (string | null)[] = [];
  const dHashes: (string | null)[] = [];
  for (const row of rows) {
    try {
      const localPath = await storageProvider.downloadToTemp(row.file_path);
      const [pHash, dHash] = await Promise.all([
        computePHash(localPath),
        computeHash(localPath),
      ]);
      pHashes.push(pHash);
      dHashes.push(dHash);
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }
    } catch {
      pHashes.push(null);
      dHashes.push(null);
    }
  }

  // 3. Track removed set so already-removed images are skipped
  const removedSet = new Set<number>();

  // 4. Sliding window comparison
  for (let i = 0; i < rows.length; i++) {
    if (removedSet.has(i)) continue;
    if (pHashes[i] === null && dHashes[i] === null) continue;

    const end = Math.min(i + windowSize, rows.length - 1);
    for (let j = i + 1; j <= end; j++) {
      if (removedSet.has(j)) continue;
      if (pHashes[j] === null && dHashes[j] === null) continue;

      // Dual hash verification: consider duplicate if EITHER hash matches
      // This catches more duplicates — pHash is better for color/tone changes,
      // dHash is better for slight position shifts
      const pDist = (pHashes[i] && pHashes[j]) ? hammingDistance(pHashes[i]!, pHashes[j]!) : 999;
      const dDist = (dHashes[i] && dHashes[j]) ? hammingDistance(dHashes[i]!, dHashes[j]!) : 999;
      const isDuplicate = pDist <= hammingThreshold || dDist <= hammingThreshold;
      if (isDuplicate) {
        // They're duplicates — decide who to remove
        const loserIdx = pickLoser(rows, i, j);
        removedSet.add(loserIdx);

        const loser = rows[loserIdx];
        if (loser.status === 'trashed') {
          // Already trashed (e.g. by blur) — append 'duplicate' to reason
          const newReason = loser.trashed_reason
            ? `${loser.trashed_reason},duplicate`
            : 'duplicate';
          db.prepare(
            "UPDATE media_items SET trashed_reason = ? WHERE id = ?"
          ).run(newReason, loser.id);
        } else {
          // Move active image to trash
          db.prepare(
            "UPDATE media_items SET status = 'trashed', trashed_reason = 'duplicate' WHERE id = ?"
          ).run(loser.id);
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
