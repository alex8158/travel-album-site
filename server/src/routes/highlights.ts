import { Router, Request, Response } from 'express';
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

export default router;
