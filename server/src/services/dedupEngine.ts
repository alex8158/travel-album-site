import sharp from 'sharp';

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
 * Resizes to 8×8 grayscale, computes global mean, then binarizes all 64 pixels
 * against that mean. Returns a 16-character hex string.
 */
export async function computePHash(imagePath: string): Promise<string> {
  const { data } = await sharp(imagePath)
    .resize(8, 8, { fit: 'cover' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Compute mean of all 64 pixel values
  let sum = 0;
  for (let i = 0; i < 64; i++) {
    sum += data[i];
  }
  const mean = sum / 64;

  // Binarize all 64 pixels against mean
  const bits: number[] = [];
  for (let i = 0; i < 64; i++) {
    bits.push(data[i] > mean ? 1 : 0);
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

export interface DedupResult {
  kept: string[];              // kept mediaId list
  removed: string[];           // removed mediaId list
  removedCount: number;
}
