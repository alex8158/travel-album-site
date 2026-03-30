import { Router, Request, Response } from 'express';
import { getDb } from '../database';
import type { DuplicateGroup } from '../types';

const router = Router();

interface DuplicateGroupRow {
  id: string;
  trip_id: string;
  default_image_id: string | null;
  image_count: number;
  created_at: string;
}

interface MediaItemRow {
  id: string;
  duplicate_group_id: string | null;
}

function rowToGroup(row: DuplicateGroupRow): DuplicateGroup {
  return {
    id: row.id,
    tripId: row.trip_id,
    defaultImageId: row.default_image_id ?? '',
    imageCount: row.image_count,
    createdAt: row.created_at,
  };
}

// GET /api/duplicate-groups/:id/images — Get all images in a duplicate group
router.get('/:id/images', (req: Request, res: Response) => {
  const db = getDb();
  const group = db.prepare('SELECT * FROM duplicate_groups WHERE id = ?').get(req.params.id) as DuplicateGroupRow | undefined;
  if (!group) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '重复组不存在' } });
  }

  const rows = db.prepare(
    'SELECT id, original_filename, thumbnail_path FROM media_items WHERE duplicate_group_id = ?'
  ).all(req.params.id) as Array<{ id: string; original_filename: string; thumbnail_path: string | null }>;

  const images = rows.map(r => ({
    id: r.id,
    originalFilename: r.original_filename,
    thumbnailUrl: `/api/media/${r.id}/thumbnail`,
  }));

  return res.json({ group: rowToGroup(group), images });
});

// PUT /api/duplicate-groups/:id/default — Change default display image
router.put('/:id/default', (req: Request, res: Response) => {
  const { imageId } = req.body;

  if (!imageId || typeof imageId !== 'string') {
    return res.status(400).json({
      error: { code: 'INVALID_IMAGE_ID', message: '必须提供有效的 imageId' },
    });
  }

  const db = getDb();

  const group = db.prepare('SELECT * FROM duplicate_groups WHERE id = ?').get(req.params.id) as DuplicateGroupRow | undefined;
  if (!group) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: '重复组不存在' },
    });
  }

  const mediaItem = db.prepare('SELECT id, duplicate_group_id FROM media_items WHERE id = ?').get(imageId) as MediaItemRow | undefined;
  if (!mediaItem || mediaItem.duplicate_group_id !== req.params.id) {
    return res.status(400).json({
      error: { code: 'IMAGE_NOT_IN_GROUP', message: '该图片不属于此重复组' },
    });
  }

  db.prepare('UPDATE duplicate_groups SET default_image_id = ? WHERE id = ?').run(imageId, req.params.id);

  const updated = db.prepare('SELECT * FROM duplicate_groups WHERE id = ?').get(req.params.id) as DuplicateGroupRow;
  return res.json(rowToGroup(updated));
});

export default router;
