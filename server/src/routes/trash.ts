import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { getDb } from '../database';
import { AppError } from '../middleware/errorHandler';
import type { MediaItem } from '../types';

const router = Router();
const serverRoot = path.join(__dirname, '..', '..');

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

function rowToMediaItem(row: MediaItemRow): MediaItem {
  return {
    id: row.id,
    tripId: row.trip_id,
    filePath: row.file_path,
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

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore if file doesn't exist
  }
}

function deleteFilesFromDisk(row: MediaItemRow): void {
  if (row.file_path) {
    safeUnlink(path.resolve(serverRoot, row.file_path));
  }
  if (row.thumbnail_path) {
    safeUnlink(path.resolve(serverRoot, row.thumbnail_path));
  }
  if (row.optimized_path) {
    safeUnlink(path.resolve(serverRoot, row.optimized_path));
  }
}

// GET /api/trips/:id/trash — Return all trashed media items for a trip
router.get('/trips/:id/trash', (req: Request, res: Response, next: NextFunction) => {
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

// DELETE /api/trips/:id/trash — Batch permanently delete all trashed files
router.delete('/trips/:id/trash', (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = getDb();
    const tripId = req.params.id;

    const rows = db.prepare(
      "SELECT * FROM media_items WHERE trip_id = ? AND status = 'trashed'"
    ).all(tripId) as MediaItemRow[];

    for (const row of rows) {
      deleteFilesFromDisk(row);
      db.prepare(
        "UPDATE media_items SET status = 'deleted' WHERE id = ?"
      ).run(row.id);
    }

    return res.json({ deletedCount: rows.length });
  } catch (err) {
    next(err);
  }
});

// PUT /api/media/:id/restore — Restore a single trashed item to active
router.put('/media/:id/restore', (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = getDb();
    const mediaId = req.params.id;

    const row = db.prepare(
      'SELECT * FROM media_items WHERE id = ?'
    ).get(mediaId) as MediaItemRow | undefined;

    if (!row) {
      throw new AppError(404, 'NOT_FOUND', '媒体文件不存在');
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

// DELETE /api/media/:id — Permanently delete a single trashed item
router.delete('/media/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = getDb();
    const mediaId = req.params.id;

    const row = db.prepare(
      'SELECT * FROM media_items WHERE id = ?'
    ).get(mediaId) as MediaItemRow | undefined;

    if (!row) {
      throw new AppError(404, 'NOT_FOUND', '媒体文件不存在');
    }

    if (row.status !== 'trashed') {
      throw new AppError(400, 'INVALID_STATUS', '只能删除待删除区中的文件');
    }

    deleteFilesFromDisk(row);

    db.prepare(
      "UPDATE media_items SET status = 'deleted' WHERE id = ?"
    ).run(mediaId);

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
