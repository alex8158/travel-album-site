import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import { deduplicate } from '../services/dedupEngine';
import { detectBlurry } from '../services/blurDetector';
import { classifyTrip, classifyImage } from '../services/imageClassifier';
import { analyzeTrip } from '../services/imageAnalyzer';
import { optimizeTrip } from '../services/imageOptimizer';
import { generateThumbnailsForTrip } from '../services/thumbnailGenerator';
import { selectCoverImage } from '../services/coverSelector';
import { analyzeVideo } from '../services/videoAnalyzer';
import { editVideo } from '../services/videoEditor';
import { ProgressReporter } from '../services/progressReporter';
import { MediaItemRow } from '../helpers/mediaItemRow';
import { getStorageProvider } from '../storage/factory';
import {
  isPythonAvailable,
  analyzeImages,
  dedupImages,
  PythonAnalyzeResult,
} from '../services/pythonAnalyzer';
import { computeSharpness, classifyBlur } from '../services/blurDetector';

const router = Router();

/**
 * Query category stats for a trip from the database.
 */
function getCategoryStats(tripId: string): { people: number; animal: number; landscape: number; other: number } {
  const db = getDb();
  const rows = db.prepare(
    "SELECT category, COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active' GROUP BY category"
  ).all(tripId) as Array<{ category: string | null; cnt: number }>;

  const stats = { people: 0, animal: 0, landscape: 0, other: 0 };
  for (const row of rows) {
    const cat = row.category as keyof typeof stats;
    if (cat in stats) {
      stats[cat] = row.cnt;
    } else {
      stats.other += row.cnt;
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Python integration helpers
// ---------------------------------------------------------------------------

interface ImageRow {
  id: string;
  file_path: string;
  original_filename: string;
  sharpness_score: number | null;
  width: number | null;
  height: number | null;
  file_size: number;
  status: string;
  trashed_reason: string | null;
}

/**
 * Apply Python analyze results to the database.
 * For images where Python returned error=true, fall back to Node.js algorithms.
 * Returns { blurryCount, classifiedCount }.
 */
async function applyPythonAnalyzeResults(
  tripId: string,
  rows: ImageRow[],
  results: PythonAnalyzeResult[]
): Promise<{ blurryCount: number }> {
  const db = getDb();
  const storageProvider = getStorageProvider();
  let blurryCount = 0;

  const updateBlurStmt = db.prepare(
    'UPDATE media_items SET sharpness_score = ?, blur_status = ? WHERE id = ?'
  );
  const trashBlurStmt = db.prepare(
    "UPDATE media_items SET status = 'trashed', trashed_reason = 'blur', sharpness_score = ?, blur_status = 'blurry' WHERE id = ?"
  );
  const updateCategoryStmt = db.prepare(
    'UPDATE media_items SET category = ? WHERE id = ?'
  );
  const deleteCategoryTagsStmt = db.prepare(
    "DELETE FROM media_tags WHERE media_id = ? AND tag_name LIKE 'category:%'"
  );
  const insertTagStmt = db.prepare(
    'INSERT INTO media_tags (id, media_id, tag_name, created_at) VALUES (?, ?, ?, ?)'
  );
  const appendErrorStmt = db.prepare(
    `UPDATE media_items
     SET processing_error = CASE
       WHEN processing_error IS NULL THEN ?
       ELSE processing_error || char(10) || ?
     END
     WHERE id = ?`
  );

  const s3Bucket = process.env.S3_BUCKET || '';
  const useS3 = process.env.STORAGE_TYPE === 's3' && s3Bucket;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const result = results[i];

    if (result && !result.error) {
      // Python succeeded for this image
      // Apply blur result
      if (result.blurStatus === 'blurry' && result.blurScore !== null) {
        trashBlurStmt.run(result.blurScore, row.id);
        blurryCount++;
      } else {
        updateBlurStmt.run(result.blurScore, result.blurStatus, row.id);
      }
      // Apply classification using categoryScores for rule-based decision
      if (result.categoryScores) {
        const scores = result.categoryScores;
        const ppl = scores.people ?? 0;
        const ani = scores.animal ?? 0;
        const lnd = scores.landscape ?? 0;
        let finalCategory: string;
        if (ppl >= 0.30 && ppl >= ani - 0.03) {
          finalCategory = 'people';
        } else if (ani >= 0.38 && ani - ppl >= 0.05) {
          finalCategory = 'animal';
        } else if (lnd >= 0.35) {
          finalCategory = 'landscape';
        } else {
          finalCategory = result.category || 'other';
        }
        updateCategoryStmt.run(finalCategory, row.id);
        // Sync category tags
        deleteCategoryTagsStmt.run(row.id);
        insertTagStmt.run(uuidv4(), row.id, `category:${finalCategory}`, new Date().toISOString());
      } else if (result.category) {
        updateCategoryStmt.run(result.category, row.id);
        deleteCategoryTagsStmt.run(row.id);
        insertTagStmt.run(uuidv4(), row.id, `category:${result.category}`, new Date().toISOString());
      }
    } else {
      // Python failed for this image — fall back to Node.js
      console.log(`[process] Python failed for ${row.original_filename}, falling back to Node.js`);
      try {
        // Blur detection fallback (Laplacian)
        const localPath = await storageProvider.downloadToTemp(row.file_path);
        const sharpness = await computeSharpness(localPath);
        const blurStatus = classifyBlur(sharpness, 100);
        if (blurStatus === 'blurry') {
          trashBlurStmt.run(sharpness, row.id);
          blurryCount++;
        } else {
          updateBlurStmt.run(sharpness, blurStatus, row.id);
        }
        // Classification fallback (Rekognition)
        try {
          let classResult;
          if (useS3) {
            classResult = await classifyImage(s3Bucket, row.file_path);
          } else {
            const imageBuffer = await storageProvider.read(row.file_path);
            classResult = await classifyImage(imageBuffer);
          }
          updateCategoryStmt.run(classResult.category, row.id);
        } catch (classErr) {
          const msg = classErr instanceof Error ? classErr.message : String(classErr);
          const errText = `[classify-fallback] ${msg}`;
          appendErrorStmt.run(errText, errText, row.id);
          updateCategoryStmt.run('other', row.id);
        }
      } catch (fallbackErr) {
        const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        const errText = `[blur-fallback] ${msg}`;
        appendErrorStmt.run(errText, errText, row.id);
      }
    }
  }

  return { blurryCount };
}

/**
 * Apply Python dedup results to the database.
 * Returns { removedCount }.
 */
function applyPythonDedupResults(
  rows: ImageRow[],
  groups: Array<{ indices: number[]; keep: number; similarities: [number, number, number][] }>
): { removedCount: number } {
  const db = getDb();
  let removedCount = 0;

  for (const group of groups) {
    for (const idx of group.indices) {
      if (idx === group.keep) continue;
      const row = rows[idx];
      if (!row) continue;

      if (row.status === 'trashed') {
        // Already trashed (e.g. by blur) — append duplicate reason
        const newReason = row.trashed_reason
          ? `${row.trashed_reason},duplicate`
          : 'duplicate';
        db.prepare("UPDATE media_items SET trashed_reason = ? WHERE id = ?").run(newReason, row.id);
      } else {
        db.prepare("UPDATE media_items SET status = 'trashed', trashed_reason = 'duplicate' WHERE id = ?").run(row.id);
      }
      removedCount++;
    }
  }

  return { removedCount };
}

// POST /api/trips/:id/process — Trigger full processing pipeline and return summary
router.post('/:id/process', async (req: Request, res: Response) => {
  const tripId = req.params.id as string;
  const db = getDb();

  // Verify trip exists
  const trip = db.prepare('SELECT id FROM trips WHERE id = ?').get(tripId);
  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Parse optional query parameters
  const videoResolution = req.query.videoResolution ? Number(req.query.videoResolution) : undefined;

  let failedCount = 0;

  // Count total images before processing (some will be deleted by blur/dedup)
  const totalImages = (db.prepare(
    "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image'"
  ).get(tripId) as { cnt: number }).cnt;

  const usePython = isPythonAvailable();
  let blurryDeletedCount = 0;
  let dedupDeletedCount = 0;

  if (usePython) {
    // Python path: analyze (blur + classify) then dedup
    const imageRows = db.prepare(
      "SELECT id, file_path, original_filename, sharpness_score, width, height, file_size, status, trashed_reason FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active'"
    ).all(tripId) as ImageRow[];

    if (imageRows.length > 0) {
      const storageProvider = getStorageProvider();
      // Download images to temp for Python processing
      const tempPaths: string[] = [];
      for (const row of imageRows) {
        const localPath = await storageProvider.downloadToTemp(row.file_path);
        tempPaths.push(localPath);
      }

      try {
        // Step 1+5: Python analyze (blur + classify combined)
        const analyzeResults = await analyzeImages(tempPaths);
        const blurResult = await applyPythonAnalyzeResults(tripId, imageRows, analyzeResults);
        blurryDeletedCount = blurResult.blurryCount;

        // Step 2: Python dedup (on active images after blur removal)
        const activeRows = db.prepare(
          "SELECT id, file_path, original_filename, sharpness_score, width, height, file_size, status, trashed_reason FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active'"
        ).all(tripId) as ImageRow[];

        if (activeRows.length > 1) {
          const dedupTempPaths: string[] = [];
          const metadata: Record<number, { blur_score: number; width: number; height: number; file_size: number }> = {};
          for (let i = 0; i < activeRows.length; i++) {
            const localPath = await storageProvider.downloadToTemp(activeRows[i].file_path);
            dedupTempPaths.push(localPath);
            metadata[i] = {
              blur_score: activeRows[i].sharpness_score ?? 0,
              width: activeRows[i].width ?? 0,
              height: activeRows[i].height ?? 0,
              file_size: activeRows[i].file_size ?? 0,
            };
          }
          const dedupResult = await dedupImages(dedupTempPaths, metadata);
          dedupDeletedCount = applyPythonDedupResults(activeRows, dedupResult.groups).removedCount;
          // Clean up dedup temp files
          for (const p of dedupTempPaths) {
            try { require('fs').unlinkSync(p); } catch { /* ignore */ }
          }
        }
      } catch (pythonErr) {
        // Python failed entirely — fall back to Node.js algorithms
        console.log(`[process] Python pipeline failed, falling back: ${pythonErr}`);
        const blurResult = await detectBlurry(tripId);
        blurryDeletedCount = blurResult.blurryCount;
        const dedupResult = await deduplicate(tripId);
        dedupDeletedCount = dedupResult.removedCount;
        await classifyTrip(tripId);
      }

      // Clean up analyze temp files
      for (const p of tempPaths) {
        try { require('fs').unlinkSync(p); } catch { /* ignore */ }
      }
    }
  } else {
    // Node.js fallback path
    const blurResult = await detectBlurry(tripId);
    blurryDeletedCount = blurResult.blurryCount;
    const dedupResult = await deduplicate(tripId);
    dedupDeletedCount = dedupResult.removedCount;
  }

  // Step 3: Analyze — compute image characteristics
  await analyzeTrip(tripId);
  const analyzedCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active' AND avg_brightness IS NOT NULL"
  ).get(tripId) as { cnt: number }).cnt;

  // Step 4: Optimize — adaptive image optimization
  const storageProvider = getStorageProvider();
  const optimizeResults = await optimizeTrip(tripId);
  const optimizedCount = optimizeResults.filter(r => r.optimizedPath !== null).length;
  failedCount += optimizeResults.filter(r => r.error).length;

  // Step 5: Classify — skip if Python already classified, otherwise use Rekognition
  if (!usePython) {
    await classifyTrip(tripId);
  }
  const classifiedCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active' AND category IS NOT NULL"
  ).get(tripId) as { cnt: number }).cnt;

  // Step 6: Thumbnails
  await generateThumbnailsForTrip(tripId);

  // Step 7 & 8: Video analysis and editing
  const videoRows = db.prepare(
    "SELECT * FROM media_items WHERE trip_id = ? AND media_type = 'video' AND status = 'active'"
  ).all(tripId) as MediaItemRow[];
  const totalVideos = videoRows.length;

  // Filter out already-processed videos
  const unprocessedVideos = videoRows.filter(v => !v.compiled_path && !v.thumbnail_path);
  const alreadyProcessedCount = totalVideos - unprocessedVideos.length;

  let compiledCount = alreadyProcessedCount;
  const updateCompiledStmt = db.prepare('UPDATE media_items SET compiled_path = ? WHERE id = ?');
  const updateErrorStmt = db.prepare(
    `UPDATE media_items
     SET processing_error = CASE
       WHEN processing_error IS NULL THEN ?
       ELSE processing_error || char(10) || ?
     END
     WHERE id = ?`
  );

  for (const videoRow of unprocessedVideos) {
    try {
      const videoPath = await storageProvider.downloadToTemp(videoRow.file_path);
      const analysis = await analyzeVideo(videoPath, videoRow.id);
      const editResult = await editVideo(videoPath, analysis, tripId, videoRow.id, { videoResolution });
      if (editResult.compiledPath) {
        updateCompiledStmt.run(editResult.compiledPath, videoRow.id);
        compiledCount++;
      } else if (editResult.error) {
        const errorText = `[videoEdit] ${editResult.error}`;
        updateErrorStmt.run(errorText, errorText, videoRow.id);
        failedCount++;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorText = `[videoEdit] ${errorMsg}`;
      updateErrorStmt.run(errorText, errorText, videoRow.id);
      failedCount++;
    }
  }

  // Step 9: Cover selection
  const coverImageId = await selectCoverImage(tripId);

  // Build category stats
  const categoryStats = getCategoryStats(tripId);

  // Build summary response
  return res.json({
    tripId,
    totalImages,
    totalVideos,
    blurryDeletedCount,
    dedupDeletedCount,
    analyzedCount,
    optimizedCount,
    classifiedCount,
    categoryStats,
    compiledCount,
    failedCount,
    coverImageId,
  });
});

// GET /api/trips/:id/process/stream — SSE streaming processing with progress
router.get('/:id/process/stream', async (req: Request, res: Response) => {
  const tripId = req.params.id as string;
  const db = getDb();

  // Verify trip exists before establishing SSE connection
  const trip = db.prepare('SELECT id FROM trips WHERE id = ?').get(tripId);
  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Parse optional query parameters
  const videoResolution = req.query.videoResolution ? Number(req.query.videoResolution) : undefined;

  // Track client disconnect
  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
  });

  // Create ProgressReporter and initialize SSE
  const reporter = new ProgressReporter(res);
  reporter.initSSE();

  try {
    let failedCount = 0;

    // Count total images before processing
    const totalImages = (db.prepare(
      "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image'"
    ).get(tripId) as { cnt: number }).cnt;

    // Query videos for this trip
    const allVideoRows = db.prepare(
      "SELECT * FROM media_items WHERE trip_id = ? AND media_type = 'video' AND status = 'active'"
    ).all(tripId) as MediaItemRow[];
    const totalVideos = allVideoRows.length;

    // Filter out already-processed videos
    const videoRows = allVideoRows.filter(v => !v.compiled_path && !v.thumbnail_path);
    const alreadyProcessedCount = totalVideos - videoRows.length;

    // Check Python availability once
    const usePython = isPythonAvailable();
    let blurryDeletedCount = 0;
    let dedupDeletedCount = 0;

    // Step 1: Blur detection + Step 2: Dedup (combined when Python available)
    if (usePython) {
      // Python path: analyze (blur + classify) then dedup
      if (clientDisconnected) return;
      reporter.sendStepStart('blurDetect', { processed: 0, total: totalImages });

      const imageRows = db.prepare(
        "SELECT id, file_path, original_filename, sharpness_score, width, height, file_size, status, trashed_reason FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active'"
      ).all(tripId) as ImageRow[];

      if (imageRows.length > 0) {
        const storageProvider = getStorageProvider();
        const tempPaths: string[] = [];
        for (const row of imageRows) {
          const localPath = await storageProvider.downloadToTemp(row.file_path);
          tempPaths.push(localPath);
        }

        try {
          // Python analyze: blur + classify in one call
          const analyzeResults = await analyzeImages(tempPaths);
          const blurResult = await applyPythonAnalyzeResults(tripId, imageRows, analyzeResults);
          blurryDeletedCount = blurResult.blurryCount;

          if (clientDisconnected) return;
          reporter.sendStepComplete('blurDetect', { processed: totalImages, total: totalImages });

          // Step 2: Python dedup
          if (clientDisconnected) return;
          const activeImageCount = (db.prepare(
            "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active'"
          ).get(tripId) as { cnt: number }).cnt;
          reporter.sendStepStart('dedup', { processed: 0, total: activeImageCount });

          if (activeImageCount > 1) {
            const activeRows = db.prepare(
              "SELECT id, file_path, original_filename, sharpness_score, width, height, file_size, status, trashed_reason FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active'"
            ).all(tripId) as ImageRow[];

            const dedupTempPaths: string[] = [];
            const metadata: Record<number, { blur_score: number; width: number; height: number; file_size: number }> = {};
            for (let i = 0; i < activeRows.length; i++) {
              const localPath = await storageProvider.downloadToTemp(activeRows[i].file_path);
              dedupTempPaths.push(localPath);
              metadata[i] = {
                blur_score: activeRows[i].sharpness_score ?? 0,
                width: activeRows[i].width ?? 0,
                height: activeRows[i].height ?? 0,
                file_size: activeRows[i].file_size ?? 0,
              };
            }
            const dedupResult = await dedupImages(dedupTempPaths, metadata);
            dedupDeletedCount = applyPythonDedupResults(activeRows, dedupResult.groups).removedCount;
            for (const p of dedupTempPaths) {
              try { require('fs').unlinkSync(p); } catch { /* ignore */ }
            }
          }

          if (clientDisconnected) return;
          reporter.sendStepComplete('dedup', { processed: activeImageCount, total: activeImageCount });
        } catch (pythonErr) {
          // Python failed — fall back to Node.js for both blur and dedup
          console.log(`[process] Python pipeline failed, falling back: ${pythonErr}`);
          const blurResult = await detectBlurry(tripId);
          blurryDeletedCount = blurResult.blurryCount;
          if (clientDisconnected) return;
          reporter.sendStepComplete('blurDetect', { processed: totalImages, total: totalImages });

          const activeImageCount = (db.prepare(
            "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active'"
          ).get(tripId) as { cnt: number }).cnt;
          reporter.sendStepStart('dedup', { processed: 0, total: activeImageCount });
          const dedupResult = await deduplicate(tripId);
          dedupDeletedCount = dedupResult.removedCount;
          if (clientDisconnected) return;
          reporter.sendStepComplete('dedup', { processed: activeImageCount, total: activeImageCount });

          // Also need to classify via Rekognition since Python failed
          await classifyTrip(tripId);
        }

        // Clean up analyze temp files
        for (const p of tempPaths) {
          try { require('fs').unlinkSync(p); } catch { /* ignore */ }
        }
      } else {
        reporter.sendStepComplete('blurDetect', { processed: 0, total: 0 });
        reporter.sendStepStart('dedup', { processed: 0, total: 0 });
        reporter.sendStepComplete('dedup', { processed: 0, total: 0 });
      }
    } else {
      // Node.js fallback path
      if (clientDisconnected) return;
      reporter.sendStepStart('blurDetect', { processed: 0, total: totalImages });
      const blurResult = await detectBlurry(tripId);
      blurryDeletedCount = blurResult.blurryCount;
      if (clientDisconnected) return;
      reporter.sendStepComplete('blurDetect', { processed: totalImages, total: totalImages });

      if (clientDisconnected) return;
      const activeImageCount = (db.prepare(
        "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active'"
      ).get(tripId) as { cnt: number }).cnt;
      reporter.sendStepStart('dedup', { processed: 0, total: activeImageCount });
      const dedupResult = await deduplicate(tripId);
      dedupDeletedCount = dedupResult.removedCount;
      if (clientDisconnected) return;
      reporter.sendStepComplete('dedup', { processed: activeImageCount, total: activeImageCount });
    }

    // Step 3: Analyze
    if (clientDisconnected) return;
    const postDedupCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active'"
    ).get(tripId) as { cnt: number }).cnt;
    reporter.sendStepStart('analyze', { processed: 0, total: postDedupCount });
    await analyzeTrip(tripId);
    const analyzedCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active' AND avg_brightness IS NOT NULL"
    ).get(tripId) as { cnt: number }).cnt;
    if (clientDisconnected) return;
    reporter.sendStepComplete('analyze', { processed: postDedupCount, total: postDedupCount });

    // Step 4: Optimize
    if (clientDisconnected) return;
    const storageProvider = getStorageProvider();
    reporter.sendStepStart('optimize', { processed: 0, total: postDedupCount });
    const optimizeResults = await optimizeTrip(tripId);
    const optimizedCount = optimizeResults.filter(r => r.optimizedPath !== null).length;
    failedCount += optimizeResults.filter(r => r.error).length;
    if (clientDisconnected) return;
    reporter.sendStepComplete('optimize', { processed: postDedupCount, total: postDedupCount });

    // Step 5: Classify — skip if Python already classified, otherwise use Rekognition
    if (clientDisconnected) return;
    reporter.sendStepStart('classify', { processed: 0, total: postDedupCount });
    if (!usePython) {
      await classifyTrip(tripId);
    }
    const classifiedCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active' AND category IS NOT NULL"
    ).get(tripId) as { cnt: number }).cnt;
    if (clientDisconnected) return;
    reporter.sendStepComplete('classify', { processed: postDedupCount, total: postDedupCount });

    // Step 6: Thumbnail
    if (clientDisconnected) return;
    const totalItemsForThumb = postDedupCount + totalVideos;
    reporter.sendStepStart('thumbnail', { processed: 0, total: totalItemsForThumb });
    await generateThumbnailsForTrip(tripId);
    if (clientDisconnected) return;
    reporter.sendStepComplete('thumbnail', { processed: totalItemsForThumb, total: totalItemsForThumb });

    // Step 7: Video analysis
    if (clientDisconnected) return;
    reporter.sendStepStart('videoAnalysis', { processed: 0, total: videoRows.length });
    const analysisResults: Map<string, Awaited<ReturnType<typeof analyzeVideo>>> = new Map();
    const updateErrorStmt = db.prepare(
      `UPDATE media_items
       SET processing_error = CASE
         WHEN processing_error IS NULL THEN ?
         ELSE processing_error || char(10) || ?
       END
       WHERE id = ?`
    );

    for (const videoRow of videoRows) {
      if (clientDisconnected) return;
      try {
        const videoPath = await storageProvider.downloadToTemp(videoRow.file_path);
        const analysis = await analyzeVideo(videoPath, videoRow.id);
        analysisResults.set(videoRow.id, analysis);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errorText = `[videoAnalysis] ${errorMsg}`;
        updateErrorStmt.run(errorText, errorText, videoRow.id);
        failedCount++;
      }
    }
    if (clientDisconnected) return;
    reporter.sendStepComplete('videoAnalysis', { processed: videoRows.length, total: videoRows.length });

    // Step 8: Video editing
    if (clientDisconnected) return;
    reporter.sendStepStart('videoEdit', { processed: 0, total: analysisResults.size });
    let compiledCount = alreadyProcessedCount;
    const updateCompiledStmt = db.prepare('UPDATE media_items SET compiled_path = ? WHERE id = ?');

    for (const videoRow of videoRows) {
      if (clientDisconnected) return;
      const analysis = analysisResults.get(videoRow.id);
      if (!analysis) continue;

      try {
        const videoPath = await storageProvider.downloadToTemp(videoRow.file_path);
        const editResult = await editVideo(videoPath, analysis, tripId, videoRow.id, { videoResolution });
        if (editResult.compiledPath) {
          updateCompiledStmt.run(editResult.compiledPath, videoRow.id);
          compiledCount++;
        } else if (editResult.error) {
          const errorText = `[videoEdit] ${editResult.error}`;
          updateErrorStmt.run(errorText, errorText, videoRow.id);
          failedCount++;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errorText = `[videoEdit] ${errorMsg}`;
        updateErrorStmt.run(errorText, errorText, videoRow.id);
        failedCount++;
      }
    }
    if (clientDisconnected) return;
    reporter.sendStepComplete('videoEdit', { processed: analysisResults.size, total: analysisResults.size });

    // Step 9: Cover
    if (clientDisconnected) return;
    reporter.sendStepStart('cover', { processed: 0, total: 1 });
    const coverImageId = await selectCoverImage(tripId);
    if (clientDisconnected) return;
    reporter.sendStepComplete('cover', { processed: 1, total: 1 });

    // Build category stats
    const categoryStats = getCategoryStats(tripId);

    // All steps complete
    reporter.sendComplete({
      tripId,
      totalImages,
      totalVideos,
      blurryDeletedCount,
      dedupDeletedCount,
      analyzedCount,
      optimizedCount,
      classifiedCount,
      categoryStats,
      compiledCount,
      failedCount,
      coverImageId,
    });
  } catch (err: unknown) {
    if (clientDisconnected) return;
    const message = err instanceof Error ? err.message : String(err);
    reporter.sendError({ message });
  }
});

export default router;
