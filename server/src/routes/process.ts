import { Router, Request, Response } from 'express';
import path from 'path';
import { getDb } from '../database';
import { deduplicate } from '../services/dedupEngine';
import { processTrip, getTrashedDuplicateCount } from '../services/qualitySelector';
import { generateThumbnailsForTrip } from '../services/thumbnailGenerator';
import { selectCoverImage } from '../services/coverSelector';
import { detectAndTrashBlurry } from '../services/blurDetector';
import { optimizeTrip } from '../services/imageOptimizer';
import { analyzeVideo } from '../services/videoAnalyzer';
import { editVideo } from '../services/videoEditor';
import { ProgressReporter } from '../services/progressReporter';
import type { MediaItem } from '../types';

const router = Router();

interface MediaItemRow {
  id: string;
  trip_id: string;
  file_path: string;
  thumbnail_path: string | null;
  media_type: string;
  mime_type: string;
  original_filename: string;
  file_size: number;
  width: number | null;
  height: number | null;
  perceptual_hash: string | null;
  quality_score: number | null;
  sharpness_score: number | null;
  duplicate_group_id: string | null;
  status: string;
  trashed_reason: string | null;
  processing_error: string | null;
  optimized_path: string | null;
  compiled_path: string | null;
  created_at: string;
}

// Base directory for resolving relative file paths stored in DB
const serverRoot = path.join(__dirname, '..', '..');

function rowToMediaItem(row: MediaItemRow): MediaItem {
  return {
    id: row.id,
    tripId: row.trip_id,
    // Resolve relative DB path (e.g. "uploads/{trip_id}/originals/file.jpg") to absolute
    filePath: path.resolve(serverRoot, row.file_path),
    thumbnailPath: row.thumbnail_path ?? undefined,
    mediaType: row.media_type as MediaItem['mediaType'],
    mimeType: row.mime_type,
    originalFilename: row.original_filename,
    fileSize: row.file_size,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    perceptualHash: row.perceptual_hash ?? undefined,
    qualityScore: row.quality_score ?? undefined,
    sharpnessScore: row.sharpness_score ?? undefined,
    duplicateGroupId: row.duplicate_group_id ?? undefined,
    status: row.status as MediaItem['status'],
    trashedReason: row.trashed_reason ?? undefined,
    processingError: row.processing_error ?? undefined,
    optimizedPath: row.optimized_path ?? undefined,
    compiledPath: row.compiled_path ?? undefined,
    createdAt: row.created_at,
  };
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

  // Step 2: Quality
  await processTrip(tripId);

  // Step 3: Blur detection
  const blurResult = await detectAndTrashBlurry(tripId, blurThreshold);
  const blurryCount = blurResult.blurryCount;

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

  let compiledCount = 0;
  const updateCompiledStmt = db.prepare('UPDATE media_items SET compiled_path = ? WHERE id = ?');
  const updateErrorStmt = db.prepare('UPDATE media_items SET processing_error = ? WHERE id = ?');

  for (const videoRow of videoRows) {
    const videoPath = path.resolve(serverRoot, videoRow.file_path);
    try {
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
  const blurThreshold = req.query.blurThreshold ? Number(req.query.blurThreshold) : undefined;
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
    const videoRows = db.prepare(
      "SELECT * FROM media_items WHERE trip_id = ? AND media_type = 'video' AND status = 'active'"
    ).all(tripId) as MediaItemRow[];
    const totalVideos = videoRows.length;
    const totalItems = imageItems.length + totalVideos;

    // Step 1: Dedup
    if (clientDisconnected) return;
    reporter.sendStepStart('dedup', { processed: 0, total: imageItems.length });
    const groups = await deduplicate(imageItems);
    if (clientDisconnected) return;
    reporter.sendStepComplete('dedup', { processed: imageItems.length, total: imageItems.length });

    // Step 2: Quality
    if (clientDisconnected) return;
    reporter.sendStepStart('quality', { processed: 0, total: imageItems.length });
    await processTrip(tripId);
    if (clientDisconnected) return;
    reporter.sendStepComplete('quality', { processed: imageItems.length, total: imageItems.length });

    // Step 3: Blur detection
    if (clientDisconnected) return;
    reporter.sendStepStart('blurDetect', { processed: 0, total: imageItems.length });
    const blurResult = await detectAndTrashBlurry(tripId, blurThreshold);
    const blurryCount = blurResult.blurryCount;
    if (clientDisconnected) return;
    reporter.sendStepComplete('blurDetect', { processed: imageItems.length, total: imageItems.length });

    // Step 4: Trashed duplicates count
    if (clientDisconnected) return;
    reporter.sendStepStart('trashDuplicates', { processed: 0, total: 1 });
    const trashedDuplicateCount = getTrashedDuplicateCount(tripId);
    if (clientDisconnected) return;
    reporter.sendStepComplete('trashDuplicates', { processed: 1, total: 1 });

    // Step 5: Image optimization
    if (clientDisconnected) return;
    reporter.sendStepStart('imageOptimize', { processed: 0, total: imageItems.length });
    const optimizeResults = await optimizeTrip(tripId, { maxResolution, jpegQuality });
    const optimizedCount = optimizeResults.filter(r => r.optimizedPath !== null).length;
    failedCount += optimizeResults.filter(r => r.error).length;
    if (clientDisconnected) return;
    reporter.sendStepComplete('imageOptimize', { processed: imageItems.length, total: imageItems.length });

    // Step 6: Thumbnail
    if (clientDisconnected) return;
    reporter.sendStepStart('thumbnail', { processed: 0, total: totalItems });
    await generateThumbnailsForTrip(tripId);
    if (clientDisconnected) return;
    reporter.sendStepComplete('thumbnail', { processed: totalItems, total: totalItems });

    // Step 7: Video analysis
    if (clientDisconnected) return;
    reporter.sendStepStart('videoAnalysis', { processed: 0, total: totalVideos });
    const analysisResults: Map<string, Awaited<ReturnType<typeof analyzeVideo>>> = new Map();
    const updateErrorStmt = db.prepare('UPDATE media_items SET processing_error = ? WHERE id = ?');

    for (const videoRow of videoRows) {
      if (clientDisconnected) return;
      const videoPath = path.resolve(serverRoot, videoRow.file_path);
      try {
        const analysis = await analyzeVideo(videoPath, videoRow.id);
        analysisResults.set(videoRow.id, analysis);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        updateErrorStmt.run(errorMsg, videoRow.id);
        failedCount++;
      }
    }
    if (clientDisconnected) return;
    reporter.sendStepComplete('videoAnalysis', { processed: totalVideos, total: totalVideos });

    // Step 8: Video editing
    if (clientDisconnected) return;
    reporter.sendStepStart('videoEdit', { processed: 0, total: analysisResults.size });
    let compiledCount = 0;
    const updateCompiledStmt = db.prepare('UPDATE media_items SET compiled_path = ? WHERE id = ?');

    for (const videoRow of videoRows) {
      if (clientDisconnected) return;
      const analysis = analysisResults.get(videoRow.id);
      if (!analysis) continue;

      const videoPath = path.resolve(serverRoot, videoRow.file_path);
      try {
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

    // Step 9: Cover
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
