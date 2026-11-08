/**
 * Create a processing job for a trip, or report the trip's active job
 * (multi-user-system G-29).
 *
 * `processing_jobs` has the partial unique index
 * `idx_processing_jobs_active_trip ON processing_jobs(trip_id) WHERE status IN ('queued', 'running')`
 * (database.ts): one active job per trip. This helper follows the pattern in
 * routes/processJobs.ts — look up the active job and insert in one
 * transaction — so a second request for the same trip ends as a conflict
 * instead of an unhandled SQLite error that takes the process down.
 *
 * A constraint error from the INSERT is reported as a conflict only when it is
 * the `processing_jobs.trip_id` unique constraint AND an active job for the
 * trip can be read back. Every other failure is returned as `error` for the
 * caller to answer with a 500.
 */
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

export type CreateTripJobResult =
  | { kind: 'created'; jobId: string }
  | { kind: 'conflict'; existingJobId: string }
  | { kind: 'error'; error: unknown };

const ACTIVE_JOB_SQL = `SELECT id FROM processing_jobs WHERE trip_id = ? AND status IN ('queued', 'running') LIMIT 1`;

/** True only for the active-job unique constraint on processing_jobs.trip_id. */
export function isActiveTripJobConstraintError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return (
    e != null &&
    e.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    typeof e.message === 'string' &&
    e.message.includes('processing_jobs.trip_id')
  );
}

export function createTripJobOrConflict(db: Database.Database, tripId: string, currentStep: string): CreateTripJobResult {
  const jobId = uuidv4();
  const now = new Date().toISOString();
  try {
    return db.transaction((): CreateTripJobResult => {
      const existing = db.prepare(ACTIVE_JOB_SQL).get(tripId) as { id: string } | undefined;
      if (existing) return { kind: 'conflict', existingJobId: existing.id };
      db.prepare(
        `INSERT INTO processing_jobs (id, trip_id, status, current_step, created_at)
         VALUES (?, ?, 'queued', ?, ?)`,
      ).run(jobId, tripId, currentStep, now);
      return { kind: 'created', jobId };
    })();
  } catch (err) {
    if (isActiveTripJobConstraintError(err)) {
      try {
        const existing = db.prepare(ACTIVE_JOB_SQL).get(tripId) as { id: string } | undefined;
        if (existing) return { kind: 'conflict', existingJobId: existing.id };
      } catch {
        /* fall through to error */
      }
    }
    return { kind: 'error', error: err };
  }
}
