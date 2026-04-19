/**
 * ML-based image quality service.
 * Calls Python quality_service.py for:
 * - DINOv2 embedding extraction (dedup)
 * - MUSIQ IQA scoring (technical quality)
 * - LAION aesthetic scoring (visual appeal)
 * - FAISS duplicate group detection
 */

import { spawn } from 'child_process';
import path from 'path';
import { getPythonPath } from '../helpers/pythonPath';

const PYTHON_SCRIPT = path.resolve(__dirname, '../../python/quality_service.py');

interface QualityResult {
  musiq_score: number | null;
  aesthetic_score: number | null;
  error: string | null;
  path?: string;
}

interface EmbeddingResult {
  path: string;
  embedding: number[] | null;
  error: string | null;
}

/**
 * Run a Python quality_service.py command and return parsed JSON output.
 * 
 * Handles stderr/stdout separation carefully:
 * - Python model loading messages go to stderr (logged but ignored)
 * - Only the last line of stdout is parsed as JSON (avoids progress bar corruption)
 * - stdin is used for large payloads to avoid E2BIG
 */
async function runPythonCommand(args: string[], stdinData?: string): Promise<unknown> {
  const TIMEOUT = 120_000; // 120 seconds max per Python call

  return new Promise((resolve, reject) => {
    const proc = spawn(getPythonPath(), [PYTHON_SCRIPT, ...args], {
      cwd: path.dirname(PYTHON_SCRIPT),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        TRANSFORMERS_NO_ADVISORY_WARNINGS: '1',
        TOKENIZERS_PARALLELISM: 'false',
      },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Kill process if it takes too long
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      reject(new Error(`Python quality_service timed out after ${TIMEOUT / 1000}s`));
    }, TIMEOUT);

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return; // Already rejected by timeout

      if (stderr) {
        console.log(`[mlQuality] stderr: ${stderr.trim().slice(0, 500)}`);
      }
      if (code !== 0) {
        reject(new Error(`Python quality_service exited with code ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      try {
        // Find the last complete JSON line in stdout
        // (pyiqa/transformers may print progress bars to stdout before the JSON)
        const lines = stdout.trim().split('\n');
        let jsonStr = '';
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (line.startsWith('{') || line.startsWith('[')) {
            jsonStr = line;
            break;
          }
        }
        if (!jsonStr) {
          reject(new Error(`No JSON found in Python output: ${stdout.slice(0, 200)}`));
          return;
        }
        resolve(JSON.parse(jsonStr));
      } catch (e) {
        reject(new Error(`Failed to parse Python output: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Python: ${err.message}`));
    });

    if (stdinData) {
      proc.stdin.write(stdinData);
      proc.stdin.end();
    }
  });
}

/**
 * Extract DINOv2 embeddings for a list of image paths.
 * Uses stdin to pass paths (avoids E2BIG for large lists).
 */
export async function extractEmbeddings(imagePaths: string[]): Promise<EmbeddingResult[]> {
  const result = await runPythonCommand(['embeddings', '--stdin'], JSON.stringify(imagePaths));
  return result as EmbeddingResult[];
}

/**
 * Compute MUSIQ + aesthetic quality scores for a single image.
 */
export async function computeMLQuality(imagePath: string): Promise<QualityResult> {
  const result = await runPythonCommand(['quality', imagePath]);
  return result as QualityResult;
}

/**
 * Compute quality scores for multiple images.
 * Uses stdin to pass paths (avoids E2BIG for large lists).
 */
export async function batchMLQuality(imagePaths: string[]): Promise<QualityResult[]> {
  const result = await runPythonCommand(['batch_quality', '--stdin'], JSON.stringify(imagePaths));
  return result as QualityResult[];
}

/**
 * Find duplicate groups from embeddings using FAISS cosine similarity.
 * Uses stdin to pass embeddings (avoids E2BIG for large arrays).
 * @param embeddings Array of embedding vectors (null for failed extractions)
 * @param threshold Cosine similarity threshold (default 0.92)
 * @returns Array of groups, each group is array of original indices
 */
export async function findDuplicateGroups(
  embeddings: (number[] | null)[],
  threshold = 0.92
): Promise<number[][]> {
  const stdinPayload = JSON.stringify({ embeddings, threshold });
  const result = await runPythonCommand(['find_duplicates', '--stdin'], stdinPayload);
  return result as number[][];
}

// Cache ML availability check result
let _mlAvailable: boolean | null = null;

/**
 * Check if the ML quality service is available (Python + dependencies installed).
 * Result is cached after first check.
 */
export async function isMLServiceAvailable(): Promise<boolean> {
  if (_mlAvailable !== null) return _mlAvailable;

  try {
    const proc = spawn(getPythonPath(), ['-c', 'import torch; import pyiqa; import faiss; print("ok")']);
    _mlAvailable = await new Promise<boolean>((resolve) => {
      let out = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      proc.on('close', (code) => { resolve(code === 0 && out.trim() === 'ok'); });
      proc.on('error', () => { resolve(false); });
    });
  } catch {
    _mlAvailable = false;
  }

  console.log(`[mlQuality] ML service available: ${_mlAvailable}`);
  return _mlAvailable;
}

/** Reset cached availability (for testing). */
export function resetMLAvailabilityCache(): void {
  _mlAvailable = null;
}
