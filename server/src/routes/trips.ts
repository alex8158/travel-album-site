import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import type { TripSummary, TripVisibility } from '../types';
import { TripRow, rowToTrip } from '../helpers/tripRow';
import { authMiddleware, requireAuth } from '../middleware/auth';

const router = Router();

// POST /api/trips — Create a new trip (requires auth)
router.post('/', authMiddleware, requireAuth, (req: Request, res: Response) => {
  const { title, description } = req.body;

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return res.status(400).json({ error: { code: 'INVALID_TITLE', message: '旅行标题不能为空' } });
  }

  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const userId = req.user!.userId;

  db.prepare(
    'INSERT INTO trips (id, title, description, visibility, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, title.trim(), description ?? null, 'public', userId, now, now);

  const row = db.prepare('SELECT * FROM trips WHERE id = ?').get(id) as TripRow;
  return res.status(201).json(rowToTrip(row));
});

// GET /api/trips — List public trips as TripSummary, ordered by created_at DESC
router.get('/', authMiddleware, (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT t.*,
           COUNT(m.id) AS media_count
    FROM trips t
    LEFT JOIN media_items m ON m.trip_id = t.id
    WHERE t.visibility = 'public'
    GROUP BY t.id
    ORDER BY t.created_at DESC
  `).all() as (TripRow & { media_count: number })[];

  const summaries: TripSummary[] = rows.map(row => {
    const excerpt = row.description
      ? row.description.length > 100
        ? row.description.slice(0, 100) + '...'
        : row.description
      : undefined;

    const coverImageUrl = row.cover_image_id
      ? `/api/media/${row.cover_image_id}/thumbnail`
      : '';

    return {
      id: row.id,
      title: row.title,
      descriptionExcerpt: excerpt,
      coverImageUrl,
      mediaCount: row.media_count,
      visibility: row.visibility as TripVisibility,
      createdAt: row.created_at,
    };
  });

  return res.json(summaries);
});

// GET /api/trips/:id — Get a single trip
router.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as TripRow | undefined;

  if (!row) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  return res.json(rowToTrip(row));
});

// PUT /api/trips/:id — Update trip title and/or description (requires auth + owner/admin)
router.put('/:id', authMiddleware, requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as TripRow | undefined;

  if (!existing) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Verify owner or admin
  if (req.user!.role !== 'admin' && existing.user_id !== req.user!.userId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
  }

  const { title, description } = req.body;

  if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0)) {
    return res.status(400).json({ error: { code: 'INVALID_TITLE', message: '旅行标题不能为空' } });
  }

  const newTitle = title !== undefined ? title.trim() : existing.title;
  const newDescription = description !== undefined ? description : existing.description;
  const now = new Date().toISOString();

  db.prepare(
    'UPDATE trips SET title = ?, description = ?, updated_at = ? WHERE id = ?'
  ).run(newTitle, newDescription, now, req.params.id);

  const row = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as TripRow;
  return res.json(rowToTrip(row));
});

// PUT /api/trips/:id/visibility — Update trip visibility (requires auth + owner/admin)
router.put('/:id/visibility', authMiddleware, requireAuth, (req: Request, res: Response) => {
  const { visibility } = req.body;

  if (visibility !== 'public' && visibility !== 'unlisted') {
    return res.status(400).json({
      error: { code: 'INVALID_VISIBILITY', message: '可见性状态无效，必须为 public 或 unlisted' }
    });
  }

  const db = getDb();
  const existing = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as TripRow | undefined;

  if (!existing) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Verify owner or admin
  if (req.user!.role !== 'admin' && existing.user_id !== req.user!.userId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE trips SET visibility = ?, updated_at = ? WHERE id = ?').run(visibility, now, req.params.id);

  const row = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as TripRow;
  return res.json(rowToTrip(row));
});

// PUT /api/trips/:id/cover — Manually set cover image (requires auth + owner/admin)
router.put('/:id/cover', authMiddleware, requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const tripId = req.params.id;

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Verify owner or admin
  if (req.user!.role !== 'admin' && trip.user_id !== req.user!.userId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
  }

  const { imageId } = req.body;
  if (!imageId || typeof imageId !== 'string') {
    return res.status(400).json({ error: { code: 'INVALID_IMAGE_ID', message: '必须提供有效的 imageId' } });
  }

  // Verify the media item exists and belongs to this trip
  const mediaItem = db.prepare(
    'SELECT id, trip_id FROM media_items WHERE id = ?'
  ).get(imageId) as { id: string; trip_id: string } | undefined;

  if (!mediaItem) {
    return res.status(404).json({ error: { code: 'MEDIA_NOT_FOUND', message: '媒体文件不存在' } });
  }

  if (mediaItem.trip_id !== tripId) {
    return res.status(400).json({ error: { code: 'MEDIA_NOT_IN_TRIP', message: '该媒体文件不属于此旅行' } });
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE trips SET cover_image_id = ?, updated_at = ? WHERE id = ?').run(imageId, now, tripId);

  const row = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow;
  return res.json(rowToTrip(row));
});

export default router;
