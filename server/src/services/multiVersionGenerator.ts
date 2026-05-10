/**
 * Multi-Version Generator
 *
 * Generates multiple output versions from the same source video based on
 * different duration/quality profiles (highlight, summary, full_edit).
 *
 * Each profile uses a different segment selection strategy:
 * - quality_first: Select highest-scoring segments
 * - balanced: Divide timeline into equal parts, pick best from each
 * - comprehensive: Include all segments passing minimum quality threshold
 */

import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { VideoSegment } from './videoAnalyzer';
import { BlackFrameResult } from './blackFrameDetector';
import { JunkClipResult } from './junkClipDetector';
import { normalizeSegments } from './audioNormalizer';
import { getStorageProvider } from '../storage/factory';
import { getDb } from '../database';
import { getTempDir } from '../helpers/tempDir';

export interface VersionProfile {
  name: string;                 // 'highlight' | 'summary' | 'full_edit' | custom
  targetDuration: number;       // seconds
  selectionStrategy: 'quality_first' | 'balanced' | 'comprehensive';
}

export interface VersionResult {
  versionId: string;
  profile: VersionProfile;
  filePath: string;
  duration: number;
  segmentCount: number;
  fileSize: number;
  error?: string;
}

export interface MultiVersionResult {
  mediaId: string;
  versions: VersionResult[];
  errors: Array<{ profile: string; error: string }>;
}

export const DEFAULT_PROFILES: Record<string, VersionProfile> = {
  highlight: { name: 'highlight', targetDuration: 30, selectionStrategy: 'quality_first' },
  summary: { name: 'summary', targetDuration: 60, selectionStrategy: 'balanced' },
  full_edit: { name: 'full_edit', targetDuration: 300, selectionStrategy: 'comprehensive' },
};

// Concurrency lock: tracks media IDs currently being processed
const generatingMediaIds = new Set<string>();

/**
 * Check if a media item is currently being processed for version generation.
 * Used by API routes to return 409 before calling generateVersions.
 */
export function isGenerating(mediaId: string): boolean {
  return generatingMediaIds.has(mediaId);
}

/**
 * Select segments for a specific version profile.
 * Applies black frame + junk filtering, then profile-specific selection strategy.
 *
 * @param segments - All video segments from analysis
 * @param profile - Version profile defining target duration and strategy
 * @param blackFrameResults - Map of segment index to black frame detection results
 * @param junkResults - Map of segment index to junk clip detection results
 * @returns Filtered and selected segments ordered by startTime
 */
export function selectSegmentsForProfile(
  segments: VideoSegment[],
  profile: VersionProfile,
  blackFrameResults: Map<number, BlackFrameResult>,
  junkResults: Map<number, JunkClipResult>,
): VideoSegment[] {
  // Step 1: Filter out black frame and junk segments
  const filtered = segments.filter((segment) => {
    const blackFrameResult = blackFrameResults.get(segment.index);
    if (blackFrameResult?.isBlackFrameSegment === true) {
      return false;
    }
    const junkResult = junkResults.get(segment.index);
    if (junkResult?.isJunk === true) {
      return false;
    }
    return true;
  });

  // Step 2: Dispatch to profile-specific selection strategy
  let selected: VideoSegment[];
  switch (profile.selectionStrategy) {
    case 'quality_first':
      selected = selectQualityFirst(filtered, profile.targetDuration);
      break;
    case 'balanced':
      selected = selectBalanced(filtered, profile.targetDuration);
      break;
    case 'comprehensive':
      selected = selectComprehensive(filtered);
      break;
    default:
      selected = [];
  }

  // Step 3: Sort selected segments by startTime (chronological order)
  return selected.sort((a, b) => a.startTime - b.startTime);
}

/**
 * Quality-first selection strategy.
 * Sorts by overallScore descending, greedily selects until targetDuration reached.
 * Skips segments that would exceed targetDuration * 1.1 (10% tolerance).
 */
function selectQualityFirst(segments: VideoSegment[], targetDuration: number): VideoSegment[] {
  // Sort a copy by overallScore descending
  const sorted = [...segments].sort((a, b) => b.overallScore - a.overallScore);

  const maxDuration = targetDuration * 1.1;
  const selected: VideoSegment[] = [];
  let cumulativeDuration = 0;

  for (const segment of sorted) {
    // Stop when we've reached the target duration
    if (cumulativeDuration >= targetDuration) {
      break;
    }

    // Skip if adding this segment would exceed the 10% tolerance
    if (cumulativeDuration + segment.duration > maxDuration) {
      continue;
    }

    selected.push(segment);
    cumulativeDuration += segment.duration;
  }

  return selected;
}

/**
 * Balanced selection strategy.
 * Divides timeline into N equal parts, selects best segment from each part.
 *
 * N is calculated to approximately fill the targetDuration:
 *   N = Math.ceil(targetDuration / averageSegmentDuration)
 *
 * If there are fewer segments than N, all segments are candidates.
 * Each time window gets at most one segment (the highest scoring one whose
 * startTime falls within that window).
 *
 * If total selected duration exceeds targetDuration, trim from lowest-scoring
 * selections until within budget.
 */
function selectBalanced(segments: VideoSegment[], targetDuration: number): VideoSegment[] {
  if (segments.length === 0) {
    return [];
  }

  // Step 1: Find timeline bounds
  const minStart = Math.min(...segments.map(s => s.startTime));
  const maxEnd = Math.max(...segments.map(s => s.endTime));
  const timelineSpan = maxEnd - minStart;

  if (timelineSpan <= 0) {
    return [];
  }

  // Step 2: Calculate number of parts (N)
  const averageSegmentDuration = segments.reduce((sum, s) => sum + s.duration, 0) / segments.length;
  const totalSegmentsDuration = segments.reduce((sum, s) => sum + s.duration, 0);

  let N: number;
  if (totalSegmentsDuration <= targetDuration) {
    // All segments fit within target — use segments.length parts (select all)
    N = segments.length;
  } else {
    // Calculate N to approximately fill targetDuration
    N = Math.max(1, Math.ceil(targetDuration / averageSegmentDuration));
  }

  // Step 3: Divide timeline into N equal windows
  const windowSize = timelineSpan / N;

  // Step 4: For each window, pick the best segment by overallScore
  const selected: VideoSegment[] = [];

  for (let i = 0; i < N; i++) {
    const windowStart = minStart + i * windowSize;
    const windowEnd = minStart + (i + 1) * windowSize;

    // Find segments whose startTime falls within this window
    const candidates = segments.filter(s => {
      if (i === N - 1) {
        // Last window includes the endpoint
        return s.startTime >= windowStart && s.startTime <= windowEnd;
      }
      return s.startTime >= windowStart && s.startTime < windowEnd;
    });

    if (candidates.length > 0) {
      // Pick the one with the highest overallScore
      const best = candidates.reduce((a, b) => b.overallScore > a.overallScore ? b : a);
      selected.push(best);
    }
  }

  // Step 5: If total selected duration exceeds targetDuration, trim from lowest-scoring
  let totalDuration = selected.reduce((sum, s) => sum + s.duration, 0);

  if (totalDuration > targetDuration) {
    // Sort by overallScore ascending (lowest first) for trimming
    const sortedByScore = [...selected].sort((a, b) => a.overallScore - b.overallScore);
    const toRemove = new Set<number>();

    for (const segment of sortedByScore) {
      if (totalDuration <= targetDuration) {
        break;
      }
      toRemove.add(segment.index);
      totalDuration -= segment.duration;
    }

    return selected.filter(s => !toRemove.has(s.index));
  }

  return selected;
}

/**
 * Comprehensive selection strategy.
 * Includes all segments passing minimum quality threshold.
 *
 * This is used for the "full_edit" (300s) version that aims to include
 * as much content as possible. The threshold is intentionally low (30)
 * to only exclude truly terrible segments.
 *
 * Note: Black frame and junk filtering is already done by selectSegmentsForProfile
 * before calling this function.
 */
const COMPREHENSIVE_MIN_SCORE = 30;

function selectComprehensive(segments: VideoSegment[]): VideoSegment[] {
  return segments.filter(segment => segment.overallScore >= COMPREHENSIVE_MIN_SCORE);
}

/**
 * Generate multiple versions of a video based on provided profiles.
 * For each profile: skip if targetDuration > sourceDuration, select segments,
 * normalize audio, concatenate, save to storage, create media_versions record.
 *
 * @param videoPath - Path to the source video file
 * @param mediaId - Media item ID
 * @param tripId - Trip ID for storage organization
 * @param segments - All video segments from analysis
 * @param profiles - Array of version profiles to generate
 * @param options - Optional generation options (e.g., video resolution, detection results)
 * @returns MultiVersionResult with generated versions and any errors
 */
export async function generateVersions(
  videoPath: string,
  mediaId: string,
  tripId: string,
  segments: VideoSegment[],
  profiles: VersionProfile[],
  options?: {
    videoResolution?: number;
    blackFrameResults?: Map<number, BlackFrameResult>;
    junkResults?: Map<number, JunkClipResult>;
  },
): Promise<MultiVersionResult> {
  // Concurrency lock: prevent duplicate generation for the same mediaId
  if (generatingMediaIds.has(mediaId)) {
    throw new Error(`GENERATION_IN_PROGRESS: Version generation already in progress for media ${mediaId}`);
  }
  generatingMediaIds.add(mediaId);

  try {
  const sourceDuration = segments.length > 0
    ? Math.max(...segments.map(s => s.endTime))
    : 0;
  const blackFrameResults = options?.blackFrameResults ?? new Map<number, BlackFrameResult>();
  const junkResults = options?.junkResults ?? new Map<number, JunkClipResult>();
  const versions: VersionResult[] = [];
  const errors: Array<{ profile: string; error: string }> = [];

  for (const profile of profiles) {
    try {
      // Skip if target exceeds source
      if (profile.targetDuration > sourceDuration) {
        continue; // Don't count as error, just skip
      }

      // Select segments for this profile
      const selected = selectSegmentsForProfile(segments, profile, blackFrameResults, junkResults);
      if (selected.length === 0) {
        errors.push({ profile: profile.name, error: 'No valid segments' });
        continue;
      }

      // Create temp dir for this version
      const tempDir = path.join(getTempDir(), `version_${mediaId}_${profile.name}`);
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        // Extract segments to temp files
        const segmentPaths: string[] = [];
        for (let i = 0; i < selected.length; i++) {
          const seg = selected[i];
          const segPath = path.join(tempDir, `seg_${i}.mp4`);
          await extractSegment(videoPath, seg.startTime, seg.duration, segPath);
          segmentPaths.push(segPath);
        }

        // Normalize audio
        const normalizedDir = path.join(tempDir, 'normalized');
        const normResults = await normalizeSegments(segmentPaths, normalizedDir);

        // Replace with normalized paths where available
        for (let i = 0; i < normResults.length; i++) {
          if (!normResults[i].skipped && normResults[i].normalizedPath) {
            segmentPaths[i] = normResults[i].normalizedPath!;
          }
        }

        // Concatenate segments
        const outputPath = path.join(tempDir, `${profile.name}_output.mp4`);
        await concatenateSegments(segmentPaths, outputPath);

        // Save to storage
        const storagePath = `${tripId}/versions/${mediaId}_${profile.name}.mp4`;
        const storage = getStorageProvider();
        const fileBuffer = fs.readFileSync(outputPath);
        await storage.save(storagePath, fileBuffer);

        // Get file stats
        const stats = fs.statSync(outputPath);
        const duration = selected.reduce((sum, s) => sum + s.duration, 0);

        // Create media_versions record
        const versionId = uuidv4();
        const db = getDb();
        db.prepare(`
          INSERT INTO media_versions (id, media_id, version_type, file_path, duration, file_size, params, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?)
        `).run(
          versionId,
          mediaId,
          profile.name,
          storagePath,
          duration,
          stats.size,
          JSON.stringify({
            profile,
            segmentCount: selected.length,
            normalizedCount: normResults.filter(r => !r.skipped).length,
          }),
          new Date().toISOString(),
        );

        versions.push({
          versionId,
          profile,
          filePath: storagePath,
          duration,
          segmentCount: selected.length,
          fileSize: stats.size,
        });
      } finally {
        // Cleanup temp dir
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore cleanup errors */
        }
      }
    } catch (err: any) {
      errors.push({ profile: profile.name, error: err.message || 'Unknown error' });
    }
  }

  return { mediaId, versions, errors };
  } finally {
    generatingMediaIds.delete(mediaId);
  }
}

// ---------------------------------------------------------------------------
// Helper functions for segment extraction and concatenation
// ---------------------------------------------------------------------------

/**
 * Extract a segment from a video file using ffmpeg stream copy.
 */
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
      .on('error', (err) => reject(err))
      .run();
  });
}

/**
 * Concatenate multiple segment files using ffmpeg concat demuxer.
 */
function concatenateSegments(
  segmentPaths: string[],
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Create concat file list
    const listPath = outputPath + '.txt';
    const listContent = segmentPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .output(outputPath)
      .outputOptions(['-c', 'copy'])
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run();
  });
}
