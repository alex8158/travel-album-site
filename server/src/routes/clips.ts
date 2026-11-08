import { Router, Request, Response } from 'express';
import fs from 'fs';
import { getDb } from '../database';
import { authMiddleware, requireAuth } from '../middleware/auth';
import { authorizeOwnerFileDownload, OWNER_FILE_NOT_FOUND_BODY, privateNoStore } from '../helpers/ownerFileDownload';
import { authorizeOwnerMediaWrite, OWNER_WRITE_FORBIDDEN_BODY } from '../helpers/ownerMediaWrite';
import { createTripJobOrConflict } from '../helpers/tripJobCreation';
import { getSegments } from '../helpers/videoSegmentStore';
import { MediaItemRow } from '../helpers/mediaItemRow';
import { analyzeVideo } from '../services/videoAnalyzer';
import { editVideo, selectSegments } from '../services/videoEditor';
import { mergeSegments } from '../services/mergeEngine';
import { saveSegments } from '../helpers/videoSegmentStore';
import { getStorageProvider } from '../storage/factory';
import { JobProgressReporter } from '../services/jobProgressReporter';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/media/:mediaId/segments — return segments from DB
// ---------------------------------------------------------------------------
router.get(
  '/:mediaId/segments',
  authMiddleware,
  requireAuth,
  (req: Request, res: Response) => {
    const mediaId = req.params.mediaId as string;
    const db = getDb();

    // Verify media item exists
    const media = db.prepare('SELECT id, media_type FROM media_items WHERE id = ?').get(mediaId) as
      | Pick<MediaItemRow, 'id' | 'media_type'>
      | undefined;

    if (!media) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: '媒体项不存在' } });
    }

    if (media.media_type !== 'video') {
      return res.status(400).json({ error: { code: 'NOT_VIDEO', message: '该媒体项不是视频' } });
    }

    const segments = getSegments(mediaId);
    return res.json({ mediaId, segments });
  },
);

// ---------------------------------------------------------------------------
// POST /api/media/:mediaId/clips — trigger smart editing (async via processing_jobs)
// ---------------------------------------------------------------------------
router.post(
  '/:mediaId/clips',
  authMiddleware,
  requireAuth,
  async (req: Request, res: Response) => {
    const mediaId = req.params.mediaId as string;
    // Owner/admin only, decided on the URL media before anything else
    // (multi-user-system G-27, 需求 7 AC 8).
    const gate = authorizeOwnerMediaWrite(req, mediaId);
    if (!gate.allowed) {
      return gate.status === 403
        ? res.status(403).json(OWNER_WRITE_FORBIDDEN_BODY)
        : res.status(404).json({ error: { code: 'NOT_FOUND', message: '媒体项不存在' } });
    }
    const db = getDb();

    // Verify media item exists and is a video
    const media = db.prepare(
      'SELECT id, trip_id, file_path, media_type FROM media_items WHERE id = ?',
    ).get(mediaId) as Pick<MediaItemRow, 'id' | 'trip_id' | 'file_path' | 'media_type'> | undefined;

    if (!media) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: '媒体项不存在' } });
    }
    if (media.media_type !== 'video') {
      return res.status(400).json({ error: { code: 'NOT_VIDEO', message: '该媒体项不是视频' } });
    }

    // Create a processing job
    // One active job per trip (idx_processing_jobs_active_trip). A second
    // request for the same trip is a 409, never an unhandled error (G-29).
    const tripId = media.trip_id;
    const job = createTripJobOrConflict(db, tripId, 'videoClip');
    if (job.kind === 'conflict') {
      return res.status(409).json({
        error: { code: 'ALREADY_PROCESSING', message: '该旅行正在处理中', existingJobId: job.existingJobId },
      });
    }
    if (job.kind === 'error') {
      const message = job.error instanceof Error ? job.error.message : String(job.error);
      console.error(`[clips] route=clips tripId=${tripId} mediaId=${mediaId} job creation failed: ${message}`);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } });
    }
    const jobId = job.jobId;

    // Return jobId immediately
    res.status(202).json({ jobId, mediaId, status: 'queued' });

    // Run smart editing in background
    const reporter = new JobProgressReporter(jobId);
    reporter.markRunning();

    try {
      // Resolve video path
      const storageProvider = getStorageProvider();
      const videoPath = await storageProvider.downloadToTemp(media.file_path);

      // Analyze
      const analysis = await analyzeVideo(videoPath, mediaId);

      // Persist segments
      saveSegments(mediaId, analysis.segments);

      // Edit
      const transitionType = (req.body?.transitionType as 'none' | 'fade' | 'crossfade') ?? undefined;
      const transitionDuration = req.body?.transitionDuration ? Number(req.body.transitionDuration) : undefined;

      const result = await editVideo(videoPath, analysis, tripId, mediaId, {
        transitionType,
        transitionDuration,
      });

      reporter.markCompleted(JSON.stringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[clips] Smart editing failed for ${mediaId}: ${message}`);
      reporter.markFailed(message);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/media/:mediaId/merge — merge selected segments (async)
// ---------------------------------------------------------------------------
router.post(
  '/:mediaId/merge',
  authMiddleware,
  requireAuth,
  async (req: Request, res: Response) => {
    const mediaId = req.params.mediaId as string;
    // Owner/admin only, decided on the URL media before anything else
    // (multi-user-system G-27, 需求 7 AC 8).
    const gate = authorizeOwnerMediaWrite(req, mediaId);
    if (!gate.allowed) {
      return gate.status === 403
        ? res.status(403).json(OWNER_WRITE_FORBIDDEN_BODY)
        : res.status(404).json({ error: { code: 'NOT_FOUND', message: '媒体项不存在' } });
    }
    const db = getDb();

    // Validate body
    const { segmentIndices, transitionType, transitionDuration } = req.body ?? {};

    if (!Array.isArray(segmentIndices) || segmentIndices.length === 0) {
      return res.status(400).json({
        error: { code: 'INVALID_PARAMS', message: '片段选择列表不能为空' },
      });
    }

    // Verify media item exists and is a video
    const media = db.prepare(
      'SELECT id, trip_id, file_path, media_type FROM media_items WHERE id = ?',
    ).get(mediaId) as Pick<MediaItemRow, 'id' | 'trip_id' | 'file_path' | 'media_type'> | undefined;

    if (!media) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: '媒体项不存在' } });
    }
    if (media.media_type !== 'video') {
      return res.status(400).json({ error: { code: 'NOT_VIDEO', message: '该媒体项不是视频' } });
    }

    // Create a processing job
    // One active job per trip (idx_processing_jobs_active_trip). A second
    // request for the same trip is a 409, never an unhandled error (G-29).
    const tripId = media.trip_id;
    const job = createTripJobOrConflict(db, tripId, 'videoMerge');
    if (job.kind === 'conflict') {
      return res.status(409).json({
        error: { code: 'ALREADY_PROCESSING', message: '该旅行正在处理中', existingJobId: job.existingJobId },
      });
    }
    if (job.kind === 'error') {
      const message = job.error instanceof Error ? job.error.message : String(job.error);
      console.error(`[clips] route=merge tripId=${tripId} mediaId=${mediaId} job creation failed: ${message}`);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } });
    }
    const jobId = job.jobId;

    // Return jobId immediately
    res.status(202).json({ jobId, mediaId, status: 'queued' });

    // Run merge in background
    const reporter = new JobProgressReporter(jobId);
    reporter.markRunning();

    try {
      const storageProvider = getStorageProvider();
      const videoPath = await storageProvider.downloadToTemp(media.file_path);

      // Load segments from DB
      const segments = getSegments(mediaId);

      const result = await mergeSegments(videoPath, segments, {
        mediaId,
        tripId,
        segmentIndices: segmentIndices.map(Number),
        transitionType,
        transitionDuration: transitionDuration ? Number(transitionDuration) : undefined,
      });

      if (result.success) {
        reporter.markCompleted(JSON.stringify(result));
      } else {
        reporter.markFailed(result.error ?? '合并失败');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[clips] Merge failed for ${mediaId}: ${message}`);
      reporter.markFailed(message);
    }
  },
);

export default router;

// ---------------------------------------------------------------------------
// GET /api/media/:mediaId/download-compiled — download compiled/merged video
// ---------------------------------------------------------------------------
// Owner/admin only (multi-user-system G-24, 需求 9 AC 24). A non-owner gets the
// same 404 as a missing media; the check runs before any storage access.
router.get(
  '/:mediaId/download-compiled',
  authMiddleware,
  privateNoStore,
  requireAuth,
  async (req: Request, res: Response) => {
    const mediaId = req.params.mediaId as string;
    if (!authorizeOwnerFileDownload(req, mediaId)) {
      return res.status(404).json(OWNER_FILE_NOT_FOUND_BODY);
    }
    const db = getDb();

    const media = db.prepare(
      'SELECT id, compiled_path, original_filename, media_type FROM media_items WHERE id = ?',
    ).get(mediaId) as Pick<MediaItemRow, 'id' | 'compiled_path' | 'original_filename' | 'media_type'> | undefined;

    if (!media) {
      return res.status(404).json(OWNER_FILE_NOT_FOUND_BODY);
    }

    const compiledPath = media.compiled_path;
    if (!compiledPath) {
      return res.status(404).json({ error: { code: 'NO_COMPILED', message: '该视频尚未生成剪辑版本' } });
    }

    try {
      const storageProvider = getStorageProvider();
      const localPath = await storageProvider.downloadToTemp(compiledPath);

      if (!fs.existsSync(localPath)) {
        return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '文件不存在' } });
      }

      const filename = `${media.original_filename?.replace(/\.[^.]+$/, '') || mediaId}_compiled.mp4`;
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Type', 'video/mp4');
      return res.sendFile(localPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: { code: 'DOWNLOAD_ERROR', message } });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/media/:mediaId/re-edit — re-edit with custom parameters
// Body: { targetDuration?: number, excludeIndices?: number[], transitionType?, transitionDuration? }
// ---------------------------------------------------------------------------
router.post(
  '/:mediaId/re-edit',
  authMiddleware,
  requireAuth,
  async (req: Request, res: Response) => {
    const mediaId = req.params.mediaId as string;
    // Owner/admin only, decided on the URL media before anything else
    // (multi-user-system G-27, 需求 7 AC 8).
    const gate = authorizeOwnerMediaWrite(req, mediaId);
    if (!gate.allowed) {
      return gate.status === 403
        ? res.status(403).json(OWNER_WRITE_FORBIDDEN_BODY)
        : res.status(404).json({ error: { code: 'NOT_FOUND', message: '媒体项不存在' } });
    }
    const db = getDb();

    const media = db.prepare(
      'SELECT id, trip_id, file_path, media_type FROM media_items WHERE id = ?',
    ).get(mediaId) as Pick<MediaItemRow, 'id' | 'trip_id' | 'file_path' | 'media_type'> | undefined;

    if (!media) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: '媒体项不存在' } });
    }
    if (media.media_type !== 'video') {
      return res.status(400).json({ error: { code: 'NOT_VIDEO', message: '该媒体项不是视频' } });
    }

    const {
      targetDuration,
      excludeIndices,
      transitionType,
      transitionDuration,
    } = req.body ?? {};

    // Create a processing job
    // One active job per trip (idx_processing_jobs_active_trip). A second
    // request for the same trip is a 409, never an unhandled error (G-29).
    const tripId = media.trip_id;
    const job = createTripJobOrConflict(db, tripId, 'videoReEdit');
    if (job.kind === 'conflict') {
      return res.status(409).json({
        error: { code: 'ALREADY_PROCESSING', message: '该旅行正在处理中', existingJobId: job.existingJobId },
      });
    }
    if (job.kind === 'error') {
      const message = job.error instanceof Error ? job.error.message : String(job.error);
      console.error(`[clips] route=re-edit tripId=${tripId} mediaId=${mediaId} job creation failed: ${message}`);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } });
    }
    const jobId = job.jobId;

    res.status(202).json({ jobId, mediaId, status: 'queued' });

    const reporter = new JobProgressReporter(jobId);
    reporter.markRunning();

    try {
      const storageProvider = getStorageProvider();
      const videoPath = await storageProvider.downloadToTemp(media.file_path);

      // Load existing segments (must have been analyzed before)
      let segments = getSegments(mediaId);
      if (segments.length === 0) {
        // If no segments exist, analyze first
        const analysis = await analyzeVideo(videoPath, mediaId);
        saveSegments(mediaId, analysis.segments);
        segments = analysis.segments;
      }

      // Apply exclusions
      const excludeSet = new Set((excludeIndices ?? []).map(Number));
      const filteredSegments = segments.filter(s => !excludeSet.has(s.index));

      // Custom target duration or auto
      const customTarget = targetDuration != null ? Number(targetDuration) : null;

      // Select segments with custom target
      const selected = selectSegments(filteredSegments, customTarget);

      if (selected.length === 0) {
        reporter.markFailed('无有效片段');
        return;
      }

      // Merge selected segments
      const result = await mergeSegments(videoPath, selected, {
        mediaId,
        tripId,
        segmentIndices: selected.map(s => s.index),
        transitionType: transitionType ?? 'none',
        transitionDuration: transitionDuration ? Number(transitionDuration) : undefined,
      });

      if (result.success) {
        // Update compiled_path on media_items
        db.prepare('UPDATE media_items SET compiled_path = ? WHERE id = ?').run(result.mergedPath, mediaId);
        reporter.markCompleted(JSON.stringify(result));
      } else {
        reporter.markFailed(result.error ?? '重新编辑失败');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[clips] Re-edit failed for ${mediaId}: ${message}`);
      reporter.markFailed(message);
    }
  },
);
