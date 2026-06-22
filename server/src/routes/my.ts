import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getDb } from '../database';
import { TripRow, rowToTrip } from '../helpers/tripRow';
import { MediaItemRow, rowToMediaItem } from '../helpers/mediaItemRow';
import { authMiddleware, requireAuth } from '../middleware/auth';
import { getStorageProvider } from '../storage/factory';
import { generateSlideshow } from '../services/slideshowGenerator';
import type { GalleryImage, DuplicateGroup } from '../types';

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

  // Get all videos (exclude incomplete uploads)
  const videoRows = db.prepare(
    `SELECT * FROM media_items WHERE trip_id = ? AND media_type = ? AND status = 'active'
     AND (processing_status IS NULL OR processing_status NOT IN ('uploading', 'cancelled'))`
  ).all(tripId, 'video') as MediaItemRow[];

  const videos = videoRows.map((row) => ({
    ...rowToMediaItem(row),
    thumbnailUrl: `/api/media/${row.id}/thumbnail`,
  }));

  // originalVideos: all videos with media_type='video' and media_source != 'merged'
  const originalVideos = videoRows
    .filter((row) => row.media_source !== 'merged')
    .map((row) => ({
      ...rowToMediaItem(row),
      thumbnailUrl: `/api/media/${row.id}/thumbnail`,
    }));

  // compiledVideos: videos with compiled_path (showing compiled version) + media_source='merged' videos
  const compiledVideos = videoRows
    .filter((row) => row.compiled_path != null || row.media_source === 'merged')
    .map((row) => ({
      ...rowToMediaItem(row),
      thumbnailUrl: `/api/media/${row.id}/thumbnail`,
    }));

  const galleryData = { trip, images, videos, originalVideos, compiledVideos };
  return res.json(galleryData);
});

// ---------------------------------------------------------------------------
// GET /api/my/trips/:id/tier-photos — Authenticated endpoint for tier photos
// Only accessible to the trip owner or admin
// Requirements: 7.2, 8.2, 9.3
// ---------------------------------------------------------------------------
router.get('/trips/:id/tier-photos', (req: Request, res: Response) => {
  const db = getDb();
  const tripId = req.params.id as string;
  const userId = req.user!.userId;

  const tripRow = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
  if (!tripRow) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Only the owner or admin can access this endpoint
  if (req.user!.role !== 'admin' && tripRow.user_id !== userId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权访问此相册' } });
  }

  // Query tier photos (excluding trashed)
  const photos = db
    .prepare(
      `SELECT mi.id, mi.file_path, mi.category, hr.reason
       FROM highlight_results hr
       INNER JOIN media_items mi ON mi.id = hr.photo_id
       WHERE hr.trip_id = ?
         AND hr.is_highlight_tier = 1
         AND mi.status = 'active'
       ORDER BY mi.category, mi.created_at ASC`
    )
    .all(tripId) as Array<{
    id: string;
    file_path: string;
    category: string | null;
    reason: string | null;
  }>;

  const tierPhotos = photos.map((row) => ({
    id: row.id,
    filePath: row.file_path,
    thumbnailUrl: `/api/media/${row.id}/thumbnail`,
    originalUrl: `/api/media/${row.id}/original`,
    category: row.category,
    reason: row.reason,
  }));

  // Check for tier slideshow video
  const uploadsBase = path.resolve(__dirname, '..', '..', 'uploads');
  const tierSlideshowDir = path.join(uploadsBase, tripId, 'tier-slideshow');
  let slideshowUrl: string | null = null;

  if (fs.existsSync(tierSlideshowDir)) {
    try {
      const files = fs.readdirSync(tierSlideshowDir);
      const mp4File = files.find((f) => f.endsWith('.mp4'));
      if (mp4File) {
        slideshowUrl = `/api/trips/${tripId}/tier-slideshow/${mp4File}`;
      }
    } catch {
      // Directory not readable
    }
  }

  return res.json({ photos: tierPhotos, slideshowUrl });
});

// ---------------------------------------------------------------------------
// GET /api/my/trips/:id/highlight-pool — Get available photos for picker
// Returns active photos NOT already in tier (eligible for adding to tier)
// Includes both highlighted and non-highlighted active photos
// ---------------------------------------------------------------------------
router.get('/trips/:id/highlight-pool', (req: Request, res: Response) => {
  const db = getDb();
  const tripId = req.params.id as string;
  const userId = req.user!.userId;

  const tripRow = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
  if (!tripRow) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  if (req.user!.role !== 'admin' && tripRow.user_id !== userId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
  }

  // Return all active photos for this trip that are NOT already in tier
  // Uses LEFT JOIN so photos without highlight_results rows are also included
  const photos = db
    .prepare(
      `SELECT mi.id, mi.file_path, mi.category, hr.reason
       FROM media_items mi
       LEFT JOIN highlight_results hr ON hr.photo_id = mi.id AND hr.trip_id = mi.trip_id
       WHERE mi.trip_id = ?
         AND mi.status = 'active'
         AND mi.media_type = 'image'
         AND (hr.is_highlight_tier IS NULL OR hr.is_highlight_tier = 0)
       ORDER BY mi.category, mi.created_at ASC`
    )
    .all(tripId) as Array<{
    id: string;
    file_path: string;
    category: string | null;
    reason: string | null;
  }>;

  const poolPhotos = photos.map((row) => ({
    id: row.id,
    filePath: row.file_path,
    thumbnailUrl: `/api/media/${row.id}/thumbnail`,
    originalUrl: `/api/media/${row.id}/original`,
    category: row.category,
    reason: row.reason,
  }));

  return res.json({ photos: poolPhotos });
});

// ---------------------------------------------------------------------------
// PUT /api/my/trips/:id/tier-photos/:photoId — Add photo to tier
// Auth: Required (owner or admin)
// Requirements: 2.3, 2.5, 3.1, 3.2, 7.1–7.6, 10.1
// ---------------------------------------------------------------------------
router.put('/trips/:id/tier-photos/:photoId', (req: Request, res: Response) => {
  const db = getDb();
  const tripId = req.params.id as string;
  const photoId = req.params.photoId as string;
  const userId = req.user!.userId;

  // Check trip exists
  const tripRow = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
  if (!tripRow) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '照片不存在' } });
  }

  // Only the owner or admin can operate
  if (req.user!.role !== 'admin' && tripRow.user_id !== userId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
  }

  // Check photo exists and belongs to this trip
  const mediaRow = db.prepare(
    'SELECT * FROM media_items WHERE id = ? AND trip_id = ?'
  ).get(photoId, tripId) as MediaItemRow | undefined;

  if (!mediaRow) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '照片不存在' } });
  }

  // Check photo is active
  if (mediaRow.status !== 'active') {
    return res.status(400).json({
      error: { code: 'NOT_ELIGIBLE', message: '该照片已被删除，无法添加到精华' },
    });
  }

  // Check if highlight_results row exists; if not, create one (for restored photos)
  const highlightRow = db.prepare(
    'SELECT * FROM highlight_results WHERE photo_id = ? AND trip_id = ?'
  ).get(photoId, tripId) as { photo_id: string; trip_id: string; is_highlight: number; is_highlight_tier: number; reason: string | null } | undefined;

  if (highlightRow) {
    // Row exists — just set tier flag
    db.prepare(
      'UPDATE highlight_results SET is_highlight_tier = 1, is_highlight = 1 WHERE photo_id = ? AND trip_id = ?'
    ).run(photoId, tripId);
  } else {
    // No highlight_results row — create one with both flags set
    const { v4: uuidv4 } = require('uuid');
    db.prepare(
      `INSERT INTO highlight_results (id, trip_id, photo_id, is_highlight, is_highlight_tier, reason, batch_index, evaluated_at)
       VALUES (?, ?, ?, 1, 1, '手动添加到精华', 0, ?)`
    ).run(uuidv4(), tripId, photoId, new Date().toISOString());
  }

  // Return updated TierPhotoItem
  const photo = {
    id: mediaRow.id,
    filePath: mediaRow.file_path,
    thumbnailUrl: `/api/media/${mediaRow.id}/thumbnail`,
    originalUrl: `/api/media/${mediaRow.id}/original`,
    category: mediaRow.category,
    reason: highlightRow?.reason || '手动添加到精华',
  };

  return res.json({ photo });
});

// ---------------------------------------------------------------------------
// DELETE /api/my/trips/:id/tier-photos/:photoId — Remove photo from tier
// Auth: Required (owner or admin)
// Requirements: 1.2, 8.1–8.6
// ---------------------------------------------------------------------------
router.delete('/trips/:id/tier-photos/:photoId', (req: Request, res: Response) => {
  const db = getDb();
  const tripId = req.params.id as string;
  const photoId = req.params.photoId as string;
  const userId = req.user!.userId;

  // Check trip exists
  const tripRow = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
  if (!tripRow) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '照片不存在' } });
  }

  // Only the owner or admin can operate
  if (req.user!.role !== 'admin' && tripRow.user_id !== userId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
  }

  // Check photo exists and belongs to this trip
  const mediaRow = db.prepare(
    'SELECT * FROM media_items WHERE id = ? AND trip_id = ?'
  ).get(photoId, tripId) as MediaItemRow | undefined;

  if (!mediaRow) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '照片不存在' } });
  }

  // Check photo is currently in the tier
  const highlightRow = db.prepare(
    'SELECT * FROM highlight_results WHERE photo_id = ? AND trip_id = ?'
  ).get(photoId, tripId) as { photo_id: string; trip_id: string; is_highlight: number; is_highlight_tier: number } | undefined;

  if (!highlightRow || highlightRow.is_highlight_tier !== 1) {
    return res.status(400).json({
      error: { code: 'NOT_IN_TIER', message: '该照片当前不在精华中' },
    });
  }

  // Set is_highlight_tier = 0
  db.prepare(
    'UPDATE highlight_results SET is_highlight_tier = 0 WHERE photo_id = ? AND trip_id = ?'
  ).run(photoId, tripId);

  return res.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /api/my/trips/:id/tier-slideshow/regenerate — Regenerate tier slideshow
// Auth: Required (owner or admin)
// Requirements: 5.2, 5.6, 9.1–9.6
// ---------------------------------------------------------------------------
router.post('/trips/:id/tier-slideshow/regenerate', async (req: Request, res: Response) => {
  const db = getDb();
  const tripId = req.params.id as string;
  const userId = req.user!.userId;

  // Check trip exists
  const tripRow = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
  if (!tripRow) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Only the owner or admin can operate
  if (req.user!.role !== 'admin' && tripRow.user_id !== userId) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
  }

  // Query current tier photos
  const tierPhotos = db.prepare(
    `SELECT mi.id, mi.file_path
     FROM highlight_results hr
     INNER JOIN media_items mi ON mi.id = hr.photo_id
     WHERE hr.trip_id = ?
       AND hr.is_highlight_tier = 1
       AND mi.status = 'active'`
  ).all(tripId) as Array<{ id: string; file_path: string }>;

  // If no tier photos, return 400
  if (tierPhotos.length === 0) {
    return res.status(400).json({
      error: { code: 'NO_TIER_PHOTOS', message: '没有精华照片可用于生成视频' },
    });
  }

  // Download photos to temp via storage provider
  const storageProvider = getStorageProvider();
  const photoPaths: string[] = [];

  for (const photo of tierPhotos) {
    try {
      const localPath = await storageProvider.downloadToTemp(photo.file_path);
      photoPaths.push(localPath);
    } catch (err) {
      console.warn(`[regenerate] Failed to download photo ${photo.id}: ${err}`);
    }
  }

  if (photoPaths.length === 0) {
    return res.status(500).json({
      error: { code: 'GENERATION_FAILED', message: '无法下载精华照片' },
    });
  }

  // Generate slideshow
  const uploadsBase = path.resolve(__dirname, '..', '..', 'uploads');
  const outputDir = path.join(uploadsBase, tripId, 'tier-slideshow');

  try {
    const result = await generateSlideshow({
      photoPaths,
      audioPath: null,
      outputDir,
      photoDuration: 3,
    });

    if (result.success && result.outputPath) {
      const filename = path.basename(result.outputPath);
      const slideshowUrl = `/api/trips/${tripId}/tier-slideshow/${filename}`;
      return res.json({ slideshowUrl });
    }

    return res.status(500).json({
      error: { code: 'GENERATION_FAILED', message: result.error || '视频生成失败' },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[regenerate] Slideshow generation error for trip ${tripId}: ${errorMessage}`);
    return res.status(500).json({
      error: { code: 'GENERATION_FAILED', message: errorMessage },
    });
  }
});

export default router;
