import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import type { MediaItem, DuplicateGroup } from '../types';
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

export interface DedupOptions {
  dHashThreshold?: number;  // default 5
  pHashThreshold?: number;  // default 8
}

/**
 * Compute a bucket key for pre-bucketing: groups images by aspect ratio
 * (rounded to 0.1) and resolution tier (floor(log2(w*h))).
 */
function computeBucketKey(width: number, height: number): string {
  const aspectRatio = Math.round((width / height) * 10) / 10;
  const resTier = Math.floor(Math.log2(width * height));
  return `${aspectRatio}:${resTier}`;
}

/**
 * Deduplicate a batch of image MediaItems using dual perceptual hashing
 * (dHash + pHash) with exemplar clustering and pre-bucketing.
 * Creates DuplicateGroup records in DB and updates media_items.
 * Does NOT delete any files.
 */
export async function deduplicate(
  imageItems: MediaItem[],
  options?: DedupOptions
): Promise<DuplicateGroup[]> {
  if (imageItems.length === 0) return [];

  const dHashThreshold = options?.dHashThreshold ?? 5;
  const pHashThreshold = options?.pHashThreshold ?? 8;

  // 1. Compute dHash and pHash for all images
  const dHashes: string[] = [];
  const pHashes: string[] = [];
  const storageProvider = getStorageProvider();

  for (const item of imageItems) {
    try {
      const localPath = await storageProvider.downloadToTemp(item.filePath);
      const [dHash, pHash] = await Promise.all([
        computeHash(localPath),
        computePHash(localPath),
      ]);
      dHashes.push(dHash);
      pHashes.push(pHash);
    } catch {
      // If hash computation fails, use empty string (won't match anything)
      dHashes.push('');
      pHashes.push('');
    }
  }

  // 2. Store both dHash and pHash in DB
  const db = getDb();
  const updateHash = db.prepare('UPDATE media_items SET perceptual_hash = ?, phash = ? WHERE id = ?');
  for (let i = 0; i < imageItems.length; i++) {
    if (dHashes[i] || pHashes[i]) {
      updateHash.run(dHashes[i] || null, pHashes[i] || null, imageItems[i].id);
    }
  }

  // 3. Pre-bucketing: group images by aspect ratio and resolution tier
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < imageItems.length; i++) {
    if (!dHashes[i] || !pHashes[i]) continue;
    const w = imageItems[i].width;
    const h = imageItems[i].height;
    // If dimensions are missing, use a fallback bucket
    const key = (w && h) ? computeBucketKey(w, h) : '__unknown__';
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key)!.push(i);
  }

  // 4. Compare pairs within each bucket and build exemplar groups
  // exemplarGroups: key = exemplar index, value = array of member indices (including exemplar)
  const exemplarGroups = new Map<number, number[]>();
  // memberOf: maps each index to its exemplar (for quick lookup)
  const memberOf = new Map<number, number>();

  for (const [, indices] of buckets) {
    for (let a = 0; a < indices.length; a++) {
      const i = indices[a];
      for (let b = a + 1; b < indices.length; b++) {
        const j = indices[b];

        // Require both dHash AND pHash within thresholds
        if (
          hammingDistance(dHashes[i], dHashes[j]) > dHashThreshold ||
          hammingDistance(pHashes[i], pHashes[j]) > pHashThreshold
        ) {
          continue;
        }

        const iExemplar = memberOf.get(i);
        const jExemplar = memberOf.get(j);

        if (iExemplar === undefined && jExemplar === undefined) {
          // Neither in any group → create new group with i as exemplar
          exemplarGroups.set(i, [i, j]);
          memberOf.set(i, i);
          memberOf.set(j, i);
        } else if (iExemplar !== undefined && exemplarGroups.has(i) && jExemplar === undefined) {
          // i is an exemplar → add j to i's group
          exemplarGroups.get(i)!.push(j);
          memberOf.set(j, i);
        } else if (jExemplar !== undefined && exemplarGroups.has(j) && iExemplar === undefined) {
          // j is an exemplar → add i to j's group
          exemplarGroups.get(j)!.push(i);
          memberOf.set(i, j);
        }
        // If both are in different groups → do not merge (prevents chain drift)
        // If i is a non-exemplar member and j is unassigned (or vice versa), also check exemplar
        else if (iExemplar !== undefined && !exemplarGroups.has(i) && jExemplar === undefined) {
          // i is a member (not exemplar) — check j against i's exemplar
          if (
            hammingDistance(dHashes[iExemplar], dHashes[j]) <= dHashThreshold &&
            hammingDistance(pHashes[iExemplar], pHashes[j]) <= pHashThreshold
          ) {
            exemplarGroups.get(iExemplar)!.push(j);
            memberOf.set(j, iExemplar);
          }
        } else if (jExemplar !== undefined && !exemplarGroups.has(j) && iExemplar === undefined) {
          // j is a member (not exemplar) — check i against j's exemplar
          if (
            hammingDistance(dHashes[jExemplar], dHashes[i]) <= dHashThreshold &&
            hammingDistance(pHashes[jExemplar], pHashes[i]) <= pHashThreshold
          ) {
            exemplarGroups.get(jExemplar)!.push(i);
            memberOf.set(i, jExemplar);
          }
        }
        // Both in groups (same or different) → skip
      }
    }
  }

  // 5. Create DuplicateGroup records in DB (only groups with 2+ members)
  const insertGroup = db.prepare(
    'INSERT INTO duplicate_groups (id, trip_id, default_image_id, image_count, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const updateMediaGroup = db.prepare(
    'UPDATE media_items SET duplicate_group_id = ? WHERE id = ?'
  );

  const createdGroups: DuplicateGroup[] = [];

  for (const [, members] of exemplarGroups) {
    if (members.length < 2) continue;

    const groupId = uuidv4();
    const tripId = imageItems[members[0]].tripId;
    const defaultImageId = imageItems[members[0]].id;
    const now = new Date().toISOString();

    insertGroup.run(groupId, tripId, defaultImageId, members.length, now);

    for (const idx of members) {
      updateMediaGroup.run(groupId, imageItems[idx].id);
    }

    createdGroups.push({
      id: groupId,
      tripId,
      defaultImageId,
      imageCount: members.length,
      createdAt: now,
    });
  }

  return createdGroups;
}
