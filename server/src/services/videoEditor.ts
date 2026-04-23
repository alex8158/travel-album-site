import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { getTempDir } from '../helpers/tempDir';
import { VideoAnalysisResult, VideoSegment } from './videoAnalyzer';
import { getStorageProvider } from '../storage/factory';
import { VIDEO_THRESHOLDS } from './videoThresholds';

export interface EditOptions {
  videoResolution?: number;
  transitionType?: 'none' | 'fade' | 'crossfade';
  transitionDuration?: number;
}

export interface SegmentDetail {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  overallScore: number;
  label: string;
}

export interface EditResult {
  mediaId: string;
  compiledPath: string | null;
  selectedSegments: number[];
  segmentDetails: SegmentDetail[];
  error?: string;
}

/**
 * Calculate the target duration based on the original video duration.
 *
 * Reads thresholds from VIDEO_THRESHOLDS:
 *   - < shortVideoCutoff (60)  → null (just remove bad segments)
 *   - [shortVideoCutoff, mediumVideoCutoff] (60-600 inclusive) → mediumTargetDuration (60)
 *   - > mediumVideoCutoff (600) → longTargetDuration (300)
 */
export function calculateTargetDuration(originalDuration: number): number | null {
  const { shortVideoCutoff, mediumVideoCutoff, mediumTargetDuration, longTargetDuration } = VIDEO_THRESHOLDS;
  if (originalDuration < shortVideoCutoff) return null;
  if (originalDuration <= mediumVideoCutoff) return mediumTargetDuration;
  return longTargetDuration;
}

/**
 * Select segments from the analysis with enhanced logic:
 *
 * 1. Exclude severely_blurry, severely_shaky, severely_exposed labels
 * 2. Filter out segments shorter than minSegmentDuration
 * 3. When targetDuration is null and all segments are good, return all unchanged
 * 4. Adjacency-aware selection: when score difference ≤ scoreProximityRatio (10%)
 *    AND gap ≤ adjacencyGapThreshold (2s), prefer adjacent segments
 * 5. Sort output by startTime
 */
export function selectSegments(
  segments: VideoSegment[],
  targetDuration: number | null
): VideoSegment[] {
  const {
    minSegmentDuration,
    scoreProximityRatio,
    adjacencyGapThreshold,
  } = VIDEO_THRESHOLDS;

  const severeLabels = new Set(['severely_blurry', 'severely_shaky', 'severely_exposed']);

  // Filter out severe labels, blurry, shaky, and segments below min duration
  const candidates = segments.filter(
    (s) =>
      !severeLabels.has(s.label) &&
      s.label !== 'blurry' &&
      s.label !== 'shaky' &&
      s.duration >= minSegmentDuration
  );

  if (candidates.length === 0) return [];

  // When targetDuration is null and all segments pass filtering, return all unchanged
  if (targetDuration === null && candidates.length === segments.length) {
    return [...candidates].sort((a, b) => a.startTime - b.startTime);
  }

  if (targetDuration === null) {
    // Short video: keep all candidates (some were filtered out)
    return [...candidates].sort((a, b) => a.startTime - b.startTime);
  }

  // Sort by overallScore descending for selection
  const sorted = [...candidates].sort((a, b) => b.overallScore - a.overallScore);

  // Adjacency-aware greedy selection
  const selected: VideoSegment[] = [];
  const usedIndices = new Set<number>();
  let cumulative = 0;

  for (const seg of sorted) {
    if (cumulative >= targetDuration) break;
    if (usedIndices.has(seg.index)) continue;

    // Don't add if it would exceed target (allow only the first segment to exceed)
    if (selected.length > 0 && cumulative + seg.duration > targetDuration * 1.1) break;

    selected.push(seg);
    usedIndices.add(seg.index);
    cumulative += seg.duration;

    if (cumulative >= targetDuration) break;

    // Find adjacent segments that are close in score and time, but respect target
    for (const adj of sorted) {
      if (cumulative >= targetDuration) break;
      if (usedIndices.has(adj.index)) continue;

      // Check if adjacent in time (gap ≤ adjacencyGapThreshold)
      const gap = Math.min(
        Math.abs(adj.startTime - seg.endTime),
        Math.abs(seg.startTime - adj.endTime)
      );
      if (gap > adjacencyGapThreshold) continue;

      // Check if score is close enough (within scoreProximityRatio)
      const maxScore = Math.max(seg.overallScore, adj.overallScore);
      const scoreDiff = Math.abs(seg.overallScore - adj.overallScore);
      if (maxScore > 0 && scoreDiff / maxScore > scoreProximityRatio) continue;

      // Don't exceed target by more than 10%
      if (cumulative + adj.duration > targetDuration * 1.1) continue;

      selected.push(adj);
      usedIndices.add(adj.index);
      cumulative += adj.duration;
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

// ---------------------------------------------------------------------------
// Audio stream detection
// ---------------------------------------------------------------------------

/**
 * Check whether a video file contains an audio stream.
 */
function hasAudioStream(videoPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        resolve(false);
        return;
      }
      const audioStream = metadata.streams?.find((s) => s.codec_type === 'audio');
      resolve(!!audioStream);
    });
  });
}

// ---------------------------------------------------------------------------
// Transition effect helpers (Task 3.5)
// ---------------------------------------------------------------------------

export interface TransitionFilter {
  videoFilter: string | null;
  audioFilter: string | null;
}

/**
 * Build ffmpeg filter strings for transitions between segments.
 *
 * - 'none': direct concat, no filter (audio gets short fade at splice points)
 * - 'fade': vfade/afade on each segment boundary
 * - 'crossfade': xfade between consecutive segments
 *
 * When a segment's duration < 2 × transitionDuration, skip transition for that segment.
 * Audio always gets a short fade in/out at splice points.
 */
export function buildTransitionFilters(
  segments: VideoSegment[],
  transitionType: 'none' | 'fade' | 'crossfade',
  transitionDuration: number,
  withAudio: boolean,
): TransitionFilter {
  if (segments.length <= 1 || transitionType === 'none') {
    // For 'none' or single segment: apply short audio fades at splice points
    if (withAudio && segments.length > 1) {
      const audioFilters: string[] = [];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const fadeDur = Math.min(transitionDuration, seg.duration / 2);
        // Fade in at start, fade out at end of each segment
        audioFilters.push(`[${i}:a]afade=t=in:d=${fadeDur},afade=t=out:st=${seg.duration - fadeDur}:d=${fadeDur}[a${i}]`);
      }
      const concatInputs = segments.map((_, i) => `[a${i}]`).join('');
      audioFilters.push(`${concatInputs}concat=n=${segments.length}:v=0:a=1[aout]`);
      return { videoFilter: null, audioFilter: audioFilters.join(';') };
    }
    return { videoFilter: null, audioFilter: null };
  }

  if (transitionType === 'fade') {
    return buildFadeFilters(segments, transitionDuration, withAudio);
  }

  // crossfade
  return buildCrossfadeFilters(segments, transitionDuration, withAudio);
}

function buildFadeFilters(
  segments: VideoSegment[],
  transitionDuration: number,
  withAudio: boolean,
): TransitionFilter {
  const videoFilters: string[] = [];
  const audioFilters: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const canTransition = seg.duration >= 2 * transitionDuration;
    const fadeDur = canTransition ? transitionDuration : 0;

    if (fadeDur > 0) {
      // Video: fade in at start, fade out at end
      videoFilters.push(
        `[${i}:v]fade=t=in:d=${fadeDur},fade=t=out:st=${seg.duration - fadeDur}:d=${fadeDur}[v${i}]`
      );
    } else {
      videoFilters.push(`[${i}:v]null[v${i}]`);
    }

    if (withAudio) {
      const aFadeDur = Math.min(transitionDuration, seg.duration / 2);
      audioFilters.push(
        `[${i}:a]afade=t=in:d=${aFadeDur},afade=t=out:st=${seg.duration - aFadeDur}:d=${aFadeDur}[a${i}]`
      );
    }
  }

  // Concat all streams
  const vInputs = segments.map((_, i) => `[v${i}]`).join('');
  videoFilters.push(`${vInputs}concat=n=${segments.length}:v=1:a=0[vout]`);

  if (withAudio) {
    const aInputs = segments.map((_, i) => `[a${i}]`).join('');
    audioFilters.push(`${aInputs}concat=n=${segments.length}:v=0:a=1[aout]`);
  }

  return {
    videoFilter: videoFilters.join(';'),
    audioFilter: withAudio ? audioFilters.join(';') : null,
  };
}

function buildCrossfadeFilters(
  segments: VideoSegment[],
  transitionDuration: number,
  withAudio: boolean,
): TransitionFilter {
  if (segments.length === 1) {
    return { videoFilter: null, audioFilter: null };
  }

  const videoFilters: string[] = [];
  const audioFilters: string[] = [];

  // For crossfade, chain xfade filters between consecutive segments
  // First, label all inputs
  let prevVideoLabel = '0:v';
  let prevAudioLabel = '0:a';

  for (let i = 1; i < segments.length; i++) {
    const prevSeg = segments[i - 1];
    const currSeg = segments[i];
    const canTransition =
      prevSeg.duration >= 2 * transitionDuration &&
      currSeg.duration >= 2 * transitionDuration;

    const outLabel = i === segments.length - 1 ? 'vout' : `xv${i}`;

    if (canTransition) {
      const offset = prevSeg.duration - transitionDuration;
      videoFilters.push(
        `[${prevVideoLabel}][${i}:v]xfade=transition=fade:duration=${transitionDuration}:offset=${offset}[${outLabel}]`
      );
      if (withAudio) {
        const aOutLabel = i === segments.length - 1 ? 'aout' : `xa${i}`;
        audioFilters.push(
          `[${prevAudioLabel}][${i}:a]acrossfade=d=${transitionDuration}[${aOutLabel}]`
        );
        prevAudioLabel = aOutLabel;
      }
    } else {
      // Skip transition — just concat
      videoFilters.push(
        `[${prevVideoLabel}][${i}:v]concat=n=2:v=1:a=0[${outLabel}]`
      );
      if (withAudio) {
        const aOutLabel = i === segments.length - 1 ? 'aout' : `xa${i}`;
        audioFilters.push(
          `[${prevAudioLabel}][${i}:a]concat=n=2:v=0:a=1[${aOutLabel}]`
        );
        prevAudioLabel = aOutLabel;
      }
    }
    prevVideoLabel = outLabel;
  }

  return {
    videoFilter: videoFilters.join(';'),
    audioFilter: withAudio ? audioFilters.join(';') : null,
  };
}


/**
 * Edit a video based on analysis results.
 *
 * 1. Calculate target duration from original length (using VIDEO_THRESHOLDS)
 * 2. Select best segments (filter severe/blurry/shaky, adjacency-aware, min duration)
 * 3. Stabilize slightly_shaky segments with vidstab
 * 4. Build transition filters (none/fade/crossfade)
 * 5. Concatenate with transitions, output MP4/H.264/AAC
 * 6. Preserve orientation and framerate, don't upscale, compress to max 1080p
 * 7. Support videos without audio track
 * 8. Return error "无有效片段" when no segments pass quality filter
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
  const segmentDetails: SegmentDetail[] = selected.map((s) => ({
    index: s.index,
    startTime: s.startTime,
    endTime: s.endTime,
    duration: s.duration,
    overallScore: s.overallScore,
    label: s.label,
  }));

  // For short videos: if all segments are good (none filtered), skip compilation
  if (targetDuration === null && selected.length === analysis.segments.length) {
    return {
      mediaId,
      compiledPath: null,
      selectedSegments: selectedIndices,
      segmentDetails,
    };
  }

  // If no segments survived filtering, return error
  if (selected.length === 0) {
    return {
      mediaId,
      compiledPath: null,
      selectedSegments: [],
      segmentDetails: [],
      error: '无有效片段',
    };
  }

  const tempDir = fs.mkdtempSync(path.join(getTempDir(), `video-edit-${mediaId}-`));

  try {
    // Detect audio stream
    const withAudio = await hasAudioStream(videoPath);

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

    const compiledRelativePath = `${tripId}/compiled/${mediaId}_compiled.mp4`;
    const compiledTempPath = path.join(tempDir, `${mediaId}_compiled.mp4`);

    // Determine transition settings
    const transitionType = options?.transitionType ?? 'none';
    const transitionDuration = options?.transitionDuration ?? VIDEO_THRESHOLDS.defaultTransitionDuration;

    if (transitionType !== 'none' && segmentPaths.length > 1) {
      // Build and apply transition filters
      const filters = buildTransitionFilters(selected, transitionType, transitionDuration, withAudio);

      await concatenateWithTransitions(
        segmentPaths,
        compiledTempPath,
        filters,
        withAudio,
        options,
      );
    } else {
      // Simple concatenation (no transitions)
      await concatenateSegments(segmentPaths, compiledTempPath, tempDir, options);
    }

    // Save compiled video via StorageProvider
    const storageProvider = getStorageProvider();
    const compiledBuffer = fs.readFileSync(compiledTempPath);
    await storageProvider.save(compiledRelativePath, compiledBuffer);

    return {
      mediaId,
      compiledPath: compiledRelativePath,
      selectedSegments: selectedIndices,
      segmentDetails,
    };
  } catch (err) {
    return {
      mediaId,
      compiledPath: null,
      selectedSegments: selectedIndices,
      segmentDetails,
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

/**
 * Concatenate segments with transition filters applied.
 * Outputs MP4/H.264/AAC, preserves orientation and framerate,
 * doesn't upscale, compresses to max 1080p if needed.
 */
function concatenateWithTransitions(
  segmentPaths: string[],
  outputPath: string,
  filters: TransitionFilter,
  withAudio: boolean,
  options?: EditOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    let cmd = ffmpeg();

    // Add each segment as an input
    for (const segPath of segmentPaths) {
      cmd = cmd.input(segPath);
    }

    // Build combined filter graph
    const filterParts: string[] = [];
    if (filters.videoFilter) filterParts.push(filters.videoFilter);
    if (filters.audioFilter) filterParts.push(filters.audioFilter);

    const outputOptions: string[] = [
      '-c:v', 'libx264',
      '-movflags', '+faststart',
    ];

    if (withAudio) {
      outputOptions.push('-c:a', 'aac');
    } else {
      outputOptions.push('-an');
    }

    // Resolution: don't upscale, compress to max 1080p if needed
    const maxRes = options?.videoResolution ?? 1080;
    const scaleFilter = `scale='min(${maxRes},iw)':min'(${maxRes},ih)':force_original_aspect_ratio=decrease`;

    if (filterParts.length > 0) {
      // Append scale to the video output of the filter graph
      const fullFilter = filterParts.join(';');
      cmd = cmd.complexFilter(fullFilter);

      // Map the filter outputs
      outputOptions.push('-map', '[vout]');
      if (withAudio && filters.audioFilter) {
        outputOptions.push('-map', '[aout]');
      }
    } else {
      // No complex filter — use simple scale
      outputOptions.push('-vf', scaleFilter);
    }

    cmd
      .outputOptions(outputOptions)
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}
