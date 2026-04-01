import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { getDb } from '../database';

const serverRoot = path.join(__dirname, '..', '..');

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
  const outputDir = path.join(serverRoot, 'uploads', tripId, 'optimized');
  fs.mkdirSync(outputDir, { recursive: true });

  const outputAbsPath = path.join(outputDir, outputFilename);

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

  await pipeline.toFile(outputAbsPath);

  return `uploads/${tripId}/optimized/${outputFilename}`;
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
    const absolutePath = path.resolve(serverRoot, row.file_path);
    try {
      const optimizedPath = await optimizeImage(absolutePath, tripId, row.id, options);
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
