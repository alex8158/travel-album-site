import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { getTempDir } from '../helpers/tempDir';
import { VideoAnalysisResult, VideoSegment } from './videoAnalyzer';
import { getStorageProvider } from '../storage/factory';

export interface EditOptions {
  videoResolution?: number;
}

export interface EditResult {
  mediaId: string;
  compiledPath: string | null;
  selectedSegments: number[];
  error?: string;
}

/**
 * Calculate the target duration based on the original video duration.
 *   - Original ≤ 60s: no target (just remove bad segments)
 *   - 60s < original < 600s: target 120s
 *   - Original ≥ 600s: target 300s
 */
export function calculateTargetDuration(originalDuration: number): number | null {
  if (originalDuration <= 60) return null;
  if (originalDuration < 600) return 120;
  return 300;
}

/**
 * Select segments from the analysis, filtering out blurry/shaky ones,
 * sorting by overallScore descending, and picking until cumulative
 * duration reaches the target. Returns segments re-sorted by startTime.
 */
export function selectSegments(
  segments: VideoSegment[],
  targetDuration: number | null
): VideoSegment[] {
  // Filter out blurry and shaky segments
  const candidates = segments.filter(
    (s) => s.label !== 'blurry' && s.label !== 'shaky'
  );

  if (candidates.length === 0) return [];

  // Sort by overallScore descending for selection
  const sorted = [...candidates].sort((a, b) => b.overallScore - a.overallScore);

  let selected: VideoSegment[];

  if (targetDuration === null) {
    // Short video: keep all non-blurry/non-shaky segments
    selected = sorted;
  } else {
    // Pick segments until cumulative duration reaches target
    selected = [];
    let cumulative = 0;
    for (const seg of sorted) {
      if (cumulative >= targetDuration) break;
      selected.push(seg);
      cumulative += seg.duration;
    }
  }

  // Re-sort by startTime for chronological order
  return selected.sort((a, b) => a.startTime - b.startTime);
}


/**
 * Extract a segment from a video file to a separate file.
 */
function extractSegment(
  videoPath: string,
  startTime: number,
  duration: number,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    ffmpeg(videoPath)
      .seekInput(startTime)
      .duration(duration)
      .output(outputPath)
      .outputOptions(['-c', 'copy'])
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}

/**
 * Apply vidstab stabilization (two-pass) to a segment.
 * Returns the path to the stabilized file, or the original path if stabilization fails.
 */
async function stabilizeSegment(
  segmentPath: string,
  tempDir: string,
  index: number
): Promise<string> {
  const transformsFile = path.join(tempDir, `transforms_${index}.trf`);
  const stabilizedPath = path.join(tempDir, `stabilized_${index}.mp4`);

  try {
    // Pass 1: detect
    await new Promise<void>((resolve, reject) => {
      ffmpeg(segmentPath)
        .videoFilters(`vidstabdetect=shakiness=5:accuracy=15:result=${transformsFile}`)
        .format('null')
        .output('-')
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    });

    // Pass 2: transform
    await new Promise<void>((resolve, reject) => {
      ffmpeg(segmentPath)
        .videoFilters(`vidstabtransform=smoothing=10:input=${transformsFile}`)
        .output(stabilizedPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    });

    return stabilizedPath;
  } catch {
    // If vidstab fails, use original segment
    return segmentPath;
  }
}

/**
 * Concatenate segments using ffmpeg concat demuxer.
 * First tries stream copy; falls back to re-encoding on failure.
 */
async function concatenateSegments(
  segmentPaths: string[],
  outputPath: string,
  tempDir: string,
  options?: EditOptions
): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const concatListPath = path.join(tempDir, 'concat_list.txt');
  const listContent = segmentPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(concatListPath, listContent);

  // Build resolution filter if needed
  const scaleFilter = options?.videoResolution
    ? `scale='min(${options.videoResolution},iw)':min(${options.videoResolution},ih):force_original_aspect_ratio=decrease`
    : null;

  // Try stream copy first (no scale filter allowed with -c copy)
  if (!scaleFilter) {
    try {
      await concatWithOptions(concatListPath, outputPath, ['-c', 'copy']);
      return;
    } catch {
      // Fall through to re-encode
    }
  }

  // Re-encode fallback (or required for scale filter)
  const outputOptions = ['-c:v', 'libx264', '-c:a', 'aac'];
  if (scaleFilter) {
    outputOptions.push('-vf', scaleFilter);
  }
  await concatWithOptions(concatListPath, outputPath, outputOptions);
}

function concatWithOptions(
  concatListPath: string,
  outputPath: string,
  outputOptions: string[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(outputOptions)
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}


/**
 * Edit a video based on analysis results.
 *
 * 1. Calculate target duration from original length
 * 2. Select best segments (filter blurry/shaky, sort by score, pick until target)
 * 3. Stabilize slightly_shaky segments with vidstab
 * 4. Concatenate selected segments into compiled output
 * 5. Clean up temp files
 */
export async function editVideo(
  videoPath: string,
  analysis: VideoAnalysisResult,
  tripId: string,
  mediaId: string,
  options?: EditOptions
): Promise<EditResult> {
  const targetDuration = calculateTargetDuration(analysis.duration);
  const selected = selectSegments(analysis.segments, targetDuration);
  const selectedIndices = selected.map((s) => s.index);

  // For short videos (≤ 60s): if all segments are good (none filtered), skip compilation
  if (targetDuration === null && selected.length === analysis.segments.length) {
    return {
      mediaId,
      compiledPath: null,
      selectedSegments: selectedIndices,
    };
  }

  // If no segments survived filtering, nothing to compile
  if (selected.length === 0) {
    return {
      mediaId,
      compiledPath: null,
      selectedSegments: [],
      error: 'No usable segments after filtering',
    };
  }

  const tempDir = fs.mkdtempSync(path.join(getTempDir(), `video-edit-${mediaId}-`));

  try {
    // Extract and optionally stabilize each selected segment
    const segmentPaths: string[] = [];

    for (let i = 0; i < selected.length; i++) {
      const seg = selected[i];
      const segPath = path.join(tempDir, `segment_${i}.mp4`);

      await extractSegment(videoPath, seg.startTime, seg.duration, segPath);

      if (seg.label === 'slightly_shaky') {
        const stabilized = await stabilizeSegment(segPath, tempDir, i);
        segmentPaths.push(stabilized);
      } else {
        segmentPaths.push(segPath);
      }
    }

    // Concatenate all segments
    const compiledRelativePath = `${tripId}/compiled/${mediaId}_compiled.mp4`;
    const compiledTempPath = path.join(tempDir, `${mediaId}_compiled.mp4`);

    await concatenateSegments(segmentPaths, compiledTempPath, tempDir, options);

    // Save compiled video via StorageProvider
    const storageProvider = getStorageProvider();
    const compiledBuffer = fs.readFileSync(compiledTempPath);
    await storageProvider.save(compiledRelativePath, compiledBuffer);

    return {
      mediaId,
      compiledPath: compiledRelativePath,
      selectedSegments: selectedIndices,
    };
  } catch (err) {
    return {
      mediaId,
      compiledPath: null,
      selectedSegments: selectedIndices,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Clean up temp files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}
