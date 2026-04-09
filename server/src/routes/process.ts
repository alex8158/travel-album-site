import { Router, Request, Response } from 'express';
import fs from 'fs';
import { getDb } from '../database';
import { deduplicate } from '../services/dedupEngine';
import { createAIClient, analyzeImageWithBedrock } from '../services/bedrockClient';
import { applyBlurResult } from '../services/blurDetector';
import { applyClassifyResult } from '../services/imageClassifier';
import { analyzeTrip } from '../services/imageAnalyzer';
import { optimizeTrip } from '../services/imageOptimizer';
import { generateThumbnailsForTrip } from '../services/thumbnailGenerator';
import { selectCoverImage } from '../services/coverSelector';
import { analyzeVideo } from '../services/videoAnalyzer';
import { editVideo } from '../services/videoEditor';
import { ProgressReporter } from '../services/progressReporter';
import { MediaItemRow } from '../helpers/mediaItemRow';
import { getStorageProvider } from '../storage/factory';

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
  const blurThreshold = req.query.blurThreshold ? Number(req.query.blurThreshold) : undefined;
  const windowSize = req.query.windowSize ? Number(req.query.windowSize) : undefined;
  const hammingThreshold = req.query.hammingThreshold ? Number(req.query.hammingThreshold) : undefined;
  const videoResolution = req.query.videoResolution ? Number(req.query.videoResolution) : undefined;

  let failedCount = 0;

  // Count total images before processing (some will be deleted by blur/dedup)
  const totalImages = (db.prepare(
    "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image'"
  ).get(tripId) as { cnt: number }).cnt;

  // Step 1: Single-image analysis (blur + classify combined via Bedrock)
  const bedrockClient = createAIClient();
  const storageProvider = getStorageProvider();
  let blurryDeletedCount = 0;

  const activeImages = db.prepare(
    "SELECT id, file_path FROM media_items WHERE trip_id = ? AND status = 'active' AND media_type = 'image'"
  ).all(tripId) as Array<{ id: string; file_path: string }>;

  for (const img of activeImages) {
    try {
      const localPath = await storageProvider.downloadToTemp(img.file_path);
      const analysis = await analyzeImageWithBedrock(localPath, bedrockClient);
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }
      applyBlurResult(img.id, analysis.blur_status);
      applyClassifyResult(img.id, analysis.category);
      if (analysis.blur_status === 'blurry') blurryDeletedCount++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorText = `[bedrockAnalysis] ${errorMsg}`;
      db.prepare(
        `UPDATE media_items SET processing_error = CASE WHEN processing_error IS NULL THEN ? ELSE processing_error || char(10) || ? END WHERE id = ?`
      ).run(errorText, errorText, img.id);
    }
  }

  const classifiedCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active' AND category IS NOT NULL"
  ).get(tripId) as { cnt: number }).cnt;

  // Step 2: Dedup via Bedrock
  const dedupResult = await deduplicate(tripId, { bedrockClient });
  const dedupDeletedCount = dedupResult.removedCount;

  // Step 3: Analyze — compute image characteristics
  await analyzeTrip(tripId);
  const analyzedCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active' AND avg_brightness IS NOT NULL"
  ).get(tripId) as { cnt: number }).cnt;

  // Step 4: Optimize — adaptive image optimization
  const optimizeResults = await optimizeTrip(tripId);
  const optimizedCount = optimizeResults.filter(r => r.optimizedPath !== null).length;
  failedCount += optimizeResults.filter(r => r.error).length;

  // Step 5: Thumbnails — generate for all active images/videos
  // Skip thumbnail generation for optimize-failed images
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
  const blurThreshold = req.query.blurThreshold ? Number(req.query.blurThreshold) : undefined;
  const windowSize = req.query.windowSize ? Number(req.query.windowSize) : undefined;
  const hammingThreshold = req.query.hammingThreshold ? Number(req.query.hammingThreshold) : undefined;
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

    // Step 1: Single-image analysis (blur + classify via Bedrock)
    if (clientDisconnected) return;
    const bedrockClient = createAIClient();
    const storageProvider = getStorageProvider();
    let blurryDeletedCount = 0;

    const activeImages = db.prepare(
      "SELECT id, file_path FROM media_items WHERE trip_id = ? AND status = 'active' AND media_type = 'image'"
    ).all(tripId) as Array<{ id: string; file_path: string }>;

    reporter.sendStepStart('blurDetect', { processed: 0, total: activeImages.length });

    for (let i = 0; i < activeImages.length; i++) {
      if (clientDisconnected) return;
      const img = activeImages[i];
      try {
        const localPath = await storageProvider.downloadToTemp(img.file_path);
        const analysis = await analyzeImageWithBedrock(localPath, bedrockClient);
        try { fs.unlinkSync(localPath); } catch { /* ignore */ }
        applyBlurResult(img.id, analysis.blur_status);
        applyClassifyResult(img.id, analysis.category);
        if (analysis.blur_status === 'blurry') blurryDeletedCount++;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errorText = `[bedrockAnalysis] ${errorMsg}`;
        db.prepare(
          `UPDATE media_items SET processing_error = CASE WHEN processing_error IS NULL THEN ? ELSE processing_error || char(10) || ? END WHERE id = ?`
        ).run(errorText, errorText, img.id);
      }
    }
    if (clientDisconnected) return;
    reporter.sendStepComplete('blurDetect', { processed: activeImages.length, total: activeImages.length });

    const classifiedCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active' AND category IS NOT NULL"
    ).get(tripId) as { cnt: number }).cnt;

    // Step 2: Dedup via Bedrock
    if (clientDisconnected) return;
    const postBlurActiveCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active'"
    ).get(tripId) as { cnt: number }).cnt;
    reporter.sendStepStart('dedup', { processed: 0, total: postBlurActiveCount });
    const dedupResult = await deduplicate(tripId, { bedrockClient });
    const dedupDeletedCount = dedupResult.removedCount;
    if (clientDisconnected) return;
    reporter.sendStepComplete('dedup', { processed: postBlurActiveCount, total: postBlurActiveCount });

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
    reporter.sendStepStart('optimize', { processed: 0, total: postDedupCount });
    const optimizeResults = await optimizeTrip(tripId);
    const optimizedCount = optimizeResults.filter(r => r.optimizedPath !== null).length;
    failedCount += optimizeResults.filter(r => r.error).length;
    if (clientDisconnected) return;
    reporter.sendStepComplete('optimize', { processed: postDedupCount, total: postDedupCount });

    // Step 5: Thumbnail
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
