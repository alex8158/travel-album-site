import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import { classify } from '../services/fileClassifier';
import { MediaItemRow, rowToMediaItem } from '../helpers/mediaItemRow';
import { authMiddleware, requireAuth } from '../middleware/auth';
import { TripRow } from '../helpers/tripRow';
import { getStorageProvider } from '../storage/factory';
import { generateTags } from '../services/tagGenerator';
import { getTempDir } from '../helpers/tempDir';


const router = Router();

const SUPPORTED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
]);

const EXTENSION_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
};

const SUPPORTED_EXTENSIONS = new Set(Object.keys(EXTENSION_TO_MIME));

function isSupportedFile(mimetype: string, originalname: string): boolean {
  if (SUPPORTED_MIME_TYPES.has(mimetype)) return true;
  const ext = path.extname(originalname).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

function getFileExtension(originalname: string, mimetype: string): string {
  // Prefer original extension if it's a supported one
  const origExt = path.extname(originalname).toLowerCase();
  if (SUPPORTED_EXTENSIONS.has(origExt)) return origExt;

  // Fall back to mime-based extension
  const mimeToExt: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/x-msvideo': '.avi',
    'video/x-matroska': '.mkv',
  };
  return mimeToExt[mimetype] || origExt || '.bin';
}



// Use multer disk storage to avoid buffering large files in memory
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, getTempDir());
  },
  filename: (_req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const upload = multer({ storage });

// POST /api/trips/:id/media — Upload a media file (requires auth + trip owner/admin)
router.post('/:id/media', authMiddleware, requireAuth, upload.single('file'), async (req: Request, res: Response) => {
  const tripId = req.params.id as string;
  const db = getDb();

  // Helper to clean up temp file left by diskStorage
  const cleanupTempFile = () => {
    if (req.file?.path) {
      try {
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
      } catch (cleanupErr) {
        console.warn(`[Upload] Failed to clean up temp file ${req.file.path}:`, cleanupErr);
      }
    }
  };

  try {
    // Verify trip exists
    const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
    if (!trip) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
    }

    // Verify user is trip owner or admin
    if (req.user!.role !== 'admin' && trip.user_id !== req.user!.userId) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
    }

    // Check file was provided
    if (!req.file) {
      return res.status(400).json({ error: { code: 'NO_FILE', message: '未提供文件' } });
    }

    const file = req.file;

    // Validate file format
    if (!isSupportedFile(file.mimetype, file.originalname)) {
      return res.status(400).json({
        error: {
          code: 'UNSUPPORTED_FORMAT',
          message: `不支持的文件格式: ${file.mimetype}。支持的格式: JPEG, PNG, WebP, HEIC, MP4, MOV, AVI, MKV`,
        },
      });
    }

    const mediaId = uuidv4();
    const ext = getFileExtension(file.originalname, file.mimetype);
    const filename = `${mediaId}${ext}`;
    const relativePath = `${tripId}/originals/${filename}`;
    const tempFilePath = file.path;

    // Save file via StorageProvider using a read stream from disk
    const storageProvider = getStorageProvider();
    await storageProvider.save(relativePath, fs.createReadStream(tempFilePath));

    // Get file size from disk
    const fileSize = fs.statSync(tempFilePath).size;

    // Determine effective mime type
    const effectiveMime = SUPPORTED_MIME_TYPES.has(file.mimetype)
      ? file.mimetype
      : EXTENSION_TO_MIME[ext] || file.mimetype;

    const now = new Date().toISOString();
    const userId = req.user!.userId;

    db.prepare(
      `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, user_id, visibility, processing_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(mediaId, tripId, relativePath, 'unknown', effectiveMime, file.originalname, fileSize, userId, 'public', 'none', now);

    // Auto-classify file type using the temp file directly (no need to download again)
    try {
      const classification = await classify(tempFilePath);
      db.prepare(
        `UPDATE media_items SET media_type = ?, mime_type = ? WHERE id = ?`
      ).run(classification.type, classification.mimeType, mediaId);
    } catch (err) {
      console.error(`[FileClassifier] Error classifying file ${mediaId}:`, err);
      // Leave as 'unknown' — non-fatal
    }

    // Generate tags and insert into media_tags table
    try {
      const classifiedRow = db.prepare('SELECT media_type FROM media_items WHERE id = ?').get(mediaId) as { media_type: string } | undefined;
      const mediaType = classifiedRow?.media_type || 'unknown';
      const tags = generateTags(mediaId, trip.title, mediaType, file.originalname, new Date());
      const insertTag = db.prepare(
        'INSERT INTO media_tags (id, media_id, tag_name, created_at) VALUES (?, ?, ?, ?)'
      );
      for (const tag of tags) {
        insertTag.run(tag.id, tag.mediaId, tag.tagName, tag.createdAt);
      }
    } catch (err) {
      console.error(`[TagGenerator] Error generating tags for ${mediaId}:`, err);
      // Non-fatal — media item is still created successfully
    }

    const row = db.prepare('SELECT * FROM media_items WHERE id = ?').get(mediaId) as MediaItemRow;
    return res.status(201).json(rowToMediaItem(row));
  } finally {
    // Always clean up the temp file, whether success or failure
    cleanupTempFile();
  }
});

// PUT /api/trips/:id/media/visibility — Batch change visibility for all media in a trip (owner or admin)
router.put('/:id/media/visibility', authMiddleware, requireAuth, (req: Request, res: Response) => {
  const tripId = req.params.id;
  const { visibility } = req.body;

  if (visibility !== 'public' && visibility !== 'private') {
    return res.status(400).json({
      error: { code: 'INVALID_VISIBILITY', message: '可见性状态无效，必须为 public 或 private' }
    });
  }

  const db = getDb();

  // Verify trip exists
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Verify user is trip owner or admin
  if (req.user!.role !== 'admin' && trip.user_id !== req.user!.userId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
  }

  const result = db.prepare(
    "UPDATE media_items SET visibility = ? WHERE trip_id = ? AND status = 'active'"
  ).run(visibility, tripId);

  return res.json({ updatedCount: result.changes });
});

export default router;
