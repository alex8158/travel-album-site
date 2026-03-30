import { Router, Request, Response } from 'express';
import path from 'path';
import { getDb } from '../database';
import { deduplicate } from '../services/dedupEngine';
import { processTrip } from '../services/qualitySelector';
import { generateThumbnailsForTrip } from '../services/thumbnailGenerator';
import { selectCoverImage } from '../services/coverSelector';
import type { MediaItem } from '../types';

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

// Base directory for resolving relative file paths stored in DB
const serverRoot = path.join(__dirname, '..', '..');

function rowToMediaItem(row: MediaItemRow): MediaItem {
  return {
    id: row.id,
    tripId: row.trip_id,
    // Resolve relative DB path (e.g. "uploads/{trip_id}/originals/file.jpg") to absolute
    filePath: path.resolve(serverRoot, row.file_path),
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

// POST /api/trips/:id/process — Trigger dedup processing and return summary
router.post('/:id/process', async (req: Request, res: Response) => {
  const tripId = req.params.id;
  const db = getDb();

  // Verify trip exists
  const trip = db.prepare('SELECT id FROM trips WHERE id = ?').get(tripId);
  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Query all image media_items for this trip
  const rows = db.prepare(
    "SELECT * FROM media_items WHERE trip_id = ? AND media_type = 'image'"
  ).all(tripId) as MediaItemRow[];

  const imageItems = rows.map(rowToMediaItem);

  // Run deduplication
  const groups = await deduplicate(imageItems);

  // Run quality selection for all groups and ungrouped images
  await processTrip(tripId);

  // Generate thumbnails for all images in the trip
  await generateThumbnailsForTrip(tripId);

  // Auto-select cover image for the trip
  const coverImageId = await selectCoverImage(tripId);

  // Build summary response
  return res.json({
    tripId,
    totalImages: imageItems.length,
    duplicateGroups: groups.map((g) => ({
      groupId: g.id,
      imageCount: g.imageCount,
    })),
    totalGroups: groups.length,
    coverImageId,
  });
});

export default router;
