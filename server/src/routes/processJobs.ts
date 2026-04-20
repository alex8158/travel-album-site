import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import { authMiddleware, requireAuth } from '../middleware/auth';
import { JobProgressReporter } from '../services/jobProgressReporter';
import { runTripProcessingPipeline } from '../services/pipeline/runTripProcessingPipeline';
import type { TripRow } from '../helpers/tripRow';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  trip_id: string;
  status: string;
  current_step: string | null;
  percent: number;
  processed: number;
  total: number;
  error_message: string | null;
  result_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface EventRow {
  id: number;
  seq: number;
  level: string;
  step: string | null;
  message: string;
  processed: number | null;
  total: number | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jobRowToCamelCase(row: JobRow) {
  return {
    id: row.id,
    tripId: row.trip_id,
    status: row.status,
    currentStep: row.current_step,
    percent: row.percent,
    processed: row.processed,
    total: row.total,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function eventRowToCamelCase(row: EventRow) {
  return {
    id: row.id,
    seq: row.seq,
    level: row.level,
    step: row.step,
    message: row.message,
    processed: row.processed,
    total: row.total,
    createdAt: row.created_at,
  };
}

/**
 * Look up the trip that owns a job. Returns the trip row or null.
 */
function getTripForJob(jobId: string): { job: JobRow; trip: TripRow } | null {
  const db = getDb();
  const job = db.prepare('SELECT * FROM processing_jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!job) return null;
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(job.trip_id) as TripRow | undefined;
  if (!trip) return null;
  return { job, trip };
}

/**
 * Verify the authenticated user is the trip owner or an admin.
 * Returns true if authorized, false otherwise (and sends the appropriate response).
 */
function verifyTripAccess(req: Request, res: Response, trip: TripRow): boolean {
  if (req.user!.role === 'admin') return true;
  if (req.user!.userId === trip.user_id) return true;
  res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
  return false;
}

// ---------------------------------------------------------------------------
// Routers
// ---------------------------------------------------------------------------

/** Router mounted at /api/trips — handles trip-scoped job endpoints */
export const tripScopedRouter = Router();

/** Router mounted at /api/process-jobs — handles job-scoped endpoints */
export const jobScopedRouter = Router();

// ---------------------------------------------------------------------------
// POST /api/trips/:id/process-jobs — Create a processing job
// ---------------------------------------------------------------------------

tripScopedRouter.post('/:id/process-jobs', authMiddleware, requireAuth, (req: Request, res: Response) => {
  const tripId = req.params.id as string;
  console.log(`[processJobs] POST /process-jobs for trip ${tripId}`);
  const db = getDb();

  // Verify trip exists
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Verify owner or admin
  if (!verifyTripAccess(req, res, trip)) return;

  const jobId = uuidv4();
  const now = new Date().toISOString();

  // Atomic check + insert in a transaction
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

  const result = createJob();

  if (result.conflict) {
    return res.status(409).json({
      error: {
        code: 'ALREADY_PROCESSING',
        message: '该旅行正在处理中',
        existingJobId: result.existingJobId,
      },
    });
  }

  // Fire-and-forget: start pipeline in background
  setImmediate(() => {
    console.log(`[processJobs] Starting pipeline for job ${jobId}, trip ${tripId}`);
    const reporter = new JobProgressReporter(jobId);
    reporter.markRunning();

    runTripProcessingPipeline(tripId, {
      onProgress: reporter.toPipelineCallback(),
    })
      .then((pipelineResult) => {
        console.log(`[processJobs] Pipeline completed for job ${jobId}`);
        reporter.markCompleted(JSON.stringify(pipelineResult));
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[processJobs] Pipeline failed for job ${jobId}: ${message}`);
        reporter.markFailed(message);
      });
  });

  return res.status(201).json({ jobId, status: 'queued' });
});

// ---------------------------------------------------------------------------
// GET /api/trips/:id/active-job — Find active job for a trip
// ---------------------------------------------------------------------------

tripScopedRouter.get('/:id/active-job', authMiddleware, requireAuth, (req: Request, res: Response) => {
  const tripId = req.params.id as string;
  const db = getDb();

  // Verify trip exists
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
  if (!trip) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
  }

  // Verify owner or admin
  if (!verifyTripAccess(req, res, trip)) return;

  const activeJob = db.prepare(
    `SELECT id, status FROM processing_jobs WHERE trip_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`
  ).get(tripId) as { id: string; status: string } | undefined;

  if (!activeJob) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '没有正在进行的处理任务' } });
  }

  return res.json({ jobId: activeJob.id, status: activeJob.status });
});

// ---------------------------------------------------------------------------
// GET /api/process-jobs/:jobId — Poll job status
// ---------------------------------------------------------------------------

jobScopedRouter.get('/:jobId', authMiddleware, requireAuth, (req: Request, res: Response) => {
  const { jobId } = req.params as { jobId: string };
  const data = getTripForJob(jobId);

  if (!data) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '任务不存在' } });
  }

  if (!verifyTripAccess(req, res, data.trip)) return;

  return res.json(jobRowToCamelCase(data.job));
});

// ---------------------------------------------------------------------------
// GET /api/process-jobs/:jobId/events — Fetch events
// ---------------------------------------------------------------------------

jobScopedRouter.get('/:jobId/events', authMiddleware, requireAuth, (req: Request, res: Response) => {
  const { jobId } = req.params as { jobId: string };
  const data = getTripForJob(jobId);

  if (!data) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '任务不存在' } });
  }

  if (!verifyTripAccess(req, res, data.trip)) return;

  const after = req.query.after != null ? Number(req.query.after) : 0;

  const rows = getDb()
    .prepare(
      `SELECT id, seq, level, step, message, processed, total, created_at
       FROM processing_job_events
       WHERE job_id = ? AND seq > ?
       ORDER BY seq ASC`
    )
    .all(jobId, after) as EventRow[];

  return res.json({ events: rows.map(eventRowToCamelCase) });
});

// ---------------------------------------------------------------------------
// GET /api/process-jobs/:jobId/result — Fetch result
// ---------------------------------------------------------------------------

jobScopedRouter.get('/:jobId/result', authMiddleware, requireAuth, (req: Request, res: Response) => {
  const { jobId } = req.params as { jobId: string };
  const data = getTripForJob(jobId);

  if (!data) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: '任务不存在' } });
  }

  if (!verifyTripAccess(req, res, data.trip)) return;

  if (data.job.status !== 'completed') {
    return res.status(409).json({ error: { code: 'JOB_NOT_COMPLETE', message: '任务尚未完成' } });
  }

  try {
    const parsed = JSON.parse(data.job.result_json!);
    return res.json(parsed);
  } catch {
    return res.status(500).json({ error: { code: 'PARSE_ERROR', message: '结果解析失败' } });
  }
});
