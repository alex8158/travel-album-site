import { Router, Request, Response } from 'express';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { getDb } from '../database';
import { authMiddleware, requireAuth } from '../middleware/auth';
import { TripRow } from '../helpers/tripRow';
import { getStorageProvider } from '../storage/factory';
import { getTempDir } from '../helpers/tempDir';

const router = Router();

interface EditParams {
  brightness: number;  // -100 to 100
  contrast: number;    // -100 to 100
  saturation: number;  // -100 to 100
  sharpen: number;     // 0 to 100
}

interface MediaRow {
  id: string;
  trip_id: string;
  file_path: string;
  media_type: string;
}

// POST /api/media/:id/edit — Apply manual edit parameters and regenerate optimized image
router.post('/:id/edit', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  const mediaId = req.params.id;
  const db = getDb();

  const row = db.prepare(
    'SELECT id, trip_id, file_path, media_type FROM media_items WHERE id = ?'
  ).get(mediaId) as MediaRow | undefined;

  if (!row) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '媒体文件不存在' } });
  }

  if (row.media_type !== 'image') {
    return res.status(400).json({ error: { code: 'INVALID_TYPE', message: '仅支持图片编辑' } });
  }

  // Verify ownership
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(row.trip_id) as TripRow | undefined;
  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }
  if (req.user!.role !== 'admin' && trip.user_id !== req.user!.userId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
  }

  const params = req.body as EditParams;

  // Validate params
  if (typeof params.brightness !== 'number' || typeof params.contrast !== 'number' ||
      typeof params.saturation !== 'number' || typeof params.sharpen !== 'number') {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '参数格式错误' } });
  }

  const storageProvider = getStorageProvider();
  const ext = path.extname(row.file_path).slice(1) || 'jpg';
  const outputFilename = `${mediaId}_opt.${ext}`;
  const outputRelativePath = `${row.trip_id}/optimized/${outputFilename}`;
  const tempPath = path.join(getTempDir(), outputFilename);

  try {
    const localPath = await storageProvider.downloadToTemp(row.file_path);

    let pipeline = sharp(localPath, { failOn: 'none' });

    // Brightness: map -100..100 to gamma. brightness > 0 = brighter (gamma < 1), < 0 = darker (gamma > 1)
    if (params.brightness !== 0) {
      // Map: -100 → gamma 2.0 (darker), 0 → gamma 1.0, +100 → gamma 0.5 (brighter)
      const gamma = 1 / (1 + params.brightness / 100);
      pipeline = pipeline.gamma(Math.max(0.1, Math.min(gamma, 3.0)));
    }

    // Contrast: use linear for contrast adjustment
    if (params.contrast !== 0) {
      // Map: -100 → a=0.5, 0 → a=1.0, +100 → a=2.0
      const a = 1 + params.contrast / 100;
      const b = 128 * (1 - a);
      pipeline = pipeline.linear(Math.max(0.1, a), b);
    }

    // Saturation: use modulate
    if (params.saturation !== 0) {
      const sat = 1 + params.saturation / 100;
      pipeline = pipeline.modulate({ saturation: Math.max(0, sat) });
    }

    // Sharpen
    if (params.sharpen > 0) {
      const sigma = 0.3 + (params.sharpen / 100) * 1.7; // 0.3 to 2.0
      pipeline = pipeline.sharpen({ sigma });
    }

    // Resize to max 2048px for web display (same as auto-optimize)
    pipeline = pipeline.resize(2048, 2048, { fit: 'inside', withoutEnlargement: true });

    pipeline = pipeline.withMetadata();

    const lowerExt = ext.toLowerCase();
    if (lowerExt === 'jpeg' || lowerExt === 'jpg') {
      pipeline = pipeline.jpeg({ quality: 85 });
    }

    await pipeline.toFile(tempPath);

    const buffer = fs.readFileSync(tempPath);
    await storageProvider.save(outputRelativePath, buffer);

    // Update DB
    db.prepare('UPDATE media_items SET optimized_path = ? WHERE id = ?').run(outputRelativePath, mediaId);

    return res.json({ mediaId, optimizedPath: outputRelativePath, status: 'success' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: { code: 'EDIT_FAILED', message } });
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
  }
});

export default router;
