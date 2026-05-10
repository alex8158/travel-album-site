/**
 * Multi-Version Generator
 *
 * Generates multiple output versions from the same source video based on
 * different duration/quality profiles (highlight, summary, extended).
 *
 * Each profile uses a different segment selection strategy:
 * - quality_first: Select highest-scoring segments greedily by overallScore desc
 * - balanced: Divide timeline into 3 equal intervals, pick best from each, fill remaining budget
 * - comprehensive: Include all segments with overallScore >= 30 (non-junk, non-black)
 *
 * Memory optimization (Requirements 10.1-10.8):
 * - Serial generation (highlight → summary → extended)
 * - Memory pressure check before each version
 * - Critical pressure: wait up to 60s for recovery, skip on timeout
 * - Stream-based storage transfer (no fs.readFileSync)
 * - Shared segment extraction: extract once, reuse across versions
 * - Cleanup shared segments after all versions complete
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
import { getMemoryManager, MemoryManager } from './memoryManager';
import { createStreamProcessor, StreamProcessor } from './streamProcessor';

export interface VersionProfile {
  name: string;                 // 'highlight' | 'summary' | 'extended' | custom
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
  status: 'ready' | 'skipped' | 'error';
  skipReason?: string;
  error?: string;
}

export interface MultiVersionResult {
  mediaId: string;
  versions: VersionResult[];
  errors: Array<{ profile: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Environment variable parsing for version durations
// ---------------------------------------------------------------------------

/**
 * Parse an integer environment variable with range validation.
 * Returns the default value if the env var is missing, non-integer, or out of range.
 */
export function parseDurationEnv(envKey: string, defaultValue: number, min: number = 5, max: number = 600): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || !Number.isFinite(parsed) || parsed !== parseFloat(raw)) {
    return defaultValue;
  }
  if (parsed < min || parsed > max) {
    return defaultValue;
  }
  return parsed;
}

/**
 * Get configured duration for each version profile from environment variables.
 */
export function getConfiguredDurations(): { highlight: number; summary: number; extended: number } {
  return {
    highlight: parseDurationEnv('VIDEO_HIGHLIGHT_DURATION', 30, 5, 600),
    summary: parseDurationEnv('VIDEO_SUMMARY_DURATION', 60, 5, 600),
    extended: parseDurationEnv('VIDEO_EXTENDED_DURATION', 300, 5, 600),
  };
}

export const DEFAULT_PROFILES: Record<string, VersionProfile> = {
  highlight: { name: 'highlight', targetDuration: getConfiguredDurations().highlight, selectionStrategy: 'quality_first' },
  summary: { name: 'summary', targetDuration: getConfiguredDurations().summary, selectionStrategy: 'balanced' },
  extended: { name: 'extended', targetDuration: getConfiguredDurations().extended, selectionStrategy: 'comprehensive' },
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
 * Applies black frame + near-black frame + junk filtering, then profile-specific selection strategy.
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
  // Step 1: Filter out black frame, near-black frame, and junk segments
  const filtered = segments.filter((segment) => {
    const blackFrameResult = blackFrameResults.get(segment.index);
    if (blackFrameResult?.isBlackFrameSegment === true) {
      return false;
    }
    if (blackFrameResult?.isNearBlackSegment === true) {
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
 * Sorts by overallScore descending, greedily selects until cumulative duration >= targetDuration.
 * Once cumulative duration reaches targetDuration, stop selecting.
 */
function selectQualityFirst(segments: VideoSegment[], targetDuration: number): VideoSegment[] {
  // Sort a copy by overallScore descending
  const sorted = [...segments].sort((a, b) => b.overallScore - a.overallScore);

  const selected: VideoSegment[] = [];
  let cumulativeDuration = 0;

  for (const segment of sorted) {
    // Stop when we've reached the target duration
    if (cumulativeDuration >= targetDuration) {
      break;
    }

    selected.push(segment);
    cumulativeDuration += segment.duration;
  }

  return selected;
}

/**
 * Balanced selection strategy.
 * Divides the source timeline into 3 equal intervals.
 * From each interval, picks segments by overallScore descending, ensuring each
 * interval contributes at least 1 segment (if available).
 * Then fills remaining budget from highest-scoring unused segments across all intervals.
 * Selected segments are returned (caller sorts by startTime).
 */
function selectBalanced(segments: VideoSegment[], targetDuration: number): VideoSegment[] {
  if (segments.length === 0) {
    return [];
  }

  const NUM_INTERVALS = 3;

  // Step 1: Find timeline bounds
  const minStart = Math.min(...segments.map(s => s.startTime));
  const maxEnd = Math.max(...segments.map(s => s.endTime));
  const timelineSpan = maxEnd - minStart;

  if (timelineSpan <= 0) {
    return [];
  }

  // Step 2: Divide timeline into 3 equal intervals
  const intervalSize = timelineSpan / NUM_INTERVALS;

  // Step 3: Assign segments to intervals based on startTime
  const intervals: VideoSegment[][] = Array.from({ length: NUM_INTERVALS }, () => []);
  for (const segment of segments) {
    const intervalIndex = Math.min(
      Math.floor((segment.startTime - minStart) / intervalSize),
      NUM_INTERVALS - 1,
    );
    intervals[intervalIndex].push(segment);
  }

  // Sort each interval by overallScore descending
  for (const interval of intervals) {
    interval.sort((a, b) => b.overallScore - a.overallScore);
  }

  // Step 4: Ensure each interval contributes at least 1 segment
  const selected: VideoSegment[] = [];
  const selectedIndices = new Set<number>();
  let cumulativeDuration = 0;

  for (const interval of intervals) {
    if (interval.length > 0) {
      const best = interval[0];
      selected.push(best);
      selectedIndices.add(best.index);
      cumulativeDuration += best.duration;
    }
  }

  // Step 5: Fill remaining budget from highest-scoring unused segments
  if (cumulativeDuration < targetDuration) {
    // Collect all unused segments, sorted by overallScore descending
    const unused = segments
      .filter(s => !selectedIndices.has(s.index))
      .sort((a, b) => b.overallScore - a.overallScore);

    for (const segment of unused) {
      if (cumulativeDuration >= targetDuration) {
        break;
      }
      selected.push(segment);
      selectedIndices.add(segment.index);
      cumulativeDuration += segment.duration;
    }
  }

  // Step 6: If total selected duration exceeds targetDuration, trim from lowest-scoring
  // but keep at least 1 per interval that has segments
  if (cumulativeDuration > targetDuration) {
    // Identify which segments are the "mandatory" ones (first from each interval)
    const mandatoryIndices = new Set<number>();
    for (const interval of intervals) {
      if (interval.length > 0) {
        mandatoryIndices.add(interval[0].index);
      }
    }

    // Sort selected by overallScore ascending (lowest first) for trimming
    const sortedByScore = [...selected].sort((a, b) => a.overallScore - b.overallScore);
    const toRemove = new Set<number>();

    for (const segment of sortedByScore) {
      if (cumulativeDuration <= targetDuration) {
        break;
      }
      // Don't remove mandatory segments (at least 1 per interval)
      if (mandatoryIndices.has(segment.index)) {
        continue;
      }
      toRemove.add(segment.index);
      cumulativeDuration -= segment.duration;
    }

    return selected.filter(s => !toRemove.has(s.index));
  }

  return selected;
}

/**
 * Comprehensive selection strategy.
 * Includes all segments passing minimum quality threshold.
 *
 * This is used for the "extended" (300s) version that aims to include
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
 * Memory optimization (Requirements 10.1-10.8):
 * - Serial generation (highlight → summary → extended)
 * - Memory pressure check before each version via MemoryManager
 * - Critical pressure: wait up to 60s for recovery, skip on timeout
 * - Stream-based storage transfer via StreamProcessor
 * - Shared segment extraction: extract once, reuse across versions
 * - Cleanup shared segments after all versions complete
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
    memoryManager?: MemoryManager;
    streamProcessor?: StreamProcessor;
  },
): Promise<MultiVersionResult> {
  // Concurrency lock: prevent duplicate generation for the same mediaId
  if (generatingMediaIds.has(mediaId)) {
    throw new Error(`GENERATION_IN_PROGRESS: Version generation already in progress for media ${mediaId}`);
  }
  generatingMediaIds.add(mediaId);

  // Get memory manager and stream processor (allow injection for testing)
  const memoryManager = options?.memoryManager ?? getMemoryManager();
  const storage = getStorageProvider();
  const streamProcessor = options?.streamProcessor ?? createStreamProcessor(storage);

  // Shared segment extraction directory — extract once, reuse across versions
  const sharedSegmentsDir = path.join(getTempDir(), `shared_segments_${mediaId}_${Date.now()}`);

  try {
  const sourceDuration = segments.length > 0
    ? Math.max(...segments.map(s => s.endTime))
    : 0;
  const blackFrameResults = options?.blackFrameResults ?? new Map<number, BlackFrameResult>();
  const junkResults = options?.junkResults ?? new Map<number, JunkClipResult>();
  const versions: VersionResult[] = [];
  const errors: Array<{ profile: string; error: string }> = [];

  // --- Shared segment extraction (Requirement 10.7) ---
  // Extract all potentially needed segments once to the shared directory.
  // We extract all valid (non-black, non-junk) segments so they can be reused.
  fs.mkdirSync(sharedSegmentsDir, { recursive: true });

  // Map: segment.index → extracted file path
  const extractedSegmentPaths = new Map<number, string>();

  // Serial generation: highlight → summary → extended (Requirement 10.1)
  for (const profile of profiles) {
    try {
      // --- Memory pressure check before each version (Requirement 10.3) ---
      const pressureLevel = memoryManager.getPressureLevel();
      if (pressureLevel === 'critical') {
        // Wait up to 60 seconds for recovery (Requirement 10.4)
        console.warn(
          `[MultiVersionGenerator] Memory pressure is critical before generating "${profile.name}". Waiting for recovery (max 60s)...`,
        );
        const recovered = await memoryManager.waitForRecovery(60000);
        if (!recovered) {
          // Timeout: skip this version (Requirement 10.5)
          console.error(
            `[MultiVersionGenerator] Memory pressure still critical after 60s. Skipping version "${profile.name}".`,
          );
          versions.push({
            versionId: '',
            profile,
            filePath: '',
            duration: 0,
            segmentCount: 0,
            fileSize: 0,
            status: 'skipped',
            skipReason: 'memory_pressure_timeout',
          });
          continue;
        }
      }

      // Skip if source duration is strictly less than target duration
      if (sourceDuration < profile.targetDuration) {
        versions.push({
          versionId: '',
          profile,
          filePath: '',
          duration: 0,
          segmentCount: 0,
          fileSize: 0,
          status: 'skipped',
          skipReason: `Source duration (${sourceDuration.toFixed(1)}s) is less than target duration (${profile.targetDuration}s)`,
        });
        continue;
      }

      // Select segments for this profile
      const selected = selectSegmentsForProfile(segments, profile, blackFrameResults, junkResults);
      if (selected.length === 0) {
        errors.push({ profile: profile.name, error: 'No valid segments' });
        continue;
      }

      // Create temp dir for this version's concatenation output
      const versionTempDir = path.join(getTempDir(), `version_${mediaId}_${profile.name}`);
      fs.mkdirSync(versionTempDir, { recursive: true });

      try {
        // --- Segment extraction with reuse (Requirement 10.7) ---
        // Extract segments to shared dir if not already extracted
        const segmentPaths: string[] = [];
        for (const seg of selected) {
          if (!extractedSegmentPaths.has(seg.index)) {
            const segPath = path.join(sharedSegmentsDir, `seg_${seg.index}.mp4`);
            await extractSegment(videoPath, seg.startTime, seg.duration, segPath);
            extractedSegmentPaths.set(seg.index, segPath);
          }
          segmentPaths.push(extractedSegmentPaths.get(seg.index)!);
        }

        // Normalize audio (uses version-specific temp dir)
        const normalizedDir = path.join(versionTempDir, 'normalized');
        const normResults = await normalizeSegments(segmentPaths, normalizedDir);

        // Build final paths: use normalized where available, otherwise shared segment
        const finalPaths: string[] = [];
        for (let i = 0; i < segmentPaths.length; i++) {
          if (!normResults[i].skipped && normResults[i].normalizedPath) {
            finalPaths.push(normResults[i].normalizedPath!);
          } else {
            finalPaths.push(segmentPaths[i]);
          }
        }

        // Concatenate segments
        const outputPath = path.join(versionTempDir, `${profile.name}_output.mp4`);
        await concatenateSegments(finalPaths, outputPath);

        // Get file stats before stream transfer (file will be deleted after transfer)
        const stats = fs.statSync(outputPath);
        const duration = selected.reduce((sum, s) => sum + s.duration, 0);

        // --- Stream-based storage transfer (Requirement 10.2 via StreamProcessor) ---
        const storagePath = `${tripId}/versions/${mediaId}_${profile.name}.mp4`;
        await streamProcessor.transferToStorage(outputPath, storagePath);

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
          status: 'ready',
        });
      } finally {
        // Cleanup version-specific temp dir (Requirement 10.6)
        try {
          fs.rmSync(versionTempDir, { recursive: true, force: true });
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
    // --- Cleanup shared segment extraction directory (Requirement 10.8) ---
    try {
      fs.rmSync(sharedSegmentsDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
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
