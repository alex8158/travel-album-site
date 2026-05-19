/**
 * Merge Route — POST /api/media/merge
 *
 * 合并多个已编译视频为一个新视频。
 *
 * Requirements: 4.1, 4.2, 4.3, 5.1, 5.2, 5.3
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../database';
import { authMiddleware, requireAuth } from '../middleware/auth';
import { MergeEngine } from '../services/mergeEngine';
import { TripRow } from '../helpers/tripRow';

const router = Router();

// POST /api/media/merge — Merge multiple compiled videos into one
router.post(
  '/merge',
  authMiddleware,
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const userRole = req.user!.role;
    const { tripId, sourceMediaIds, name } = req.body ?? {};

    // Validate tripId is provided
    if (!tripId || typeof tripId !== 'string') {
      return res.status(400).json({
        error: { code: 'INVALID_PARAMS', message: '必须提供 tripId' },
      });
    }

    // Validate sourceMediaIds is an array with at least 2 items
    if (!Array.isArray(sourceMediaIds) || sourceMediaIds.length < 2) {
      return res.status(400).json({
        error: { code: 'INSUFFICIENT_SOURCES', message: '至少需要选择 2 个源视频' },
      });
    }

    const db = getDb();

    // Verify target trip exists and user has permission
    const targetTrip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
    if (!targetTrip) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: '目标相册不存在' },
      });
    }

    if (userRole !== 'admin' && targetTrip.user_id !== userId) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: '无权操作目标相册' },
      });
    }

    // Validate all source videos exist and have compiled_path
    for (const mediaId of sourceMediaIds) {
      if (typeof mediaId !== 'string') {
        return res.status(400).json({
          error: { code: 'INVALID_PARAMS', message: '源视频 ID 必须为字符串' },
        });
      }

      const row = db.prepare(
        "SELECT id, compiled_path, trip_id FROM media_items WHERE id = ? AND status = 'active'"
      ).get(mediaId) as { id: string; compiled_path: string | null; trip_id: string } | undefined;

      if (!row) {
        return res.status(400).json({
          error: { code: 'INVALID_SOURCES', message: `源视频不存在: ${mediaId}` },
        });
      }

      if (!row.compiled_path) {
        return res.status(400).json({
          error: { code: 'INVALID_SOURCES', message: '所有源视频必须已完成编译' },
        });
      }

      // Verify user has permission on the source video's trip
      const sourceTrip = db.prepare('SELECT * FROM trips WHERE id = ?').get(row.trip_id) as TripRow | undefined;
      if (!sourceTrip) {
        return res.status(400).json({
          error: { code: 'INVALID_SOURCES', message: `源视频所属相册不存在: ${mediaId}` },
        });
      }

      if (userRole !== 'admin' && sourceTrip.user_id !== userId) {
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: '无权操作源视频所属相册' },
        });
      }
    }

    // Execute merge
    const mergeEngine = new MergeEngine();
    const result = await mergeEngine.merge({
      userId,
      tripId,
      sourceMediaIds,
      name: name || undefined,
    });

    if (!result.success) {
      return res.status(500).json({
        error: { code: 'MERGE_FAILED', message: result.error || '合并失败' },
      });
    }

    // Determine the name used for the merged video
    const mergedRow = db.prepare('SELECT original_filename FROM media_items WHERE id = ?').get(result.mediaId!) as { original_filename: string } | undefined;
    const mergedName = mergedRow?.original_filename || name || '合并视频';

    return res.status(200).json({
      mediaId: result.mediaId,
      filePath: result.filePath,
      name: mergedName,
    });
  },
);

export default router;
