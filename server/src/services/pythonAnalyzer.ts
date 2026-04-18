import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { getPythonPath } from '../helpers/pythonPath';
import {
  CLIP_CONFIRMED_THRESHOLD,
  CLIP_GRAY_HIGH_THRESHOLD,
  CLIP_GRAY_LOW_THRESHOLD,
  CLIP_TOP_K,
  GRAY_LOW_SEQ_DISTANCE,
  GRAY_LOW_HASH_DISTANCE,
} from './dedupThresholds';
import { DEFAULT_BLUR_THRESHOLD, DEFAULT_CLEAR_THRESHOLD } from './blurDetector';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImageCategory = 'people' | 'animal' | 'landscape' | 'other';

export interface PythonAnalyzeResult {
  file: string;
  error: boolean;
  errorMessage?: string;
  category: ImageCategory | null;
  categoryScores: Record<string, number> | null;
  blurStatus: 'clear' | 'suspect' | 'blurry' | 'unknown';
  blurScore: number | null;
}

export interface PythonDedupGroup {
  indices: number[];
  keep: number;
  similarities: [number, number, number][];
}

export interface PythonDedupResult {
  groups: PythonDedupGroup[];
}

export interface ClipCandidatePair {
  /** 图片索引 A */
  i: number;
  /** 图片索引 B */
  j: number;
  /** CLIP 余弦相似度 */
  similarity: number;
}

export interface ClipNeighborResult {
  confirmedPairs: ClipCandidatePair[];
  grayZonePairs: ClipCandidatePair[];
  embeddingTimeMs: number;
  totalTimeMs: number;
}

// ---------------------------------------------------------------------------
// Mutex — single Python process at a time (t3.medium: 2 core, 4GB)
// ---------------------------------------------------------------------------

class PythonMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const mutex = new PythonMutex();

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PYTHON_DIR = path.resolve(__dirname, '../../python');
const ANALYZE_SCRIPT = path.join(PYTHON_DIR, 'analyze.py');
const MODEL_CONFIG_PATH = path.join(PYTHON_DIR, 'model_config.json');

/** Resolve the actual model directory from model_config.json's onnx_dir field */
function getDefaultModelDir(): string {
  try {
    const config = JSON.parse(fs.readFileSync(MODEL_CONFIG_PATH, 'utf-8'));
    if (config.onnx_dir) {
      return path.resolve(PYTHON_DIR, config.onnx_dir);
    }
  } catch { /* fall through */ }
  return path.join(PYTHON_DIR, 'models');
}

// ---------------------------------------------------------------------------
// isPythonAvailable — cached at process startup, exit code 2 = permanent false
// ---------------------------------------------------------------------------

let pythonAvailableCache: boolean | null = null;

/**
 * Check if Python environment is available and model files exist with valid checksums.
 * Result is cached at process startup. Exit code 2 from Python sets cache to false permanently.
 */
export function isPythonAvailable(): boolean {
  if (pythonAvailableCache !== null) return pythonAvailableCache;

  try {
    // 1. Check python3 exists and is 3.9+
    const { execSync } = require('child_process');
    const versionOutput = execSync(`${getPythonPath()} --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
    const match = versionOutput.match(/Python (\d+)\.(\d+)/);
    if (!match || parseInt(match[1]) < 3 || (parseInt(match[1]) === 3 && parseInt(match[2]) < 9)) {
      console.log(`[pythonAnalyzer] Python version too old: ${versionOutput}`);
      pythonAvailableCache = false;
      return false;
    }

    // 2. Check analyze.py exists
    if (!fs.existsSync(ANALYZE_SCRIPT)) {
      console.log('[pythonAnalyzer] analyze.py not found');
      pythonAvailableCache = false;
      return false;
    }

    // 3. Check model directory and config
    if (!fs.existsSync(MODEL_CONFIG_PATH)) {
      console.log('[pythonAnalyzer] model_config.json not found');
      pythonAvailableCache = false;
      return false;
    }

    const config = JSON.parse(fs.readFileSync(MODEL_CONFIG_PATH, 'utf-8'));
    const modelDir = path.resolve(PYTHON_DIR, config.onnx_dir);

    if (!fs.existsSync(modelDir)) {
      console.log(`[pythonAnalyzer] Model directory not found: ${modelDir}`);
      pythonAvailableCache = false;
      return false;
    }

    // 4. Verify checksums for key files
    const checksums = config.checksums || {};
    for (const [filename, expectedHash] of Object.entries(checksums)) {
      const filePath = path.join(modelDir, filename);
      if (!fs.existsSync(filePath)) {
        console.log(`[pythonAnalyzer] Model file missing: ${filePath}`);
        pythonAvailableCache = false;
        return false;
      }
      // Only verify .onnx files (large files — skip others for speed)
      if (filename.endsWith('.onnx')) {
        const hash = computeFileHash(filePath);
        if (hash !== expectedHash) {
          console.log(`[pythonAnalyzer] Checksum mismatch for ${filename}`);
          pythonAvailableCache = false;
          return false;
        }
      }
    }

    console.log('[pythonAnalyzer] Python environment available');
    pythonAvailableCache = true;
    return true;
  } catch (err) {
    console.log(`[pythonAnalyzer] Python check failed: ${err}`);
    pythonAvailableCache = false;
    return false;
  }
}

function computeFileHash(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Mark Python as permanently unavailable (called on exit code 2).
 */
function markPythonUnavailable(): void {
  pythonAvailableCache = false;
  console.log('[pythonAnalyzer] Python marked as permanently unavailable (exit code 2)');
}

// ---------------------------------------------------------------------------
// analyzeImages — CLIP classification + blur detection
// ---------------------------------------------------------------------------

const ANALYZE_BATCH_SIZE = 200;
const DEDUP_MAX_IMAGES = 1000; // Skip Python dedup for trips larger than this
const EXEC_TIMEOUT = 300_000; // 300s
const EXEC_MAX_BUFFER = 50 * 1024 * 1024; // 50MB

/**
 * Run Python CLIP analysis on a list of image paths.
 * Automatically batches when > 200 images (no overlap needed for analyze).
 * Throws on total failure; individual image errors are marked in results.
 */
export async function analyzeImages(
  imagePaths: string[],
  options?: { blurThreshold?: number; clearThreshold?: number; modelDir?: string }
): Promise<PythonAnalyzeResult[]> {
  const modelDir = options?.modelDir ?? getDefaultModelDir();
  const blurThreshold = options?.blurThreshold ?? DEFAULT_BLUR_THRESHOLD;
  const clearThreshold = options?.clearThreshold ?? DEFAULT_CLEAR_THRESHOLD;

  if (imagePaths.length <= ANALYZE_BATCH_SIZE) {
    return runAnalyzeBatch(imagePaths, modelDir, blurThreshold, clearThreshold);
  }

  // Split into batches of ANALYZE_BATCH_SIZE, no overlap
  const allResults: PythonAnalyzeResult[] = [];
  for (let i = 0; i < imagePaths.length; i += ANALYZE_BATCH_SIZE) {
    const batch = imagePaths.slice(i, i + ANALYZE_BATCH_SIZE);
    const batchResults = await runAnalyzeBatch(batch, modelDir, blurThreshold, clearThreshold);
    allResults.push(...batchResults);
  }
  return allResults;
}

async function runAnalyzeBatch(
  imagePaths: string[],
  modelDir: string,
  blurThreshold: number,
  clearThreshold: number
): Promise<PythonAnalyzeResult[]> {
  await mutex.acquire();
  const imagesFile = path.join(os.tmpdir(), `analyze-images-${Date.now()}.txt`);
  try {
    // Write image paths to temp file to avoid E2BIG
    fs.writeFileSync(imagesFile, imagePaths.join('\n'));

    const args = [
      ANALYZE_SCRIPT,
      'analyze',
      '--images-file', imagesFile,
      '--model-dir', modelDir,
      '--blur-threshold', String(blurThreshold),
      '--clear-threshold', String(clearThreshold),
    ];

    const { stdout, stderr } = await execFileAsync(getPythonPath(), args, {
      timeout: EXEC_TIMEOUT,
      maxBuffer: EXEC_MAX_BUFFER,
    });

    if (stderr) {
      console.log(`[pythonAnalyzer] analyze stderr: ${stderr.slice(0, 500)}`);
    }

    const output = JSON.parse(stdout);
    return (output.results as any[]).map(mapAnalyzeResult);
  } catch (err: any) {
    if (err.code === 2 || (err.killed === false && err.code === 2)) {
      markPythonUnavailable();
    }
    throw new Error(`Python analyze failed: ${err.message || err}`);
  } finally {
    try { fs.unlinkSync(imagesFile); } catch { /* ignore */ }
    mutex.release();
  }
}

function mapAnalyzeResult(raw: any): PythonAnalyzeResult {
  return {
    file: raw.file,
    error: raw.error ?? false,
    errorMessage: raw.error_message,
    category: raw.category as ImageCategory | null,
    categoryScores: raw.category_scores,
    blurStatus: raw.blur_status ?? 'unknown',
    blurScore: raw.blur_score ?? null,
  };
}

// ---------------------------------------------------------------------------
// dedupImages — CLIP embedding-based deduplication
// ---------------------------------------------------------------------------

/**
 * Run Python CLIP dedup on a list of image paths.
 * Does NOT batch — processes entire trip at once (Python handles >500 via top-k).
 * Throws on failure (caller should fall back to pHash).
 * @deprecated Use `clipNeighborSearch()` instead.
 */
export async function dedupImages(
  imagePaths: string[],
  metadata: Record<number, { blur_score: number; width: number; height: number; file_size: number }>,
  options?: { threshold?: number; modelDir?: string }
): Promise<PythonDedupResult> {
  // Hard limit: skip Python dedup for very large trips to avoid OOM/timeout
  if (imagePaths.length > DEDUP_MAX_IMAGES) {
    console.log(`[pythonAnalyzer] Trip has ${imagePaths.length} images, exceeds dedup limit ${DEDUP_MAX_IMAGES}, skipping Python dedup`);
    throw new Error(`Too many images for Python dedup (${imagePaths.length} > ${DEDUP_MAX_IMAGES})`);
  }

  const modelDir = options?.modelDir ?? getDefaultModelDir();
  const threshold = options?.threshold ?? 0.955;

  await mutex.acquire();
  const imagesFile = path.join(os.tmpdir(), `dedup-images-${Date.now()}.txt`);
  try {
    fs.writeFileSync(imagesFile, imagePaths.join('\n'));
    const metadataStr = JSON.stringify(metadata);
    const args = [
      ANALYZE_SCRIPT,
      'dedup',
      '--images-file', imagesFile,
      '--model-dir', modelDir,
      '--threshold', String(threshold),
      '--metadata', metadataStr,
    ];

    const { stdout, stderr } = await execFileAsync(getPythonPath(), args, {
      timeout: EXEC_TIMEOUT,
      maxBuffer: EXEC_MAX_BUFFER,
    });

    if (stderr) {
      console.log(`[pythonAnalyzer] dedup stderr: ${stderr.slice(0, 500)}`);
    }

    const output = JSON.parse(stdout);
    return {
      groups: (output.groups as any[]).map(g => ({
        indices: g.indices,
        keep: g.keep,
        similarities: g.similarities,
      })),
    };
  } catch (err: any) {
    if (err.code === 2 || (err.killed === false && err.code === 2)) {
      markPythonUnavailable();
    }
    throw new Error(`Python dedup failed: ${err.message || err}`);
  } finally {
    try { fs.unlinkSync(imagesFile); } catch { /* ignore */ }
    mutex.release();
  }
}


// ---------------------------------------------------------------------------
// clipNeighborSearch — CLIP top-k neighbor search with three-tier classification
// ---------------------------------------------------------------------------

/**
 * Call Python analyze.py clip-neighbors subcommand.
 * Passes all threshold constants from dedupThresholds.ts as CLI arguments.
 *
 * @param imagePaths - List of image file paths
 * @param hashData - Per-image pHash, dHash and sequence index data
 * @param options - Optional model directory and top-k override
 */
export async function clipNeighborSearch(
  imagePaths: string[],
  hashData: Record<number, { pHash: string | null; dHash: string | null; seqIndex: number }>,
  options?: { modelDir?: string; topK?: number }
): Promise<ClipNeighborResult> {
  const modelDir = options?.modelDir ?? getDefaultModelDir();
  const topK = options?.topK ?? CLIP_TOP_K;

  await mutex.acquire();
  const imagesFile = path.join(os.tmpdir(), `clip-images-${Date.now()}.txt`);
  try {
    fs.writeFileSync(imagesFile, imagePaths.join('\n'));
    const hashDataStr = JSON.stringify(hashData);
    const args = [
      ANALYZE_SCRIPT,
      'clip-neighbors',
      '--images-file', imagesFile,
      '--model-dir', modelDir,
      '--top-k', String(topK),
      '--confirmed-threshold', String(CLIP_CONFIRMED_THRESHOLD),
      '--gray-high-threshold', String(CLIP_GRAY_HIGH_THRESHOLD),
      '--gray-low-threshold', String(CLIP_GRAY_LOW_THRESHOLD),
      '--gray-low-seq-distance', String(GRAY_LOW_SEQ_DISTANCE),
      '--gray-low-hash-distance', String(GRAY_LOW_HASH_DISTANCE),
      '--hash-data', hashDataStr,
    ];

    const { stdout, stderr } = await execFileAsync(getPythonPath(), args, {
      timeout: EXEC_TIMEOUT,
      maxBuffer: EXEC_MAX_BUFFER,
    });

    if (stderr) {
      console.log(`[pythonAnalyzer] clip-neighbors stderr: ${stderr.slice(0, 500)}`);
    }

    const output = JSON.parse(stdout);
    return {
      confirmedPairs: (output.confirmed_pairs as any[]).map(p => ({
        i: p.i,
        j: p.j,
        similarity: p.similarity,
      })),
      grayZonePairs: (output.gray_zone_pairs as any[]).map(p => ({
        i: p.i,
        j: p.j,
        similarity: p.similarity,
      })),
      embeddingTimeMs: output.embedding_time_ms,
      totalTimeMs: output.total_time_ms,
    };
  } catch (err: any) {
    if (err.code === 2 || (err.killed === false && err.code === 2)) {
      markPythonUnavailable();
    }
    throw new Error(`Python clip-neighbors failed: ${err.message || err}`);
  } finally {
    try { fs.unlinkSync(imagesFile); } catch { /* ignore */ }
    mutex.release();
  }
}
