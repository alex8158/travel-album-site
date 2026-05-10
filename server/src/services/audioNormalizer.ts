/**
 * Audio Normalizer
 *
 * Analyzes and normalizes audio loudness across video segments using ffmpeg loudnorm filter.
 * Two-stage processing: analysis mode (measure LUFS/LRA/true peak) then linear normalization.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoudnessAnalysis {
  integratedLoudness: number;   // LUFS
  loudnessRange: number;        // LRA in LU
  truePeak: number;             // dBTP
  hasAudio: boolean;
}

export interface NormalizationResult {
  normalizedPath: string | null;  // null if skipped
  skipped: boolean;
  reason: string;                 // 'normalized' | 'within_tolerance' | 'no_audio' | 'error'
  originalLoudness: number;
  targetLoudness: number;
}

export interface NormalizationOptions {
  targetLufs?: number;          // default from env AUDIO_TARGET_LUFS or -16
  truePeakLimit?: number;       // default -1.5 dBTP
  tolerance?: number;           // default 1.0 LUFS
}

// ---------------------------------------------------------------------------
// Environment Configuration
// ---------------------------------------------------------------------------

/**
 * Read AUDIO_TARGET_LUFS from environment variable (default -16).
 */
export function getTargetLufs(): number {
  const envVal = process.env.AUDIO_TARGET_LUFS;
  if (envVal) {
    const parsed = parseFloat(envVal);
    if (!isNaN(parsed)) return parsed;
  }
  return -16;
}

// ---------------------------------------------------------------------------
// Loudness Analysis
// ---------------------------------------------------------------------------

/**
 * Analyze the loudness of a video/audio segment using ffmpeg loudnorm filter in analysis mode.
 *
 * Runs: ffmpeg -i segmentPath -af loudnorm=print_format=json -f null -
 * Parses the JSON block from stderr containing input_i, input_lra, input_tp.
 *
 * @param segmentPath - Path to the video/audio segment file
 * @returns LoudnessAnalysis with measured values
 */
export function analyzeLoudness(segmentPath: string): Promise<LoudnessAnalysis> {
  return new Promise((resolve) => {
    const args = [
      '-i', segmentPath,
      '-af', 'loudnorm=print_format=json',
      '-f', 'null',
      '-',
    ];

    const proc = spawn('ffmpeg', args);

    let stderr = '';

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', () => {
      // ffmpeg not found or spawn failure
      resolve({
        hasAudio: true,
        integratedLoudness: -23,
        loudnessRange: 7,
        truePeak: -1,
      });
    });

    proc.on('close', (code) => {
      // Check for no audio stream
      if (stderr.includes('does not contain any stream') ||
          stderr.includes('no audio') ||
          stderr.includes('Output file #0 does not contain any stream')) {
        resolve({
          hasAudio: false,
          integratedLoudness: -23,
          loudnessRange: 0,
          truePeak: 0,
        });
        return;
      }

      // Try to parse the loudnorm JSON output from stderr
      const analysis = parseLoudnormOutput(stderr);
      if (analysis) {
        resolve(analysis);
      } else {
        // Parse failure — return defaults
        resolve({
          hasAudio: true,
          integratedLoudness: -23,
          loudnessRange: 7,
          truePeak: -1,
        });
      }
    });
  });
}

/**
 * Parse the loudnorm JSON block from ffmpeg stderr output.
 * Looks for a JSON object containing "input_i", "input_lra", "input_tp".
 */
export function parseLoudnormOutput(stderr: string): LoudnessAnalysis | null {
  try {
    // The loudnorm filter outputs a JSON block in stderr.
    // Find the last JSON block that contains loudnorm measurements.
    const jsonBlockRegex = /\{[^{}]*"input_i"[^{}]*\}/gs;
    const matches = stderr.match(jsonBlockRegex);

    if (!matches || matches.length === 0) {
      return null;
    }

    // Use the last match (loudnorm outputs at the end)
    const jsonStr = matches[matches.length - 1];
    const data = JSON.parse(jsonStr);

    const integratedLoudness = parseFloat(data.input_i);
    const loudnessRange = parseFloat(data.input_lra);
    const truePeak = parseFloat(data.input_tp);

    if (isNaN(integratedLoudness) || isNaN(loudnessRange) || isNaN(truePeak)) {
      return null;
    }

    return {
      integratedLoudness,
      loudnessRange,
      truePeak,
      hasAudio: true,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Codec Detection
// ---------------------------------------------------------------------------

/**
 * Detect the audio codec of a file using ffprobe.
 * Returns the codec name (e.g., 'aac', 'mp3', 'opus') or null if detection fails.
 */
export function detectAudioCodec(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [
      '-v', 'quiet',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0',
      filePath,
    ];

    const proc = spawn('ffprobe', args);

    let stdout = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on('error', () => {
      resolve(null);
    });

    proc.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Segment Normalization
// ---------------------------------------------------------------------------

/**
 * Run ffmpeg normalization with specified codec arguments.
 * Returns true on success (exit code 0), false on failure.
 */
function runNormalization(
  segmentPath: string,
  outputPath: string,
  loudnormFilter: string,
  codecArgs: string[]
): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [
      '-i', segmentPath,
      '-af', loudnormFilter,
      '-c:v', 'copy',
      ...codecArgs,
      '-y',
      outputPath,
    ];

    const proc = spawn('ffmpeg', args);

    proc.on('error', () => {
      resolve(false);
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });
  });
}

/**
 * Normalize a single segment's audio to the target loudness using ffmpeg loudnorm in linear mode.
 *
 * Skips normalization if:
 * - The segment has no audio
 * - The measured loudness is within tolerance of the target
 *
 * Attempts to preserve the original audio codec. If encoding with the original codec fails,
 * falls back to AAC 48kHz.
 *
 * @param segmentPath - Path to the input segment
 * @param outputPath - Path for the normalized output
 * @param analysis - Previously computed loudness analysis
 * @param options - Normalization options (target, peak limit, tolerance)
 * @returns NormalizationResult indicating what happened
 */
export async function normalizeSegment(
  segmentPath: string,
  outputPath: string,
  analysis: LoudnessAnalysis,
  options?: NormalizationOptions
): Promise<NormalizationResult> {
  const targetLufs = options?.targetLufs ?? getTargetLufs();
  const truePeakLimit = options?.truePeakLimit ?? -1.5;
  const tolerance = options?.tolerance ?? 1.0;

  // Skip if no audio
  if (!analysis.hasAudio) {
    return {
      normalizedPath: null,
      skipped: true,
      reason: 'no_audio',
      originalLoudness: analysis.integratedLoudness,
      targetLoudness: targetLufs,
    };
  }

  // Skip if within tolerance
  if (Math.abs(analysis.integratedLoudness - targetLufs) <= tolerance) {
    return {
      normalizedPath: null,
      skipped: true,
      reason: 'within_tolerance',
      originalLoudness: analysis.integratedLoudness,
      targetLoudness: targetLufs,
    };
  }

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // Build loudnorm filter string
  const loudnormFilter = [
    `loudnorm=I=${targetLufs}`,
    `TP=${truePeakLimit}`,
    `LRA=${analysis.loudnessRange}`,
    `linear=true`,
  ].join(':');

  // Detect original audio codec to try preserving it
  const originalCodec = await detectAudioCodec(segmentPath);

  // First attempt: preserve original codec if detected
  if (originalCodec && originalCodec !== 'aac') {
    const codecArgs = ['-c:a', originalCodec];
    const success = await runNormalization(segmentPath, outputPath, loudnormFilter, codecArgs);
    if (success) {
      return {
        normalizedPath: outputPath,
        skipped: false,
        reason: 'normalized',
        originalLoudness: analysis.integratedLoudness,
        targetLoudness: targetLufs,
      };
    }
    // Original codec failed, fall through to AAC fallback
  }

  // Fallback (or primary if codec is already AAC): use AAC 48kHz
  const aacArgs = ['-c:a', 'aac', '-ar', '48000'];
  const success = await runNormalization(segmentPath, outputPath, loudnormFilter, aacArgs);

  if (success) {
    return {
      normalizedPath: outputPath,
      skipped: false,
      reason: 'normalized',
      originalLoudness: analysis.integratedLoudness,
      targetLoudness: targetLufs,
    };
  }

  // Both attempts failed
  return {
    normalizedPath: null,
    skipped: true,
    reason: 'error',
    originalLoudness: analysis.integratedLoudness,
    targetLoudness: targetLufs,
  };
}

// ---------------------------------------------------------------------------
// Batch Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize multiple segments, collecting results for each.
 * For each segment: analyze loudness, then normalize if needed.
 *
 * @param segmentPaths - Array of paths to segment files
 * @param outputDir - Directory for normalized output files
 * @param options - Normalization options
 * @returns Array of NormalizationResult for each segment
 */
export async function normalizeSegments(
  segmentPaths: string[],
  outputDir: string,
  options?: NormalizationOptions
): Promise<NormalizationResult[]> {
  fs.mkdirSync(outputDir, { recursive: true });

  const results: NormalizationResult[] = [];

  for (const segmentPath of segmentPaths) {
    const analysis = await analyzeLoudness(segmentPath);

    const baseName = path.basename(segmentPath, path.extname(segmentPath));
    const outputPath = path.join(outputDir, `${baseName}_normalized.mp4`);

    const result = await normalizeSegment(segmentPath, outputPath, analysis, options);
    results.push(result);
  }

  return results;
}
