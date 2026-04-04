import { Router, Request, Response } from 'express';
import { getDb } from '../database';
import { deduplicate } from '../services/dedupEngine';
import { processTrip, getTrashedDuplicateCount } from '../services/qualitySelector';
import { generateThumbnailsForTrip } from '../services/thumbnailGenerator';
import { selectCoverImage } from '../services/coverSelector';
import { detectBlurry } from '../services/blurDetector';
import { optimizeTrip } from '../services/imageOptimizer';
import { analyzeVideo } from '../services/videoAnalyzer';
import { editVideo } from '../services/videoEditor';
import { ProgressReporter } from '../services/progressReporter';
import type { MediaItem } from '../types';
import { MediaItemRow, rowToMediaItem as baseRowToMediaItem } from '../helpers/mediaItemRow';
import { getStorageProvider } from '../storage/factory';

const router = Router();

function rowToMediaItem(row: MediaItemRow): MediaItem {
  return baseRowToMediaItem(row);
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
  const hardThreshold = req.query.hardThreshold ? Number(req.query.hardThreshold) : undefined;
  const softThreshold = req.query.softThreshold ? Number(req.query.softThreshold) : undefined;
  const maxResolution = req.query.maxResolution ? Number(req.query.maxResolution) : undefined;
  const jpegQuality = req.query.jpegQuality ? Number(req.query.jpegQuality) : undefined;
  const videoResolution = req.query.videoResolution ? Number(req.query.videoResolution) : undefined;

  let failedCount = 0;

  // Query all image media_items for this trip
  const rows = db.prepare(
    "SELECT * FROM media_items WHERE trip_id = ? AND media_type = 'image'"
  ).all(tripId) as MediaItemRow[];
  const imageItems = rows.map(rowToMediaItem);

  // Step 1: Dedup
  const groups = await deduplicate(imageItems);

  // Step 2: Blur detection (computes sharpness_score for quality reuse)
  const blurOptions: Record<string, number> = {};
  if (hardThreshold !== undefined) blurOptions.hardThreshold = hardThreshold;
  if (softThreshold !== undefined) blurOptions.softThreshold = softThreshold;
  const blurResult = await detectBlurry(tripId, Object.keys(blurOptions).length > 0 ? blurOptions : undefined);
  const blurryCount = blurResult.blurryCount;
  const suspectCount = blurResult.suspectCount;

  // Step 3: Quality scoring (reuses sharpness_score from blur detection)
  await processTrip(tripId);

  // Step 4: Trashed duplicate count
  const trashedDuplicateCount = getTrashedDuplicateCount(tripId);

  // Step 5: Image optimization
  const optimizeResults = await optimizeTrip(tripId, { maxResolution, jpegQuality });
  const optimizedCount = optimizeResults.filter(r => r.optimizedPath !== null).length;
  failedCount += optimizeResults.filter(r => r.error).length;

  // Step 6: Thumbnails
  await generateThumbnailsForTrip(tripId);

  // Step 7 & 8: Video analysis and editing
  const videoRows = db.prepare(
    "SELECT * FROM media_items WHERE trip_id = ? AND media_type = 'video' AND status = 'active'"
  ).all(tripId) as MediaItemRow[];

  // Filter out already-processed videos (those with compiled_path or thumbnail_path set)
  const unprocessedVideos = videoRows.filter(v => !v.compiled_path && !v.thumbnail_path);
  const alreadyProcessedCount = videoRows.length - unprocessedVideos.length;

  let compiledCount = alreadyProcessedCount;
  const updateCompiledStmt = db.prepare('UPDATE media_items SET compiled_path = ? WHERE id = ?');
  const updateErrorStmt = db.prepare('UPDATE media_items SET processing_error = ? WHERE id = ?');

  for (const videoRow of unprocessedVideos) {
    const storageProvider = getStorageProvider();
    try {
      const videoPath = await storageProvider.downloadToTemp(videoRow.file_path);
      const analysis = await analyzeVideo(videoPath, videoRow.id);
      const editResult = await editVideo(videoPath, analysis, tripId, videoRow.id, { videoResolution });
      if (editResult.compiledPath) {
        updateCompiledStmt.run(editResult.compiledPath, videoRow.id);
        compiledCount++;
      } else if (editResult.error) {
        updateErrorStmt.run(editResult.error, videoRow.id);
        failedCount++;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      updateErrorStmt.run(errorMsg, videoRow.id);
      failedCount++;
    }
  }

  // Step 9: Cover
  const coverImageId = await selectCoverImage(tripId);

  // Build summary response
  return res.json({
    tripId,
    totalImages: imageItems.length,
    totalVideos: videoRows.length,
    duplicateGroups: groups.map((g) => ({
      groupId: g.id,
      imageCount: g.imageCount,
    })),
    totalGroups: groups.length,
    blurryCount,
    suspectCount,
    trashedDuplicateCount,
    optimizedCount,
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
  const hardThreshold = req.query.hardThreshold ? Number(req.query.hardThreshold) : undefined;
  const softThreshold = req.query.softThreshold ? Number(req.query.softThreshold) : undefined;
  const maxResolution = req.query.maxResolution ? Number(req.query.maxResolution) : undefined;
  const jpegQuality = req.query.jpegQuality ? Number(req.query.jpegQuality) : undefined;
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

    // Query all image media_items for this trip
    const rows = db.prepare(
      "SELECT * FROM media_items WHERE trip_id = ? AND media_type = 'image'"
    ).all(tripId) as MediaItemRow[];
    const imageItems = rows.map(rowToMediaItem);

    // Query videos for this trip
    const allVideoRows = db.prepare(
      "SELECT * FROM media_items WHERE trip_id = ? AND media_type = 'video' AND status = 'active'"
    ).all(tripId) as MediaItemRow[];
    const totalVideos = allVideoRows.length;
    const totalItems = imageItems.length + totalVideos;

    // Filter out already-processed videos (those with compiled_path or thumbnail_path set)
    const videoRows = allVideoRows.filter(v => !v.compiled_path && !v.thumbnail_path);
    const alreadyProcessedCount = totalVideos - videoRows.length;

    // Step 1: Dedup
    if (clientDisconnected) return;
    reporter.sendStepStart('dedup', { processed: 0, total: imageItems.length });
    const groups = await deduplicate(imageItems);
    if (clientDisconnected) return;
    reporter.sendStepComplete('dedup', { processed: imageItems.length, total: imageItems.length });

    // Step 2: Blur detection (computes sharpness_score for quality reuse)
    if (clientDisconnected) return;
    reporter.sendStepStart('blurDetect', { processed: 0, total: imageItems.length });
    const blurOptions: Record<string, number> = {};
    if (hardThreshold !== undefined) blurOptions.hardThreshold = hardThreshold;
    if (softThreshold !== undefined) blurOptions.softThreshold = softThreshold;
    const blurResult = await detectBlurry(tripId, Object.keys(blurOptions).length > 0 ? blurOptions : undefined);
    const blurryCount = blurResult.blurryCount;
    const suspectCount = blurResult.suspectCount;
    if (clientDisconnected) return;
    reporter.sendStepComplete('blurDetect', { processed: imageItems.length, total: imageItems.length });

    // Step 3: Quality scoring (reuses sharpness_score from blur detection)
    if (clientDisconnected) return;
    reporter.sendStepStart('quality', { processed: 0, total: imageItems.length });
    await processTrip(tripId);
    const trashedDuplicateCount = getTrashedDuplicateCount(tripId);
    if (clientDisconnected) return;
    reporter.sendStepComplete('quality', { processed: imageItems.length, total: imageItems.length });

    // Step 4: Image optimization
    if (clientDisconnected) return;
    reporter.sendStepStart('imageOptimize', { processed: 0, total: imageItems.length });
    const optimizeResults = await optimizeTrip(tripId, { maxResolution, jpegQuality });
    const optimizedCount = optimizeResults.filter(r => r.optimizedPath !== null).length;
    failedCount += optimizeResults.filter(r => r.error).length;
    if (clientDisconnected) return;
    reporter.sendStepComplete('imageOptimize', { processed: imageItems.length, total: imageItems.length });

    // Step 5: Thumbnail
    if (clientDisconnected) return;
    reporter.sendStepStart('thumbnail', { processed: 0, total: totalItems });
    await generateThumbnailsForTrip(tripId);
    if (clientDisconnected) return;
    reporter.sendStepComplete('thumbnail', { processed: totalItems, total: totalItems });

    // Step 6: Video analysis
    if (clientDisconnected) return;
    reporter.sendStepStart('videoAnalysis', { processed: 0, total: videoRows.length });
    const analysisResults: Map<string, Awaited<ReturnType<typeof analyzeVideo>>> = new Map();
    const updateErrorStmt = db.prepare('UPDATE media_items SET processing_error = ? WHERE id = ?');
    const storageProvider = getStorageProvider();

    for (const videoRow of videoRows) {
      if (clientDisconnected) return;
      try {
        const videoPath = await storageProvider.downloadToTemp(videoRow.file_path);
        const analysis = await analyzeVideo(videoPath, videoRow.id);
        analysisResults.set(videoRow.id, analysis);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        updateErrorStmt.run(errorMsg, videoRow.id);
        failedCount++;
      }
    }
    if (clientDisconnected) return;
    reporter.sendStepComplete('videoAnalysis', { processed: videoRows.length, total: videoRows.length });

    // Step 7: Video editing
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
          updateErrorStmt.run(editResult.error, videoRow.id);
          failedCount++;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        updateErrorStmt.run(errorMsg, videoRow.id);
        failedCount++;
      }
    }
    if (clientDisconnected) return;
    reporter.sendStepComplete('videoEdit', { processed: analysisResults.size, total: analysisResults.size });

    // Step 8: Cover
    if (clientDisconnected) return;
    reporter.sendStepStart('cover', { processed: 0, total: 1 });
    const coverImageId = await selectCoverImage(tripId);
    if (clientDisconnected) return;
    reporter.sendStepComplete('cover', { processed: 1, total: 1 });

    // All steps complete
    reporter.sendComplete({
      tripId,
      totalImages: imageItems.length,
      totalVideos,
      duplicateGroups: groups.map((g) => ({
        groupId: g.id,
        imageCount: g.imageCount,
      })),
      totalGroups: groups.length,
      blurryCount,
      suspectCount,
      trashedDuplicateCount,
      optimizedCount,
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
