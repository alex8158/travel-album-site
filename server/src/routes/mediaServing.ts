import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { getDb } from '../database';
import { generateThumbnail, generateVideoThumbnail } from '../services/thumbnailGenerator';

const router = Router();

const serverRoot = path.join(__dirname, '..', '..');

interface MediaItemRow {
  id: string;
  trip_id: string;
  file_path: string;
  thumbnail_path: string | null;
  media_type: string;
  status: string;
  trashed_reason: string | null;
  processing_error: string | null;
  optimized_path: string | null;
  compiled_path: string | null;
}

// GET /api/media/:id/thumbnail — Serve thumbnail, generate on-the-fly if missing
router.get('/:id/thumbnail', async (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare(
    'SELECT id, trip_id, file_path, thumbnail_path, media_type, status, trashed_reason, processing_error, optimized_path, compiled_path FROM media_items WHERE id = ?'
  ).get(req.params.id) as MediaItemRow | undefined;

  if (!row) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '媒体文件不存在' } });
  }

  let thumbAbsPath: string | null = null;

  // If thumbnail already exists on disk, use it
  if (row.thumbnail_path) {
    const candidate = path.resolve(serverRoot, row.thumbnail_path);
    if (fs.existsSync(candidate)) {
      thumbAbsPath = candidate;
    }
  }

  // Generate on-the-fly if no thumbnail yet
  if (!thumbAbsPath) {
    try {
      const originalAbs = path.resolve(serverRoot, row.file_path);
      const thumbRelPath = row.media_type === 'video'
        ? await generateVideoThumbnail(originalAbs, row.trip_id, row.id)
        : await generateThumbnail(originalAbs, row.trip_id, row.id);
      db.prepare('UPDATE media_items SET thumbnail_path = ? WHERE id = ?').run(thumbRelPath, row.id);
      thumbAbsPath = path.resolve(serverRoot, thumbRelPath);
    } catch (err) {
      console.error(`[MediaServing] On-the-fly thumbnail generation failed for ${row.id}:`, err);
      if (row.media_type === 'video') {
        return res.status(404).json({ error: { code: 'THUMBNAIL_FAILED', message: '视频缩略图生成失败' } });
      }
      return res.status(500).json({ error: { code: 'THUMBNAIL_FAILED', message: '缩略图生成失败' } });
    }
  }

  return res.sendFile(thumbAbsPath);
});

// GET /api/media/:id/original — Serve the best available version (optimized/compiled or original)
router.get('/:id/original', (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare(
    'SELECT id, file_path, media_type, optimized_path, compiled_path FROM media_items WHERE id = ?'
  ).get(req.params.id) as Pick<MediaItemRow, 'id' | 'file_path' | 'media_type' | 'optimized_path' | 'compiled_path'> | undefined;

  if (!row) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '媒体文件不存在' } });
  }

  // For videos: serve compiled version by default, unless ?original=true
  if (row.media_type === 'video') {
    const wantOriginal = req.query.original === 'true';
    if (!wantOriginal && row.compiled_path) {
      const compiledAbs = path.resolve(serverRoot, row.compiled_path);
      if (fs.existsSync(compiledAbs)) {
        return res.sendFile(compiledAbs);
      }
    }
  }

  // For images: serve optimized version if available
  if (row.media_type === 'image' && row.optimized_path) {
    const optimizedAbs = path.resolve(serverRoot, row.optimized_path);
    if (fs.existsSync(optimizedAbs)) {
      return res.sendFile(optimizedAbs);
    }
  }

  // Fallback: serve original file
  const absPath = path.resolve(serverRoot, row.file_path);
  if (!fs.existsSync(absPath)) {
    return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '原始文件不存在' } });
  }

  return res.sendFile(absPath);
});

// GET /api/media/:id/raw — Always serve the original file regardless of optimized/compiled versions
router.get('/:id/raw', (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare(
    'SELECT id, file_path FROM media_items WHERE id = ?'
  ).get(req.params.id) as Pick<MediaItemRow, 'id' | 'file_path'> | undefined;

  if (!row) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '媒体文件不存在' } });
  }

  const absPath = path.resolve(serverRoot, row.file_path);
  if (!fs.existsSync(absPath)) {
    return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '原始文件不存在' } });
  }

  return res.sendFile(absPath);
});

export default router;
