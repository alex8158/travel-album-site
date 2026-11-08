import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getDb } from '../database';
import { generateThumbnail, generateVideoThumbnail } from '../services/thumbnailGenerator';
import { getStorageProvider } from '../storage/factory';
import { authMiddleware } from '../middleware/auth';
import {
  classifyMediaFileEntry,
  decideMediaFileAccess,
  loadMediaFileAccessRow,
  type MediaFileAccessRow,
  type MediaFileDecision,
  type MediaFileRoute,
} from '../helpers/mediaFileAccess';

// ---------------------------------------------------------------------------
// Range-aware video streaming for iOS Safari compatibility
// iOS Safari requires HTTP Range requests (206 Partial Content) for video playback
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function isVideoMime(mime: string): boolean {
  return mime.startsWith('video/');
}

/**
 * Serve a file with Range request support (required for iOS Safari video playback).
 * For non-video files or requests without Range header, falls back to sendFile.
 * Cache-Control is set by the caller (G-21: always `private, no-store`).
 */
function serveFileWithRange(req: Request, res: Response, localPath: string): void {
  const stat = fs.statSync(localPath);
  const fileSize = stat.size;
  const mime = getMimeType(localPath);

  // For video files, always support Range requests
  if (isVideoMime(mime)) {
    const range = req.headers.range;

    if (range) {
      // Parse Range header: "bytes=start-end"
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mime,
      });

      const stream = fs.createReadStream(localPath, { start, end });
      stream.pipe(res);
    } else {
      // No Range header — return full file with Accept-Ranges to signal support
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
      });

      fs.createReadStream(localPath).pipe(res);
    }
  } else {
    // Non-video: sendFile handles conditional requests (304) and HEAD. It only
    // runs after the access decision. cacheControl:false keeps our header.
    res.sendFile(localPath, { cacheControl: false });
  }
}

const router = Router();

const usePresignedUrls = process.env.STORAGE_TYPE === 's3';

// ---------------------------------------------------------------------------
// Access control (multi-user-system G-21, 需求 9 AC 16–23)
//
// Order for every request, GET and HEAD alike:
//   1. authMiddleware: Bearer only, invalid token = anonymous.
//   2. Cache-Control: private, no-store + Vary: Authorization (merged), before
//      any branch, so 200 / 206 / 302 / 304 / 404 / 500 all carry them.
//   3. One read-only SELECT (media LEFT JOIN trips), then the pure decision.
//   4. Denied or missing: one identical 404. Nothing else has run: no storage
//      lookup, no download, no thumbnail generation, no UPDATE, no signing.
//   5. Only then storage work, thumbnail generation, signing, redirect, Range.
// ---------------------------------------------------------------------------

const NOT_FOUND_BODY = { error: { code: 'NOT_FOUND', message: '媒体文件不存在' } };

function setPrivateNoStore(res: Response): void {
  res.set('Cache-Control', 'private, no-store');
  res.vary('Authorization');
}

function sendMediaNotFound(res: Response): Response {
  return res.status(404).json(NOT_FOUND_BODY);
}

type Authorized = { row: MediaFileAccessRow; decision: Extract<MediaFileDecision, { allowed: true }> };

function authorize(req: Request, route: MediaFileRoute): Authorized | null {
  const entry = classifyMediaFileEntry(route, req.query.original);
  const row = loadMediaFileAccessRow(getDb(), req.params.id as string);
  const decision = decideMediaFileAccess(row, req.user, entry);
  if (!decision.allowed || !row) return null;
  return { row, decision };
}

/**
 * A non-owner video is served only from an available compiled file
 * (AC 18). `compiled_path` being set is not enough; there is no fallback.
 */
async function compiledFileAvailable(row: MediaFileAccessRow): Promise<boolean> {
  if (!row.compiled_path) return false;
  try {
    return await getStorageProvider().exists(row.compiled_path);
  } catch {
    return false;
  }
}

// GET /api/media/:id/thumbnail — Serve thumbnail, generate on-the-fly if missing
router.get('/:id/thumbnail', authMiddleware, async (req: Request, res: Response) => {
  setPrivateNoStore(res);
  const auth = authorize(req, 'thumbnail');
  if (!auth) return sendMediaNotFound(res);
  const { row, decision } = auth;

  if (decision.compiledOnly && !(await compiledFileAvailable(row))) {
    return sendMediaNotFound(res);
  }

  const db = getDb();
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
          return res.redirect(302, url);
        }
        thumbLocalPath = await storageProvider.downloadToTemp(row.thumbnail_path);
      }
    } catch {
      // Fall through to regenerate
    }
  }

  // Generate on-the-fly if no thumbnail yet (allowed requesters only)
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

  return res.sendFile(thumbLocalPath, { cacheControl: false });
});

// GET /api/media/:id/original — Serve the best available version (optimized/compiled or original)
// `?original=true` is the raw-upload entry and is owner/admin-only (AC 18).
// For S3 storage: redirect to presigned URL (bypasses server as middleman)
router.get('/:id/original', authMiddleware, async (req: Request, res: Response) => {
  setPrivateNoStore(res);
  const auth = authorize(req, 'original');
  if (!auth) return sendMediaNotFound(res);
  const { row, decision } = auth;

  const storageProvider = getStorageProvider();

  // Determine which file to serve
  let servePath: string | null = null;

  if (decision.compiledOnly) {
    // Non-owner video: the compiled file only. No preview proxy, no original.
    if (!(await compiledFileAvailable(row))) return sendMediaNotFound(res);
    servePath = row.compiled_path;
  } else {
    // For videos: serve compiled version by default, unless ?original=true
    if (row.media_type === 'video') {
      const wantOriginal = req.query.original === 'true';
      if (!wantOriginal && row.compiled_path) {
        servePath = row.compiled_path;
      } else if (!wantOriginal && row.preview_proxy_path) {
        // Fallback to preview proxy (much smaller than original)
        servePath = row.preview_proxy_path;
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
  }

  if (!servePath) return sendMediaNotFound(res);

  // S3: redirect to presigned URL (browser downloads directly from S3)
  if (usePresignedUrls) {
    try {
      const url = await storageProvider.getUrl(servePath);
      return res.redirect(302, url);
    } catch {
      return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '文件不存在' } });
    }
  }

  // Non-S3: download to temp and serve with Range support
  try {
    const localPath = await storageProvider.downloadToTemp(servePath);
    if (!fs.existsSync(localPath)) {
      return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '文件不存在' } });
    }
    return serveFileWithRange(req, res, localPath);
  } catch {
    return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '文件不存在' } });
  }
});

// GET /api/media/:id/raw — Always serve the original file regardless of optimized/compiled versions.
// Owner/admin only (AC 18).
router.get('/:id/raw', authMiddleware, async (req: Request, res: Response) => {
  setPrivateNoStore(res);
  const auth = authorize(req, 'raw');
  if (!auth) return sendMediaNotFound(res);
  const { row } = auth;

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
    return serveFileWithRange(req, res, localPath);
  } catch {
    return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '原始文件不存在' } });
  }
});

export default router;
