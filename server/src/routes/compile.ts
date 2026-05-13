/**
 * Compile API Routes — 视频剪辑编译接口
 *
 * POST /api/media/:mediaId/compile — 启动剪辑任务
 * GET  /api/media/:mediaId/compile/status — 获取任务状态
 * GET  /api/media/:mediaId/compile/download — 下载编译结果
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import { getDb } from '../database';
import { authMiddleware, requireAuth } from '../middleware/auth';
import { validateTargetDuration, validateSegmentIndices } from '../services/segmentSelector';
import { CompilationEngine } from '../services/compilationEngine';
import { getStorageProvider } from '../storage/factory';

const router = Router();
const compilationEngine = new CompilationEngine();

// ---------------------------------------------------------------------------
// POST /api/media/:mediaId/compile — 启动剪辑任务
// Requirements: 7.1, 7.4, 7.5, 7.6, 7.7, 7.9, 7.10
// ---------------------------------------------------------------------------
router.post('/:mediaId/compile', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  const mediaId = req.params.mediaId as string;
  const { segmentIndices, targetDuration } = req.body;
  const db = getDb();

  try {
    // Verify media exists
    const media = db.prepare(
      'SELECT id, file_path FROM media_items WHERE id = ?'
    ).get(mediaId) as { id: string; file_path: string } | undefined;

    if (!media) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: '媒体文件不存在' },
      });
    }

    // Verify video_segments data is available
    const segmentCount = db.prepare(
      'SELECT COUNT(*) as count FROM video_segments WHERE media_id = ?'
    ).get(mediaId) as { count: number };

    if (segmentCount.count === 0) {
      return res.status(404).json({
        error: { code: 'NO_SEGMENTS', message: '视频片段数据不可用，请先完成视频分析' },
      });
    }

    // Check for active compile jobs (concurrency conflict)
    // Requirements: 7.7
    const activeJob = db.prepare(
      "SELECT id FROM compile_jobs WHERE media_id = ? AND status IN ('queued', 'running') LIMIT 1"
    ).get(mediaId) as { id: string } | undefined;

    if (activeJob) {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: '已有剪辑任务正在执行，请等待完成后再试' },
      });
    }

    // Validate targetDuration if provided
    // Requirements: 7.5, 7.10
    if (targetDuration !== undefined) {
      const validation = validateTargetDuration(targetDuration);
      if (!validation.valid) {
        return res.status(400).json({
          error: { code: 'INVALID_PARAM', message: validation.error },
        });
      }
    }

    // Validate segmentIndices if provided
    // Requirements: 7.4, 7.9
    if (segmentIndices !== undefined) {
      const maxIndex = segmentCount.count - 1;
      const validation = validateSegmentIndices(segmentIndices, maxIndex);
      if (!validation.valid) {
        return res.status(400).json({
          error: { code: 'INVALID_PARAM', message: validation.error },
        });
      }
    }

    // Start compilation (fire-and-forget, status tracked via compile_jobs)
    const compilePromise = segmentIndices
      ? compilationEngine.manualCompile(mediaId, segmentIndices, {
          targetDuration: targetDuration ? Number(targetDuration) : undefined,
        })
      : compilationEngine.autoCompile(mediaId, {
          targetDuration: targetDuration ? Number(targetDuration) : undefined,
        });

    // Don't await — let it run in background
    compilePromise.catch((err) => {
      console.error(`[Compile] Background compilation failed for ${mediaId}:`, err);
    });

    // Return the job status immediately
    // Give a small delay for the job to be created
    await new Promise((resolve) => setTimeout(resolve, 50));
    const jobStatus = compilationEngine.getJobStatus(mediaId);

    return res.status(202).json({
      jobId: jobStatus?.jobId ?? null,
      status: jobStatus?.status ?? 'queued',
      percent: jobStatus?.percent ?? 0,
      message: '剪辑任务已启动',
    });
  } catch (err) {
    console.error(`[Compile] Error starting compilation for ${mediaId}:`, err);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: '启动剪辑任务失败' },
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/media/:mediaId/compile/status — 获取任务状态
// Requirements: 7.2
// ---------------------------------------------------------------------------
router.get('/:mediaId/compile/status', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  const mediaId = req.params.mediaId as string;
  const db = getDb();

  // Verify media exists
  const media = db.prepare('SELECT id FROM media_items WHERE id = ?').get(mediaId) as { id: string } | undefined;
  if (!media) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: '媒体文件不存在' },
    });
  }

  const jobStatus = compilationEngine.getJobStatus(mediaId);

  if (!jobStatus) {
    return res.json({
      status: 'none',
      percent: 0,
      error: null,
      message: '无编译任务记录',
    });
  }

  return res.json({
    jobId: jobStatus.jobId,
    mediaId: jobStatus.mediaId,
    status: jobStatus.status,
    percent: jobStatus.percent,
    error: jobStatus.error ?? null,
    createdAt: jobStatus.createdAt,
  });
});

// ---------------------------------------------------------------------------
// GET /api/media/:mediaId/compile/download — 下载编译结果
// Requirements: 7.3, 7.8
// ---------------------------------------------------------------------------
router.get('/:mediaId/compile/download', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  const mediaId = req.params.mediaId as string;
  const db = getDb();

  // Verify media exists and has compiled_path
  const media = db.prepare(
    'SELECT id, compiled_path FROM media_items WHERE id = ?'
  ).get(mediaId) as { id: string; compiled_path: string | null } | undefined;

  if (!media) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: '媒体文件不存在' },
    });
  }

  if (!media.compiled_path) {
    return res.status(404).json({
      error: { code: 'NOT_COMPILED', message: '剪辑尚未完成，请先启动编译任务' },
    });
  }

  // Serve the compiled video file with Range support (iOS Safari compatibility)
  const storageProvider = getStorageProvider();

  try {
    const localPath = await storageProvider.downloadToTemp(media.compiled_path);

    if (!fs.existsSync(localPath)) {
      return res.status(404).json({
        error: { code: 'FILE_NOT_FOUND', message: '编译文件不存在' },
      });
    }

    // Range-aware streaming for iOS Safari
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
        'Content-Disposition': `inline; filename="compiled_${mediaId}.mp4"`,
      });

      const stream = fs.createReadStream(localPath, { start, end });
      return stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename="compiled_${mediaId}.mp4"`,
      });

      return fs.createReadStream(localPath).pipe(res);
    }
  } catch (err) {
    console.error(`[Compile] Error serving compiled file for ${mediaId}:`, err);
    return res.status(404).json({
      error: { code: 'FILE_NOT_FOUND', message: '编译文件不存在或无法访问' },
    });
  }
});

export default router;
