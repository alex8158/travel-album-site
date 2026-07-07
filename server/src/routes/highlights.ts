import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import { authMiddleware, requireAuth } from '../middleware/auth';
import {
  runHighlightEvaluation,
  getHighlightsForTrip,
  getSimilarGroupsForTrip,
  HighlightServiceError,
} from '../services/highlightService';
import { generateSlideshow } from '../services/slideshowGenerator';
import { getStorageProvider } from '../storage/factory';

const router = Router();

/**
 * Look up a trip and verify the authenticated user has access.
 *
 * Returns the trip row on success, or sends an error response and returns
 * `null` (caller should `return` immediately).
 *
 * Error responses:
 *   - 404 NOT_FOUND   if the trip does not exist
 *   - 403 FORBIDDEN   if the user is neither the owner nor an admin
 */
function requireTripAccess(req: Request, res: Response): { id: string; user_id: string } | null {
  const tripId = req.params.id as string;
  const db = getDb();

  const trip = db
    .prepare('SELECT id, user_id FROM trips WHERE id = ?')
    .get(tripId) as { id: string; user_id: string } | undefined;

  if (!trip) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
    return null;
  }

  if (req.user!.role !== 'admin' && trip.user_id !== req.user!.userId) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
    return null;
  }

  return trip;
}

// POST /api/trips/:id/highlights — Trigger AI highlight evaluation for the trip.
//   Returns the HighlightEvaluation summary on success.
//   Returns 409 ALREADY_RUNNING if an evaluation is already in progress.
router.post('/:id/highlights', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  const trip = requireTripAccess(req, res);
  if (!trip) return;

  const tripId = trip.id;
  const userId = req.user!.userId;

  try {
    const evaluation = await runHighlightEvaluation(tripId);

    // Auto-generate slideshow video from highlighted photos (fire-and-forget)
    if (evaluation.highlightCount >= 2) {
      autoGenerateHighlightSlideshow(tripId, userId).catch((err) => {
        console.error(`[highlights] Auto-slideshow generation failed for trip ${tripId}: ${err}`);
      });
    }

    return res.json(evaluation);
  } catch (err) {
    if (err instanceof HighlightServiceError) {
      switch (err.code) {
        case 'ALREADY_RUNNING':
          return res.status(409).json({
            error: { code: 'ALREADY_RUNNING', message: '该旅行的精华评估正在进行中，请稍后再试' },
          });
        case 'NO_PROVIDERS_CONFIGURED':
          return res.status(500).json({
            error: { code: 'NO_PROVIDERS_CONFIGURED', message: '未配置任何 AI provider，无法执行精华评估' },
          });
        case 'TRIP_NOT_FOUND':
          // Race: trip was deleted between access check and evaluation.
          return res.status(404).json({
            error: { code: 'NOT_FOUND', message: '旅行不存在' },
          });
        case 'EVALUATION_FAILED':
          return res.status(500).json({
            error: { code: 'EVALUATION_FAILED', message: err.message || '精华评估失败' },
          });
        default:
          return res.status(500).json({
            error: { code: err.code, message: err.message || '精华评估失败' },
          });
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[highlights] Evaluation failed for trip ${tripId}: ${message}`);
    return res.status(500).json({
      error: { code: 'EVALUATION_FAILED', message },
    });
  }
});

// GET /api/trips/:id/highlights — Return all highlight photos for the trip.
router.get('/:id/highlights', authMiddleware, requireAuth, (req: Request, res: Response) => {
  const trip = requireTripAccess(req, res);
  if (!trip) return;

  const highlights = getHighlightsForTrip(trip.id);
  return res.json({ highlights });
});

// GET /api/trips/:id/similar-groups — Return all similar photo groups for the trip.
router.get('/:id/similar-groups', authMiddleware, requireAuth, (req: Request, res: Response) => {
  const trip = requireTripAccess(req, res);
  if (!trip) return;

  const groups = getSimilarGroupsForTrip(trip.id);
  return res.json({ groups });
});

// ---------------------------------------------------------------------------
// Auto-generate slideshow video from highlighted photos
// ---------------------------------------------------------------------------

/**
 * After AI highlight evaluation, automatically generate a slideshow video
 * using the highlighted photos. Runs in the background (fire-and-forget).
 *
 * - Queries highlight photos for the trip (is_highlight = 1)
 * - Downloads each photo to a temp path (prefers optimized_path)
 * - Calls generateSlideshow to produce an MP4
 * - Records the job in slideshow_jobs table
 */
async function autoGenerateHighlightSlideshow(tripId: string, userId: string): Promise<void> {
  const db = getDb();
  const storageProvider = getStorageProvider();

  // Check if there's already a running slideshow job for this trip
  const activeJob = db.prepare(
    `SELECT id FROM slideshow_jobs WHERE trip_id = ? AND status IN ('queued', 'running')`
  ).get(tripId) as { id: string } | undefined;
  if (activeJob) {
    console.log(`[highlights] Skipping auto-slideshow: job already running for trip ${tripId}`);
    return;
  }

  // Get highlighted photo IDs (ordered by the original photo sequence)
  const highlightPhotos = db.prepare(
    `SELECT mi.id, mi.file_path, mi.optimized_path
     FROM highlight_results hr
     INNER JOIN media_items mi ON mi.id = hr.photo_id
     WHERE hr.trip_id = ? AND hr.is_highlight = 1
     ORDER BY mi.created_at ASC, mi.id ASC`
  ).all(tripId) as Array<{ id: string; file_path: string; optimized_path: string | null }>;

  if (highlightPhotos.length < 2) {
    console.log(`[highlights] Skipping auto-slideshow: only ${highlightPhotos.length} highlight(s) for trip ${tripId}`);
    return;
  }

  // Create slideshow job record
  const jobId = uuidv4();
  const now = new Date().toISOString();
  const photoIds = highlightPhotos.map(p => p.id);

  db.prepare(
    `INSERT INTO slideshow_jobs (id, trip_id, user_id, status, photo_ids, audio_track_id, created_at)
     VALUES (?, ?, ?, 'running', ?, NULL, ?)`
  ).run(jobId, tripId, userId, JSON.stringify(photoIds), now);

  // Download photos to temp (prefer optimized_path)
  const photoPaths: string[] = [];
  for (const photo of highlightPhotos) {
    try {
      const storagePath = photo.optimized_path || photo.file_path;
      const localPath = await storageProvider.downloadToTemp(storagePath);
      photoPaths.push(localPath);
    } catch (err) {
      console.warn(`[highlights] Auto-slideshow: skipping photo ${photo.id}: ${err}`);
    }
  }

  if (photoPaths.length < 2) {
    db.prepare(
      `UPDATE slideshow_jobs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?`
    ).run('可用照片不足 2 张', new Date().toISOString(), jobId);
    return;
  }

  // Generate slideshow
  const uploadsBase = path.resolve(__dirname, '..', '..', 'uploads');
  const outputDir = path.join(uploadsBase, tripId, 'slideshow');

  try {
    const result = await generateSlideshow({
      photoPaths,
      audioPath: null,
      outputDir,
      photoDuration: 2,
    });

    if (result.success && result.outputPath) {
      const outputFilename = path.basename(result.outputPath);
      const relativeOutputPath = path.join(tripId, 'slideshow', outputFilename);

      db.prepare(
        `UPDATE slideshow_jobs SET status = 'completed', output_path = ?, total_duration = ?, percent = 100, completed_at = ? WHERE id = ?`
      ).run(relativeOutputPath, result.totalDuration, new Date().toISOString(), jobId);

      console.log(`[highlights] Auto-slideshow generated for trip ${tripId}: ${relativeOutputPath} (${result.totalDuration}s)`);
    } else {
      const errorMessage = result.error || '视频生成失败';
      db.prepare(
        `UPDATE slideshow_jobs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?`
      ).run(errorMessage, new Date().toISOString(), jobId);
      console.error(`[highlights] Auto-slideshow failed for trip ${tripId}: ${errorMessage}`);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE slideshow_jobs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?`
    ).run(errorMessage, new Date().toISOString(), jobId);
    console.error(`[highlights] Auto-slideshow error for trip ${tripId}: ${errorMessage}`);
  }
}

// ---------------------------------------------------------------------------
// Tier Photos Types & Helpers
// ---------------------------------------------------------------------------

interface TierPhotoItem {
  id: string;
  filePath: string;
  thumbnailUrl: string;
  originalUrl: string;
  category: string | null;
  reason: string | null;
}

/**
 * Find the tier slideshow video file for a trip.
 * Returns a URL path if a slideshow exists, or null otherwise.
 */
function getTierSlideshowUrls(tripId: string): Record<string, string> {
  const uploadsBase = path.resolve(__dirname, '..', '..', 'uploads');
  const tierSlideshowDir = path.join(uploadsBase, tripId, 'tier-slideshow');
  const urls: Record<string, string> = {};

  if (!fs.existsSync(tierSlideshowDir)) {
    return urls;
  }

  try {
    const entries = fs.readdirSync(tierSlideshowDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Per-category subdirectory (animal/, landscape/, people/)
        const catDir = path.join(tierSlideshowDir, entry.name);
        const catFiles = fs.readdirSync(catDir);
        const mp4File = catFiles.find((f) => f.endsWith('.mp4'));
        if (mp4File) {
          urls[entry.name] = `/api/trips/${tripId}/tier-slideshow/${entry.name}/${mp4File}`;
        }
      } else if (entry.isFile() && entry.name.endsWith('.mp4')) {
        // Legacy: mp4 directly in tier-slideshow/ root
        urls['all'] = `/api/trips/${tripId}/tier-slideshow/${entry.name}`;
      }
    }
  } catch {
    // Directory not readable
  }

  return urls;
}

/**
 * Query tier photos for a trip from the database.
 * Excludes trashed photos (only returns status = 'active').
 */
function queryTierPhotos(tripId: string): TierPhotoItem[] {
  const db = getDb();
  const rows = db
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

  return rows.map((row) => ({
    id: row.id,
    filePath: row.file_path,
    thumbnailUrl: `/api/media/${row.id}/thumbnail`,
    originalUrl: `/api/media/${row.id}/original`,
    category: row.category,
    reason: row.reason,
  }));
}

// ---------------------------------------------------------------------------
// GET /api/trips/:id/tier-photos — Public endpoint for tier photos
// Only returns data for trips with visibility = 'public'
// Requirements: 8.1, 8.2, 8.3, 9.3
// ---------------------------------------------------------------------------
router.get('/:id/tier-photos', authMiddleware, (req: Request, res: Response) => {
  const db = getDb();
  const tripId = req.params.id as string;

  // Verify trip exists
  const trip = db
    .prepare('SELECT id, user_id, visibility FROM trips WHERE id = ?')
    .get(tripId) as { id: string; user_id: string; visibility: string } | undefined;

  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Check if requester is owner or admin (they can always access)
  const isOwnerOrAdmin =
    req.user != null &&
    (req.user.role === 'admin' || req.user.userId === trip.user_id);

  // Public endpoint: non-owners can only see public trips
  if (!isOwnerOrAdmin && trip.visibility !== 'public') {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  const photos = queryTierPhotos(tripId);
  const slideshowUrls = getTierSlideshowUrls(tripId);

  return res.json({ photos, slideshowUrls });
});

// ---------------------------------------------------------------------------
// GET /api/trips/:id/highlight-photos — Public endpoint for all highlight photos
// Returns all photos with is_highlight = 1 and status = 'active' for the trip.
// Auth optional; non-owners can only see public trips.
// Requirements: 6.3, 6.5
// ---------------------------------------------------------------------------
router.get('/:id/highlight-photos', authMiddleware, (req: Request, res: Response) => {
  const db = getDb();
  const tripId = req.params.id as string;

  // Verify trip exists
  const trip = db
    .prepare('SELECT id, user_id, visibility FROM trips WHERE id = ?')
    .get(tripId) as { id: string; user_id: string; visibility: string } | undefined;

  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Check if requester is owner or admin (they can always access)
  const isOwnerOrAdmin =
    req.user != null &&
    (req.user.role === 'admin' || req.user.userId === trip.user_id);

  // Public endpoint: non-owners can only see public trips
  if (!isOwnerOrAdmin && trip.visibility !== 'public') {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Query all highlight photos (is_highlight = 1, status = 'active')
  const rows = db
    .prepare(
      `SELECT mi.id, mi.file_path, mi.category, hr.reason
       FROM highlight_results hr
       INNER JOIN media_items mi ON mi.id = hr.photo_id
       WHERE hr.trip_id = ?
         AND hr.is_highlight = 1
         AND mi.status = 'active'
       ORDER BY mi.category, mi.created_at ASC`
    )
    .all(tripId) as Array<{
    id: string;
    file_path: string;
    category: string | null;
    reason: string | null;
  }>;

  const photos: TierPhotoItem[] = rows.map((row) => ({
    id: row.id,
    filePath: row.file_path,
    thumbnailUrl: `/api/media/${row.id}/thumbnail`,
    originalUrl: `/api/media/${row.id}/original`,
    category: row.category,
    reason: row.reason,
  }));

  return res.json({ photos });
});

// ---------------------------------------------------------------------------
// GET /api/trips/:id/tier-slideshow/:filename — Serve tier slideshow video file (legacy)
// GET /api/trips/:id/tier-slideshow/:category/:filename — Serve per-category tier video
// ---------------------------------------------------------------------------
router.get('/:id/tier-slideshow/:category/:filename', authMiddleware, (req: Request, res: Response) => {
  const tripId = req.params.id as string;
  const category = req.params.category as string;
  const filename = req.params.filename as string;

  // Verify trip exists and check visibility
  const db = getDb();
  const trip = db
    .prepare('SELECT id, user_id, visibility FROM trips WHERE id = ?')
    .get(tripId) as { id: string; user_id: string; visibility: string } | undefined;

  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  const isOwnerOrAdmin =
    req.user != null &&
    (req.user.role === 'admin' || req.user.userId === trip.user_id);

  if (!isOwnerOrAdmin && trip.visibility !== 'public') {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Prevent path traversal
  const safeCategory = path.basename(category);
  const safeName = path.basename(filename);
  if (!safeName.endsWith('.mp4')) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: '无效文件名' } });
  }

  const uploadsBase = path.resolve(__dirname, '..', '..', 'uploads');
  const videoPath = path.join(uploadsBase, tripId, 'tier-slideshow', safeCategory, safeName);

  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '视频文件不存在' } });
  }

  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });

    return fs.createReadStream(videoPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    });

    return fs.createReadStream(videoPath).pipe(res);
  }
});

router.get('/:id/tier-slideshow/:filename', authMiddleware, (req: Request, res: Response) => {
  const tripId = req.params.id as string;
  const filename = req.params.filename as string;

  // Verify trip exists and check visibility
  const db = getDb();
  const trip = db
    .prepare('SELECT id, user_id, visibility FROM trips WHERE id = ?')
    .get(tripId) as { id: string; user_id: string; visibility: string } | undefined;

  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  const isOwnerOrAdmin =
    req.user != null &&
    (req.user.role === 'admin' || req.user.userId === trip.user_id);

  if (!isOwnerOrAdmin && trip.visibility !== 'public') {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Prevent path traversal
  const safeName = path.basename(filename);
  if (!safeName.endsWith('.mp4')) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: '无效文件名' } });
  }

  const uploadsBase = path.resolve(__dirname, '..', '..', 'uploads');
  const videoPath = path.join(uploadsBase, tripId, 'tier-slideshow', safeName);

  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '视频文件不存在' } });
  }

  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });

    return fs.createReadStream(videoPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    });

    return fs.createReadStream(videoPath).pipe(res);
  }
});

export default router;
