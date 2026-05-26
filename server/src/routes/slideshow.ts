/**
 * Slideshow API Routes — 照片幻灯片视频生成接口
 *
 * POST /api/slideshow/generate — 生成幻灯片视频（SSE 流式进度）
 * GET  /api/slideshow/:jobId/download — 下载生成的视频
 *
 * Requirements: 1.3, 2.1, 2.2, 2.3, 2.4, 5.1, 5.3, 6.1, 6.2, 6.3, 7.4
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import { authMiddleware, requireAuth } from '../middleware/auth';
import { generateSlideshow } from '../services/slideshowGenerator';
import { getStorageProvider } from '../storage/factory';

const router = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TripRow {
  id: string;
  user_id: string;
}

interface MediaItemRow {
  id: string;
  trip_id: string;
  file_path: string;
  media_type: string;
  optimized_path: string | null;
}

interface AudioTrackRow {
  id: string;
  user_id: string;
  file_path: string;
}

interface SlideshowJobRow {
  id: string;
  trip_id: string;
  user_id: string;
  status: string;
  output_path: string | null;
}

// ---------------------------------------------------------------------------
// GET /api/slideshow/latest — 获取指定旅行的最新幻灯片视频 job
// ---------------------------------------------------------------------------

router.get('/latest', authMiddleware, requireAuth, (req: Request, res: Response) => {
  const tripId = req.query.tripId as string;
  if (!tripId) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: '缺少 tripId 参数' } });
  }

  const db = getDb();
  const job = db.prepare(
    `SELECT id, trip_id, status, output_path, total_duration, created_at
     FROM slideshow_jobs
     WHERE trip_id = ? AND user_id = ?
     ORDER BY created_at DESC
     LIMIT 1`
  ).get(tripId, req.user!.userId) as { id: string; trip_id: string; status: string; output_path: string | null; total_duration: number | null; created_at: string } | undefined;

  if (!job) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '暂无幻灯片视频' } });
  }

  return res.json({
    id: job.id,
    tripId: job.trip_id,
    status: job.status,
    outputPath: job.output_path,
    totalDuration: job.total_duration,
    createdAt: job.created_at,
  });
});

// ---------------------------------------------------------------------------
// POST /api/slideshow/generate — 生成幻灯片视频（SSE 流式进度）
// Requirements: 1.3, 2.1, 2.2, 2.3, 2.4, 6.1, 6.2, 6.3, 7.4
// ---------------------------------------------------------------------------
router.post('/generate', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  const { tripId, photoIds, audioTrackId } = req.body as {
    tripId?: string;
    photoIds?: string[];
    audioTrackId?: string;
  };
  const db = getDb();
  const userId = req.user!.userId;

  // --- Validation ---

  // Validate tripId is provided
  if (!tripId) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: '缺少 tripId 参数' },
    });
  }

  // Validate photoIds is provided and is an array
  if (!photoIds || !Array.isArray(photoIds)) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: '缺少 photoIds 参数' },
    });
  }

  // Validate photoIds count >= 2
  if (photoIds.length < 2) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: '至少需要选择 2 张照片' },
    });
  }

  // Verify trip exists and belongs to current user
  const trip = db.prepare('SELECT id, user_id FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
  if (!trip) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: '旅行不存在' },
    });
  }

  if (req.user!.role !== 'admin' && trip.user_id !== userId) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: '无权操作此资源' },
    });
  }

  // Verify all photoIds belong to the trip and are image type
  const placeholders = photoIds.map(() => '?').join(',');
  const mediaItems = db.prepare(
    `SELECT id, trip_id, file_path, media_type, optimized_path FROM media_items WHERE id IN (${placeholders})`
  ).all(...photoIds) as MediaItemRow[];

  const invalidIds: string[] = [];

  for (const photoId of photoIds) {
    const item = mediaItems.find((m) => m.id === photoId);
    if (!item) {
      invalidIds.push(photoId);
    } else if (item.trip_id !== tripId) {
      invalidIds.push(photoId);
    } else if (item.media_type !== 'image') {
      invalidIds.push(photoId);
    }
  }

  if (invalidIds.length > 0) {
    return res.status(400).json({
      error: {
        code: 'INVALID_PHOTOS',
        message: '部分照片 ID 无效或不属于该旅行',
        invalidIds,
      },
    });
  }

  // Validate audioTrackId if provided
  let audioTrack: AudioTrackRow | undefined;
  if (audioTrackId) {
    audioTrack = db.prepare('SELECT id, user_id, file_path FROM audio_tracks WHERE id = ?').get(audioTrackId) as AudioTrackRow | undefined;
    if (!audioTrack) {
      return res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: '音频不存在' },
      });
    }
    if (req.user!.role !== 'admin' && audioTrack.user_id !== userId) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: '无权使用此音频' },
      });
    }
  }

  // Check for concurrent job (409 if already running/queued for same trip)
  const activeJob = db.prepare(
    `SELECT id FROM slideshow_jobs WHERE trip_id = ? AND status IN ('queued', 'running')`
  ).get(tripId) as { id: string } | undefined;

  if (activeJob) {
    return res.status(409).json({
      error: { code: 'ALREADY_PROCESSING', message: '该旅行已有幻灯片视频正在生成中，请稍后再试' },
    });
  }

  // --- SSE Setup ---
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Track client disconnect
  let clientDisconnected = false;

  // Heartbeat: send keepalive every 15s
  const heartbeat = setInterval(() => {
    if (!clientDisconnected) {
      res.write(`: heartbeat\n\n`);
    }
  }, 15000);

  req.on('close', () => {
    clientDisconnected = true;
    clearInterval(heartbeat);
  });

  // --- Create slideshow_jobs record ---
  const jobId = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO slideshow_jobs (id, trip_id, user_id, status, photo_ids, audio_track_id, created_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?)`
  ).run(jobId, tripId, userId, JSON.stringify(photoIds), audioTrackId || null, now);

  // --- Resolve file paths ---
  const storageProvider = getStorageProvider();

  // Get photo file paths (prefer optimized_path over file_path)
  const photoPaths: string[] = [];
  for (const photoId of photoIds) {
    const item = mediaItems.find((m) => m.id === photoId)!;
    const storagePath = item.optimized_path || item.file_path;
    const localPath = await storageProvider.downloadToTemp(storagePath);
    photoPaths.push(localPath);
  }

  // Get audio file path if provided
  let audioPath: string | null = null;
  if (audioTrack) {
    try {
      audioPath = await storageProvider.downloadToTemp(audioTrack.file_path);
    } catch {
      // Audio not accessible — will proceed without audio
      audioPath = null;
    }
  }

  // --- Determine output directory ---
  // Output to trip's slideshow directory
  const outputRelDir = path.join(tripId, 'slideshow');
  const uploadsBase = path.resolve(__dirname, '..', '..', 'uploads');
  const outputDir = path.join(uploadsBase, outputRelDir);

  // --- Invoke SlideshowGenerator ---
  generateSlideshow({
    photoPaths,
    audioPath,
    outputDir,
    onProgress: (percent: number) => {
      if (!clientDisconnected) {
        // Update job percent in DB
        db.prepare('UPDATE slideshow_jobs SET percent = ? WHERE id = ?').run(percent, jobId);
        // Send SSE progress event
        res.write(`event: progress\ndata: ${JSON.stringify({ percent })}\n\n`);
      }
    },
  })
    .then((result) => {
      clearInterval(heartbeat);

      if (result.success && result.outputPath) {
        // Compute relative output path for storage
        const outputFilename = path.basename(result.outputPath);
        const relativeOutputPath = path.join(outputRelDir, outputFilename);

        // Update job record
        db.prepare(
          `UPDATE slideshow_jobs SET status = 'completed', output_path = ?, total_duration = ?, skipped_photos = ?, percent = 100, completed_at = ? WHERE id = ?`
        ).run(
          relativeOutputPath,
          result.totalDuration,
          result.skippedPhotos.length > 0 ? JSON.stringify(result.skippedPhotos) : null,
          new Date().toISOString(),
          jobId,
        );

        // Send complete SSE event
        if (!clientDisconnected) {
          const videoUrl = `/api/slideshow/${jobId}/download`;
          res.write(
            `event: complete\ndata: ${JSON.stringify({
              videoUrl,
              videoId: jobId,
              duration: result.totalDuration,
            })}\n\n`,
          );
          res.end();
        }
      } else {
        // Generation failed
        const errorMessage = result.error || '视频生成失败';
        db.prepare(
          `UPDATE slideshow_jobs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?`
        ).run(errorMessage, new Date().toISOString(), jobId);

        if (!clientDisconnected) {
          res.write(`event: error\ndata: ${JSON.stringify({ message: errorMessage })}\n\n`);
          res.end();
        }
      }
    })
    .catch((err) => {
      clearInterval(heartbeat);

      const errorMessage = err instanceof Error ? err.message : String(err);
      db.prepare(
        `UPDATE slideshow_jobs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?`
      ).run(errorMessage, new Date().toISOString(), jobId);

      if (!clientDisconnected) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: errorMessage })}\n\n`);
        res.end();
      }
    });
});

// ---------------------------------------------------------------------------
// GET /api/slideshow/:jobId/download — 下载生成的视频
// Requirements: 5.1, 5.3
// ---------------------------------------------------------------------------
router.get('/:jobId/download', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  const jobId = req.params.jobId as string;
  const db = getDb();
  const userId = req.user!.userId;

  // Verify job exists
  const job = db.prepare(
    'SELECT id, trip_id, user_id, status, output_path FROM slideshow_jobs WHERE id = ?'
  ).get(jobId) as SlideshowJobRow | undefined;

  if (!job) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: '任务不存在' },
    });
  }

  // Verify ownership
  if (req.user!.role !== 'admin' && job.user_id !== userId) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: '无权访问此资源' },
    });
  }

  // Verify job is completed
  if (job.status !== 'completed' || !job.output_path) {
    return res.status(404).json({
      error: { code: 'NOT_READY', message: '视频尚未生成完成' },
    });
  }

  // Serve the video file with Range support (iOS Safari compatibility)
  const storageProvider = getStorageProvider();

  try {
    const localPath = await storageProvider.downloadToTemp(job.output_path);

    if (!fs.existsSync(localPath)) {
      return res.status(404).json({
        error: { code: 'FILE_NOT_FOUND', message: '视频文件不存在' },
      });
    }

    const stat = fs.statSync(localPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="slideshow_${jobId}.mp4"`,
      });

      const stream = fs.createReadStream(localPath, { start, end });
      return stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `attachment; filename="slideshow_${jobId}.mp4"`,
      });

      return fs.createReadStream(localPath).pipe(res);
    }
  } catch (err) {
    console.error(`[Slideshow] Error serving video for job ${jobId}:`, err);
    return res.status(404).json({
      error: { code: 'FILE_NOT_FOUND', message: '视频文件不存在或无法访问' },
    });
  }
});

export default router;
