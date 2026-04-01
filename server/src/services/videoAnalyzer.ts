import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { computeSharpness } from './blurDetector';

export interface VideoSegment {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  sharpnessScore: number;
  stabilityScore: number;
  overallScore: number;
  label: 'good' | 'blurry' | 'shaky' | 'slightly_shaky';
}

export interface VideoAnalysisResult {
  mediaId: string;
  duration: number;
  segments: VideoSegment[];
}

/**
 * Get the duration of a video file in seconds using ffprobe.
 */
export function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration || 0);
    });
  });
}

/**
 * Extract a single frame from a video at a specific time (in seconds).
 */
function extractFrameAt(videoPath: string, timeSeconds: number, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const outputDir = path.dirname(outputPath);
    fs.mkdirSync(outputDir, { recursive: true });

    ffmpeg(videoPath)
      .seekInput(timeSeconds)
      .frames(1)
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}

/**
 * Estimate stability of a video segment by comparing frames at the start and end.
 * Uses sharp to resize both frames to 64x64 grayscale, then computes mean absolute
 * pixel difference. Higher difference = more motion = less stable.
 *
 * Mapping:
 *   diff < 5  → stability 100
 *   diff 5-15 → linear 50-100
 *   diff > 15 → linear 0-50
 */
async function estimateStability(
  videoPath: string,
  startTime: number,
  endTime: number,
  tempDir: string,
  segmentIndex: number
): Promise<number> {
  const startFramePath = path.join(tempDir, `seg${segmentIndex}_start.png`);
  const endFramePath = path.join(tempDir, `seg${segmentIndex}_end.png`);

  try {
    await extractFrameAt(videoPath, startTime, startFramePath);
    await extractFrameAt(videoPath, endTime, endFramePath);

    const startBuf = await sharp(startFramePath)
      .resize(64, 64)
      .grayscale()
      .raw()
      .toBuffer();

    const endBuf = await sharp(endFramePath)
      .resize(64, 64)
      .grayscale()
      .raw()
      .toBuffer();

    const pixelCount = 64 * 64;
    let totalDiff = 0;
    for (let i = 0; i < pixelCount; i++) {
      totalDiff += Math.abs(startBuf[i] - endBuf[i]);
    }
    const meanDiff = totalDiff / pixelCount;

    // Map mean difference to stability score
    if (meanDiff < 5) {
      return 100;
    } else if (meanDiff <= 15) {
      // Linear mapping: diff 5 → 100, diff 15 → 50
      return 100 - ((meanDiff - 5) / 10) * 50;
    } else {
      // Linear mapping: diff 15 → 50, diff 45 → 0 (clamped at 0)
      return Math.max(0, 50 - ((meanDiff - 15) / 30) * 50);
    }
  } finally {
    // Clean up temp frame files
    try { fs.unlinkSync(startFramePath); } catch { /* ignore */ }
    try { fs.unlinkSync(endFramePath); } catch { /* ignore */ }
  }
}

/**
 * Determine the label for a video segment based on its scores.
 *   - blurry: sharpnessScore < 50.0
 *   - shaky: stabilityScore < 30
 *   - slightly_shaky: stabilityScore 30-60
 *   - good: otherwise
 */
function assignLabel(sharpnessScore: number, stabilityScore: number): VideoSegment['label'] {
  if (sharpnessScore < 50.0) return 'blurry';
  if (stabilityScore < 30) return 'shaky';
  if (stabilityScore < 60) return 'slightly_shaky';
  return 'good';
}

/**
 * Analyze a video by splitting it into segments and computing quality scores.
 *
 * For each segment:
 *   1. Extract the middle frame and compute sharpness via Laplacian variance
 *   2. Estimate stability by comparing start/end frames
 *   3. Compute overall score = sharpness * 0.6 + stability * 0.4
 *   4. Assign a label based on thresholds
 */
export async function analyzeVideo(
  videoPath: string,
  mediaId: string,
  segmentDuration: number = 2
): Promise<VideoAnalysisResult> {
  const duration = await getVideoDuration(videoPath);

  if (duration <= 0) {
    return { mediaId, duration: 0, segments: [] };
  }

  const segmentCount = Math.ceil(duration / segmentDuration);
  const segments: VideoSegment[] = [];

  // Create a temp directory for intermediate frame files
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `video-analysis-${mediaId}-`));

  try {
    for (let i = 0; i < segmentCount; i++) {
      const startTime = i * segmentDuration;
      const endTime = Math.min((i + 1) * segmentDuration, duration);
      const segDuration = endTime - startTime;
      const midTime = startTime + segDuration / 2;

      // Extract middle frame for sharpness
      const midFramePath = path.join(tempDir, `seg${i}_mid.png`);
      let sharpnessScore = 0;
      try {
        await extractFrameAt(videoPath, midTime, midFramePath);
        sharpnessScore = await computeSharpness(midFramePath);
      } catch {
        sharpnessScore = 0;
      } finally {
        try { fs.unlinkSync(midFramePath); } catch { /* ignore */ }
      }

      // Estimate stability from start/end frame comparison
      let stabilityScore = 100;
      try {
        stabilityScore = await estimateStability(videoPath, startTime, endTime, tempDir, i);
      } catch {
        stabilityScore = 100; // Default to stable if estimation fails
      }

      const overallScore = sharpnessScore * 0.6 + stabilityScore * 0.4;
      const label = assignLabel(sharpnessScore, stabilityScore);

      segments.push({
        index: i,
        startTime,
        endTime,
        duration: segDuration,
        sharpnessScore,
        stabilityScore,
        overallScore,
        label,
      });
    }
  } finally {
    // Clean up temp directory
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return { mediaId, duration, segments };
}
