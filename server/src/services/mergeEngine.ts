import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { getTempDir } from '../helpers/tempDir';
import { getStorageProvider } from '../storage/factory';
import { VideoSegment } from './videoAnalyzer';
import { buildTransitionFilters } from './videoEditor';
import { VIDEO_THRESHOLDS } from './videoThresholds';

export interface MergeRequest {
  mediaId: string;
  tripId: string;
  segmentIndices: number[];
  transitionType?: 'none' | 'fade' | 'crossfade';
  transitionDuration?: number;
}

export interface MergeResult {
  success: boolean;
  mergedPath: string | null;
  error?: string;
}

/**
 * Merge user-selected video segments into a single output video.
 *
 * - Extracts each selected segment from the source video
 * - Applies optional transition effects between segments
 * - Concatenates and saves the result via StorageProvider
 * - Returns error for empty segment list
 * - Cleans up temp files on error
 */
export async function mergeSegments(
  videoPath: string,
  segments: VideoSegment[],
  request: MergeRequest,
): Promise<MergeResult> {
  if (request.segmentIndices.length === 0) {
    return { success: false, mergedPath: null, error: '片段选择列表不能为空' };
  }

  // Resolve selected segments in the requested order
  const segmentMap = new Map(segments.map((s) => [s.index, s]));
  const selected: VideoSegment[] = [];
  for (const idx of request.segmentIndices) {
    const seg = segmentMap.get(idx);
    if (!seg) {
      return { success: false, mergedPath: null, error: `片段索引 ${idx} 不存在` };
    }
    selected.push(seg);
  }

  const tempDir = fs.mkdtempSync(path.join(getTempDir(), `video-merge-${request.mediaId}-`));

  try {
    // Detect audio
    const withAudio = await hasAudioStream(videoPath);

    // Extract each segment to a temp file
    const segmentPaths: string[] = [];
    for (let i = 0; i < selected.length; i++) {
      const seg = selected[i];
      const segPath = path.join(tempDir, `merge_seg_${i}.mp4`);
      await extractSegment(videoPath, seg.startTime, seg.duration, segPath);
      segmentPaths.push(segPath);
    }

    const mergedTempPath = path.join(tempDir, `${request.mediaId}_merged.mp4`);
    const transitionType = request.transitionType ?? 'none';
    const transitionDuration = request.transitionDuration ?? VIDEO_THRESHOLDS.defaultTransitionDuration;

    if (transitionType !== 'none' && segmentPaths.length > 1) {
      const filters = buildTransitionFilters(selected, transitionType, transitionDuration, withAudio);
      await concatenateWithTransitions(segmentPaths, mergedTempPath, filters, withAudio);
    } else {
      await concatenateSimple(segmentPaths, mergedTempPath, tempDir);
    }

    // Save via StorageProvider
    const mergedRelativePath = `${request.tripId}/merged/${request.mediaId}_merged.mp4`;
    const storageProvider = getStorageProvider();
    const mergedBuffer = fs.readFileSync(mergedTempPath);
    await storageProvider.save(mergedRelativePath, mergedBuffer);

    return { success: true, mergedPath: mergedRelativePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, mergedPath: null, error: message };
  } finally {
    // Clean up temp files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}


// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hasAudioStream(videoPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) { resolve(false); return; }
      const audio = metadata.streams?.find((s) => s.codec_type === 'audio');
      resolve(!!audio);
    });
  });
}

function extractSegment(
  videoPath: string,
  startTime: number,
  duration: number,
  outputPath: string,
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

function concatenateSimple(
  segmentPaths: string[],
  outputPath: string,
  tempDir: string,
): Promise<void> {
  const concatListPath = path.join(tempDir, 'concat_list.txt');
  const listContent = segmentPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(concatListPath, listContent);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy'])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}

interface TransitionFilter {
  videoFilter: string | null;
  audioFilter: string | null;
}

function concatenateWithTransitions(
  segmentPaths: string[],
  outputPath: string,
  filters: TransitionFilter,
  withAudio: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    let cmd = ffmpeg();
    for (const segPath of segmentPaths) {
      cmd = cmd.input(segPath);
    }

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

    if (filterParts.length > 0) {
      cmd = cmd.complexFilter(filterParts.join(';'));
      outputOptions.push('-map', '[vout]');
      if (withAudio && filters.audioFilter) {
        outputOptions.push('-map', '[aout]');
      }
    }

    cmd
      .outputOptions(outputOptions)
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}
