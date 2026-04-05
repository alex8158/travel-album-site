import { Router, Request, Response } from 'express';
import { getDb } from '../database';
import type { MediaItem, DuplicateGroup, GalleryData, GalleryImage } from '../types';
import { TripRow, rowToTrip } from '../helpers/tripRow';
import { MediaItemRow, rowToMediaItem } from '../helpers/mediaItemRow';
import { authMiddleware } from '../middleware/auth';
import { normalizeTagName } from '../services/tagGenerator';

const router = Router();

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

// GET /api/trips/:id/gallery — Get gallery data for a trip
router.get('/:id/gallery', authMiddleware, (req: Request, res: Response) => {
  const db = getDb();
  const tripId = req.params.id;

  // Verify trip exists
  const tripRow = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
  if (!tripRow) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  const trip = rowToTrip(tripRow);

  // Determine if the requester is the trip owner or an admin
  const isOwnerOrAdmin =
    req.user != null &&
    (req.user.role === 'admin' || req.user.userId === tripRow.user_id);

  // Visibility filter: public access only sees public media items
  const visibilityClause = isOwnerOrAdmin ? '' : "AND m.visibility = 'public'";

  // Tag filter: normalize and build clause if ?tag= is provided
  const rawTag = req.query.tag as string | undefined;
  const normalizedTag = rawTag ? normalizeTagName(rawTag) : null;
  const tagJoin = normalizedTag
    ? 'INNER JOIN media_tags mt ON mt.media_id = m.id'
    : '';
  const tagClause = normalizedTag ? 'AND mt.tag_name = ?' : '';

  // Category filter: ?category=landscape|animal|people|other
  const validCategories = ['landscape', 'animal', 'people', 'other'];
  const rawCategory = req.query.category as string | undefined;
  const category = rawCategory && validCategories.includes(rawCategory) ? rawCategory : null;
  const categoryClause = category ? 'AND m.category = ?' : '';

  // Get all duplicate groups for this trip
  const groupRows = db.prepare(
    'SELECT * FROM duplicate_groups WHERE trip_id = ?'
  ).all(tripId) as DuplicateGroupRow[];

  // Build gallery images:
  // 1. For each duplicate group, get the default image
  // 2. Get all ungrouped images (not in any duplicate group)
  const images: GalleryImage[] = [];

  for (const groupRow of groupRows) {
    if (!groupRow.default_image_id) continue;

    const defaultImageParams: unknown[] = [groupRow.default_image_id, 'image'];
    if (normalizedTag) defaultImageParams.push(normalizedTag);
    if (category) defaultImageParams.push(category);

    const defaultImageRow = db.prepare(
      `SELECT m.* FROM media_items m ${tagJoin} WHERE m.id = ? AND m.media_type = ? AND m.status = 'active' ${visibilityClause} ${tagClause} ${categoryClause}`
    ).get(...defaultImageParams) as MediaItemRow | undefined;

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

  // Get ungrouped images (images not in any duplicate group)
  const ungroupedParams: unknown[] = [tripId, 'image'];
  if (normalizedTag) ungroupedParams.push(normalizedTag);
  if (category) ungroupedParams.push(category);

  const ungroupedRows = db.prepare(
    `SELECT m.* FROM media_items m ${tagJoin} WHERE m.trip_id = ? AND m.media_type = ? AND m.duplicate_group_id IS NULL AND m.status = 'active' ${visibilityClause} ${tagClause} ${categoryClause}`
  ).all(...ungroupedParams) as MediaItemRow[];

  for (const row of ungroupedRows) {
    images.push({
      item: rowToMediaItem(row),
      isDefault: false,
      thumbnailUrl: `/api/media/${row.id}/thumbnail`,
      originalUrl: `/api/media/${row.id}/original`,
    });
  }

  // Get all videos
  const videoParams: unknown[] = [tripId, 'video'];
  if (normalizedTag) videoParams.push(normalizedTag);
  if (category) videoParams.push(category);

  const videoRows = db.prepare(
    `SELECT m.* FROM media_items m ${tagJoin} WHERE m.trip_id = ? AND m.media_type = ? AND m.status = 'active' ${visibilityClause} ${tagClause} ${categoryClause}`
  ).all(...videoParams) as MediaItemRow[];

  const videos = videoRows.map((row) => ({
    ...rowToMediaItem(row),
    thumbnailUrl: row.thumbnail_path ? `/api/media/${row.id}/thumbnail` : '',
  }));

  const galleryData: GalleryData = { trip, images, videos };
  return res.json(galleryData);
});

export default router;
