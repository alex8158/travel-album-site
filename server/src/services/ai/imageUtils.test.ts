import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { resizeForProvider, getImageDimensions } from './imageUtils';

/** Helper: create a base64-encoded JPEG image of given dimensions */
async function createJpegBase64(width: number, height: number): Promise<string> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .jpeg()
    .toBuffer();
  return buffer.toString('base64');
}

/** Helper: create a base64-encoded PNG image of given dimensions */
async function createPngBase64(width: number, height: number): Promise<string> {
  const buffer = await sharp({
    create: { width, height, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 1 } },
  })
    .png()
    .toBuffer();
  return buffer.toString('base64');
}

describe('resizeForProvider', () => {
  it('should return image unchanged if within limits', async () => {
    const base64 = await createJpegBase64(500, 400);
    const result = await resizeForProvider(base64, 768, 768);
    expect(result).toBe(base64);
  });

  it('should resize a wide JPEG image to fit within max dimensions', async () => {
    const base64 = await createJpegBase64(1920, 1080);
    const result = await resizeForProvider(base64, 768, 768);
    const dims = await getImageDimensions(result);
    expect(dims.width).toBeLessThanOrEqual(768);
    expect(dims.height).toBeLessThanOrEqual(768);
    // Check aspect ratio preserved (1920/1080 ≈ 1.778)
    const originalRatio = 1920 / 1080;
    const resultRatio = dims.width / dims.height;
    expect(Math.abs(resultRatio - originalRatio) / originalRatio).toBeLessThan(0.02);
  });

  it('should resize a tall JPEG image to fit within max dimensions', async () => {
    const base64 = await createJpegBase64(600, 2000);
    const result = await resizeForProvider(base64, 768, 768);
    const dims = await getImageDimensions(result);
    expect(dims.width).toBeLessThanOrEqual(768);
    expect(dims.height).toBeLessThanOrEqual(768);
    // Check aspect ratio preserved (600/2000 = 0.3)
    const originalRatio = 600 / 2000;
    const resultRatio = dims.width / dims.height;
    expect(Math.abs(resultRatio - originalRatio) / originalRatio).toBeLessThan(0.02);
  });

  it('should preserve PNG format on output', async () => {
    const base64 = await createPngBase64(1024, 1024);
    const result = await resizeForProvider(base64, 768, 768);
    const dims = await getImageDimensions(result);
    expect(dims.width).toBeLessThanOrEqual(768);
    expect(dims.height).toBeLessThanOrEqual(768);
    // Verify output is PNG
    const resultBuffer = Buffer.from(result, 'base64');
    const metadata = await sharp(resultBuffer).metadata();
    expect(metadata.format).toBe('png');
  });

  it('should preserve JPEG format on output', async () => {
    const base64 = await createJpegBase64(1500, 900);
    const result = await resizeForProvider(base64, 768, 768);
    const resultBuffer = Buffer.from(result, 'base64');
    const metadata = await sharp(resultBuffer).metadata();
    expect(metadata.format).toBe('jpeg');
  });

  it('should use default max dimensions of 768x768', async () => {
    const base64 = await createJpegBase64(2000, 2000);
    const result = await resizeForProvider(base64);
    const dims = await getImageDimensions(result);
    expect(dims.width).toBeLessThanOrEqual(768);
    expect(dims.height).toBeLessThanOrEqual(768);
  });

  it('should handle custom max dimensions', async () => {
    const base64 = await createJpegBase64(1000, 800);
    const result = await resizeForProvider(base64, 400, 300);
    const dims = await getImageDimensions(result);
    expect(dims.width).toBeLessThanOrEqual(400);
    expect(dims.height).toBeLessThanOrEqual(300);
  });

  it('should not upscale small PNG images', async () => {
    const base64 = await createPngBase64(200, 150);
    const result = await resizeForProvider(base64, 768, 768);
    // Should return unchanged since within limits
    expect(result).toBe(base64);
  });
});

describe('getImageDimensions', () => {
  it('should return correct dimensions for JPEG', async () => {
    const base64 = await createJpegBase64(800, 600);
    const dims = await getImageDimensions(base64);
    expect(dims.width).toBe(800);
    expect(dims.height).toBe(600);
  });

  it('should return correct dimensions for PNG', async () => {
    const base64 = await createPngBase64(1024, 768);
    const dims = await getImageDimensions(base64);
    expect(dims.width).toBe(1024);
    expect(dims.height).toBe(768);
  });
});
