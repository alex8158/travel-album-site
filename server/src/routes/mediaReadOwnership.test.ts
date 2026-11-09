/**
 * G-27 read routes: GET /api/media/:mediaId/segments (clips.ts) and
 * GET /api/media/:mediaId/compile/status (compile.ts) follow the same
 * owner/admin rule as the media write routes (需求 7 AC 8, helpers/ownerMediaWrite.ts).
 * A rejected request carries none of the media's segments or job details.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { listenLocal } from '../../test-support/localServer';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import clipsRouter from './clips';
import compileRouter from './compile';

const app = express();
app.use(express.json());
app.use('/api/media', clipsRouter);
app.use('/api/media', compileRouter);

function createUser(role: 'admin' | 'regular') {
  const userId = uuidv4(); const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, 'h', ?, 'active', ?, ?)`)
    .run(userId, `g27r_${userId.slice(0, 8)}`, role, now, now);
  return { userId, token: signToken({ userId, role }) };
}

const ROUTES = [
  { name: 'GET /segments', path: (id: string) => `/api/media/${id}/segments`, notFound: '媒体项不存在' },
  { name: 'GET /compile/status', path: (id: string) => `/api/media/${id}/compile/status`, notFound: '媒体文件不存在' },
] as const;

describe('G-27 media read routes: owner/admin only', () => {
  const createdTrips: string[] = [];
  const createdUsers: string[] = [];
  let owner: { userId: string; token: string };
  let other: { userId: string; token: string };
  let admin: { userId: string; token: string };
  let tripId: string;

  function insertMedia(o: { status?: string; type?: string; trip?: string } = {}): string {
    const id = uuidv4(); const now = new Date().toISOString(); const trip = o.trip ?? tripId;
    getDb().prepare(`INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, visibility, media_source, processing_status, created_at)
      VALUES (?, ?, ?, ?, ?, 'v.mp4', 1, ?, 'public', 'upload', 'none', ?)`)
      .run(id, trip, `${trip}/originals/${id}.mp4`, o.type ?? 'video', o.type === 'image' ? 'image/jpeg' : 'video/mp4', o.status ?? 'active', now);
    getDb().prepare(`INSERT INTO video_segments (id, media_id, segment_index, start_time, end_time, duration, overall_score, label, selected, created_at)
      VALUES (?, ?, 0, 0, 5, 5, 80, 'secret-label', 1, ?)`).run(uuidv4(), id, now);
    getDb().prepare(`INSERT INTO compile_jobs (id, media_id, status, percent, error_message, created_at) VALUES (?, ?, 'failed', 40, 'secret-error /abs/path', ?)`)
      .run(uuidv4(), id, now);
    return id;
  }

  beforeEach(() => {
    owner = createUser('regular'); other = createUser('regular'); admin = createUser('admin');
    createdUsers.push(owner.userId, other.userId, admin.userId);
    tripId = `g27r-${uuidv4().slice(0, 8)}`; const now = new Date().toISOString();
    getDb().prepare(`INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at) VALUES (?, 't', 'public', ?, ?, ?)`).run(tripId, owner.userId, now, now);
    createdTrips.push(tripId);
  });
  afterEach(() => {
    const db = getDb();
    for (const t of createdTrips.splice(0)) {
      db.prepare('DELETE FROM compile_jobs WHERE media_id IN (SELECT id FROM media_items WHERE trip_id = ?)').run(t);
      db.prepare('DELETE FROM video_segments WHERE media_id IN (SELECT id FROM media_items WHERE trip_id = ?)').run(t);
      db.prepare('DELETE FROM media_items WHERE trip_id = ?').run(t);
      db.prepare('DELETE FROM trips WHERE id = ?').run(t);
    }
    for (const u of createdUsers.splice(0)) db.prepare('DELETE FROM users WHERE id = ?').run(u);
    closeDb();
  });

  describe.each(ROUTES.map((r) => [r.name, r] as const))('%s', (_n, route) => {
    const get = async (id: string, token?: string) => {
      const r = request(await listenLocal(app)).get(route.path(id));
      return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };

    it('owner and admin: 200 with the media data', async () => {
      const id = insertMedia();
      for (const t of [owner.token, admin.token]) {
        const res = await get(id, t);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).toMatch(route.name === 'GET /segments' ? /secret-label/ : /secret-error/);
      }
    });

    it('anonymous and invalid token: 401, no media data', async () => {
      const id = insertMedia();
      for (const t of [undefined, 'not-a-token']) {
        const res = await get(id, t);
        expect(res.status).toBe(401);
        expect(JSON.stringify(res.body)).not.toMatch(/secret-/);
      }
    });

    it('ordinary non-owner: 403 FORBIDDEN, no media data', async () => {
      const id = insertMedia();
      const res = await get(id, other.token);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
      expect(JSON.stringify(res.body)).not.toMatch(/secret-/);
    });

    it('missing, deleted, or trip row missing: 404 NOT_FOUND for everyone including admin', async () => {
      const deleted = insertMedia({ status: 'deleted' });
      const db = getDb();
      db.pragma('foreign_keys = OFF');
      const orphanTrip = `g27r-orphan-${uuidv4().slice(0, 6)}`;
      let orphan: string;
      try { orphan = insertMedia({ trip: orphanTrip }); } finally { db.pragma('foreign_keys = ON'); }
      createdTrips.push(orphanTrip);
      for (const t of [other.token, owner.token, admin.token]) {
        for (const id of ['does-not-exist', deleted, orphan]) {
          const res = await get(id, t);
          expect(res.status).toBe(404);
          expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: route.notFound } });
        }
      }
    });

    it('trashed media: non-owner 403; owner and admin 404 (same as the write routes)', async () => {
      const id = insertMedia({ status: 'trashed' });
      expect((await get(id, other.token)).status).toBe(403);
      for (const t of [owner.token, admin.token]) expect((await get(id, t)).status).toBe(404);
    });
  });

  it('GET /segments keeps 400 NOT_VIDEO for the owner on an image', async () => {
    const id = insertMedia({ type: 'image' });
    const res = await request(await listenLocal(app)).get(`/api/media/${id}/segments`).set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_VIDEO');
  });
});
