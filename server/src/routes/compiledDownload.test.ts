/**
 * G-24 (multi-user-system 需求 9 AC 24): the two compiled-video download routes
 * are owner/admin only.
 *
 * - GET /api/media/:mediaId/download-compiled  (clips.ts)
 * - GET /api/media/:mediaId/compile/download   (compile.ts)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import { getStorageProvider } from '../storage/factory';
import clipsRouter from './clips';
import compileRouter from './compile';

// Mounted as in index.ts. A pre-set `Vary: Origin` proves Vary is merged.
const app = express();
app.use(express.json());
app.use((_req, res, next) => { res.vary('Origin'); next(); });
app.use('/api/media', clipsRouter);
app.use('/api/media', compileRouter);

// Per-request server bound to 127.0.0.1 (see docs/agent/known-issues.md 12a).
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

const uploadsBase = path.join(__dirname, '..', '..', 'uploads');
const NOT_FOUND = { error: { code: 'NOT_FOUND', message: '媒体文件不存在' } };
const COMPILED = Buffer.from('COMPILED-VIDEO--'.repeat(256));

const ROUTES: Array<[string, (id: string) => string]> = [
  ['download-compiled', (id) => `/api/media/${id}/download-compiled`],
  ['compile/download', (id) => `/api/media/${id}/compile/download`],
];

function expectNoStore(res: request.Response): void {
  expect(res.headers['cache-control']).toBe('private, no-store');
  const vary = String(res.headers['vary'] ?? '').split(',').map((s) => s.trim().toLowerCase());
  expect(vary).toContain('authorization');
  expect(vary).toContain('origin');
}

function createUser(role: 'admin' | 'regular') {
  const userId = uuidv4();
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, 'hash', ?, 'active', ?, ?)`,
  ).run(userId, `g24_${userId.slice(0, 8)}`, role, now, now);
  return { userId, token: signToken({ userId, role }) };
}

describe('G-24 compiled-video downloads are owner/admin only', () => {
  const tripId = `g24-trip-${uuidv4().slice(0, 8)}`;
  let owner: { userId: string; token: string };
  let other: { userId: string; token: string };
  let admin: { userId: string; token: string };

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  async function get(url: string, headers: Record<string, string> = {}) {
    const r = request(await local()).get(url).responseType('blob');
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return r;
  }

  function insert(o: {
    visibility?: string; status?: string; mediaSource?: string; compiled?: boolean; trip?: string;
  } = {}): string {
    const id = uuidv4();
    const trip = o.trip ?? tripId;
    fs.mkdirSync(path.join(uploadsBase, trip, 'compiled'), { recursive: true });
    let compiledPath: string | null = null;
    if (o.compiled !== false) {
      compiledPath = `${trip}/compiled/${id}.mp4`;
      fs.writeFileSync(path.join(uploadsBase, compiledPath), COMPILED);
    }
    getDb().prepare(
      `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size,
         status, visibility, media_source, processing_status, compiled_path, created_at)
       VALUES (?, ?, ?, 'video', 'video/mp4', 'clip.mp4', 1, ?, ?, ?, 'none', ?, ?)`,
    ).run(id, trip, `${trip}/originals/${id}.mp4`, o.status ?? 'active', o.visibility ?? 'public',
      o.mediaSource ?? 'upload', compiledPath, new Date().toISOString());
    return id;
  }

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM merged_video_sources');
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM upload_sessions');
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM compile_jobs');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');
    owner = createUser('regular');
    other = createUser('regular');
    admin = createUser('admin');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at) VALUES (?, 't', 'public', ?, ?, ?)`,
    ).run(tripId, owner.userId, now, now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(path.join(uploadsBase, tripId), { recursive: true, force: true });
    closeDb();
  });

  describe.each(ROUTES)('%s', (_name, url) => {
    it('anonymous and invalid token: 401, with no-store headers', async () => {
      const id = insert();
      for (const h of [{}, { Authorization: 'Bearer not-a-token' }] as Array<Record<string, string>>) {
        const res = await get(url(id), h);
        expect(res.status).toBe(401);
        expectNoStore(res);
      }
    });

    // Core G-24 property, asserted on its own so a regression shows up as the
    // download itself, not as a header or body-shape difference.
    it('non-owner never receives compiled bytes', async () => {
      for (const id of [insert(), insert({ visibility: 'private' }), insert({ status: 'trashed' }), insert({ mediaSource: 'merged' })]) {
        const res = await get(url(id), auth(other.token));
        expect(res.status).not.toBe(200);
        expect(res.status).not.toBe(206);
        expect(Buffer.compare(Buffer.from(res.body as Buffer), COMPILED)).not.toBe(0);
      }
    });

    it('non-owner: identical 404 for public, unlisted-trip, private, trashed, merged and missing media', async () => {
      const ids = [
        insert(),
        insert({ visibility: 'private' }),
        insert({ status: 'trashed' }),
        insert({ mediaSource: 'merged' }),
      ];
      const missing = await get(url('does-not-exist'), auth(other.token));
      expect(missing.status).toBe(404);
      const missingText = Buffer.from(missing.body as Buffer).toString();
      expect(JSON.parse(missingText)).toEqual(NOT_FOUND);
      expectNoStore(missing);
      for (const tv of ['public', 'unlisted']) {
        getDb().prepare('UPDATE trips SET visibility = ? WHERE id = ?').run(tv, tripId);
        for (const id of ids) {
          const res = await get(url(id), auth(other.token));
          expect(res.status).toBe(404);
          expect(Buffer.from(res.body as Buffer).toString()).toBe(missingText);
          expectNoStore(res);
        }
      }
    });

    it('owner and admin: 200 with the compiled bytes for public, private, trashed and merged', async () => {
      const ids = [insert(), insert({ visibility: 'private' }), insert({ status: 'trashed' }), insert({ mediaSource: 'merged' })];
      for (const token of [owner.token, admin.token]) {
        for (const id of ids) {
          const res = await get(url(id), auth(token));
          expect(res.status).toBe(200);
          expect(Buffer.compare(res.body as Buffer, COMPILED)).toBe(0);
          expect(res.headers['content-type']).toMatch(/video\/mp4/);
          expectNoStore(res);
        }
      }
    });

    it('owner and admin: a Range request returns 206', async () => {
      const id = insert();
      for (const token of [owner.token, admin.token]) {
        const res = await get(url(id), { ...auth(token), Range: 'bytes=0-15' });
        expect(res.status).toBe(206);
        expect(res.headers['content-range']).toBe(`bytes 0-15/${COMPILED.length}`);
        expect(Buffer.from(res.body as Buffer).toString()).toBe('COMPILED-VIDEO--');
        expectNoStore(res);
      }
    });

    it('deleted media and a missing trip row: 404 for everyone, including admin', async () => {
      const deleted = insert({ status: 'deleted' });
      const db = getDb();
      const orphanTrip = `g24-orphan-${uuidv4().slice(0, 8)}`;
      db.pragma('foreign_keys = OFF');
      let orphan: string;
      try { orphan = insert({ trip: orphanTrip }); } finally { db.pragma('foreign_keys = ON'); }
      try {
        for (const token of [owner.token, admin.token, other.token]) {
          for (const id of [deleted, orphan]) {
            const res = await get(url(id), auth(token));
            expect(res.status).toBe(404);
            expect(JSON.parse(Buffer.from(res.body as Buffer).toString())).toEqual(NOT_FOUND);
          }
        }
      } finally {
        fs.rmSync(path.join(uploadsBase, orphanTrip), { recursive: true, force: true });
      }
    });

    it('no compiled version: owner/admin keep the existing not-compiled 404; non-owner gets NOT_FOUND', async () => {
      const id = insert({ compiled: false });
      const expected = _name === 'download-compiled' ? 'NO_COMPILED' : 'NOT_COMPILED';
      for (const token of [owner.token, admin.token]) {
        const res = await get(url(id), auth(token));
        expect(res.status).toBe(404);
        expect(JSON.parse(Buffer.from(res.body as Buffer).toString()).error.code).toBe(expected);
      }
      const res = await get(url(id), auth(other.token));
      expect(JSON.parse(Buffer.from(res.body as Buffer).toString())).toEqual(NOT_FOUND);
    });

    it('denied and unauthenticated requests never touch storage', async () => {
      const download = vi.spyOn(getStorageProvider(), 'downloadToTemp');
      const ids = [insert(), insert({ visibility: 'private' }), insert({ mediaSource: 'merged' }), insert({ status: 'deleted' })];
      for (const id of ids) {
        expect((await get(url(id), auth(other.token))).status).toBe(404);
        expect((await get(url(id))).status).toBe(401);
      }
      expect((await get(url('does-not-exist'), auth(owner.token))).status).toBe(404);
      expect(download).not.toHaveBeenCalled();
      expect((await get(url(ids[0]), auth(owner.token))).status).toBe(200);
      expect(download).toHaveBeenCalledTimes(1);
    });
  });

  it('existing download headers are kept', async () => {
    const id = insert();
    const a = await get(`/api/media/${id}/download-compiled`, auth(owner.token));
    expect(a.headers['content-disposition']).toBe(`attachment; filename="${encodeURIComponent('clip_compiled.mp4')}"`);
    const b = await get(`/api/media/${id}/compile/download`, auth(owner.token));
    expect(b.headers['content-disposition']).toBe(`inline; filename="compiled_${id}.mp4"`);
    expect(b.headers['accept-ranges']).toBe('bytes');
  });
});
