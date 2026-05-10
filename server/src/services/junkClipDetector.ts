/**
 * Junk Clip Detector
 *
 * Detects and classifies junk video segments based on multiple heuristics:
 * - Too short duration (< 1s)
 * - Extreme motion blur (high motion vector magnitude)
 * - Ground shots (camera pointing down)
 * - Accidental touch (sudden motion followed by stillness)
 *
 * Priority order: too_short > extreme_blur > ground_shot > accidental_touch
 */

import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { upsertAnalysisResult } from '../helpers/analysisStore';
import { getTempDir } from '../helpers/tempDir';

export type JunkReason = 'too_short' | 'extreme_blur' | 'ground_shot' | 'accidental_touch';

export interface JunkClipResult {
  isJunk: boolean;
  reason: JunkReason | null;
  confidence: number;           // [0.0, 1.0]
  details: {
    duration: number;
    motionMagnitude: number | null;
    pitchAngle: number | null;
    hasAccidentalPattern: boolean;
  };
}

export interface JunkDetectionOptions {
  minDuration?: number;           // default 1.0s
  extremeMotionThreshold?: number; // default 80
  groundShotAngle?: number;       // default 60 degrees
  groundShotRatio?: number;       // default 0.7
}

/**
 * Classify a video segment as junk based on pre-computed features.
 * Pure function: applies priority-ordered rules to determine junk status.
 *
 * Priority order:
 * 1. too_short — duration < minDuration
 * 2. extreme_blur — motionMagnitude > extremeMotionThreshold
 * 3. ground_shot — pitchAngle > groundShotAngle (with ratio check)
 * 4. accidental_touch — hasAccidentalPattern is true
 *
 * @param duration - Segment duration in seconds
 * @param motionMagnitude - Average motion vector magnitude (null if unavailable)
 * @param pitchAngle - Dominant pitch angle in degrees from horizontal (null if unavailable)
 * @param hasAccidentalPattern - Whether accidental touch pattern was detected
 * @param options - Detection thresholds
 * @returns JunkClipResult with classification
 */
export function classifyJunkClip(
  duration: number,
  motionMagnitude: number | null,
  pitchAngle: number | null,
  hasAccidentalPattern: boolean,
  options?: JunkDetectionOptions
): JunkClipResult {
  const minDuration = options?.minDuration ?? 1.0;
  const extremeMotionThreshold = options?.extremeMotionThreshold ?? 80;
  const groundShotAngle = options?.groundShotAngle ?? 60;

  const details = {
    duration,
    motionMagnitude,
    pitchAngle,
    hasAccidentalPattern,
  };

  // Priority 1: too_short
  if (duration < minDuration) {
    return { isJunk: true, reason: 'too_short', confidence: 1.0, details };
  }

  // Priority 2: extreme_blur
  if (motionMagnitude !== null && motionMagnitude > extremeMotionThreshold) {
    const confidence = Math.min(1.0, motionMagnitude / (extremeMotionThreshold * 2));
    return { isJunk: true, reason: 'extreme_blur', confidence, details };
  }

  // Priority 3: ground_shot
  if (pitchAngle !== null && pitchAngle > groundShotAngle) {
    const confidence = Math.min(1.0, (pitchAngle - groundShotAngle) / 30 + 0.5);
    return { isJunk: true, reason: 'ground_shot', confidence, details };
  }

  // Priority 4: accidental_touch
  if (hasAccidentalPattern) {
    return { isJunk: true, reason: 'accidental_touch', confidence: 0.8, details };
  }

  // No junk condition matched
  return { isJunk: false, reason: null, confidence: 0.0, details };
}

/**
 * Detect junk clip characteristics for a video segment.
 * Orchestrates motion estimation, pitch angle analysis, and accidental touch detection.
 * Handles individual analysis failures gracefully (null values for failed analyses).
 *
 * @param videoPath - Path to the video file
 * @param startTime - Segment start time in seconds
 * @param endTime - Segment end time in seconds
 * @param options - Detection thresholds
 * @returns JunkClipResult with full analysis
 */
export async function detectJunkClip(
  videoPath: string,
  startTime: number,
  endTime: number,
  options?: JunkDetectionOptions
): Promise<JunkClipResult> {
  const duration = endTime - startTime;

  // Run all three analysis methods in parallel, catching errors individually
  const [motionMagnitude, pitchAngle, hasAccidentalPattern] = await Promise.all([
    estimateMotionMagnitude(videoPath, startTime, endTime).catch(() => null),
    estimatePitchAngle(videoPath, startTime, endTime).catch(() => null),
    detectAccidentalTouch(videoPath, startTime, endTime).catch(() => false),
  ]);

  // Classify using the pure function with collected features
  return classifyJunkClip(duration, motionMagnitude, pitchAngle, hasAccidentalPattern, options);
}

/**
 * Persist junk clip detection result to the media_analysis table.
 * Upserts the record keyed by (mediaId, segmentIndex) using the shared helper.
 *
 * quality_score: 0 for junk, 1.0 for non-junk.
 *
 * @param mediaId - Media item ID
 * @param segmentIndex - Segment index within the video
 * @param result - Junk clip detection result to persist
 */
export async function persistJunkClipResult(
  mediaId: string,
  segmentIndex: number,
  result: JunkClipResult
): Promise<void> {
  const reasonJson = JSON.stringify({
    type: 'junk_clip',
    isJunk: result.isJunk,
    reason: result.reason,
    confidence: result.confidence,
    details: result.details,
  });

  const qualityScore = result.isJunk ? 0 : 1.0;

  upsertAnalysisResult({
    mediaId,
    segmentIndex,
    analysisType: 'junk_clip',
    qualityScore,
    reasonJson,
  });
}

// --- Internal helper functions ---

/**
 * Extract a single frame from a video at a specific time.
 * Returns a promise that resolves when the frame is written.
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
 * Estimate the average motion vector magnitude for a video segment.
 * Extracts multiple frames and computes frame-to-frame pixel differences.
 *
 * Algorithm:
 * 1. Extract 5 frames evenly spaced across the segment
 * 2. Resize each frame to 64x64 grayscale
 * 3. Compute mean absolute pixel difference between consecutive frames
 * 4. Return the average of all frame-pair differences
 *
 * @param videoPath - Path to the video file
 * @param startTime - Segment start time in seconds
 * @param endTime - Segment end time in seconds
 * @returns Average motion magnitude, or null if estimation fails
 */
export async function estimateMotionMagnitude(
  videoPath: string,
  startTime: number,
  endTime: number
): Promise<number | null> {
  const duration = endTime - startTime;
  if (duration <= 0) return null;

  const frameCount = 5;
  const tempBase = getTempDir();
  const tempDir = fs.mkdtempSync(path.join(tempBase, 'motion-'));

  try {
    // Compute evenly-spaced time points
    const timePoints: number[] = [];
    for (let i = 0; i < frameCount; i++) {
      const t = startTime + (i / (frameCount - 1)) * duration;
      timePoints.push(t);
    }

    // Extract frames and convert to 64x64 grayscale buffers
    const frameBuffers: Buffer[] = [];
    for (let i = 0; i < timePoints.length; i++) {
      const framePath = path.join(tempDir, `motion_frame_${i}.png`);
      try {
        await extractFrameAt(videoPath, timePoints[i], framePath);
        const grayBuffer = await sharp(framePath)
          .resize(64, 64)
          .grayscale()
          .raw()
          .toBuffer();
        frameBuffers.push(grayBuffer);
      } catch {
        // Skip frames that fail to extract
        continue;
      }
    }

    // Need at least 2 frames to compute differences
    if (frameBuffers.length < 2) return null;

    // Compute mean absolute difference between consecutive frame pairs
    let totalDiff = 0;
    let pairCount = 0;

    for (let i = 0; i < frameBuffers.length - 1; i++) {
      const curr = frameBuffers[i];
      const next = frameBuffers[i + 1];
      const pixelCount = Math.min(curr.length, next.length);

      let sumDiff = 0;
      for (let p = 0; p < pixelCount; p++) {
        sumDiff += Math.abs(curr[p] - next[p]);
      }

      totalDiff += sumDiff / pixelCount;
      pairCount++;
    }

    if (pairCount === 0) return null;
    return totalDiff / pairCount;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Estimate the dominant pitch angle (camera tilt) for a video segment.
 * Analyzes frame-to-frame differences in top vs bottom halves to determine
 * if the camera is consistently pointing downward (ground shot).
 *
 * Algorithm:
 * 1. Extract 5 frames evenly spaced
 * 2. For each consecutive pair, resize to 64x64 grayscale
 * 3. Split each frame into top half and bottom half
 * 4. Compare top-half difference vs bottom-half difference
 * 5. If bottom half has significantly more change → camera moving down
 * 6. Compute ratio of "downward motion" frames to total frame pairs
 * 7. If ratio > groundShotRatio (0.7), estimate pitch angle from vertical asymmetry
 *
 * @param videoPath - Path to the video file
 * @param startTime - Segment start time in seconds
 * @param endTime - Segment end time in seconds
 * @returns Pitch angle in degrees from horizontal (0-90), or null if estimation fails
 */
export async function estimatePitchAngle(
  videoPath: string,
  startTime: number,
  endTime: number
): Promise<number | null> {
  const duration = endTime - startTime;
  if (duration <= 0) return null;

  const frameCount = 5;
  const frameSize = 64;
  const halfSize = frameSize * frameSize / 2; // pixels in each half (top/bottom)
  const groundShotRatio = 0.7;
  const tempBase = getTempDir();
  const tempDir = fs.mkdtempSync(path.join(tempBase, 'pitch-'));

  try {
    // Compute evenly-spaced time points
    const timePoints: number[] = [];
    for (let i = 0; i < frameCount; i++) {
      const t = startTime + (i / (frameCount - 1)) * duration;
      timePoints.push(t);
    }

    // Extract frames and convert to 64x64 grayscale buffers
    const frameBuffers: Buffer[] = [];
    for (let i = 0; i < timePoints.length; i++) {
      const framePath = path.join(tempDir, `pitch_frame_${i}.png`);
      try {
        await extractFrameAt(videoPath, timePoints[i], framePath);
        const grayBuffer = await sharp(framePath)
          .resize(frameSize, frameSize)
          .grayscale()
          .raw()
          .toBuffer();
        frameBuffers.push(grayBuffer);
      } catch {
        continue;
      }
    }

    // Need at least 2 frames
    if (frameBuffers.length < 2) return null;

    let downwardCount = 0;
    let totalPairs = 0;
    let totalAsymmetry = 0;

    for (let i = 0; i < frameBuffers.length - 1; i++) {
      const curr = frameBuffers[i];
      const next = frameBuffers[i + 1];

      // Each frame is 64x64 = 4096 pixels in row-major order
      // Top half: rows 0-31 (pixels 0..2047)
      // Bottom half: rows 32-63 (pixels 2048..4095)

      let topDiff = 0;
      let bottomDiff = 0;

      // Compute top half difference
      for (let p = 0; p < halfSize; p++) {
        topDiff += Math.abs(curr[p] - next[p]);
      }
      topDiff /= halfSize;

      // Compute bottom half difference
      for (let p = halfSize; p < halfSize * 2; p++) {
        bottomDiff += Math.abs(curr[p] - next[p]);
      }
      bottomDiff /= halfSize;

      totalPairs++;

      // If bottom half has significantly more change than top half,
      // this suggests downward camera motion (ground shot)
      if (bottomDiff > topDiff * 1.3 && bottomDiff > 2) {
        downwardCount++;
        // Asymmetry: how much more the bottom changes vs top
        const asymmetry = topDiff > 0 ? bottomDiff / topDiff : 2.0;
        totalAsymmetry += asymmetry;
      }
    }

    if (totalPairs === 0) return null;

    const downwardRatio = downwardCount / totalPairs;

    // Only classify as ground shot if ratio exceeds threshold
    if (downwardRatio > groundShotRatio) {
      // Estimate pitch angle based on average asymmetry
      // Higher asymmetry → more extreme downward angle
      const avgAsymmetry = totalAsymmetry / downwardCount;
      // Map asymmetry (1.3 to 4.0+) to angle (60 to 90 degrees)
      const pitchAngle = Math.min(90, 60 + (avgAsymmetry - 1.3) * 11);
      return pitchAngle;
    }

    // Not enough downward motion to be a ground shot
    // Return a low pitch angle based on whatever downward ratio we have
    return downwardRatio * 60;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Detect accidental touch pattern in a video segment.
 * Looks for sudden high-magnitude motion followed by immediate stillness
 * within 0.5 seconds.
 *
 * Algorithm:
 * 1. Extract frames at ~0.1s intervals
 * 2. Compute frame-to-frame differences
 * 3. Look for pattern: a frame pair with very high difference (> 3x average)
 *    followed immediately by a pair with very low difference (< 0.3x average)
 *    within 0.5s
 *
 * @param videoPath - Path to the video file
 * @param startTime - Segment start time in seconds
 * @param endTime - Segment end time in seconds
 * @returns true if accidental touch pattern detected, false otherwise
 */
export async function detectAccidentalTouch(
  videoPath: string,
  startTime: number,
  endTime: number
): Promise<boolean> {
  const duration = endTime - startTime;
  if (duration <= 0) return false;

  const frameInterval = 0.1; // seconds between frames
  const frameCount = Math.min(30, Math.max(3, Math.floor(duration / frameInterval) + 1));
  const tempBase = getTempDir();
  const tempDir = fs.mkdtempSync(path.join(tempBase, 'touch-'));

  try {
    // Compute time points at ~0.1s intervals
    const timePoints: number[] = [];
    for (let i = 0; i < frameCount; i++) {
      const t = startTime + (i / (frameCount - 1)) * duration;
      timePoints.push(t);
    }

    // Extract frames and convert to 64x64 grayscale
    const frameBuffers: Buffer[] = [];
    const frameTimes: number[] = [];
    for (let i = 0; i < timePoints.length; i++) {
      const framePath = path.join(tempDir, `touch_frame_${i}.png`);
      try {
        await extractFrameAt(videoPath, timePoints[i], framePath);
        const grayBuffer = await sharp(framePath)
          .resize(64, 64)
          .grayscale()
          .raw()
          .toBuffer();
        frameBuffers.push(grayBuffer);
        frameTimes.push(timePoints[i]);
      } catch {
        continue;
      }
    }

    // Need at least 3 frames (2 pairs) to detect the pattern
    if (frameBuffers.length < 3) return false;

    // Compute frame-to-frame differences
    const diffs: number[] = [];
    for (let i = 0; i < frameBuffers.length - 1; i++) {
      const curr = frameBuffers[i];
      const next = frameBuffers[i + 1];
      const pixelCount = Math.min(curr.length, next.length);

      let sumDiff = 0;
      for (let p = 0; p < pixelCount; p++) {
        sumDiff += Math.abs(curr[p] - next[p]);
      }
      diffs.push(sumDiff / pixelCount);
    }

    if (diffs.length < 2) return false;

    // Compute average difference
    const avgDiff = diffs.reduce((sum, d) => sum + d, 0) / diffs.length;
    if (avgDiff === 0) return false;

    // Look for pattern: high spike followed by stillness within 0.5s
    const highThreshold = avgDiff * 3;
    const lowThreshold = avgDiff * 0.3;
    const maxTimeDelta = 0.5; // seconds

    for (let i = 0; i < diffs.length - 1; i++) {
      if (diffs[i] > highThreshold) {
        // Found a high-motion frame pair, check subsequent pairs within 0.5s
        for (let j = i + 1; j < diffs.length; j++) {
          const timeDelta = frameTimes[j + 1] - frameTimes[i + 1];
          if (timeDelta > maxTimeDelta) break;

          if (diffs[j] < lowThreshold) {
            // Found the pattern: high motion followed by stillness
            return true;
          }
        }
      }
    }

    return false;
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
