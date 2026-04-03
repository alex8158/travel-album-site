import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../database';
import { AppError } from '../middleware/errorHandler';
import { MediaItemRow, rowToMediaItem } from '../helpers/mediaItemRow';
import { authMiddleware, requireAuth } from '../middleware/auth';
import { TripRow } from '../helpers/tripRow';
import { getStorageProvider } from '../storage/factory';

const router = Router();

async function deleteFilesFromStorage(row: MediaItemRow): Promise<void> {
  const storageProvider = getStorageProvider();
  if (row.file_path) {
    try { await storageProvider.delete(row.file_path); } catch { /* ignore */ }
  }
  if (row.thumbnail_path) {
    try { await storageProvider.delete(row.thumbnail_path); } catch { /* ignore */ }
  }
  if (row.optimized_path) {
    try { await storageProvider.delete(row.optimized_path); } catch { /* ignore */ }
  }
}

// PUT /api/trips/:id/media/trash — Batch mark media items as trashed
router.put('/trips/:id/media/trash', authMiddleware, requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = getDb();
    const tripId = req.params.id;
    const { mediaIds } = req.body;

    // Validate mediaIds is a non-empty array of strings
    if (!Array.isArray(mediaIds) || mediaIds.length === 0 || !mediaIds.every((id: unknown) => typeof id === 'string')) {
      return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'mediaIds 必须是非空字符串数组' } });
    }

    // Verify trip exists
    const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
    if (!trip) {
      throw new AppError(404, 'NOT_FOUND', '旅行不存在');
    }

    // Check ownership: user must be trip owner or admin
    if (req.user!.role !== 'admin' && trip.user_id !== req.user!.userId) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
    }

    // Update matching active media items belonging to this trip
    const placeholders = mediaIds.map(() => '?').join(',');
    const result = db.prepare(
      `UPDATE media_items SET status = 'trashed', trashed_reason = 'manual'
       WHERE trip_id = ? AND id IN (${placeholders}) AND status = 'active'`
    ).run(tripId, ...mediaIds);

    return res.json({ trashedCount: result.changes });
  } catch (err) {
    next(err);
  }
});

// GET /api/trips/:id/trash — Return all trashed media items for a trip
router.get('/trips/:id/trash', authMiddleware, requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = getDb();
    const tripId = req.params.id;

    const rows = db.prepare(
      "SELECT * FROM media_items WHERE trip_id = ? AND status = 'trashed'"
    ).all(tripId) as MediaItemRow[];

    const items = rows.map((row) => ({
      ...rowToMediaItem(row),
      thumbnailUrl: `/api/media/${row.id}/thumbnail`,
    }));

    return res.json(items);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/trips/:id/trash — Batch permanently delete all trashed files (owner or admin)
router.delete('/trips/:id/trash', authMiddleware, requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = getDb();
    const tripId = req.params.id;

    // Verify trip exists and check ownership
    const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
    if (!trip) {
      throw new AppError(404, 'NOT_FOUND', '旅行不存在');
    }
    if (req.user!.role !== 'admin' && trip.user_id !== req.user!.userId) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
    }

    const rows = db.prepare(
      "SELECT * FROM media_items WHERE trip_id = ? AND status = 'trashed'"
    ).all(tripId) as MediaItemRow[];

    for (const row of rows) {
      await deleteFilesFromStorage(row);
      db.prepare(
        "UPDATE media_items SET status = 'deleted' WHERE id = ?"
      ).run(row.id);
    }

    return res.json({ deletedCount: rows.length });
  } catch (err) {
    next(err);
  }
});

// PUT /api/media/:id/restore — Restore a single trashed item to active (owner or admin)
router.put('/media/:id/restore', authMiddleware, requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = getDb();
    const mediaId = req.params.id;

    const row = db.prepare(
      'SELECT * FROM media_items WHERE id = ?'
    ).get(mediaId) as MediaItemRow | undefined;

    if (!row) {
      throw new AppError(404, 'NOT_FOUND', '媒体文件不存在');
    }

    // Check ownership: media owner, trip owner, or admin
    if (req.user!.role !== 'admin') {
      const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(row.trip_id) as TripRow | undefined;
      if (row.user_id !== req.user!.userId && (!trip || trip.user_id !== req.user!.userId)) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
      }
    }

    if (row.status !== 'trashed') {
      throw new AppError(400, 'INVALID_STATUS', '该文件不在待删除区');
    }

    db.prepare(
      "UPDATE media_items SET status = 'active', trashed_reason = NULL WHERE id = ?"
    ).run(mediaId);

    const updated = db.prepare(
      'SELECT * FROM media_items WHERE id = ?'
    ).get(mediaId) as MediaItemRow;

    return res.json(rowToMediaItem(updated));
  } catch (err) {
    next(err);
  }
});

// PUT /api/media/:id/visibility — Change visibility of a single media item (owner or admin)
router.put('/media/:id/visibility', authMiddleware, requireAuth, (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = getDb();
    const mediaId = req.params.id;
    const { visibility } = req.body;

    if (visibility !== 'public' && visibility !== 'private') {
      return res.status(400).json({
        error: { code: 'INVALID_VISIBILITY', message: '可见性状态无效，必须为 public 或 private' }
      });
    }

    const row = db.prepare(
      'SELECT * FROM media_items WHERE id = ?'
    ).get(mediaId) as MediaItemRow | undefined;

    if (!row) {
      throw new AppError(404, 'NOT_FOUND', '媒体文件不存在');
    }

    // Check ownership: media owner, trip owner, or admin
    if (req.user!.role !== 'admin') {
      const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(row.trip_id) as TripRow | undefined;
      if (row.user_id !== req.user!.userId && (!trip || trip.user_id !== req.user!.userId)) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
      }
    }

    db.prepare('UPDATE media_items SET visibility = ? WHERE id = ?').run(visibility, mediaId);

    const updated = db.prepare('SELECT * FROM media_items WHERE id = ?').get(mediaId) as MediaItemRow;
    return res.json(rowToMediaItem(updated));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/media/:id — Permanently delete a single trashed item (owner or admin)
router.delete('/media/:id', authMiddleware, requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = getDb();
    const mediaId = req.params.id;

    const row = db.prepare(
      'SELECT * FROM media_items WHERE id = ?'
    ).get(mediaId) as MediaItemRow | undefined;

    if (!row) {
      throw new AppError(404, 'NOT_FOUND', '媒体文件不存在');
    }

    // Check ownership: media owner, trip owner, or admin
    if (req.user!.role !== 'admin') {
      const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(row.trip_id) as TripRow | undefined;
      if (row.user_id !== req.user!.userId && (!trip || trip.user_id !== req.user!.userId)) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
      }
    }

    if (row.status !== 'trashed') {
      throw new AppError(400, 'INVALID_STATUS', '只能删除待删除区中的文件');
    }

    await deleteFilesFromStorage(row);

    db.prepare(
      "UPDATE media_items SET status = 'deleted' WHERE id = ?"
    ).run(mediaId);

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
