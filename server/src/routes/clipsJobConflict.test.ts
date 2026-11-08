/**
 * G-29: POST /clips, /merge, /re-edit share the per-trip active-job slot.
 * A second request for the same trip while a job is queued/running gets
 * 409 ALREADY_PROCESSING instead of an unhandled SQLite error.
 *
 * Real SQLite and the real job insert; only the slow media processing is
 * replaced by holdable fakes so the first job can be kept `running`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ctl = vi.hoisted(() => {
  let release: (() => void) | null = null;
  let gate: Promise<void> = Promise.resolve();
  return {
    hold() { gate = new Promise<void>((r) => { release = r; }); },
    release() { release?.(); release = null; },
    wait: () => gate,
  };
});
const stubs = vi.hoisted(() => ({
  analyzeVideo: vi.fn(async (_p: string, mediaId: string) => {
    await ctl.wait();
    return { mediaId, segments: [0, 1].map((i) => ({ index: i, startTime: i * 5, endTime: i * 5 + 5, duration: 5,
      sharpnessScore: 0.9, stabilityScore: 0.9, exposureScore: 0.9, overallScore: 0.9, label: 'good' })) };
  }),
  editVideo: vi.fn(async () => ({ success: true, compiledPath: null })),
  selectSegments: vi.fn((s: unknown[]) => s),
  mergeSegments: vi.fn(async () => { await ctl.wait(); return { success: true, mergedPath: 'x' }; }),
}));
vi.mock('../services/videoAnalyzer', () => ({ analyzeVideo: stubs.analyzeVideo }));
vi.mock('../services/videoEditor', () => ({ editVideo: stubs.editVideo, selectSegments: stubs.selectSegments }));
vi.mock('../services/mergeEngine', () => ({ mergeSegments: stubs.mergeSegments }));

import express from 'express';
import http from 'http';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import { getStorageProvider } from '../storage/factory';
import { createTripJobOrConflict, isActiveTripJobConstraintError } from '../helpers/tripJobCreation';
import clipsRouter from './clips';

const app = express();
app.use(express.json());
app.use('/api/media', clipsRouter);
const openServers = new Set<http.Server>();
async function local(): Promise<http.Server> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  openServers.add(server);
  return server;
}
afterEach(async () => {
  await Promise.all([...openServers].map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  openServers.clear();
});

const ROUTES: Record<string, [string, Record<string, unknown>]> = {
  clips: ['clips', {}],
  merge: ['merge', { segmentIndices: [0, 1] }],
  're-edit': ['re-edit', {}],
};
const settle = () => new Promise((r) => setTimeout(r, 60));

/**
 * Remove only what this test created, scoped to its own trip ids: first wait
 * for the test's background jobs (started after a 202) to leave queued/running,
 * then delete their job events and jobs, the trips' media data and the trips.
 * Test files share one DB file, and processing_jobs references trips, so
 * leftover job rows would break the next file's `DELETE FROM trips`.
 */
async function cleanupTripTestData(db: ReturnType<typeof getDb>, tripIds: string[]): Promise<void> {
  if (tripIds.length === 0) return;
  const ph = tripIds.map(() => '?').join(', ');
  const activeSql = `SELECT COUNT(*) AS c FROM processing_jobs WHERE trip_id IN (${ph}) AND status IN ('queued', 'running')`;
  for (let i = 0; i < 150; i++) {
    if ((db.prepare(activeSql).get(...tripIds) as { c: number }).c === 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const stillActive = (db.prepare(activeSql).get(...tripIds) as { c: number }).c;
  if (stillActive > 0) throw new Error(`cleanup: ${stillActive} test job(s) still active for trips ${tripIds.join(',')}`);
  const media = `SELECT id FROM media_items WHERE trip_id IN (${ph})`;
  db.transaction(() => {
    db.prepare(`DELETE FROM processing_job_events WHERE job_id IN (SELECT id FROM processing_jobs WHERE trip_id IN (${ph}))`).run(...tripIds);
    db.prepare(`DELETE FROM processing_jobs WHERE trip_id IN (${ph})`).run(...tripIds);
    db.prepare(`DELETE FROM compile_jobs WHERE media_id IN (${media})`).run(...tripIds);
    db.prepare(`DELETE FROM video_segments WHERE media_id IN (${media})`).run(...tripIds);
    db.prepare(`DELETE FROM media_items WHERE trip_id IN (${ph})`).run(...tripIds);
    db.prepare(`DELETE FROM trips WHERE id IN (${ph})`).run(...tripIds);
  })();
}

function createUser(role: 'admin' | 'regular') {
  const userId = uuidv4(); const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, 'h', ?, 'active', ?, ?)`)
    .run(userId, `g29_${userId.slice(0, 8)}`, role, now, now);
  return { userId, token: signToken({ userId, role }) };
}

describe('G-29: per-trip job conflicts on POST /clips, /merge, /re-edit', () => {
  let owner: { userId: string; token: string };
  let other: { userId: string; token: string };
  let tripA: string; let tripB: string;
  const createdTrips = new Set<string>();

  function trip(): string {
    const t = `g29-${uuidv4().slice(0, 8)}`; const now = new Date().toISOString();
    createdTrips.add(t);
    getDb().prepare(`INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at) VALUES (?, 't', 'public', ?, ?, ?)`).run(t, owner.userId, now, now);
    return t;
  }
  function video(t: string): string {
    const id = uuidv4(); const now = new Date().toISOString();
    getDb().prepare(`INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, visibility, media_source, processing_status, created_at)
      VALUES (?, ?, ?, 'video', 'video/mp4', 'v.mp4', 1, 'active', 'private', 'upload', 'none', ?)`).run(id, t, `${t}/originals/${id}.mp4`, now);
    [0, 1].forEach((i) => getDb().prepare(`INSERT INTO video_segments (id, media_id, segment_index, start_time, end_time, duration, overall_score, label, selected, created_at)
      VALUES (?, ?, ?, ?, ?, 5, 80, 'good', 1, ?)`).run(uuidv4(), id, i, i * 5, i * 5 + 5, now));
    return id;
  }
  async function post(route: string, mediaId: string, token: string) {
    const [sub, body] = ROUTES[route];
    const res = await request(await local()).post(`/api/media/${mediaId}/${sub}`).set('Authorization', `Bearer ${token}`).send(body);
    await settle();
    return res;
  }
  const jobs = (t: string) => getDb().prepare('SELECT id, status, current_step FROM processing_jobs WHERE trip_id = ? ORDER BY created_at').all(t) as Array<{ id: string; status: string; current_step: string }>;
  const processingCalls = () => stubs.analyzeVideo.mock.calls.length + stubs.mergeSegments.mock.calls.length;
  async function waitStatus(jobId: string, status: string) {
    for (let i = 0; i < 100; i++) {
      const r = getDb().prepare('SELECT status FROM processing_jobs WHERE id = ?').get(jobId) as { status: string };
      if (r.status === status) return true;
      await new Promise((res) => setTimeout(res, 20));
    }
    return false;
  }

  beforeEach(() => {
    const db = getDb();
    db.exec('DROP TRIGGER IF EXISTS g29_test_block');
    owner = createUser('regular'); other = createUser('regular');
    createdTrips.clear();
    tripA = trip(); tripB = trip();
    Object.values(stubs).forEach((s) => s.mockClear());
    vi.spyOn(getStorageProvider(), 'downloadToTemp').mockResolvedValue('/tmp/g29-not-a-real-file.mp4');
  });
  afterEach(async () => {
    ctl.release();
    const db = getDb();
    db.exec('DROP TRIGGER IF EXISTS g29_test_block');
    await cleanupTripTestData(db, [...createdTrips]);
    vi.restoreAllMocks();
    closeDb();
  });

  for (const [first, second] of [['clips', 'clips'], ['merge', 'merge'], ['re-edit', 're-edit'], ['clips', 'merge']] as const) {
    it(`same trip ${first} -> ${second}: second is 409 ALREADY_PROCESSING; first runs on and completes`, async () => {
      const v1 = video(tripA); const v2 = video(tripA);
      ctl.hold();
      const r1 = await post(first, v1, owner.token);
      expect(r1.status).toBe(202);
      expect(await waitStatus(r1.body.jobId, 'running')).toBe(true);
      const callsBefore = processingCalls();

      const r2 = await post(second, v2, owner.token);
      expect(r2.status).toBe(409);
      expect(r2.body).toEqual({ error: { code: 'ALREADY_PROCESSING', message: '该旅行正在处理中', existingJobId: r1.body.jobId } });
      expect(jobs(tripA)).toHaveLength(1);
      expect(processingCalls()).toBe(callsBefore);

      ctl.release();
      expect(await waitStatus(r1.body.jobId, 'completed')).toBe(true);
      // The slot is free again: a new request for the same trip is accepted.
      const r3 = await post(second, v2, owner.token);
      expect(r3.status).toBe(202);
      expect(await waitStatus(r3.body.jobId, 'completed')).toBe(true);
    });
  }

  it('different trips do not conflict', async () => {
    ctl.hold();
    const r1 = await post('clips', video(tripA), owner.token);
    const r2 = await post('merge', video(tripB), owner.token);
    expect([r1.status, r2.status]).toEqual([202, 202]);
    ctl.release();
    expect(await waitStatus(r1.body.jobId, 'completed')).toBe(true);
    expect(await waitStatus(r2.body.jobId, 'completed')).toBe(true);
  });

  it('a non-owner still gets 403 while the trip has an active job', async () => {
    const v1 = video(tripA); const v2 = video(tripA);
    ctl.hold();
    const r1 = await post('clips', v1, owner.token);
    expect(r1.status).toBe(202);
    for (const route of Object.keys(ROUTES)) {
      const res = await post(route, v2, other.token);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    expect(jobs(tripA)).toHaveLength(1);
  });

  it('other database errors on job creation return 500 and the app keeps serving', async () => {
    const v1 = video(tripA);
    const db = getDb();
    // A trigger that rejects every new processing job with a non-unique error.
    // Test files share one DB file (singleFork), so the trigger must never
    // outlive this test: dropped here, in finally, and again in afterEach.
    db.exec('DROP TRIGGER IF EXISTS g29_test_block');
    db.exec(`CREATE TRIGGER g29_test_block BEFORE INSERT ON processing_jobs BEGIN SELECT RAISE(ABORT, 'g29 simulated failure'); END;`);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const route of Object.keys(ROUTES)) {
        const res = await post(route, v1, owner.token);
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } });
      }
      expect(err.mock.calls.some((c) => String(c[0]).includes(`tripId=${tripA}`) && String(c[0]).includes(`mediaId=${v1}`))).toBe(true);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS g29_test_block');
    }
    expect(processingCalls()).toBe(0);
    const ok = await post('clips', v1, owner.token);
    expect(ok.status).toBe(202);
  });
});

describe('createTripJobOrConflict / isActiveTripJobConstraintError', () => {
  afterEach(() => closeDb());
  it('maps only the processing_jobs.trip_id unique constraint', () => {
    expect(isActiveTripJobConstraintError({ code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'UNIQUE constraint failed: processing_jobs.trip_id' })).toBe(true);
    expect(isActiveTripJobConstraintError({ code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'UNIQUE constraint failed: processing_jobs.id' })).toBe(false);
    expect(isActiveTripJobConstraintError({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY', message: 'processing_jobs.trip_id' })).toBe(false);
    expect(isActiveTripJobConstraintError(new Error('UNIQUE constraint failed: processing_jobs.trip_id'))).toBe(false);
  });
  it('a trip_id constraint error with no readable active job is an error, not a conflict', () => {
    const fakeDb = {
      transaction: () => () => { throw Object.assign(new Error('UNIQUE constraint failed: processing_jobs.trip_id'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }); },
      prepare: () => ({ get: () => undefined }),
    } as unknown as Parameters<typeof createTripJobOrConflict>[0];
    expect(createTripJobOrConflict(fakeDb, 't', 'videoClip').kind).toBe('error');
    const fakeDb2 = {
      transaction: () => () => { throw Object.assign(new Error('UNIQUE constraint failed: processing_jobs.trip_id'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }); },
      prepare: () => ({ get: () => ({ id: 'job-1' }) }),
    } as unknown as Parameters<typeof createTripJobOrConflict>[0];
    expect(createTripJobOrConflict(fakeDb2, 't', 'videoClip')).toEqual({ kind: 'conflict', existingJobId: 'job-1' });
  });
});
