import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import { classify } from '../services/fileClassifier';
import type { MediaItem } from '../types';

const router = Router();

const uploadsBase = path.join(__dirname, '..', '..', 'uploads');

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
    createdAt: row.created_at,
  };
}

// Use multer memory storage so we can validate before writing to disk
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/trips/:id/media — Upload a media file
router.post('/:id/media', upload.single('file'), async (req: Request, res: Response) => {
  const tripId = req.params.id;
  const db = getDb();

  // Verify trip exists
  const trip = db.prepare('SELECT id FROM trips WHERE id = ?').get(tripId);
  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
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
  const tripDir = path.join(uploadsBase, tripId, 'originals');
  fs.mkdirSync(tripDir, { recursive: true });

  const filename = `${mediaId}${ext}`;
  const filePath = path.join(tripDir, filename);

  // Write file to disk
  fs.writeFileSync(filePath, file.buffer);

  // Determine effective mime type
  const effectiveMime = SUPPORTED_MIME_TYPES.has(file.mimetype)
    ? file.mimetype
    : EXTENSION_TO_MIME[ext] || file.mimetype;

  const now = new Date().toISOString();
  const relativePath = `uploads/${tripId}/originals/${filename}`;

  db.prepare(
    `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(mediaId, tripId, relativePath, 'unknown', effectiveMime, file.originalname, file.buffer.length, now);

  // Auto-classify file type using magic bytes / extension fallback
  try {
    const classification = await classify(filePath);
    db.prepare(
      `UPDATE media_items SET media_type = ?, mime_type = ? WHERE id = ?`
    ).run(classification.type, classification.mimeType, mediaId);
  } catch (err) {
    console.error(`[FileClassifier] Error classifying file ${mediaId}:`, err);
    // Leave as 'unknown' — non-fatal
  }

  const row = db.prepare('SELECT * FROM media_items WHERE id = ?').get(mediaId) as MediaItemRow;
  return res.status(201).json(rowToMediaItem(row));
});

export default router;
