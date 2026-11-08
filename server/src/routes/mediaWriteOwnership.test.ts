/**
 * G-27 (multi-user-system 需求 7 AC 8): media processing write routes are
 * owner/admin only and only for `active` media.
 *
 * Heavy processing is stubbed at the enqueue boundary. CompilationEngine is a
 * stub too, so the real `compile_jobs` write chain does not run here; for
 * POST /compile the evidence is "engine called / not called".
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';

const stubs = vi.hoisted(() => ({
  analyzeVideo: vi.fn(async (_p: string, mediaId: string) => ({
    mediaId,
    segments: [0, 1, 2].map((i) => ({
      index: i, startTime: i * 5, endTime: i * 5 + 5, duration: 5,
      sharpnessScore: 0.9, stabilityScore: 0.9, exposureScore: 0.9, overallScore: 0.9, label: 'good',
    })),
  })),
  editVideo: vi.fn(async () => ({ success: true, compiledPath: null })),
  selectSegments: vi.fn((segs: unknown[]) => segs),
  mergeSegments: vi.fn(async () => ({ success: true, mergedPath: 'x' })),
  autoCompile: vi.fn(async () => ({ success: true })),
  manualCompile: vi.fn(async () => ({ success: true })),
}));
vi.mock('../services/videoAnalyzer', () => ({ analyzeVideo: stubs.analyzeVideo }));
vi.mock('../services/videoEditor', () => ({ editVideo: stubs.editVideo, selectSegments: stubs.selectSegments }));
vi.mock('../services/mergeEngine', () => ({ mergeSegments: stubs.mergeSegments }));
vi.mock('../services/compilationEngine', () => ({
  CompilationEngine: class {
    autoCompile = stubs.autoCompile;
    manualCompile = stubs.manualCompile;
    getJobStatus() { return { jobId: 'stub-job', status: 'queued', percent: 0 }; }
  },
}));

import express from 'express';
import http from 'http';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import { getStorageProvider } from '../storage/factory';
import clipsRouter from './clips';
import compileRouter from './compile';

const app = express();
app.use(express.json());
app.use('/api/media', clipsRouter);
app.use('/api/media', compileRouter);

// Per-request server bound to 127.0.0.1 (docs/agent/known-issues.md 12a).
const openServers = new Set<http.Server>();
async function local(): Promise<http.Server> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  openServers.add(server);
  return server;
}
afterEach(async () => {
  await Promise.all([...openServers].map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections();
    s.close(() => resolve());
  })));
  openServers.clear();
});

const FORBIDDEN = { error: { code: 'FORBIDDEN', message: '无权操作此资源' } };

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

type Route = { name: string; path: (id: string) => string; body: Record<string, unknown>; stub: keyof typeof stubs };
const ROUTES: Route[] = [
  { name: 'POST /clips', path: (id) => `/api/media/${id}/clips`, body: { transitionType: 'fade' }, stub: 'analyzeVideo' },
  { name: 'POST /merge', path: (id) => `/api/media/${id}/merge`, body: { segmentIndices: [1, 0] }, stub: 'mergeSegments' },
  { name: 'POST /re-edit', path: (id) => `/api/media/${id}/re-edit`, body: { excludeIndices: [0] }, stub: 'mergeSegments' },
  { name: 'POST /compile (auto)', path: (id) => `/api/media/${id}/compile`, body: {}, stub: 'autoCompile' },
  { name: 'POST /compile (manual)', path: (id) => `/api/media/${id}/compile`, body: { segmentIndices: [1] }, stub: 'manualCompile' },
];
// Invalid input per route, to prove 403 comes before input validation.
const INVALID_BODY: Record<string, Record<string, unknown>> = {
  'POST /merge': { segmentIndices: [] },
  'POST /compile (auto)': { targetDuration: 99999 },
  'POST /compile (manual)': { segmentIndices: [42] },
};

function createUser(role: 'admin' | 'regular') {
  const userId = uuidv4();
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, 'hash', ?, 'active', ?, ?)`,
  ).run(userId, `g27_${userId.slice(0, 8)}`, role, now, now);
  return { userId, token: signToken({ userId, role }) };
}

describe('G-27 media processing write routes: owner/admin, active media only', () => {
  const tripId = `g27-trip-${uuidv4().slice(0, 8)}`;
  /** Trip ids this test created rows for (incl. orphan media trips). */
  const createdTrips = new Set<string>();
  let owner: { userId: string; token: string };
  let other: { userId: string; token: string };
  let admin: { userId: string; token: string };

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  async function post(url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    const r = request(await local()).post(url).send(body);
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    const res = await r;
    // Let the routes' fire-and-forget background work settle.
    await new Promise((resolve) => setTimeout(resolve, 80));
    return res;
  }

  function insertVideo(o: { status?: string; trip?: string; segments?: boolean } = {}): string {
    const id = uuidv4();
    const trip = o.trip ?? tripId;
    createdTrips.add(trip);
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size,
         status, visibility, media_source, processing_status, created_at)
       VALUES (?, ?, ?, 'video', 'video/mp4', 'v.mp4', 1, ?, 'private', 'upload', 'none', ?)`,
    ).run(id, trip, `${trip}/originals/${id}.mp4`, o.status ?? 'active', now);
    if (o.segments !== false) {
      [0, 1].forEach((i) => getDb().prepare(
        `INSERT INTO video_segments (id, media_id, segment_index, start_time, end_time, duration, overall_score, label, selected, created_at)
         VALUES (?, ?, ?, ?, ?, 10, 0.1, 'owner-label', 1, ?)`,
      ).run(uuidv4(), id, i, i * 10, i * 10 + 10, now));
    }
    return id;
  }

  const state = (mediaId: string) => ({
    jobs: (getDb().prepare('SELECT COUNT(*) AS c FROM processing_jobs').get() as { c: number }).c,
    segments: getDb().prepare(
      'SELECT segment_index, start_time, end_time, overall_score, label, selected FROM video_segments WHERE media_id = ? ORDER BY segment_index',
    ).all(mediaId),
  });
  const totalStubCalls = () => Object.values(stubs).reduce((n, s) => n + s.mock.calls.length, 0);

  let download: MockInstance<(relativePath: string) => Promise<string>>;
  beforeEach(() => {
    const db = getDb();
    for (const t of ['processing_job_events', 'processing_jobs', 'compile_jobs', 'video_segments', 'merged_video_sources',
      'media_tags', 'upload_sessions', 'media_items', 'duplicate_groups', 'trips']) {
      db.exec(`DELETE FROM ${t}`);
    }
    owner = createUser('regular');
    other = createUser('regular');
    admin = createUser('admin');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at) VALUES (?, 't', 'public', ?, ?, ?)`,
    ).run(tripId, owner.userId, now, now);
    createdTrips.clear();
    createdTrips.add(tripId);
    Object.values(stubs).forEach((s) => s.mockClear());
    download = vi.spyOn(getStorageProvider(), 'downloadToTemp').mockResolvedValue('/tmp/g27-not-a-real-file.mp4');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTripTestData(getDb(), [...createdTrips]);
    closeDb();
  });

  describe.each(ROUTES.map((r) => [r.name, r] as const))('%s', (_name, route) => {
    it('anonymous and invalid token: 401, nothing created or called', async () => {
      const id = insertVideo();
      const before = state(id);
      for (const h of [{}, { Authorization: 'Bearer not-a-token' }] as Array<Record<string, string>>) {
        expect((await post(route.path(id), route.body, h)).status).toBe(401);
      }
      expect(state(id)).toEqual(before);
      expect(totalStubCalls()).toBe(0);
      expect(download).not.toHaveBeenCalled();
    });

    it('owner and admin with valid input on active media: 202 and the processing entry is called for that media', async () => {
      for (const token of [owner.token, admin.token]) {
        const id = insertVideo();
        Object.values(stubs).forEach((s) => s.mockClear());
        const res = await post(route.path(id), route.body, auth(token));
        expect(res.status).toBe(202);
        expect(stubs[route.stub]).toHaveBeenCalled();
        const firstArgs = stubs[route.stub].mock.calls[0] as unknown[];
        expect(JSON.stringify(firstArgs)).toContain(id);
      }
    });

    it('non-owner on active media: 403 FORBIDDEN, no job, no segment change, no processing or storage call', async () => {
      const id = insertVideo();
      const before = state(id);
      const res = await post(route.path(id), route.body, auth(other.token));
      expect(res.status).toBe(403);
      expect(res.body).toEqual(FORBIDDEN);
      expect(state(id)).toEqual(before);
      expect(totalStubCalls()).toBe(0);
      expect(download).not.toHaveBeenCalled();
    });

    it('non-owner gets 403 before input validation, segment lookup and conflict checks', async () => {
      const invalid = INVALID_BODY[route.name];
      if (invalid) {
        const id = insertVideo();
        expect((await post(route.path(id), invalid, auth(other.token))).status).toBe(403);
        // The same invalid input is still rejected for the owner by the existing validation.
        expect((await post(route.path(id), invalid, auth(owner.token))).status).toBe(400);
      }
      const noSegments = insertVideo({ segments: false });
      expect((await post(route.path(noSegments), route.body, auth(other.token))).status).toBe(403);
      if (route.name.startsWith('POST /compile')) {
        const busy = insertVideo();
        getDb().prepare(`INSERT INTO compile_jobs (id, media_id, status, percent, created_at) VALUES (?, ?, 'running', 10, ?)`)
          .run(uuidv4(), busy, new Date().toISOString());
        expect((await post(route.path(busy), route.body, auth(other.token))).status).toBe(403);
        expect((await post(route.path(busy), route.body, auth(owner.token))).status).toBe(409);
        const ownerNoSeg = await post(route.path(noSegments), route.body, auth(owner.token));
        expect(ownerNoSeg.status).toBe(404);
        expect(ownerNoSeg.body.error.code).toBe('NO_SEGMENTS');
      }
      expect(totalStubCalls()).toBe(0);
    });

    it('trashed media: non-owner 403; owner and admin 404; nothing runs', async () => {
      const id = insertVideo({ status: 'trashed' });
      const before = state(id);
      expect((await post(route.path(id), route.body, auth(other.token))).status).toBe(403);
      for (const token of [owner.token, admin.token]) {
        const res = await post(route.path(id), route.body, auth(token));
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      expect(state(id)).toEqual(before);
      expect(totalStubCalls()).toBe(0);
      expect(download).not.toHaveBeenCalled();
    });

    it('missing media, deleted media and a missing trip row: 404 for everyone, including admin', async () => {
      const deleted = insertVideo({ status: 'deleted' });
      const db = getDb();
      db.pragma('foreign_keys = OFF');
      let orphan: string;
      try { orphan = insertVideo({ trip: `g27-orphan-${uuidv4().slice(0, 6)}` }); } finally { db.pragma('foreign_keys = ON'); }
      for (const token of [other.token, owner.token, admin.token]) {
        for (const id of ['does-not-exist', deleted, orphan]) {
          const res = await post(route.path(id), route.body, auth(token));
          expect(res.status).toBe(404);
          expect(res.body.error.code).toBe('NOT_FOUND');
        }
      }
      expect(totalStubCalls()).toBe(0);
      expect(download).not.toHaveBeenCalled();
    });
  });

  it('POST /clips by a non-owner no longer rewrites the owner\'s video_segments', async () => {
    const id = insertVideo();
    const before = state(id).segments;
    expect((await post(`/api/media/${id}/clips`, {}, auth(other.token))).status).toBe(403);
    expect(state(id).segments).toEqual(before);
    // Control: the owner's request does rewrite them through the real segment store.
    expect((await post(`/api/media/${id}/clips`, {}, auth(owner.token))).status).toBe(202);
    expect(state(id).segments).not.toEqual(before);
  });
});
