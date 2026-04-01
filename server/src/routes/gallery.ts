import { Router, Request, Response } from 'express';
import { getDb } from '../database';
import type { MediaItem, DuplicateGroup, GalleryData, GalleryImage } from '../types';
import { TripRow, rowToTrip } from '../helpers/tripRow';

const router = Router();

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

interface DuplicateGroupRow {
  id: string;
  trip_id: string;
  default_image_id: string | null;
  image_count: number;
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
router.get('/:id/gallery', (req: Request, res: Response) => {
  const db = getDb();
  const tripId = req.params.id;

  // Verify trip exists
  const tripRow = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
  if (!tripRow) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  const trip = rowToTrip(tripRow);

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

    const defaultImageRow = db.prepare(
      'SELECT * FROM media_items WHERE id = ? AND media_type = ?'
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

  // Get ungrouped images (images not in any duplicate group)
  const ungroupedRows = db.prepare(
    'SELECT * FROM media_items WHERE trip_id = ? AND media_type = ? AND duplicate_group_id IS NULL'
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
    'SELECT * FROM media_items WHERE trip_id = ? AND media_type = ?'
  ).all(tripId, 'video') as MediaItemRow[];

  const videos = videoRows.map(rowToMediaItem);

  const galleryData: GalleryData = { trip, images, videos };
  return res.json(galleryData);
});

export default router;
