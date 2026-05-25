import { Router, Request, Response } from 'express';
import { getDb } from '../database';
import { authMiddleware, requireAuth } from '../middleware/auth';
import {
  runHighlightEvaluation,
  getHighlightsForTrip,
  getSimilarGroupsForTrip,
  HighlightServiceError,
} from '../services/highlightService';

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

  try {
    const evaluation = await runHighlightEvaluation(tripId);
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

export default router;
