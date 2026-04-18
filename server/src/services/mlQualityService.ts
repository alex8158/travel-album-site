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
 */
async function runPythonCommand(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn(getPythonPath(), [PYTHON_SCRIPT, ...args], {
      cwd: path.dirname(PYTHON_SCRIPT),
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (stderr) {
        console.log(`[mlQuality] stderr: ${stderr.trim()}`);
      }
      if (code !== 0) {
        reject(new Error(`Python quality_service exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Failed to parse Python output: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Python: ${err.message}`));
    });
  });
}

/**
 * Extract DINOv2 embeddings for a list of image paths.
 */
export async function extractEmbeddings(imagePaths: string[]): Promise<EmbeddingResult[]> {
  const result = await runPythonCommand(['embeddings', JSON.stringify(imagePaths)]);
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
 */
export async function batchMLQuality(imagePaths: string[]): Promise<QualityResult[]> {
  const result = await runPythonCommand(['batch_quality', JSON.stringify(imagePaths)]);
  return result as QualityResult[];
}

/**
 * Find duplicate groups from embeddings using FAISS cosine similarity.
 * @param embeddings Array of embedding vectors (null for failed extractions)
 * @param threshold Cosine similarity threshold (default 0.92)
 * @returns Array of groups, each group is array of original indices
 */
export async function findDuplicateGroups(
  embeddings: (number[] | null)[],
  threshold = 0.92
): Promise<number[][]> {
  const result = await runPythonCommand([
    'find_duplicates',
    JSON.stringify(embeddings),
    String(threshold),
  ]);
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
