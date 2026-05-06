import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';

const router = Router({ mergeParams: true });

interface MediaAnalysisRow {
  id: string;
  media_id: string;
  blur_score: number | null;
  sharpness_score: number | null;
  exposure_score: number | null;
  color_score: number | null;
  noise_score: number | null;
  aesthetic_score: number | null;
  quality_score: number | null;
  is_blurry: number;
  is_overexposed: number;
  is_underexposed: number;
  is_duplicate: number;
  is_recommended: number;
  recommendation: string | null;
  reason: string | null;
  analysis_version: string | null;
  created_at: string;
}

// POST /api/media/:mediaId/analysis — Create a new analysis record
router.post('/', (req: Request, res: Response) => {
  const { mediaId } = req.params;
  const {
    blur_score,
    sharpness_score,
    exposure_score,
    color_score,
    noise_score,
    aesthetic_score,
    quality_score,
    is_blurry,
    is_overexposed,
    is_underexposed,
    is_duplicate,
    is_recommended,
    recommendation,
    reason,
    analysis_version,
  } = req.body;

  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO media_analysis (id, media_id, blur_score, sharpness_score, exposure_score, color_score, noise_score, aesthetic_score, quality_score, is_blurry, is_overexposed, is_underexposed, is_duplicate, is_recommended, recommendation, reason, analysis_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    mediaId,
    blur_score ?? null,
    sharpness_score ?? null,
    exposure_score ?? null,
    color_score ?? null,
    noise_score ?? null,
    aesthetic_score ?? null,
    quality_score ?? null,
    is_blurry ?? 0,
    is_overexposed ?? 0,
    is_underexposed ?? 0,
    is_duplicate ?? 0,
    is_recommended ?? 0,
    recommendation ?? null,
    reason ?? null,
    analysis_version ?? null,
    now,
  );

  const row = db.prepare('SELECT * FROM media_analysis WHERE id = ?').get(id) as MediaAnalysisRow;
  return res.status(201).json(row);
});

// GET /api/media/:mediaId/analysis — Get latest analysis or full history
router.get('/', (req: Request, res: Response) => {
  const { mediaId } = req.params;
  const { history } = req.query;
  const db = getDb();

  if (history === 'true') {
    const rows = db.prepare(
      'SELECT * FROM media_analysis WHERE media_id = ? ORDER BY created_at DESC'
    ).all(mediaId) as MediaAnalysisRow[];
    return res.json(rows);
  }

  // Default: return only the latest record
  const row = db.prepare(
    'SELECT * FROM media_analysis WHERE media_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(mediaId) as MediaAnalysisRow | undefined;

  if (!row) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: '该媒体没有分析记录' },
    });
  }

  return res.json(row);
});

// PUT /api/media/:mediaId/analysis/:analysisId — Update an analysis record
router.put('/:analysisId', (req: Request, res: Response) => {
  const { analysisId } = req.params;
  const db = getDb();

  const existing = db.prepare('SELECT * FROM media_analysis WHERE id = ?').get(analysisId) as MediaAnalysisRow | undefined;
  if (!existing) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: '分析记录不存在' },
    });
  }

  const {
    blur_score,
    sharpness_score,
    exposure_score,
    color_score,
    noise_score,
    aesthetic_score,
    quality_score,
    is_blurry,
    is_overexposed,
    is_underexposed,
    is_duplicate,
    is_recommended,
    recommendation,
    reason,
    analysis_version,
  } = req.body;

  db.prepare(
    `UPDATE media_analysis SET
      blur_score = ?,
      sharpness_score = ?,
      exposure_score = ?,
      color_score = ?,
      noise_score = ?,
      aesthetic_score = ?,
      quality_score = ?,
      is_blurry = ?,
      is_overexposed = ?,
      is_underexposed = ?,
      is_duplicate = ?,
      is_recommended = ?,
      recommendation = ?,
      reason = ?,
      analysis_version = ?
     WHERE id = ?`
  ).run(
    blur_score ?? existing.blur_score,
    sharpness_score ?? existing.sharpness_score,
    exposure_score ?? existing.exposure_score,
    color_score ?? existing.color_score,
    noise_score ?? existing.noise_score,
    aesthetic_score ?? existing.aesthetic_score,
    quality_score ?? existing.quality_score,
    is_blurry ?? existing.is_blurry,
    is_overexposed ?? existing.is_overexposed,
    is_underexposed ?? existing.is_underexposed,
    is_duplicate ?? existing.is_duplicate,
    is_recommended ?? existing.is_recommended,
    recommendation ?? existing.recommendation,
    reason ?? existing.reason,
    analysis_version ?? existing.analysis_version,
    analysisId,
  );

  const updated = db.prepare('SELECT * FROM media_analysis WHERE id = ?').get(analysisId) as MediaAnalysisRow;
  return res.json(updated);
});

export default router;
