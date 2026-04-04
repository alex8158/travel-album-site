import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { getTempDir } from '../helpers/tempDir';
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
 * Chain: optional resize → median(3) → gamma/clahe → sharpen(0.7) → withMetadata → optional jpeg quality → toFile
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
  const tempPath = path.join(getTempDir(), outputFilename);

  try {
    let pipeline = sharp(imagePath);

    if (options?.maxResolution) {
      pipeline = pipeline.resize(options.maxResolution, options.maxResolution, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    // Step 1: Light denoising
    pipeline = pipeline.median(3);

    // Step 2: Adaptive brightness/contrast correction
    pipeline = pipeline.gamma().clahe({ width: 3, height: 3 });

    // Step 3: Light sharpening (sigma 0.5-0.8, using 0.7)
    pipeline = pipeline.sharpen({ sigma: 0.7 });

    // Preserve EXIF metadata
    pipeline = pipeline.withMetadata();

    // JPEG quality (if applicable)
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
