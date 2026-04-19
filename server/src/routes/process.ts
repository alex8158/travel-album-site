import { Router, Request, Response } from 'express';
import { getDb } from '../database';
import { runTripProcessingPipeline } from '../services/pipeline/runTripProcessingPipeline';
import { ProgressReporter } from '../services/progressReporter';
import type { PipelineStage } from '../services/pipeline/types';
import type { StepName } from '../services/progressReporter';

const router = Router();

const processingTrips = new Set<string>();

/**
 * Map PipelineStage to ProgressReporter StepName.
 * Stages that don't map to a visible SSE step return null.
 */
const STAGE_TO_STEP: Partial<Record<PipelineStage, StepName>> = {
  classify: 'classify',
  blur: 'blurDetect',
  dedup: 'dedup',
  analyze: 'analyze',
  optimize: 'optimize',
  thumbnail: 'thumbnail',
  videoAnalysis: 'videoAnalysis',
  videoEdit: 'videoEdit',
  cover: 'cover',
};

// POST /api/trips/:id/process — Trigger full processing pipeline and return summary
router.post('/:id/process', async (req: Request, res: Response) => {
  const tripId = req.params.id as string;
  const db = getDb();

  // Verify trip exists
  const trip = db.prepare('SELECT id FROM trips WHERE id = ?').get(tripId);
  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  if (processingTrips.has(tripId)) {
    return res.status(409).json({ error: { code: 'ALREADY_PROCESSING', message: '该旅行正在处理中，请稍后再试' } });
  }

  // For large trips, recommend using SSE stream instead
  const imageCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image'"
  ).get(tripId) as { cnt: number }).cnt;

  if (imageCount > 80) {
    return res.status(400).json({
      error: {
        code: 'USE_STREAM',
        message: `该旅行有 ${imageCount} 张图片，请使用 /process/stream 接口`,
        imageCount,
      },
    });
  }

  processingTrips.add(tripId);

  // Parse optional query parameters
  const videoResolution = req.query.videoResolution ? Number(req.query.videoResolution) : undefined;

  try {
    const result = await runTripProcessingPipeline(tripId, { videoResolution });
    return res.json({
      tripId: result.tripId,
      totalImages: result.totalImages,
      totalVideos: result.totalVideos,
      blurryDeletedCount: result.blurryDeletedCount,
      dedupDeletedCount: result.dedupDeletedCount,
      analyzedCount: result.analyzedCount,
      optimizedCount: result.optimizedCount,
      classifiedCount: result.classifiedCount,
      categoryStats: result.categoryStats,
      compiledCount: result.compiledCount,
      failedCount: result.failedCount,
      coverImageId: result.coverImageId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[process] Pipeline failed for trip ${tripId}: ${message}`);
    return res.status(500).json({ error: { code: 'PROCESSING_FAILED', message } });
  } finally {
    processingTrips.delete(tripId);
  }
});

// GET /api/trips/:id/process/stream — SSE streaming processing with progress
router.get('/:id/process/stream', async (req: Request, res: Response) => {
  const tripId = req.params.id as string;
  const db = getDb();

  // Verify trip exists before establishing SSE connection
  const trip = db.prepare('SELECT id FROM trips WHERE id = ?').get(tripId);
  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  if (processingTrips.has(tripId)) {
    return res.status(409).json({ error: { code: 'ALREADY_PROCESSING', message: '该旅行正在处理中，请稍后再试' } });
  }
  processingTrips.add(tripId);

  // Parse optional query parameters
  const videoResolution = req.query.videoResolution ? Number(req.query.videoResolution) : undefined;

  // Track client disconnect
  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
  });

  // Create ProgressReporter and initialize SSE
  const reporter = new ProgressReporter(res);
  reporter.initSSE();

  // Heartbeat: send keepalive every 15s to prevent SSE timeout
  const heartbeat = setInterval(() => {
    if (!clientDisconnected) {
      res.write(`:keepalive\n\n`);
    }
  }, 15000);

  try {
    const result = await runTripProcessingPipeline(tripId, {
      videoResolution,
      onProgress: (stage, status, _detail) => {
        if (clientDisconnected) return;
        const stepName = STAGE_TO_STEP[stage];
        if (!stepName) return; // skip internal stages like collectInputs, reduce, write

        if (status === 'start') {
          reporter.sendStepStart(stepName, { processed: 0 });
        } else if (status === 'complete') {
          reporter.sendStepComplete(stepName);
        }
      },
    });

    if (!clientDisconnected) {
      reporter.sendComplete({
        tripId: result.tripId,
        totalImages: result.totalImages,
        totalVideos: result.totalVideos,
        blurryDeletedCount: result.blurryDeletedCount,
        dedupDeletedCount: result.dedupDeletedCount,
        analyzedCount: result.analyzedCount,
        optimizedCount: result.optimizedCount,
        classifiedCount: result.classifiedCount,
        categoryStats: result.categoryStats,
        compiledCount: result.compiledCount,
        failedCount: result.failedCount,
        coverImageId: result.coverImageId,
      });
    }
  } catch (err: unknown) {
    if (!clientDisconnected) {
      const message = err instanceof Error ? err.message : String(err);
      reporter.sendError({ message });
    }
  } finally {
    clearInterval(heartbeat);
    processingTrips.delete(tripId);
  }
});

export default router;
