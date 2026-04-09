import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

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
  blurStatus: 'clear' | 'blurry' | 'unknown';
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
    const versionOutput = execSync('python3 --version', { encoding: 'utf-8', timeout: 5000 }).trim();
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
const EXEC_TIMEOUT = 300_000; // 300s
const EXEC_MAX_BUFFER = 50 * 1024 * 1024; // 50MB

/**
 * Run Python CLIP analysis on a list of image paths.
 * Automatically batches when > 200 images (no overlap needed for analyze).
 * Throws on total failure; individual image errors are marked in results.
 */
export async function analyzeImages(
  imagePaths: string[],
  options?: { blurThreshold?: number; modelDir?: string }
): Promise<PythonAnalyzeResult[]> {
  const modelDir = options?.modelDir ?? getDefaultModelDir();
  const blurThreshold = options?.blurThreshold ?? 100;

  if (imagePaths.length <= ANALYZE_BATCH_SIZE) {
    return runAnalyzeBatch(imagePaths, modelDir, blurThreshold);
  }

  // Split into batches of ANALYZE_BATCH_SIZE, no overlap
  const allResults: PythonAnalyzeResult[] = [];
  for (let i = 0; i < imagePaths.length; i += ANALYZE_BATCH_SIZE) {
    const batch = imagePaths.slice(i, i + ANALYZE_BATCH_SIZE);
    const batchResults = await runAnalyzeBatch(batch, modelDir, blurThreshold);
    allResults.push(...batchResults);
  }
  return allResults;
}

async function runAnalyzeBatch(
  imagePaths: string[],
  modelDir: string,
  blurThreshold: number
): Promise<PythonAnalyzeResult[]> {
  await mutex.acquire();
  try {
    const args = [
      ANALYZE_SCRIPT,
      'analyze',
      '--images', ...imagePaths,
      '--model-dir', modelDir,
      '--blur-threshold', String(blurThreshold),
    ];

    const { stdout, stderr } = await execFileAsync('python3', args, {
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
 */
export async function dedupImages(
  imagePaths: string[],
  metadata: Record<number, { blur_score: number; width: number; height: number; file_size: number }>,
  options?: { threshold?: number; modelDir?: string }
): Promise<PythonDedupResult> {
  const modelDir = options?.modelDir ?? getDefaultModelDir();
  const threshold = options?.threshold ?? 0.9;

  await mutex.acquire();
  try {
    const metadataStr = JSON.stringify(metadata);
    const args = [
      ANALYZE_SCRIPT,
      'dedup',
      '--images', ...imagePaths,
      '--model-dir', modelDir,
      '--threshold', String(threshold),
      '--metadata', metadataStr,
    ];

    const { stdout, stderr } = await execFileAsync('python3', args, {
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
    mutex.release();
  }
}
