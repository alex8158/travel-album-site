import { Router, Request, Response } from 'express';
import { getDb } from '../database';
import { TripRow, rowToTrip } from '../helpers/tripRow';
import { MediaItemRow, rowToMediaItem } from '../helpers/mediaItemRow';
import { authMiddleware, requireAuth } from '../middleware/auth';
import type { GalleryImage, GalleryData, DuplicateGroup } from '../types';

interface DuplicateGroupRow {
  id: string;
  trip_id: string;
  default_image_id: string | null;
  image_count: number;
  created_at: string;
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

const router = Router();

// All /api/my routes require authentication
router.use(authMiddleware, requireAuth);

// GET /api/my/trips — Return current user's all trips (public + private), ordered by created_at DESC
router.get('/trips', (req: Request, res: Response) => {
  const db = getDb();
  const userId = req.user!.userId;

  // Admin sees all trips; regular users see only their own
  const isAdmin = req.user!.role === 'admin';
  const query = isAdmin
    ? `SELECT t.*, COUNT(m.id) AS media_count
       FROM trips t
       LEFT JOIN media_items m ON m.trip_id = t.id AND m.status = 'active'
       GROUP BY t.id
       ORDER BY t.created_at DESC`
    : `SELECT t.*, COUNT(m.id) AS media_count
       FROM trips t
       LEFT JOIN media_items m ON m.trip_id = t.id AND m.status = 'active'
       WHERE t.user_id = ?
       GROUP BY t.id
       ORDER BY t.created_at DESC`;

  const rows = (isAdmin
    ? db.prepare(query).all()
    : db.prepare(query).all(userId)
  ) as (TripRow & { media_count: number })[];

  const trips = rows.map(row => ({
    ...rowToTrip(row),
    mediaCount: row.media_count,
    coverImageUrl: row.cover_image_id ? `/api/media/${row.cover_image_id}/thumbnail` : '',
  }));

  return res.json({ trips });
});

// GET /api/my/trips/:id/gallery — Return all media for user's own trip (no visibility filter)
router.get('/trips/:id/gallery', (req: Request, res: Response) => {
  const db = getDb();
  const tripId = req.params.id;
  const userId = req.user!.userId;

  const tripRow = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
  if (!tripRow) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Only the owner or admin can access this endpoint
  if (req.user!.role !== 'admin' && tripRow.user_id !== userId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权访问此相册' } });
  }

  const trip = rowToTrip(tripRow);

  // Get all duplicate groups for this trip
  const groupRows = db.prepare(
    'SELECT * FROM duplicate_groups WHERE trip_id = ?'
  ).all(tripId) as DuplicateGroupRow[];

  // Build gallery images (all media, no visibility filter)
  const images: GalleryImage[] = [];

  for (const groupRow of groupRows) {
    if (!groupRow.default_image_id) continue;

    const defaultImageRow = db.prepare(
      `SELECT * FROM media_items WHERE id = ? AND media_type = ? AND status = 'active'`
    ).get(groupRow.default_image_id, 'image') as MediaItemRow | undefined;

    if (defaultImageRow) {
      images.push({
        item: rowToMediaItem(defaultImageRow),
        isDefault: true,
        duplicateGroup: rowToGroup(groupRow),
        thumbnailUrl: `/api/media/${defaultImageRow.id}/thumbnail`,
        originalUrl: `/api/media/${defaultImageRow.id}/original`,
      });
    }
  }

  // Get ungrouped images
  const ungroupedRows = db.prepare(
    `SELECT * FROM media_items WHERE trip_id = ? AND media_type = ? AND duplicate_group_id IS NULL AND status = 'active'`
  ).all(tripId, 'image') as MediaItemRow[];

  for (const row of ungroupedRows) {
    images.push({
      item: rowToMediaItem(row),
      isDefault: false,
      thumbnailUrl: `/api/media/${row.id}/thumbnail`,
      originalUrl: `/api/media/${row.id}/original`,
    });
  }

  // Get all videos
  const videoRows = db.prepare(
    `SELECT * FROM media_items WHERE trip_id = ? AND media_type = ? AND status = 'active'`
  ).all(tripId, 'video') as MediaItemRow[];

  const videos = videoRows.map((row) => ({
    ...rowToMediaItem(row),
    thumbnailUrl: row.thumbnail_path ? `/api/media/${row.id}/thumbnail` : '',
  }));

  const galleryData: GalleryData = { trip, images, videos };
  return res.json(galleryData);
});

export default router;
