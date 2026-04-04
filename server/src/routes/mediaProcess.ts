import { Router, Request, Response } from 'express';
import { getDb } from '../database';
import { authMiddleware, requireAuth } from '../middleware/auth';
import { MediaItemRow } from '../helpers/mediaItemRow';
import { TripRow } from '../helpers/tripRow';
import { getStorageProvider } from '../storage/factory';
import { analyzeVideo } from '../services/videoAnalyzer';
import { editVideo } from '../services/videoEditor';
import { generateVideoThumbnail } from '../services/thumbnailGenerator';

const router = Router();

// POST /api/media/:id/process — Process a single video (analyze → edit → thumbnail)
router.post('/:id/process', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  const mediaId = req.params.id as string;
  const db = getDb();

  // Look up the media item
  const mediaRow = db.prepare('SELECT * FROM media_items WHERE id = ?').get(mediaId) as MediaItemRow | undefined;
  if (!mediaRow) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '媒体文件不存在' } });
  }

  // Only video files can be processed
  if (mediaRow.media_type !== 'video') {
    return res.status(400).json({ error: { code: 'INVALID_TYPE', message: '仅支持视频处理' } });
  }

  // Verify requester is trip owner or admin
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(mediaRow.trip_id) as TripRow | undefined;
  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }
  if (req.user!.role !== 'admin' && trip.user_id !== req.user!.userId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
  }

  const updateCompiledStmt = db.prepare('UPDATE media_items SET compiled_path = ? WHERE id = ?');
  const updateThumbnailStmt = db.prepare('UPDATE media_items SET thumbnail_path = ? WHERE id = ?');
  const updateErrorStmt = db.prepare('UPDATE media_items SET processing_error = ? WHERE id = ?');

  try {
    // Download video from storage to temp
    const storageProvider = getStorageProvider();
    const videoPath = await storageProvider.downloadToTemp(mediaRow.file_path);

    // Analyze → Edit → Thumbnail
    const analysis = await analyzeVideo(videoPath, mediaId);
    const editResult = await editVideo(videoPath, analysis, mediaRow.trip_id, mediaId);

    let compiledPath: string | null = editResult.compiledPath;
    let thumbnailPath: string | null = null;

    if (compiledPath) {
      updateCompiledStmt.run(compiledPath, mediaId);
    } else if (editResult.error) {
      updateErrorStmt.run(editResult.error, mediaId);
      return res.json({
        mediaId,
        compiledPath: null,
        thumbnailPath: null,
        status: 'error' as const,
        error: editResult.error,
      });
    }

    // Generate thumbnail
    try {
      thumbnailPath = await generateVideoThumbnail(videoPath, mediaRow.trip_id, mediaId);
      updateThumbnailStmt.run(thumbnailPath, mediaId);
    } catch (thumbErr) {
      // Thumbnail failure is non-fatal — compiled_path is still valid
      console.error(`[MediaProcess] Thumbnail generation failed for ${mediaId}:`, thumbErr);
    }

    return res.json({
      mediaId,
      compiledPath,
      thumbnailPath,
      status: 'success' as const,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    updateErrorStmt.run(errorMsg, mediaId);
    return res.json({
      mediaId,
      compiledPath: null,
      thumbnailPath: null,
      status: 'error' as const,
      error: errorMsg,
    });
  }
});

export default router;
