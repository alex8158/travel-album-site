import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';

export interface OptimizeOptions {
  maxResolution?: number;
  jpegQuality?: number;
}

export interface OptimizeResult {
  mediaId: string;
  optimizedPath: string | null;
  error?: string;
}

interface MediaItemRow {
  id: string;
  file_path: string;
  original_filename: string;
}

/**
 * Optimize a single image using sharp.
 * Chain: optional resize → normalize → modulate → sharpen → optional jpeg quality → toFile
 * Returns the relative output path string.
 */
export async function optimizeImage(
  imagePath: string,
  tripId: string,
  mediaId: string,
  options?: OptimizeOptions
): Promise<string> {
  const ext = path.extname(imagePath).slice(1) || 'jpg';
  const outputFilename = `${mediaId}_opt.${ext}`;
  const outputRelativePath = `${tripId}/optimized/${outputFilename}`;

  // Process to a temp file, then save via StorageProvider
  const tempPath = path.join(os.tmpdir(), outputFilename);

  try {
    let pipeline = sharp(imagePath);

    if (options?.maxResolution) {
      pipeline = pipeline.resize(options.maxResolution, options.maxResolution, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    pipeline = pipeline
      .normalize()
      .modulate({ brightness: 1.0 })
      .sharpen({ sigma: 1.0 });

    const lowerExt = ext.toLowerCase();
    if (options?.jpegQuality && (lowerExt === 'jpeg' || lowerExt === 'jpg')) {
      pipeline = pipeline.jpeg({ quality: options.jpegQuality });
    }

    await pipeline.toFile(tempPath);

    const storageProvider = getStorageProvider();
    const buffer = fs.readFileSync(tempPath);
    await storageProvider.save(outputRelativePath, buffer);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
  }

  return outputRelativePath;
}

/**
 * Batch optimize all active images for a trip.
 * For each image, calls optimizeImage and updates optimized_path in DB.
 * On failure, records processing_error and continues.
 */
export async function optimizeTrip(
  tripId: string,
  options?: OptimizeOptions
): Promise<OptimizeResult[]> {
  const db = getDb();
  const storageProvider = getStorageProvider();

  const rows = db.prepare(
    "SELECT id, file_path, original_filename FROM media_items WHERE trip_id = ? AND status = 'active' AND media_type = 'image'"
  ).all(tripId) as MediaItemRow[];

  const updateOptimizedStmt = db.prepare(
    'UPDATE media_items SET optimized_path = ? WHERE id = ?'
  );
  const updateErrorStmt = db.prepare(
    'UPDATE media_items SET processing_error = ? WHERE id = ?'
  );

  const results: OptimizeResult[] = [];

  for (const row of rows) {
    try {
      const localPath = await storageProvider.downloadToTemp(row.file_path);
      const optimizedPath = await optimizeImage(localPath, tripId, row.id, options);
      updateOptimizedStmt.run(optimizedPath, row.id);
      results.push({ mediaId: row.id, optimizedPath });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      updateErrorStmt.run(errorMsg, row.id);
      results.push({ mediaId: row.id, optimizedPath: null, error: errorMsg });
    }
  }

  return results;
}
