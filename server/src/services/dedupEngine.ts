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
    .resize(9, 8, { fit: 'fill' })
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


// --- Union-Find (Disjoint Set) ---

class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = new Array(size).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]); // path compression
    }
    return this.parent[x];
  }

  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    // union by rank
    if (this.rank[rx] < this.rank[ry]) {
      this.parent[rx] = ry;
    } else if (this.rank[rx] > this.rank[ry]) {
      this.parent[ry] = rx;
    } else {
      this.parent[ry] = rx;
      this.rank[rx]++;
    }
  }

  connected(x: number, y: number): boolean {
    return this.find(x) === this.find(y);
  }
}

/**
 * Deduplicate a batch of image MediaItems using perceptual hashing.
 * Groups similar images (hamming distance ≤ threshold) using Union-Find.
 * Creates DuplicateGroup records in DB and updates media_items.
 * Does NOT delete any files.
 */
export async function deduplicate(
  imageItems: MediaItem[],
  threshold: number = 10
): Promise<DuplicateGroup[]> {
  if (imageItems.length === 0) return [];

  // 1. Compute hashes for all images
  const hashes: string[] = [];
  const storageProvider = getStorageProvider();
  for (const item of imageItems) {
    try {
      const localPath = await storageProvider.downloadToTemp(item.filePath);
      const hash = await computeHash(localPath);
      hashes.push(hash);
    } catch {
      // If hash computation fails, use empty string (won't match anything)
      hashes.push('');
    }
  }

  // 2. Update perceptual_hash in DB
  const db = getDb();
  const updateHash = db.prepare('UPDATE media_items SET perceptual_hash = ? WHERE id = ?');
  for (let i = 0; i < imageItems.length; i++) {
    if (hashes[i]) {
      updateHash.run(hashes[i], imageItems[i].id);
    }
  }

  // 3. Compare all pairs and union similar images
  const uf = new UnionFind(imageItems.length);
  for (let i = 0; i < imageItems.length; i++) {
    if (!hashes[i]) continue;
    for (let j = i + 1; j < imageItems.length; j++) {
      if (!hashes[j]) continue;
      if (hammingDistance(hashes[i], hashes[j]) <= threshold) {
        uf.union(i, j);
      }
    }
  }

  // 4. Build groups (only groups with 2+ members)
  const groupMap = new Map<number, number[]>();
  for (let i = 0; i < imageItems.length; i++) {
    const root = uf.find(i);
    if (!groupMap.has(root)) {
      groupMap.set(root, []);
    }
    groupMap.get(root)!.push(i);
  }

  // 5. Create DuplicateGroup records in DB
  const insertGroup = db.prepare(
    'INSERT INTO duplicate_groups (id, trip_id, default_image_id, image_count, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const updateMediaGroup = db.prepare(
    'UPDATE media_items SET duplicate_group_id = ? WHERE id = ?'
  );

  const createdGroups: DuplicateGroup[] = [];

  for (const [, members] of groupMap) {
    if (members.length < 2) continue;

    const groupId = uuidv4();
    const tripId = imageItems[members[0]].tripId;
    const defaultImageId = imageItems[members[0]].id; // first member as default for now
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
