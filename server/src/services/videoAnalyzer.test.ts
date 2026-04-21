import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { computeExposureScore } from './videoAnalyzer';

/**
 * Unit tests for computeExposureScore.
 * Creates synthetic single-colour or patterned images to validate the scoring logic.
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exposure-test-'));
}

describe('computeExposureScore', () => {
  it('should return score near 0 for an all-black frame (over-dark)', async () => {
    const dir = tmpDir();
    const framePath = path.join(dir, 'black.png');
    // 64x64 all-black image (pixel value 0)
    await sharp(Buffer.alloc(64 * 64, 0), { raw: { width: 64, height: 64, channels: 1 } })
      .png()
      .toFile(framePath);

    const result = await computeExposureScore(framePath);
    expect(result.meanBrightness).toBeLessThan(5);
    expect(result.exposureScore).toBeLessThan(10);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should return score near 0 for an all-white frame (over-exposed)', async () => {
    const dir = tmpDir();
    const framePath = path.join(dir, 'white.png');
    // 64x64 all-white image (pixel value 255)
    await sharp(Buffer.alloc(64 * 64, 255), { raw: { width: 64, height: 64, channels: 1 } })
      .png()
      .toFile(framePath);

    const result = await computeExposureScore(framePath);
    expect(result.meanBrightness).toBeGreaterThan(250);
    expect(result.exposureScore).toBeLessThan(10);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should return high score for a well-exposed frame with good contrast', async () => {
    const dir = tmpDir();
    const framePath = path.join(dir, 'normal.png');
    // Create a frame with mean ~128 and high stdDev by alternating 60 and 200
    const pixels = Buffer.alloc(64 * 64);
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = i % 2 === 0 ? 60 : 200;
    }
    await sharp(pixels, { raw: { width: 64, height: 64, channels: 1 } })
      .png()
      .toFile(framePath);

    const result = await computeExposureScore(framePath);
    // Mean should be ~130, stdDev should be ~70 → ideal zone
    expect(result.meanBrightness).toBeGreaterThan(100);
    expect(result.meanBrightness).toBeLessThan(160);
    expect(result.brightnessStdDev).toBeGreaterThan(30);
    expect(result.exposureScore).toBe(100);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should return default score 50 when frame path does not exist', async () => {
    const result = await computeExposureScore('/nonexistent/path/frame.png');
    expect(result.exposureScore).toBe(50);
    expect(result.meanBrightness).toBe(128);
    expect(result.brightnessStdDev).toBe(0);
  });

  it('should return reduced score for a flat low-contrast frame in ideal brightness range', async () => {
    const dir = tmpDir();
    const framePath = path.join(dir, 'flat.png');
    // All pixels at 130 → mean=130 (ideal range) but stdDev=0 (low contrast)
    await sharp(Buffer.alloc(64 * 64, 130), { raw: { width: 64, height: 64, channels: 1 } })
      .png()
      .toFile(framePath);

    const result = await computeExposureScore(framePath);
    expect(result.meanBrightness).toBeGreaterThan(125);
    expect(result.brightnessStdDev).toBeLessThan(5);
    // Brightness factor = 1, but stdDev factor = 0.5 → score ~50
    expect(result.exposureScore).toBe(50);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
