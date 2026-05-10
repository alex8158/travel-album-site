/**
 * Black Frame Detector
 *
 * Detects and classifies black frames in video segments.
 * Used to identify segments dominated by black frames (lens cap, accidental start/end).
 */

import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { getTempDir } from '../helpers/tempDir';
import { upsertAnalysisResult } from '../helpers/analysisStore';

export interface BlackFrameResult {
  blackFrameRatio: number;      // [0.0, 1.0] — 黑帧占比
  blackFrameScore: number;      // [0.0, 1.0] — 1.0=无黑帧, 0.0=全黑帧
  isBlackFrameSegment: boolean; // blackFrameRatio > 0.8
  sampledFrameCount: number;
  blackFrameCount: number;
  thresholdUsed: number;

  // Near-black frame detection fields
  nearBlackRatio: number;           // [0.0, 1.0] — 近黑帧占比
  nearBlackFrameCount: number;      // 近黑帧数量
  isNearBlackSegment: boolean;      // nearBlackRatio > nearBlackRatioThreshold
  nearBlackThresholdUsed: number;   // 使用的近黑亮度阈值
}

export interface BlackFrameDetectionOptions {
  brightnessThreshold?: number;     // 纯黑阈值，默认 10
  ratioThreshold?: number;          // 纯黑占比阈值，默认 0.8
  minSamples?: number;              // 最小采样数，默认 5
  nearBlackThreshold?: number;      // 近黑亮度阈值，默认 20
  nearBlackRatioThreshold?: number; // 近黑占比阈值，默认 0.9
}

// ---------------------------------------------------------------------------
// Environment variable parsing for near-black detection
// ---------------------------------------------------------------------------

/**
 * Parse VIDEO_NEAR_BLACK_THRESHOLD from environment.
 * Valid range: 1-255 (integer). Returns default 20 if invalid.
 */
export function parseNearBlackThreshold(): number {
  const raw = process.env.VIDEO_NEAR_BLACK_THRESHOLD;
  if (raw === undefined) return 20;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 255) return 20;
  return Math.round(parsed);
}

/**
 * Parse VIDEO_NEAR_BLACK_RATIO from environment.
 * Valid range: 0.0-1.0 (float). Returns default 0.9 if invalid.
 */
export function parseNearBlackRatioThreshold(): number {
  const raw = process.env.VIDEO_NEAR_BLACK_RATIO;
  if (raw === undefined) return 0.9;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0.0 || parsed > 1.0) return 0.9;
  return parsed;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Compute the mean brightness of a raw grayscale pixel buffer.
 * Each byte represents one pixel's brightness value [0, 255].
 *
 * @param grayPixels - Raw grayscale buffer from sharp
 * @returns Mean brightness value [0, 255]
 */
export function computeFrameBrightness(grayPixels: Buffer): number {
  if (grayPixels.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < grayPixels.length; i++) {
    sum += grayPixels[i];
  }

  return sum / grayPixels.length;
}

/**
 * Classify black frames and near-black frames from an array of brightness values.
 * Pure function: computes blackFrameRatio, nearBlackRatio, and segment classification.
 *
 * Priority: pure black frame segment takes precedence over near-black frame segment.
 * When both blackFrameRatio > ratioThreshold AND nearBlackRatio > nearBlackRatioThreshold,
 * the segment is marked as pure black (isBlackFrameSegment = true, isNearBlackSegment = false).
 *
 * @param brightnesses - Array of per-frame mean brightness values
 * @param options - Detection options (thresholds)
 * @returns BlackFrameResult with classification
 */
export function classifyBlackFrames(
  brightnesses: number[],
  options?: BlackFrameDetectionOptions
): BlackFrameResult {
  const brightnessThreshold = options?.brightnessThreshold ?? 10;
  const ratioThreshold = options?.ratioThreshold ?? 0.8;
  const nearBlackThreshold = options?.nearBlackThreshold ?? parseNearBlackThreshold();
  const nearBlackRatioThreshold = options?.nearBlackRatioThreshold ?? parseNearBlackRatioThreshold();

  if (brightnesses.length === 0) {
    return {
      blackFrameRatio: 0,
      blackFrameScore: 1.0,
      isBlackFrameSegment: false,
      sampledFrameCount: 0,
      blackFrameCount: 0,
      thresholdUsed: brightnessThreshold,
      nearBlackRatio: 0,
      nearBlackFrameCount: 0,
      isNearBlackSegment: false,
      nearBlackThresholdUsed: nearBlackThreshold,
    };
  }

  let blackFrameCount = 0;
  let nearBlackFrameCount = 0;

  for (const brightness of brightnesses) {
    if (brightness < brightnessThreshold) {
      blackFrameCount++;
    }
    if (brightness < nearBlackThreshold) {
      nearBlackFrameCount++;
    }
  }

  const blackFrameRatio = blackFrameCount / brightnesses.length;
  const nearBlackRatio = nearBlackFrameCount / brightnesses.length;
  const blackFrameScore = 1.0 - blackFrameRatio;
  const isBlackFrameSegment = blackFrameRatio > ratioThreshold;

  // Priority: pure black frame segment takes precedence over near-black
  const isNearBlackSegment = !isBlackFrameSegment && nearBlackRatio > nearBlackRatioThreshold;

  return {
    blackFrameRatio,
    blackFrameScore,
    isBlackFrameSegment,
    sampledFrameCount: brightnesses.length,
    blackFrameCount,
    thresholdUsed: brightnessThreshold,
    nearBlackRatio,
    nearBlackFrameCount,
    isNearBlackSegment,
    nearBlackThresholdUsed: nearBlackThreshold,
  };
}

/**
 * Extract a single frame from a video at a specific time (in seconds).
 * Returns the output path on success, or null on failure.
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
 * Detect black frames in a video segment by extracting frames via ffmpeg,
 * converting to grayscale via sharp, and computing brightness per frame.
 *
 * Sampling logic:
 * - Normal segments: max(minSamples, ceil(duration * 2.5)) frames
 * - Short segments (<0.5s): minimum 2 frames
 *
 * @param videoPath - Path to the video file
 * @param startTime - Segment start time in seconds
 * @param endTime - Segment end time in seconds
 * @param options - Detection options
 * @returns BlackFrameResult with detection results
 */
export async function detectBlackFrames(
  videoPath: string,
  startTime: number,
  endTime: number,
  options?: BlackFrameDetectionOptions
): Promise<BlackFrameResult> {
  const minSamples = options?.minSamples ?? 5;
  const duration = endTime - startTime;

  // Determine sample count
  let sampleCount: number;
  if (duration < 0.5) {
    sampleCount = 2;
  } else {
    sampleCount = Math.max(minSamples, Math.ceil(duration * 2.5));
  }

  // Compute evenly-spaced time points within [startTime, endTime]
  const timePoints: number[] = [];
  if (sampleCount === 1) {
    timePoints.push(startTime);
  } else {
    for (let i = 0; i < sampleCount; i++) {
      const t = startTime + (i / (sampleCount - 1)) * duration;
      timePoints.push(t);
    }
  }

  // Create temp directory for frame extraction
  const tempBase = getTempDir();
  const tempDir = fs.mkdtempSync(path.join(tempBase, 'blackframe-'));

  const brightnesses: number[] = [];

  try {
    for (let i = 0; i < timePoints.length; i++) {
      const framePath = path.join(tempDir, `frame_${i}.png`);

      try {
        // Extract frame using ffmpeg
        await extractFrameAt(videoPath, timePoints[i], framePath);

        // Convert to grayscale using sharp and get raw buffer
        const grayBuffer = await sharp(framePath)
          .grayscale()
          .raw()
          .toBuffer();

        // Compute brightness
        const brightness = computeFrameBrightness(grayBuffer);
        brightnesses.push(brightness);
      } catch {
        // On ffmpeg/sharp error: skip that frame, continue with remaining
        continue;
      }
    }

    // Classify black frames from collected brightnesses
    return classifyBlackFrames(brightnesses, options);
  } finally {
    // Clean up temp files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Persist black frame detection result to the media_analysis table.
 * Upserts the record keyed by (mediaId, segmentIndex) using the shared helper.
 *
 * @param mediaId - Media item ID
 * @param segmentIndex - Segment index within the video
 * @param result - Black frame detection result to persist
 */
export async function persistBlackFrameResult(
  mediaId: string,
  segmentIndex: number,
  result: BlackFrameResult
): Promise<void> {
  const reasonJson = JSON.stringify({
    type: 'black_frame',
    blackFrameRatio: result.blackFrameRatio,
    blackFrameScore: result.blackFrameScore,
    isBlackFrameSegment: result.isBlackFrameSegment,
    sampledFrameCount: result.sampledFrameCount,
    blackFrameCount: result.blackFrameCount,
    thresholdUsed: result.thresholdUsed,
    nearBlackRatio: result.nearBlackRatio,
    nearBlackFrameCount: result.nearBlackFrameCount,
    isNearBlackSegment: result.isNearBlackSegment,
    nearBlackThresholdUsed: result.nearBlackThresholdUsed,
  });

  upsertAnalysisResult({
    mediaId,
    segmentIndex,
    analysisType: 'black_frame',
    qualityScore: result.blackFrameScore,
    reasonJson,
  });
}
