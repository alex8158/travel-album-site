import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';

const router = Router({ mergeParams: true });

const VALID_VERSION_TYPES = [
  'original',
  'thumbnail',
  'preview',
  'enhanced',
  'ai_refined',
  'proxy',
  'segment',
  'final_output',
] as const;

type VersionType = typeof VALID_VERSION_TYPES[number];

interface MediaVersionRow {
  id: string;
  media_id: string;
  version_type: string;
  file_path: string;
  file_size: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  model_name: string | null;
  processor_name: string | null;
  params: string | null;
  status: string;
  created_at: string;
}

function isValidVersionType(value: string): value is VersionType {
  return VALID_VERSION_TYPES.includes(value as VersionType);
}

// POST /api/media/:mediaId/versions — Create a new version record
router.post('/', (req: Request, res: Response) => {
  const { mediaId } = req.params;
  const { version_type, file_path, file_size, width, height, duration, model_name, processor_name, params, status } = req.body;

  // Validate version_type
  if (!version_type || !isValidVersionType(version_type)) {
    return res.status(400).json({
      error: {
        code: 'INVALID_VERSION_TYPE',
        message: `无效的版本类型: ${version_type}。有效值: ${VALID_VERSION_TYPES.join(', ')}`,
      },
    });
  }

  // Validate required field: file_path
  if (!file_path || typeof file_path !== 'string') {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: '缺少必填字段: file_path' },
    });
  }

  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO media_versions (id, media_id, version_type, file_path, file_size, width, height, duration, model_name, processor_name, params, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    mediaId,
    version_type,
    file_path,
    file_size ?? null,
    width ?? null,
    height ?? null,
    duration ?? null,
    model_name ?? null,
    processor_name ?? null,
    params ?? null,
    status ?? 'ready',
    now,
  );

  const row = db.prepare('SELECT * FROM media_versions WHERE id = ?').get(id) as MediaVersionRow;
  return res.status(201).json(row);
});

// GET /api/media/:mediaId/versions — List all versions for a media item
router.get('/', (req: Request, res: Response) => {
  const { mediaId } = req.params;
  const db = getDb();

  const rows = db.prepare(
    'SELECT * FROM media_versions WHERE media_id = ? ORDER BY created_at DESC'
  ).all(mediaId) as MediaVersionRow[];

  return res.json(rows);
});

// GET /api/media/:mediaId/versions/:versionId — Get a single version
router.get('/:versionId', (req: Request, res: Response) => {
  const { versionId } = req.params;
  const db = getDb();

  const row = db.prepare('SELECT * FROM media_versions WHERE id = ?').get(versionId) as MediaVersionRow | undefined;
  if (!row) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: '版本记录不存在' },
    });
  }

  return res.json(row);
});

// DELETE /api/media/:mediaId/versions/:versionId — Delete a version record
router.delete('/:versionId', (req: Request, res: Response) => {
  const { versionId } = req.params;
  const db = getDb();

  const row = db.prepare('SELECT * FROM media_versions WHERE id = ?').get(versionId) as MediaVersionRow | undefined;
  if (!row) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: '版本记录不存在' },
    });
  }

  db.prepare('DELETE FROM media_versions WHERE id = ?').run(versionId);
  return res.status(204).send();
});

export default router;
