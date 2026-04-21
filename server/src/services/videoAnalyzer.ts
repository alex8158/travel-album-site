import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { getTempDir } from '../helpers/tempDir';
import { computeSharpness } from './blurDetector';
import { VIDEO_THRESHOLDS } from './videoThresholds';

export interface VideoSegment {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  sharpnessScore: number;
  stabilityScore: number;
  exposureScore: number;
  overallScore: number;
  label: 'good' | 'blurry' | 'shaky' | 'slightly_shaky'
       | 'severely_blurry' | 'severely_shaky' | 'severely_exposed';
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
 *
 * Severe labels (checked first, using VIDEO_THRESHOLDS):
 *   - severely_blurry:  sharpnessScore < severeBlurThreshold
 *   - severely_shaky:   stabilityScore < severeShakeThreshold
 *   - severely_exposed: exposureScore < severeExposureLow OR > severeExposureHigh
 *
 * Normal labels (existing logic):
 *   - blurry:           sharpnessScore < 50.0
 *   - shaky:            stabilityScore < 30
 *   - slightly_shaky:   stabilityScore 30-60
 *   - good:             otherwise
 */
export function assignLabel(
  sharpnessScore: number,
  stabilityScore: number,
  exposureScore: number = 50,
): VideoSegment['label'] {
  // Severe labels first
  if (sharpnessScore < VIDEO_THRESHOLDS.severeBlurThreshold) return 'severely_blurry';
  if (stabilityScore < VIDEO_THRESHOLDS.severeShakeThreshold) return 'severely_shaky';
  if (exposureScore < VIDEO_THRESHOLDS.severeExposureLow || exposureScore > VIDEO_THRESHOLDS.severeExposureHigh) return 'severely_exposed';

  // Existing normal labels
  if (sharpnessScore < 50.0) return 'blurry';
  if (stabilityScore < 30) return 'shaky';
  if (stabilityScore < 60) return 'slightly_shaky';
  return 'good';
}

/**
 * Analyze a video by splitting it into segments and computing quality scores.
 *
 * Segment boundaries are determined by scene cuts (via detectSceneCuts) when
 * available. When scene detection returns empty, falls back to fixed-duration
 * splitting. Scene cut boundaries are padded by cutBufferDuration.
 *
 * For each segment:
 *   1. Extract the middle frame and compute sharpness via Laplacian variance
 *   2. Estimate stability by comparing start/end frames
 *   3. Compute exposure score from the middle frame
 *   4. Compute overall score = sharpness * 0.4 + stability * 0.3 + exposure * 0.3
 *   5. Assign a label based on thresholds (including severe labels)
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

  // Attempt scene-cut-based segmentation first
  const sceneCuts = await detectSceneCuts(videoPath);
  const boundaries = buildSegmentBoundaries(sceneCuts, duration, segmentDuration);

  const segments: VideoSegment[] = [];

  // Create a temp directory for intermediate frame files
  const tempDir = fs.mkdtempSync(path.join(getTempDir(), `video-analysis-${mediaId}-`));

  try {
    for (let i = 0; i < boundaries.length; i++) {
      const { start: startTime, end: endTime } = boundaries[i];
      const segDuration = endTime - startTime;
      const midTime = startTime + segDuration / 2;

      // Extract middle frame for sharpness and exposure
      const midFramePath = path.join(tempDir, `seg${i}_mid.png`);
      let sharpnessScore = 0;
      let exposureScore = 50;
      try {
        await extractFrameAt(videoPath, midTime, midFramePath);
        sharpnessScore = await computeSharpness(midFramePath);
        const exposureResult = await computeExposureScore(midFramePath);
        exposureScore = exposureResult.exposureScore;
      } catch {
        sharpnessScore = 0;
        exposureScore = 50;
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

      const overallScore = sharpnessScore * 0.4 + stabilityScore * 0.3 + exposureScore * 0.3;
      const label = assignLabel(sharpnessScore, stabilityScore, exposureScore);

      segments.push({
        index: i,
        startTime,
        endTime,
        duration: segDuration,
        sharpnessScore,
        stabilityScore,
        exposureScore,
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

/**
 * Build segment boundaries from scene cuts or fall back to fixed-duration splitting.
 *
 * When scene cuts are available, each pair of consecutive cuts (plus video
 * start/end) defines a segment. A cutBufferDuration padding is applied so
 * segments don't start/end exactly at the cut point.
 *
 * When scene detection returns empty, falls back to fixed-duration splitting.
 */
function buildSegmentBoundaries(
  sceneCuts: SceneCut[],
  totalDuration: number,
  fixedSegmentDuration: number,
): Array<{ start: number; end: number }> {
  if (sceneCuts.length === 0) {
    // Fall back to fixed-duration splitting
    const count = Math.ceil(totalDuration / fixedSegmentDuration);
    const boundaries: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < count; i++) {
      const start = i * fixedSegmentDuration;
      const end = Math.min((i + 1) * fixedSegmentDuration, totalDuration);
      boundaries.push({ start, end });
    }
    return boundaries;
  }

  const buffer = VIDEO_THRESHOLDS.cutBufferDuration;

  // Build cut points: [0, cut1, cut2, ..., totalDuration]
  const cutPoints = [0, ...sceneCuts.map(c => c.timestamp), totalDuration];

  // Deduplicate and sort
  const uniqueSorted = [...new Set(cutPoints)].sort((a, b) => a - b);

  const boundaries: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < uniqueSorted.length - 1; i++) {
    const rawStart = uniqueSorted[i];
    const rawEnd = uniqueSorted[i + 1];

    // Apply buffer: push start forward and pull end back, but not for
    // the very first start (0) or the very last end (totalDuration)
    const start = i === 0 ? rawStart : Math.min(rawStart + buffer, rawEnd);
    const end = i === uniqueSorted.length - 2 ? rawEnd : Math.max(rawEnd - buffer, start);

    if (end > start) {
      boundaries.push({ start, end });
    }
  }

  return boundaries;
}

// ---------------------------------------------------------------------------
// Exposure Analysis
// ---------------------------------------------------------------------------

export interface ExposureAnalysis {
  exposureScore: number;
  meanBrightness: number;
  brightnessStdDev: number;
}

/**
 * Compute an exposure score for a single frame image.
 *
 * Uses sharp to extract a grayscale histogram, then derives mean brightness
 * and standard deviation. Mapping rules:
 *   - brightness in [60, 200] AND stdDev > 30 → ideal exposure (100)
 *   - deviation from that range lowers the score proportionally
 *   - over-dark (< 30) or over-exposed (> 230) → severe anomaly (score near 0)
 *   - frame read failure → default { exposureScore: 50, meanBrightness: 128, brightnessStdDev: 0 }
 */
export async function computeExposureScore(framePath: string): Promise<ExposureAnalysis> {
  try {
    const rawBuf = await sharp(framePath).grayscale().raw().toBuffer();
    const totalPixels = rawBuf.length;
    const histogram = new Float64Array(256);

    for (let i = 0; i < totalPixels; i++) {
      histogram[rawBuf[i]]++;
    }

    // Compute mean brightness
    let mean = 0;
    for (let i = 0; i < 256; i++) {
      mean += i * histogram[i];
    }
    mean /= totalPixels;

    // Compute standard deviation
    let variance = 0;
    for (let i = 0; i < 256; i++) {
      variance += histogram[i] * (i - mean) ** 2;
    }
    variance /= totalPixels;
    const stdDev = Math.sqrt(variance);

    const exposureScore = computeExposureFromStats(mean, stdDev);

    return {
      exposureScore: Math.round(exposureScore * 100) / 100,
      meanBrightness: Math.round(mean * 100) / 100,
      brightnessStdDev: Math.round(stdDev * 100) / 100,
    };
  } catch {
    // Frame extraction / read failure → neutral defaults
    return { exposureScore: 50, meanBrightness: 128, brightnessStdDev: 0 };
  }
}

/**
 * Map mean brightness and stdDev to an exposure score (0-100).
 *
 * Ideal zone: brightness ∈ [60, 200] AND stdDev > 30 → 100
 * Severe zones: brightness < 30 (over-dark) or > 230 (over-exposed) → near 0
 * Otherwise: linear interpolation between zones.
 */
function computeExposureFromStats(mean: number, stdDev: number): number {
  // Severe over-dark
  if (mean < 30) {
    // 0 at mean=0, ~10 at mean=29
    return (mean / 30) * 10;
  }
  // Severe over-exposed
  if (mean > 230) {
    // ~10 at mean=231, 0 at mean=255
    return ((255 - mean) / 25) * 10;
  }

  // Brightness component: full credit inside [60, 200], linear ramp outside
  let brightnessFactor: number;
  if (mean >= 60 && mean <= 200) {
    brightnessFactor = 1;
  } else if (mean < 60) {
    // Linear ramp from 30→60: factor 0.3→1
    brightnessFactor = 0.3 + 0.7 * ((mean - 30) / 30);
  } else {
    // Linear ramp from 200→230: factor 1→0.3
    brightnessFactor = 1 - 0.7 * ((mean - 200) / 30);
  }

  // StdDev component: full credit when > 30, reduced below
  const stdDevFactor = stdDev > 30 ? 1 : 0.5 + 0.5 * (stdDev / 30);

  return brightnessFactor * stdDevFactor * 100;
}

// ---------------------------------------------------------------------------
// Scene Cut Detection
// ---------------------------------------------------------------------------

export interface SceneCut {
  timestamp: number;
  score: number;
}

/**
 * Detect scene cuts in a video using ffmpeg's scene change detection filter.
 *
 * Runs ffmpeg with `select='gt(scene,THRESHOLD)',showinfo` and parses stderr
 * for `pts_time:` and `scene_score:` values.
 *
 * On failure, returns an empty array so the caller can fall back to
 * fixed-duration splitting.
 */
export function detectSceneCuts(
  videoPath: string,
  threshold?: number,
): Promise<SceneCut[]> {
  const th = threshold ?? VIDEO_THRESHOLDS.sceneDetectThreshold;

  return new Promise((resolve) => {
    const args = [
      '-i', videoPath,
      '-vf', `select='gt(scene,${th})',showinfo`,
      '-f', 'null',
      '-',
    ];

    const proc = spawn('ffmpeg', args);

    let stderr = '';

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', () => {
      // ffmpeg not found or spawn failure → fall back to empty
      resolve([]);
    });

    proc.on('close', (code) => {
      if (code !== 0 && stderr === '') {
        // Process failed with no output → fall back
        resolve([]);
        return;
      }

      try {
        const cuts = parseSceneCutsFromStderr(stderr);
        resolve(cuts);
      } catch {
        resolve([]);
      }
    });
  });
}

/**
 * Parse ffmpeg showinfo stderr output to extract scene cut timestamps and scores.
 *
 * Looks for lines containing both `pts_time:` and `scene_score:` values
 * from the showinfo filter output.
 */
function parseSceneCutsFromStderr(stderr: string): SceneCut[] {
  const cuts: SceneCut[] = [];
  const lines = stderr.split('\n');

  for (const line of lines) {
    // showinfo filter outputs lines like:
    // [Parsed_showinfo_1 ...] n:0 pts:0 pts_time:1.234 ... scene_score=0.567
    const ptsMatch = line.match(/pts_time:\s*([\d.]+)/);
    if (!ptsMatch) continue;

    const timestamp = parseFloat(ptsMatch[1]);
    if (isNaN(timestamp)) continue;

    // scene_score may appear as "score:X.XX" in the select filter metadata
    // or as "scene_score=X.XX" depending on ffmpeg version
    let score = 0;
    const scoreMatch = line.match(/scene_score[=:]\s*([\d.]+)/);
    if (scoreMatch) {
      score = parseFloat(scoreMatch[1]);
      if (isNaN(score)) score = 0;
    }

    cuts.push({ timestamp, score });
  }

  return cuts;
}
