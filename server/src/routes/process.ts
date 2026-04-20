import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import { runTripProcessingPipeline } from '../services/pipeline/runTripProcessingPipeline';
import { JobProgressReporter } from '../services/jobProgressReporter';

const router = Router();

// POST /api/trips/:id/process — Trigger full processing pipeline and return summary
// Kept as-is for backward compatibility (synchronous, no job backend).
router.post('/:id/process', async (req: Request, res: Response) => {
  const tripId = req.params.id as string;
  const db = getDb();

  // Verify trip exists
  const trip = db.prepare('SELECT id FROM trips WHERE id = ?').get(tripId);
  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Check for active job in DB (replaces in-memory Set)
  const activeJob = db.prepare(
    `SELECT id FROM processing_jobs WHERE trip_id = ? AND status IN ('queued', 'running')`
  ).get(tripId) as { id: string } | undefined;
  if (activeJob) {
    return res.status(409).json({ error: { code: 'ALREADY_PROCESSING', message: '该旅行正在处理中，请稍后再试' } });
  }

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
  }
});

// ---------------------------------------------------------------------------
// GET /api/trips/:id/process/stream — SSE streaming via job backend
// ---------------------------------------------------------------------------

interface JobEventRow {
  id: number;
  seq: number;
  level: string;
  step: string | null;
  message: string;
  processed: number | null;
  total: number | null;
  created_at: string;
}

interface JobStatusRow {
  status: string;
  result_json: string | null;
  error_message: string | null;
  current_step: string | null;
  percent: number;
  processed: number;
  total: number;
}

router.get('/:id/process/stream', async (req: Request, res: Response) => {
  const tripId = req.params.id as string;
  const db = getDb();

  // Verify trip exists before establishing SSE connection
  const trip = db.prepare('SELECT id FROM trips WHERE id = ?').get(tripId);
  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Create a processing_job record (atomic check + insert, same as POST /process-jobs)
  const jobId = uuidv4();
  const now = new Date().toISOString();

  const createJob = db.transaction(() => {
    const existing = db.prepare(
      `SELECT id FROM processing_jobs WHERE trip_id = ? AND status IN ('queued', 'running')`
    ).get(tripId) as { id: string } | undefined;

    if (existing) {
      return { conflict: true, existingJobId: existing.id };
    }

    db.prepare(
      `INSERT INTO processing_jobs (id, trip_id, status, created_at) VALUES (?, ?, 'queued', ?)`
    ).run(jobId, tripId, now);

    return { conflict: false };
  });

  const createResult = createJob();

  if (createResult.conflict) {
    return res.status(409).json({
      error: {
        code: 'ALREADY_PROCESSING',
        message: '该旅行正在处理中，请稍后再试',
      },
    });
  }

  // Parse optional query parameters
  const videoResolution = req.query.videoResolution ? Number(req.query.videoResolution) : undefined;

  // Track client disconnect
  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
  });

  // Initialize SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Heartbeat: send keepalive every 15s
  const heartbeat = setInterval(() => {
    if (!clientDisconnected) {
      res.write(`event: heartbeat\ndata: {}\n\n`);
    }
  }, 15000);

  // Start pipeline in background with jobProgressReporter
  const reporter = new JobProgressReporter(jobId);
  reporter.markRunning();

  runTripProcessingPipeline(tripId, {
    videoResolution,
    onProgress: reporter.toPipelineCallback(),
  })
    .then((pipelineResult) => {
      reporter.markCompleted(JSON.stringify(pipelineResult));
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[process/stream] Pipeline failed for job ${jobId}: ${message}`);
      reporter.markFailed(message);
    });

  // Poll processing_job_events every 500ms and stream new events as SSE
  let lastSeq = 0;

  const poll = setInterval(() => {
    if (clientDisconnected) {
      clearInterval(poll);
      clearInterval(heartbeat);
      return;
    }

    // Fetch new events since lastSeq
    const events = db.prepare(
      `SELECT id, seq, level, step, message, processed, total, created_at
       FROM processing_job_events
       WHERE job_id = ? AND seq > ?
       ORDER BY seq ASC`
    ).all(jobId, lastSeq) as JobEventRow[];

    for (const evt of events) {
      if (clientDisconnected) break;
      res.write(`event: progress\ndata: ${JSON.stringify({
        seq: evt.seq,
        level: evt.level,
        step: evt.step,
        message: evt.message,
        processed: evt.processed,
        total: evt.total,
      })}\n\n`);
      lastSeq = evt.seq;
    }

    // Check job final status
    const job = db.prepare(
      `SELECT status, result_json, error_message, current_step, percent, processed, total
       FROM processing_jobs WHERE id = ?`
    ).get(jobId) as JobStatusRow | undefined;

    if (!job) {
      // Job disappeared — shouldn't happen, but handle gracefully
      clearInterval(poll);
      clearInterval(heartbeat);
      if (!clientDisconnected) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: '任务记录丢失' })}\n\n`);
        res.end();
      }
      return;
    }

    if (job.status === 'completed') {
      clearInterval(poll);
      clearInterval(heartbeat);
      if (!clientDisconnected) {
        try {
          const result = JSON.parse(job.result_json!);
          res.write(`event: complete\ndata: ${JSON.stringify({
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
          })}\n\n`);
        } catch {
          res.write(`event: error\ndata: ${JSON.stringify({ message: '结果解析失败' })}\n\n`);
        }
        res.end();
      }
      return;
    }

    if (job.status === 'failed') {
      clearInterval(poll);
      clearInterval(heartbeat);
      if (!clientDisconnected) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: job.error_message || '处理失败' })}\n\n`);
        res.end();
      }
      return;
    }
  }, 500);

  // Handle client disconnect cleanup
  req.on('close', () => {
    clearInterval(poll);
    clearInterval(heartbeat);
  });
});

export default router;
