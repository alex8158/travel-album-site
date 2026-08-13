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

  // Check for tier slideshow videos (per-category subdirectories)
  const uploadsBase = path.resolve(__dirname, '..', '..', 'uploads');
  const tierSlideshowDir = path.join(uploadsBase, tripId, 'tier-slideshow');
  const slideshowUrls: Record<string, string> = {};

  if (fs.existsSync(tierSlideshowDir)) {
    try {
      const entries = fs.readdirSync(tierSlideshowDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Per-category subdirectory (e.g., animal/, landscape/, people/)
          const catDir = path.join(tierSlideshowDir, entry.name);
          const catFiles = fs.readdirSync(catDir);
          const mp4File = catFiles.find((f) => f.endsWith('.mp4'));
          if (mp4File) {
            slideshowUrls[entry.name] = `/api/trips/${tripId}/tier-slideshow/${entry.name}/${mp4File}`;
          }
        } else if (entry.isFile() && entry.name.endsWith('.mp4')) {
          // Legacy: mp4 directly in tier-slideshow/ (old format)
          slideshowUrls['all'] = `/api/trips/${tripId}/tier-slideshow/${entry.name}`;
        }
      }
    } catch {
      // Directory not readable
    }
  }

  return res.json({ photos: tierPhotos, slideshowUrls });
});

// ---------------------------------------------------------------------------
// GET /api/my/trips/:id/highlight-pool — Get available photos for picker
//
// Returns exactly the Highlight_Pool subset that is eligible to be added to the
// tier: active highlight photos that are not already Tier_Photos. Photos that
// are not highlights — including photos with no `highlight_results` row at all
// (never evaluated) — are NOT candidates and must not appear here.
//
// Requirements: 2.2, 2.6, 3.3 (and design.md Property 2)
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

  // Eligibility: trip match AND image AND active AND is_highlight = 1 AND not
  // already in tier.
  //
  // `hr.is_highlight = 1` also excludes photos with no highlight_results row:
  // the LEFT JOIN yields NULL for those, and `NULL = 1` evaluates to NULL (not
  // true), so the row is filtered out. The JOIN is therefore left as-is.
  const photos = db
    .prepare(
      `SELECT mi.id, mi.file_path, mi.category, hr.reason
       FROM media_items mi
       LEFT JOIN highlight_results hr ON hr.photo_id = mi.id AND hr.trip_id = mi.trip_id
       WHERE mi.trip_id = ?
         AND mi.status = 'active'
         AND mi.media_type = 'image'
         AND hr.is_highlight = 1
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

  // No category quota gate here by design. Category quotas are SOFT quotas:
  // requirements.md Requirement 4.1 states the API must allow adding a photo
  // "even if the photo's category already has the maximum quota number of
  // Tier_Photos", and design.md Key Design Decision 2 / Property 4 both require
  // that quotas never block add/remove. Quota counts are advisory labels shown
  // in My Gallery only.
  //
  // The 6–9 per-category range in the highlight-tier spec constrains the AI
  // Highlight_Tier_Selector, not this manual endpoint.

  // Membership in the Highlight_Pool is a PRECONDITION, not something this
  // endpoint may bring about. Requirements 2.5, 3.1, 7.2, 7.5 and 10.1 all
  // require verifying `is_highlight = 1` and rejecting otherwise, and Property 3
  // states the add succeeds "if and only if" the photo already satisfies
  // `is_highlight = 1` AND `status = 'active'` AND belongs to the trip.
  //
  // `is_highlight` is owned by the AI evaluation flow (`highlightService.ts`),
  // which rebuilds every `highlight_results` row for a trip per run. Therefore:
  //   - no row            → the photo has not been evaluated yet → not eligible
  //   - row, is_highlight=0 → evaluated and judged NOT a highlight → not eligible
  // In neither case may this endpoint create a row or flip `is_highlight`.
  const highlightRow = db.prepare(
    'SELECT * FROM highlight_results WHERE photo_id = ? AND trip_id = ?'
  ).get(photoId, tripId) as { photo_id: string; trip_id: string; is_highlight: number; is_highlight_tier: number; reason: string | null } | undefined;

  if (!highlightRow || highlightRow.is_highlight !== 1) {
    return res.status(400).json({
      error: { code: 'NOT_ELIGIBLE', message: '该照片不在精选池中，无法添加到精华' },
    });
  }

  // Eligible — set the tier flag only. `is_highlight`, `reason`, `batch_index`
  // and `evaluated_at` are evaluation metadata and must not be written here.
  db.prepare(
    'UPDATE highlight_results SET is_highlight_tier = 1 WHERE photo_id = ? AND trip_id = ?'
  ).run(photoId, tripId);

  // Return updated TierPhotoItem
  const photo = {
    id: mediaRow.id,
    filePath: mediaRow.file_path,
    thumbnailUrl: `/api/media/${mediaRow.id}/thumbnail`,
    originalUrl: `/api/media/${mediaRow.id}/original`,
    category: mediaRow.category,
    reason: highlightRow.reason,
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
// Generates per-category videos (animal/people/landscape), minimum 6 photos per category
// Auth: Required (owner or admin)
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

  // Query current tier photos grouped by category
  const tierPhotos = db.prepare(
    `SELECT mi.id, mi.file_path, mi.category
     FROM highlight_results hr
     INNER JOIN media_items mi ON mi.id = hr.photo_id
     WHERE hr.trip_id = ?
       AND hr.is_highlight_tier = 1
       AND mi.status = 'active'
     ORDER BY mi.category, mi.created_at ASC`
  ).all(tripId) as Array<{ id: string; file_path: string; category: string | null }>;

  if (tierPhotos.length === 0) {
    return res.status(400).json({
      error: { code: 'NO_TIER_PHOTOS', message: '没有精华照片可用于生成视频' },
    });
  }

  // Group by category
  const grouped: Record<string, Array<{ id: string; file_path: string }>> = {};
  for (const photo of tierPhotos) {
    const cat = photo.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(photo);
  }

  // Generate per-category videos (minimum 6 photos required)
  const MIN_PHOTOS_FOR_VIDEO = 6;
  const storageProvider = getStorageProvider();
  const uploadsBase = path.resolve(__dirname, '..', '..', 'uploads');
  const slideshowUrls: Record<string, string> = {};
  const errors: string[] = [];
  // Eligibility is decided *before* any generation attempt, purely on the
  // Tier_Photo count (Requirement 9.7 / highlight-tier 6.3). It must never be
  // inferred from download results, generator success or `slideshowUrls` size,
  // because the terminal state depends on eligibility and success being counted
  // independently (Requirements 9.3 / 9.6 / 9.7).
  let eligibleCategories = 0;

  for (const [category, photos] of Object.entries(grouped)) {
    if (photos.length < MIN_PHOTOS_FOR_VIDEO) {
      // highlight-tier 6.3: skip and log the category with its photo count.
      // Not an Eligible_Category, so this is NOT recorded in `errors[]`.
      console.log(`[regenerate] Skipping category '${category}': only ${photos.length} photos (need ${MIN_PHOTOS_FOR_VIDEO})`);
      continue;
    }

    // From here on the category IS an Eligible_Category: any subsequent failure
    // is a generation-attempt failure (highlight-tier 6.7), not an eligibility skip.
    eligibleCategories++;

    // Download photos to temp
    const photoPaths: string[] = [];
    for (const photo of photos) {
      try {
        const localPath = await storageProvider.downloadToTemp(photo.file_path);
        photoPaths.push(localPath);
      } catch (err) {
        console.warn(`[regenerate] Failed to download photo ${photo.id}: ${err}`);
      }
    }

    if (photoPaths.length < MIN_PHOTOS_FOR_VIDEO) {
      // The category cleared the Tier_Photo eligibility threshold, so falling
      // below it after download failures is a failed generation attempt — it is
      // recorded in `errors[]` rather than silently skipped (Requirement 9.3).
      console.warn(`[regenerate] Category '${category}': only ${photoPaths.length} of ${photos.length} photos downloadable (need ${MIN_PHOTOS_FOR_VIDEO})`);
      errors.push(
        `${category}: 素材准备失败，仅 ${photoPaths.length}/${photos.length} 张照片可用（需 ${MIN_PHOTOS_FOR_VIDEO} 张）`
      );
      continue;
    }

    const outputDir = path.join(uploadsBase, tripId, 'tier-slideshow', category);

    try {
      const result = await generateSlideshow({
        photoPaths,
        audioPath: null,
        outputDir,
        photoDuration: 3,
      });

      if (result.success && result.outputPath) {
        const filename = path.basename(result.outputPath);
        slideshowUrls[category] = `/api/trips/${tripId}/tier-slideshow/${category}/${filename}`;
        console.log(`[regenerate] Category '${category}': video generated (${result.totalDuration}s)`);
      } else {
        errors.push(`${category}: ${result.error || '生成失败'}`);
      }
    } catch (err) {
      errors.push(`${category}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Terminal state — decided only after every Eligible_Category was attempted.
  // See the truth table in `.kiro/specs/manual-photo-management/design.md`
  // §Components 3:
  //
  //   eligible | successful | result
  //   ---------|------------|--------------------------------
  //          0 |          0 | 400 NO_ELIGIBLE_CATEGORIES
  //       >= 1 |       >= 1 | 200 { slideshowUrls, errors? }
  //       >= 1 |          0 | 500 GENERATION_FAILED
  // ---------------------------------------------------------------------------
  const successfulGenerations = Object.keys(slideshowUrls).length;

  // Requirement 9.7: eligibility precondition failure. This is NOT a generation
  // failure, so the message describes only the photo-count shortfall and must
  // not splice in generator/download error detail.
  if (eligibleCategories === 0) {
    return res.status(400).json({
      error: {
        code: 'NO_ELIGIBLE_CATEGORIES',
        message: `没有类别达到最少${MIN_PHOTOS_FOR_VIDEO}张照片的要求`,
      },
    });
  }

  // Requirement 9.6: at least one Eligible_Category existed, but none produced a
  // video. Every eligible category was already attempted and its error recorded.
  if (successfulGenerations === 0) {
    return res.status(500).json({
      error: {
        code: 'GENERATION_FAILED',
        message:
          errors.length > 0 ? `视频生成失败：${errors.join('; ')}` : '视频生成失败',
      },
    });
  }

  // Requirement 9.3: partial success — per-category failures do not fail the
  // whole request; `errors` is omitted when no eligible category failed.
  return res.json({ slideshowUrls, errors: errors.length > 0 ? errors : undefined });
});

export default router;
