import { Router, Request, Response } from 'express';
import fs from 'fs';
import { getDb } from '../database';
import { generateThumbnail, generateVideoThumbnail } from '../services/thumbnailGenerator';
import { getStorageProvider } from '../storage/factory';

const router = Router();

const usePresignedUrls = process.env.STORAGE_TYPE === 's3';

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

  const storageProvider = getStorageProvider();
  let thumbLocalPath: string | null = null;

  // If thumbnail already exists in storage, use it
  if (row.thumbnail_path) {
    try {
      const exists = await storageProvider.exists(row.thumbnail_path);
      if (exists) {
        // S3: redirect to presigned URL for cached thumbnails
        if (usePresignedUrls) {
          const url = await storageProvider.getUrl(row.thumbnail_path);
          res.set('Cache-Control', 'public, max-age=86400');
          return res.redirect(302, url);
        }
        thumbLocalPath = await storageProvider.downloadToTemp(row.thumbnail_path);
      }
    } catch {
      // Fall through to regenerate
    }
  }

  // Generate on-the-fly if no thumbnail yet
  if (!thumbLocalPath) {
    try {
      const originalLocalPath = await storageProvider.downloadToTemp(row.file_path);
      const thumbRelPath = row.media_type === 'video'
        ? await generateVideoThumbnail(originalLocalPath, row.trip_id, row.id)
        : await generateThumbnail(originalLocalPath, row.trip_id, row.id);
      db.prepare('UPDATE media_items SET thumbnail_path = ? WHERE id = ?').run(thumbRelPath, row.id);
      thumbLocalPath = await storageProvider.downloadToTemp(thumbRelPath);
    } catch (err) {
      console.error(`[MediaServing] On-the-fly thumbnail generation failed for ${row.id}:`, err);
      if (row.media_type === 'video') {
        return res.status(404).json({ error: { code: 'THUMBNAIL_FAILED', message: '视频缩略图生成失败' } });
      }
      return res.status(500).json({ error: { code: 'THUMBNAIL_FAILED', message: '缩略图生成失败' } });
    }
  }

  res.set('Cache-Control', 'public, max-age=86400'); // 24h
  return res.sendFile(thumbLocalPath);
});

// GET /api/media/:id/original — Serve the best available version (optimized/compiled or original)
// For S3 storage: redirect to presigned URL (bypasses server as middleman)
router.get('/:id/original', async (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare(
    'SELECT id, file_path, media_type, optimized_path, compiled_path FROM media_items WHERE id = ?'
  ).get(req.params.id) as Pick<MediaItemRow, 'id' | 'file_path' | 'media_type' | 'optimized_path' | 'compiled_path'> | undefined;

  if (!row) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '媒体文件不存在' } });
  }

  const storageProvider = getStorageProvider();

  // Determine which file to serve
  let servePath: string | null = null;

  // For videos: serve compiled version by default, unless ?original=true
  if (row.media_type === 'video') {
    const wantOriginal = req.query.original === 'true';
    if (!wantOriginal && row.compiled_path) {
      servePath = row.compiled_path;
    }
  }

  // For images: serve optimized version if available, verify it exists
  if (!servePath && row.media_type === 'image' && row.optimized_path) {
    try {
      const exists = await storageProvider.exists(row.optimized_path);
      if (exists) {
        servePath = row.optimized_path;
      }
    } catch {
      // Fall through to original
    }
  }

  // Fallback: original file
  if (!servePath) {
    servePath = row.file_path;
  }

  // S3: redirect to presigned URL (browser downloads directly from S3)
  if (usePresignedUrls) {
    try {
      const url = await storageProvider.getUrl(servePath);
      res.set('Cache-Control', 'private, max-age=3600');
      return res.redirect(302, url);
    } catch {
      return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '文件不存在' } });
    }
  }

  // Non-S3: download to temp and sendFile
  try {
    const localPath = await storageProvider.downloadToTemp(servePath);
    if (!fs.existsSync(localPath)) {
      return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '文件不存在' } });
    }
    res.set('Cache-Control', 'public, max-age=3600');
    return res.sendFile(localPath);
  } catch {
    return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '文件不存在' } });
  }
});

// GET /api/media/:id/raw — Always serve the original file regardless of optimized/compiled versions
router.get('/:id/raw', async (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare(
    'SELECT id, file_path FROM media_items WHERE id = ?'
  ).get(req.params.id) as Pick<MediaItemRow, 'id' | 'file_path'> | undefined;

  if (!row) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '媒体文件不存在' } });
  }

  const storageProvider = getStorageProvider();

  // S3: redirect to presigned URL
  if (usePresignedUrls) {
    try {
      const url = await storageProvider.getUrl(row.file_path);
      return res.redirect(302, url);
    } catch {
      return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '原始文件不存在' } });
    }
  }

  try {
    const localPath = await storageProvider.downloadToTemp(row.file_path);
    if (!fs.existsSync(localPath)) {
      return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '原始文件不存在' } });
    }
    return res.sendFile(localPath);
  } catch {
    return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '原始文件不存在' } });
  }
});

export default router;
