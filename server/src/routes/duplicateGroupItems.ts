import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';

const router = Router({ mergeParams: true });

interface DuplicateGroupItemRow {
  id: string;
  group_id: string;
  media_id: string;
  similarity_score: number | null;
  quality_score: number | null;
  recommendation: string | null;
  reason: string | null;
  created_at: string;
}

// POST /api/duplicate-groups/:groupId/items — Add a member to the group
router.post('/', (req: Request, res: Response) => {
  const { groupId } = req.params;
  const { media_id, similarity_score, quality_score, recommendation, reason } = req.body;

  if (!media_id || typeof media_id !== 'string') {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: '缺少必填字段: media_id' },
    });
  }

  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  try {
    db.prepare(
      `INSERT INTO duplicate_group_items (id, group_id, media_id, similarity_score, quality_score, recommendation, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      groupId,
      media_id,
      similarity_score ?? null,
      quality_score ?? null,
      recommendation ?? null,
      reason ?? null,
      now,
    );
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE constraint failed'))) {
      return res.status(409).json({
        error: { code: 'DUPLICATE_ENTRY', message: '该媒体已存在于此重复组中' },
      });
    }
    throw err;
  }

  const row = db.prepare('SELECT * FROM duplicate_group_items WHERE id = ?').get(id) as DuplicateGroupItemRow;
  return res.status(201).json(row);
});

// GET /api/duplicate-groups/:groupId/items — List all items in the group
router.get('/', (req: Request, res: Response) => {
  const { groupId } = req.params;
  const db = getDb();

  const rows = db.prepare(
    'SELECT * FROM duplicate_group_items WHERE group_id = ? ORDER BY created_at DESC'
  ).all(groupId) as DuplicateGroupItemRow[];

  return res.json(rows);
});

// PUT /api/duplicate-groups/:groupId/items/:itemId — Update recommendation info
router.put('/:itemId', (req: Request, res: Response) => {
  const { itemId } = req.params;
  const { similarity_score, quality_score, recommendation, reason } = req.body;
  const db = getDb();

  const existing = db.prepare('SELECT * FROM duplicate_group_items WHERE id = ?').get(itemId) as DuplicateGroupItemRow | undefined;
  if (!existing) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: '组成员记录不存在' },
    });
  }

  db.prepare(
    `UPDATE duplicate_group_items SET similarity_score = ?, quality_score = ?, recommendation = ?, reason = ? WHERE id = ?`
  ).run(
    similarity_score ?? existing.similarity_score,
    quality_score ?? existing.quality_score,
    recommendation ?? existing.recommendation,
    reason ?? existing.reason,
    itemId,
  );

  const row = db.prepare('SELECT * FROM duplicate_group_items WHERE id = ?').get(itemId) as DuplicateGroupItemRow;
  return res.json(row);
});

// DELETE /api/duplicate-groups/:groupId/items/:itemId — Delete a member
router.delete('/:itemId', (req: Request, res: Response) => {
  const { itemId } = req.params;
  const db = getDb();

  const existing = db.prepare('SELECT * FROM duplicate_group_items WHERE id = ?').get(itemId) as DuplicateGroupItemRow | undefined;
  if (!existing) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: '组成员记录不存在' },
    });
  }

  db.prepare('DELETE FROM duplicate_group_items WHERE id = ?').run(itemId);
  return res.status(204).send();
});

export default router;
