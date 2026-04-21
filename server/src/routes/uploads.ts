import { Router, Request, Response } from 'express';
import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';
import { authMiddleware, requireAuth } from '../middleware/auth';
import { calculatePartSize, MULTIPART_THRESHOLD, SUPPORTED_VIDEO_EXTENSIONS } from '../services/uploadUtils';
import { getTempDir } from '../helpers/tempDir';
import { generateProxies } from '../services/proxyGenerator';

const router = Router();

// Apply auth to all routes
router.use(authMiddleware, requireAuth);

// --- 5.1: POST /init ---
router.post('/init', async (req: Request, res: Response) => {
  const { filename, fileSize, tripId } = req.body;

  if (!filename || !fileSize || !tripId) {
    return res.status(400).json({ error: { code: 'MISSING_FIELDS', message: '缺少必填字段' } });
  }

  // Validate video format
  const ext = path.extname(filename).toLowerCase();
  if (!SUPPORTED_VIDEO_EXTENSIONS.has(ext)) {
    return res.status(400).json({
      error: { code: 'UNSUPPORTED_FORMAT', message: `不支持的文件格式: ${ext}。支持的格式: .mp4, .mov, .avi, .mkv` },
    });
  }

  const db = getDb();

  // Verify trip exists and user has access
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as any;
  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }
  if (req.user!.role !== 'admin' && trip.user_id !== req.user!.userId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
  }

  const mediaId = uuidv4();
  const storageKey = `${tripId}/originals/${mediaId}${ext}`;
  const mode = fileSize > MULTIPART_THRESHOLD ? 'multipart' : 'simple';
  const now = new Date().toISOString();
  const storageProvider = getStorageProvider();

  try {
    // Create media_items record
    db.prepare(
      `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, user_id, visibility, processing_status, storage_key, upload_mode, created_at)
       VALUES (?, ?, ?, 'video', 'video/mp4', ?, ?, ?, 'public', 'uploading', ?, ?, ?)`
    ).run(mediaId, tripId, storageKey, filename, fileSize, req.user!.userId, storageKey, mode, now);

    if (mode === 'multipart') {
      const uploadId = await storageProvider.initMultipartUpload(storageKey);
      const partSize = calculatePartSize(fileSize);
      const totalParts = Math.ceil(fileSize / partSize);

      // Create upload_sessions record
      db.prepare(
        `INSERT INTO upload_sessions (id, media_id, trip_id, storage_key, mode, status, total_parts, part_size, file_size, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
      ).run(uploadId, mediaId, tripId, storageKey, mode, totalParts, partSize, fileSize, now, now);

      // Update media_items with upload_id
      db.prepare('UPDATE media_items SET upload_id = ? WHERE id = ?').run(uploadId, mediaId);

      return res.status(201).json({ mediaId, storageKey, mode, uploadId, partSize, totalParts });
    } else {
      // Simple mode
      const uploadId = uuidv4();
      const presignedUrl = await storageProvider.getPresignedUploadUrl(storageKey);

      db.prepare(
        `INSERT INTO upload_sessions (id, media_id, trip_id, storage_key, mode, status, file_size, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      ).run(uploadId, mediaId, tripId, storageKey, mode, fileSize, now, now);

      db.prepare('UPDATE media_items SET upload_id = ? WHERE id = ?').run(uploadId, mediaId);

      return res.status(201).json({ mediaId, storageKey, mode, uploadId, presignedUrl });
    }
  } catch (err) {
    console.error('[uploads/init] Error:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '初始化上传失败' } });
  }
});

// --- 5.2: POST /:mediaId/parts/presign ---
router.post('/:mediaId/parts/presign', async (req: Request, res: Response) => {
  const mediaId = req.params.mediaId as string;
  const { uploadId, partNumbers } = req.body;
  const db = getDb();

  const session = db.prepare(
    'SELECT * FROM upload_sessions WHERE media_id = ? AND status = ?'
  ).get(mediaId, 'active') as any;

  if (!session) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '上传会话不存在或已完成' } });
  }

  if (session.id !== uploadId) {
    return res.status(409).json({ error: { code: 'UPLOAD_ID_MISMATCH', message: 'uploadId 不匹配' } });
  }

  const storageProvider = getStorageProvider();
  try {
    const parts = await Promise.all(
      (partNumbers as number[]).map(async (partNumber: number) => ({
        partNumber,
        url: await storageProvider.getPresignedPartUrl(session.storage_key, uploadId, partNumber),
      }))
    );
    return res.json({ parts });
  } catch (err) {
    console.error('[uploads/presign] Error:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '获取签名URL失败' } });
  }
});

// --- 5.3: PUT /:mediaId/parts/:partNumber (local storage relay) ---
router.put('/:mediaId/parts/:partNumber', express.raw({ limit: '200mb', type: '*/*' }), async (req: Request, res: Response) => {
  const mediaId = req.params.mediaId as string; const partNumber = req.params.partNumber as string;
  const uploadId = req.query.uploadId as string;
  const db = getDb();

  const session = db.prepare(
    'SELECT * FROM upload_sessions WHERE media_id = ? AND status = ?'
  ).get(mediaId, 'active') as any;

  if (!session) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '上传会话不存在' } });
  }

  if (session.id !== uploadId) {
    return res.status(409).json({ error: { code: 'UPLOAD_ID_MISMATCH', message: 'uploadId 不匹配' } });
  }

  try {
    const uploadDir = path.join(getTempDir(), 'uploads', session.id);
    await fs.promises.mkdir(uploadDir, { recursive: true });

    const partFile = path.join(uploadDir, `part_${partNumber}`);
    const body = req.body as Buffer;

    await fs.promises.writeFile(partFile, body);

    // Compute MD5 ETag
    const hash = crypto.createHash('md5').update(body).digest('hex');

    return res.json({ etag: hash });
  } catch (err) {
    console.error('[uploads/part] Error:', err);
    return res.status(500).json({ error: { code: 'STORAGE_ERROR', message: '分片写入失败' } });
  }
});

// --- 5.3b: PUT /:mediaId/simple (local storage simple relay) ---
router.put('/:mediaId/simple', express.raw({ limit: '200mb', type: '*/*' }), async (req: Request, res: Response) => {
  const mediaId = req.params.mediaId as string;
  const db = getDb();

  const session = db.prepare(
    'SELECT * FROM upload_sessions WHERE media_id = ? AND status = ?'
  ).get(mediaId, 'active') as any;

  if (!session) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '上传会话不存在' } });
  }

  try {
    const storageProvider = getStorageProvider();
    const body = req.body as Buffer;
    await storageProvider.save(session.storage_key, body);

    const hash = crypto.createHash('md5').update(body).digest('hex');
    return res.json({ etag: hash });
  } catch (err) {
    console.error('[uploads/simple] Error:', err);
    return res.status(500).json({ error: { code: 'STORAGE_ERROR', message: '文件写入失败' } });
  }
});

// --- 5.4: POST /:mediaId/complete ---
router.post('/:mediaId/complete', async (req: Request, res: Response) => {
  const mediaId = req.params.mediaId as string;
  const { uploadId, parts } = req.body;
  const db = getDb();

  const session = db.prepare(
    'SELECT * FROM upload_sessions WHERE media_id = ? AND status = ?'
  ).get(mediaId, 'active') as any;

  if (!session) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '上传会话不存在' } });
  }

  if (session.id !== uploadId) {
    return res.status(409).json({ error: { code: 'UPLOAD_ID_MISMATCH', message: 'uploadId 不匹配' } });
  }

  if (!parts || !Array.isArray(parts) || parts.length === 0) {
    return res.status(400).json({ error: { code: 'PARTS_MISMATCH', message: '分片列表无效' } });
  }

  try {
    const storageProvider = getStorageProvider();
    await storageProvider.completeMultipartUpload(session.storage_key, uploadId, parts);

    const now = new Date().toISOString();

    // Update media_items status
    db.prepare('UPDATE media_items SET processing_status = ? WHERE id = ?').run('uploaded', mediaId);

    // Update upload session status
    db.prepare('UPDATE upload_sessions SET status = ?, updated_at = ? WHERE id = ?').run('completed', now, uploadId);

    // Create processing_jobs record
    const jobId = uuidv4();
    db.prepare(
      `INSERT INTO processing_jobs (id, trip_id, status, created_at) VALUES (?, ?, 'queued', ?)`
    ).run(jobId, session.trip_id, now);

    // Fire-and-forget proxy generation
    generateProxies(mediaId, session.trip_id, session.storage_key).catch(err =>
      console.error(`[uploads/complete] proxy generation failed for ${mediaId}:`, err)
    );

    return res.json({ mediaId, status: 'uploaded', processingJobId: jobId });
  } catch (err) {
    console.error('[uploads/complete] Error:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '完成上传失败' } });
  }
});

// --- 5.5: POST /:mediaId/finalize ---
router.post('/:mediaId/finalize', async (req: Request, res: Response) => {
  const mediaId = req.params.mediaId as string;
  const { uploadId } = req.body;
  const db = getDb();

  const session = db.prepare(
    'SELECT * FROM upload_sessions WHERE media_id = ?'
  ).get(mediaId) as any;

  if (!session) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '上传会话不存在' } });
  }

  if (session.id !== uploadId) {
    return res.status(409).json({ error: { code: 'UPLOAD_ID_MISMATCH', message: 'uploadId 不匹配' } });
  }

  if (session.status !== 'active') {
    return res.status(409).json({ error: { code: 'INVALID_STATUS', message: `当前状态为 ${session.status}，无法完成` } });
  }

  // Verify media_items status is uploading
  const media = db.prepare('SELECT processing_status FROM media_items WHERE id = ?').get(mediaId) as any;
  if (!media || media.processing_status !== 'uploading') {
    return res.status(409).json({ error: { code: 'INVALID_STATUS', message: '媒体状态不是上传中' } });
  }

  try {
    const now = new Date().toISOString();

    db.prepare('UPDATE media_items SET processing_status = ? WHERE id = ?').run('uploaded', mediaId);
    db.prepare('UPDATE upload_sessions SET status = ?, updated_at = ? WHERE id = ?').run('completed', now, session.id);

    const jobId = uuidv4();
    db.prepare(
      `INSERT INTO processing_jobs (id, trip_id, status, created_at) VALUES (?, ?, 'queued', ?)`
    ).run(jobId, session.trip_id, now);

    // Fire-and-forget proxy generation
    generateProxies(mediaId, session.trip_id, session.storage_key).catch(err =>
      console.error(`[uploads/finalize] proxy generation failed for ${mediaId}:`, err)
    );

    return res.json({ mediaId, status: 'uploaded', processingJobId: jobId });
  } catch (err) {
    console.error('[uploads/finalize] Error:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '完成上传失败' } });
  }
});

// --- 5.6: GET /:mediaId/status ---
router.get('/:mediaId/status', async (req: Request, res: Response) => {
  const mediaId = req.params.mediaId as string;
  const db = getDb();

  const session = db.prepare(
    'SELECT * FROM upload_sessions WHERE media_id = ?'
  ).get(mediaId) as any;

  if (!session) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '上传会话不存在' } });
  }

  try {
    const storageProvider = getStorageProvider();
    let uploadedParts: Array<{ partNumber: number; etag: string; size: number }> = [];

    if (session.mode === 'multipart' && session.status === 'active') {
      uploadedParts = await storageProvider.listParts(session.storage_key, session.id);
    }

    return res.json({
      mediaId,
      uploadId: session.id,
      mode: session.mode,
      status: session.status,
      uploadedParts,
    });
  } catch (err) {
    console.error('[uploads/status] Error:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '查询状态失败' } });
  }
});

// --- 5.7: POST /:mediaId/abort ---
router.post('/:mediaId/abort', async (req: Request, res: Response) => {
  const mediaId = req.params.mediaId as string;
  const { uploadId } = req.body;
  const db = getDb();

  const session = db.prepare(
    'SELECT * FROM upload_sessions WHERE media_id = ? AND status = ?'
  ).get(mediaId, 'active') as any;

  if (!session) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '上传会话不存在' } });
  }

  if (session.id !== uploadId) {
    return res.status(409).json({ error: { code: 'UPLOAD_ID_MISMATCH', message: 'uploadId 不匹配' } });
  }

  try {
    const storageProvider = getStorageProvider();
    await storageProvider.abortMultipartUpload(session.storage_key, session.id);

    const now = new Date().toISOString();
    db.prepare('UPDATE upload_sessions SET status = ?, updated_at = ? WHERE id = ?').run('aborted', now, session.id);
    db.prepare("UPDATE media_items SET processing_status = ?, status = 'trashed', trashed_reason = 'upload_cancelled' WHERE id = ?").run('cancelled', mediaId);

    return res.json({ mediaId, status: 'cancelled' });
  } catch (err) {
    console.error('[uploads/abort] Error:', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '取消上传失败' } });
  }
});

export default router;
