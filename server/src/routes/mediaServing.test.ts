import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Wrap the real thumbnail generators so tests can assert whether they ran.
vi.mock('../services/thumbnailGenerator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/thumbnailGenerator')>();
  return {
    ...actual,
    generateThumbnail: vi.fn(actual.generateThumbnail),
    generateVideoThumbnail: vi.fn(actual.generateVideoThumbnail),
  };
});

import express from 'express';
import http from 'http';
import request from 'supertest';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import { generateThumbnail, generateVideoThumbnail } from '../services/thumbnailGenerator';
import { getStorageProvider } from '../storage/factory';
import mediaServingRouter from './mediaServing';

// The app mounts the router exactly as index.ts does: no app-level auth. A
// pre-set `Vary: Origin` proves the route merges rather than overwrites Vary.
const app = express();
app.use(express.json());
app.use((_req, res, next) => { res.vary('Origin'); next(); });
app.use('/api/media', mediaServingRouter);

// supertest's default `app.listen(0)` binds the dual-stack `::` wildcard but then
// connects to 127.0.0.1. On macOS that ephemeral port can already be held on
// 127.0.0.1 by another local process, so the request lands there (foreign 404,
// ETIMEDOUT, ECONNRESET). Proven 2026-11-02, evidence in
// travel-album-acceptance/g21/. Each request still gets its own server (closed
// after the test); it is bound to 127.0.0.1 so the OS never picks a port another
// process already holds there.
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
// supertest does not close a server it was handed already listening.
afterEach(async () => {
  await Promise.all([...openServers].map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections();
    s.close(() => resolve());
  })));
  openServers.clear();
});

const uploadsBase = path.join(__dirname, '..', '..', 'uploads');

const NOT_FOUND = { error: { code: 'NOT_FOUND', message: '媒体文件不存在' } };

function createTestImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .jpeg()
    .toBuffer();
}

function expectNoStore(res: request.Response): void {
  expect(res.headers['cache-control']).toBe('private, no-store');
  const vary = String(res.headers['vary'] ?? '').split(',').map((s) => s.trim().toLowerCase());
  expect(vary).toContain('authorization');
  expect(vary).toContain('origin');
}

function expectDenied(res: request.Response): void {
  expect(res.status).toBe(404);
  expect(res.body).toEqual(NOT_FOUND);
  expectNoStore(res);
}

function createUser(role: 'admin' | 'regular'): { userId: string; token: string } {
  const db = getDb();
  const userId = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).run(userId, `g21_${userId.slice(0, 8)}`, 'hash', role, now, now);
  return { userId, token: signToken({ userId, role }) };
}

describe('Media Serving API (G-21)', () => {
  const tripId = `serve-test-trip-${uuidv4().slice(0, 8)}`;
  const tripDir = path.join(uploadsBase, tripId);
  let owner: { userId: string; token: string };
  let other: { userId: string; token: string };
  let admin: { userId: string; token: string };
  let imageId: string;

  /** Requesters for which the non-owner rule applies. */
  const nonOwnerAuth = (): Array<[string, Record<string, string>]> => [
    ['anonymous', {}],
    ['invalid token', { Authorization: 'Bearer not-a-real-token' }],
    ['non-owner', { Authorization: `Bearer ${other.token}` }],
  ];
  const privilegedAuth = (): Array<[string, Record<string, string>]> => [
    ['owner', { Authorization: `Bearer ${owner.token}` }],
    ['admin', { Authorization: `Bearer ${admin.token}` }],
  ];

  async function get(url: string, headers: Record<string, string> = {}, blob = false) {
    const r = request(await local()).get(url);
    if (blob) r.responseType('blob');
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return r;
  }

  function insertMedia(opts: {
    mediaType: 'image' | 'video';
    ext: string;
    bytes: Buffer;
    visibility?: string;
    status?: string;
    mediaSource?: string | null;
    processingStatus?: string | null;
    compiled?: Buffer | null;
    compiledPathOverride?: string | null;
    proxy?: Buffer | null;
    thumbnail?: Buffer | null;
    trip?: string;
  }): string {
    const db = getDb();
    const id = uuidv4();
    const trip = opts.trip ?? tripId;
    const dir = path.join(uploadsBase, trip);
    fs.mkdirSync(path.join(dir, 'originals'), { recursive: true });
    const filePath = `${trip}/originals/${id}.${opts.ext}`;
    fs.writeFileSync(path.join(uploadsBase, filePath), opts.bytes);

    let compiledPath: string | null = opts.compiledPathOverride ?? null;
    if (opts.compiled) {
      fs.mkdirSync(path.join(dir, 'compiled'), { recursive: true });
      compiledPath = `${trip}/compiled/${id}.mp4`;
      fs.writeFileSync(path.join(uploadsBase, compiledPath), opts.compiled);
    }
    let proxyPath: string | null = null;
    if (opts.proxy) {
      fs.mkdirSync(path.join(dir, 'proxy'), { recursive: true });
      proxyPath = `${trip}/proxy/${id}.mp4`;
      fs.writeFileSync(path.join(uploadsBase, proxyPath), opts.proxy);
    }
    let thumbPath: string | null = null;
    if (opts.thumbnail) {
      fs.mkdirSync(path.join(dir, 'thumbnails'), { recursive: true });
      thumbPath = `${trip}/thumbnails/${id}_thumb.webp`;
      fs.writeFileSync(path.join(uploadsBase, thumbPath), opts.thumbnail);
    }

    db.prepare(
      `INSERT INTO media_items (id, trip_id, file_path, thumbnail_path, media_type, mime_type, original_filename,
         file_size, status, visibility, media_source, processing_status, compiled_path, preview_proxy_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, trip, filePath, thumbPath, opts.mediaType,
      opts.mediaType === 'image' ? 'image/jpeg' : 'video/mp4', `file.${opts.ext}`, opts.bytes.length,
      opts.status ?? 'active', opts.visibility ?? 'public',
      opts.mediaSource === undefined ? 'upload' : opts.mediaSource,
      opts.processingStatus === undefined ? 'none' : opts.processingStatus,
      compiledPath, proxyPath, new Date().toISOString(),
    );
    return id;
  }

  let thumbWebp: Buffer;
  const ORIGINAL_VIDEO = Buffer.from('ORIGINAL-UPLOAD-'.repeat(64));
  const COMPILED_VIDEO = Buffer.from('COMPILED-VIDEO--'.repeat(64));
  const PROXY_VIDEO = Buffer.from('PREVIEW-PROXY---'.repeat(64));

  beforeEach(async () => {
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
      `INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at) VALUES (?, ?, 'public', ?, ?, ?)`,
    ).run(tripId, 'Serve Test', owner.userId, now, now);

    const imgBuf = await createTestImage(800, 600);
    imageId = insertMedia({ mediaType: 'image', ext: 'jpg', bytes: imgBuf });
    thumbWebp = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 50, g: 50, b: 50 } },
    }).webp().toBuffer();
    vi.mocked(generateThumbnail).mockClear();
    vi.mocked(generateVideoThumbnail).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(tripDir)) {
      fs.rmSync(tripDir, { recursive: true, force: true });
    }
    closeDb();
  });

  // -------------------------------------------------------------------------
  // Legitimate anonymous public scenario (the former tests, now explicit)
  // -------------------------------------------------------------------------
  describe('anonymous, public active image on a public trip', () => {
    it('GET /original serves the file', async () => {
      const res = await request(await local()).get(`/api/media/${imageId}/original`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/image\/jpeg|application\/octet-stream/);
      expectNoStore(res);
    });

    it('returns 404 NOT_FOUND for non-existent media, identical to a denial', async () => {
      const missing = await request(await local()).get('/api/media/non-existent/original');
      getDb().prepare("UPDATE media_items SET visibility = 'private' WHERE id = ?").run(imageId);
      const denied = await request(await local()).get(`/api/media/${imageId}/original`);
      expectDenied(missing);
      expectDenied(denied);
      expect(denied.text).toBe(missing.text);
    });

    it('returns 404 FILE_NOT_FOUND if the allowed file is missing from disk', async () => {
      fs.unlinkSync(path.join(tripDir, 'originals', `${imageId}.jpg`));
      const res = await request(await local()).get(`/api/media/${imageId}/original`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('FILE_NOT_FOUND');
      expectNoStore(res);
    });

    it('generates a thumbnail on-the-fly for an allowed requester', async () => {
      const res = await request(await local()).get(`/api/media/${imageId}/thumbnail`);
      expect(res.status).toBe(200);
      expectNoStore(res);
      const row = getDb().prepare('SELECT thumbnail_path FROM media_items WHERE id = ?').get(imageId) as { thumbnail_path: string };
      expect(row.thumbnail_path).toBe(`${tripId}/thumbnails/${imageId}_thumb.webp`);
      expect(generateThumbnail).toHaveBeenCalledTimes(1);
    });

    it('serves an existing thumbnail without regenerating', async () => {
      const id = insertMedia({ mediaType: 'image', ext: 'jpg', bytes: await createTestImage(10, 10), thumbnail: thumbWebp });
      const res = await request(await local()).get(`/api/media/${id}/thumbnail`);
      expect(res.status).toBe(200);
      expect(generateThumbnail).not.toHaveBeenCalled();
    });

    it('returns 404 for non-existent media on /thumbnail', async () => {
      expectDenied(await request(await local()).get('/api/media/non-existent/thumbnail'));
    });
  });

  // -------------------------------------------------------------------------
  // Identity × media state matrix
  // -------------------------------------------------------------------------
  describe('images', () => {
    it('unlisted trip is treated like public for non-owners', async () => {
      getDb().prepare("UPDATE trips SET visibility = 'unlisted' WHERE id = ?").run(tripId);
      for (const [who, h] of nonOwnerAuth()) {
        const res = await get(`/api/media/${imageId}/original`, h);
        // The message carries the body: the 404 seen on 2026-10-29 was a foreign
        // local server answering on a dual-stack port collision (see local()).
        expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(200);
      }
    });

    it.each(['private', 'something-else', ''])('trip visibility %j: non-owner 404, owner/admin 200', async (tv) => {
      getDb().prepare('UPDATE trips SET visibility = ? WHERE id = ?').run(tv, tripId);
      for (const [, h] of nonOwnerAuth()) {
        expectDenied(await get(`/api/media/${imageId}/original`, h));
        expectDenied(await get(`/api/media/${imageId}/thumbnail`, h));
      }
      for (const [, h] of privilegedAuth()) {
        expect((await get(`/api/media/${imageId}/original`, h)).status).toBe(200);
      }
    });

    it('private media: non-owner 404 on every entry, owner/admin 200', async () => {
      getDb().prepare("UPDATE media_items SET visibility = 'private' WHERE id = ?").run(imageId);
      for (const [, h] of nonOwnerAuth()) {
        for (const e of ['thumbnail', 'original', 'raw']) expectDenied(await get(`/api/media/${imageId}/${e}`, h));
      }
      for (const [, h] of privilegedAuth()) {
        for (const e of ['thumbnail', 'original', 'raw']) {
          const res = await get(`/api/media/${imageId}/${e}`, h);
          expect(res.status).toBe(200);
          expectNoStore(res);
        }
      }
    });

    it('trashed media: non-owner 404, owner/admin keep access (trash thumbnails)', async () => {
      const id = insertMedia({ mediaType: 'image', ext: 'jpg', bytes: await createTestImage(10, 10), status: 'trashed', thumbnail: thumbWebp });
      for (const [, h] of nonOwnerAuth()) expectDenied(await get(`/api/media/${id}/thumbnail`, h));
      for (const [, h] of privilegedAuth()) {
        expect((await get(`/api/media/${id}/thumbnail`, h)).status).toBe(200);
        expect((await get(`/api/media/${id}/original`, h)).status).toBe(200);
      }
    });

    it('deleted media: 404 for everyone', async () => {
      getDb().prepare("UPDATE media_items SET status = 'deleted' WHERE id = ?").run(imageId);
      for (const [, h] of [...nonOwnerAuth(), ...privilegedAuth()]) {
        for (const e of ['thumbnail', 'original', 'raw']) expectDenied(await get(`/api/media/${imageId}/${e}`, h));
      }
    });

    it('trip row missing: 404 for everyone, including admin', async () => {
      const db = getDb();
      db.pragma('foreign_keys = OFF');
      const orphanTrip = `orphan-${uuidv4().slice(0, 8)}`;
      let id: string;
      try {
        id = insertMedia({ mediaType: 'image', ext: 'jpg', bytes: await createTestImage(10, 10), trip: orphanTrip });
      } finally {
        db.pragma('foreign_keys = ON');
      }
      try {
        for (const [, h] of [...nonOwnerAuth(), ...privilegedAuth()]) {
          for (const e of ['thumbnail', 'original', 'raw']) expectDenied(await get(`/api/media/${id}/${e}`, h));
        }
      } finally {
        fs.rmSync(path.join(uploadsBase, orphanTrip), { recursive: true, force: true });
      }
    });

    it('/raw and /original?original=true: non-owner 404 even for public media; owner/admin 200', async () => {
      for (const [, h] of nonOwnerAuth()) {
        expectDenied(await get(`/api/media/${imageId}/raw`, h));
        expectDenied(await get(`/api/media/${imageId}/original?original=true`, h));
      }
      for (const [, h] of privilegedAuth()) {
        expect((await get(`/api/media/${imageId}/raw`, h)).status).toBe(200);
        expect((await get(`/api/media/${imageId}/original?original=true`, h)).status).toBe(200);
      }
    });
  });

  describe('videos', () => {
    it('compiled video: non-owner gets exactly the compiled bytes, with Range 206', async () => {
      const id = insertMedia({ mediaType: 'video', ext: 'mp4', bytes: ORIGINAL_VIDEO, compiled: COMPILED_VIDEO, proxy: PROXY_VIDEO });
      for (const [, h] of nonOwnerAuth()) {
        const full = await get(`/api/media/${id}/original`, h, true);
        expect(full.status).toBe(200);
        expect(Buffer.compare(full.body as Buffer, COMPILED_VIDEO)).toBe(0);
        expectNoStore(full);

        const part = await get(`/api/media/${id}/original`, { ...h, Range: 'bytes=0-15' }, true);
        expect(part.status).toBe(206);
        expect(part.headers['content-range']).toBe(`bytes 0-15/${COMPILED_VIDEO.length}`);
        expect((part.body as Buffer).toString()).toBe('COMPILED-VIDEO--');
        expectNoStore(part);
      }
    });

    it('compiled_path set but compiled file missing: non-owner 404 on original and thumbnail, no fallback', async () => {
      const id = insertMedia({
        mediaType: 'video', ext: 'mp4', bytes: ORIGINAL_VIDEO, proxy: PROXY_VIDEO, thumbnail: thumbWebp,
        compiledPathOverride: `${tripId}/compiled/does-not-exist.mp4`,
      });
      for (const [, h] of nonOwnerAuth()) {
        expectDenied(await get(`/api/media/${id}/original`, h));
        expectDenied(await get(`/api/media/${id}/thumbnail`, h));
      }
      // Owner behaviour is unchanged: compiled_path is chosen and its absence is a 404.
      const ownerRes = await get(`/api/media/${id}/original`, privilegedAuth()[0][1]);
      expect(ownerRes.status).toBe(404);
      expect(ownerRes.body.error.code).toBe('FILE_NOT_FOUND');
    });

    it('uncompiled video with a proxy: non-owner 404 (thumbnail included); owner gets the proxy', async () => {
      const id = insertMedia({ mediaType: 'video', ext: 'mp4', bytes: ORIGINAL_VIDEO, proxy: PROXY_VIDEO, thumbnail: thumbWebp });
      for (const [, h] of nonOwnerAuth()) {
        expectDenied(await get(`/api/media/${id}/original`, h));
        expectDenied(await get(`/api/media/${id}/thumbnail`, h));
      }
      for (const [, h] of privilegedAuth()) {
        const res = await get(`/api/media/${id}/original`, h, true);
        expect(res.status).toBe(200);
        expect(Buffer.compare(res.body as Buffer, PROXY_VIDEO)).toBe(0);
        expect((await get(`/api/media/${id}/thumbnail`, h)).status).toBe(200);
      }
    });

    it.each(['uploading', 'cancelled'])('processing_status %s: non-owner 404, owner 200', async (ps) => {
      const id = insertMedia({ mediaType: 'video', ext: 'mp4', bytes: ORIGINAL_VIDEO, compiled: COMPILED_VIDEO, processingStatus: ps });
      for (const [, h] of nonOwnerAuth()) expectDenied(await get(`/api/media/${id}/original`, h));
      expect((await get(`/api/media/${id}/original`, privilegedAuth()[0][1])).status).toBe(200);
    });

    it.each([null, 'none'])('processing_status %j counts as complete for non-owners', async (ps) => {
      const id = insertMedia({ mediaType: 'video', ext: 'mp4', bytes: ORIGINAL_VIDEO, compiled: COMPILED_VIDEO, processingStatus: ps });
      expect((await request(await local()).get(`/api/media/${id}/original`)).status).toBe(200);
    });

    it('video raw entries: non-owner 404; owner gets the original upload', async () => {
      const id = insertMedia({ mediaType: 'video', ext: 'mp4', bytes: ORIGINAL_VIDEO, compiled: COMPILED_VIDEO });
      for (const [, h] of nonOwnerAuth()) {
        expectDenied(await get(`/api/media/${id}/raw`, h));
        expectDenied(await get(`/api/media/${id}/original?original=true`, h));
      }
      const res = await get(`/api/media/${id}/original?original=true`, privilegedAuth()[0][1], true);
      expect(Buffer.compare(res.body as Buffer, ORIGINAL_VIDEO)).toBe(0);
    });

    it('merged video: non-owner 404 regardless of sources; owner/admin 200', async () => {
      const src1 = insertMedia({ mediaType: 'video', ext: 'mp4', bytes: ORIGINAL_VIDEO, compiled: COMPILED_VIDEO });
      const src2 = insertMedia({ mediaType: 'video', ext: 'mp4', bytes: ORIGINAL_VIDEO, compiled: COMPILED_VIDEO });
      const merged = insertMedia({
        mediaType: 'video', ext: 'mp4', bytes: COMPILED_VIDEO, compiled: COMPILED_VIDEO, mediaSource: 'merged', thumbnail: thumbWebp,
      });
      const db = getDb();
      const now = new Date().toISOString();
      [src1, src2].forEach((s, i) => db.prepare(
        'INSERT INTO merged_video_sources (id, merged_media_id, source_media_id, sort_order, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(uuidv4(), merged, s, i, now));

      const states: Array<() => void> = [
        () => {}, // every source public and active
        () => db.prepare("UPDATE media_items SET visibility = 'private' WHERE id = ?").run(src1),
        () => db.prepare("UPDATE media_items SET status = 'trashed' WHERE id = ?").run(src2),
        () => db.prepare('UPDATE merged_video_sources SET source_media_id = NULL WHERE source_media_id = ?').run(src1),
        () => db.prepare('DELETE FROM merged_video_sources WHERE merged_media_id = ?').run(merged),
      ];
      for (const apply of states) {
        apply();
        for (const [, h] of nonOwnerAuth()) {
          expectDenied(await get(`/api/media/${merged}/original`, h));
          expectDenied(await get(`/api/media/${merged}/thumbnail`, h));
        }
        for (const [, h] of privilegedAuth()) {
          expect((await get(`/api/media/${merged}/original`, h)).status).toBe(200);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Same URL, state changes after an allowed response
  // -------------------------------------------------------------------------
  describe('revocation on the same URL', () => {
    const revocations: Array<[string, (mediaId: string) => void]> = [
      ['media → private', (id) => getDb().prepare("UPDATE media_items SET visibility = 'private' WHERE id = ?").run(id)],
      ['media → trashed', (id) => getDb().prepare("UPDATE media_items SET status = 'trashed' WHERE id = ?").run(id)],
      ['trip visibility invalid', () => getDb().prepare("UPDATE trips SET visibility = 'private' WHERE id = ?").run(tripId)],
    ];

    it.each(revocations)('image, %s: GET, HEAD and conditional requests are re-denied', async (_n, revoke) => {
      const first = await request(await local()).get(`/api/media/${imageId}/original`);
      expect(first.status).toBe(200);
      const etag = first.headers['etag'];
      const lastModified = first.headers['last-modified'];
      expect(etag).toBeTruthy();

      // Before revocation a conditional request may legitimately get 304.
      const cond = await request(await local()).get(`/api/media/${imageId}/original`).set('If-None-Match', etag);
      expect(cond.status).toBe(304);
      expectNoStore(cond);

      revoke(imageId);

      expectDenied(await request(await local()).get(`/api/media/${imageId}/original`));
      expectDenied(await request(await local()).get(`/api/media/${imageId}/thumbnail`));
      const head = await request(await local()).head(`/api/media/${imageId}/original`);
      expect(head.status).toBe(404);
      expectNoStore(head);
      expectDenied(await request(await local()).get(`/api/media/${imageId}/original`).set('If-None-Match', etag));
      expectDenied(await request(await local()).get(`/api/media/${imageId}/original`).set('If-Modified-Since', lastModified));
    });

    it.each(revocations)('video, %s: GET, HEAD and Range are re-denied', async (_n, revoke) => {
      const id = insertMedia({ mediaType: 'video', ext: 'mp4', bytes: ORIGINAL_VIDEO, compiled: COMPILED_VIDEO });
      expect((await request(await local()).get(`/api/media/${id}/original`).set('Range', 'bytes=0-15')).status).toBe(206);
      const headOk = await request(await local()).head(`/api/media/${id}/original`);
      expect(headOk.status).toBe(200);
      expectNoStore(headOk);

      revoke(id);

      expectDenied(await request(await local()).get(`/api/media/${id}/original`));
      expectDenied(await request(await local()).get(`/api/media/${id}/original`).set('Range', 'bytes=0-15'));
      const head = await request(await local()).head(`/api/media/${id}/original`);
      expect(head.status).toBe(404);
      expectNoStore(head);
    });
  });

  // -------------------------------------------------------------------------
  // Denied requests have no side effects
  // -------------------------------------------------------------------------
  describe('no side effects on denial', () => {
    it('denied thumbnail requests generate nothing, write nothing, touch no storage', async () => {
      const provider = getStorageProvider();
      const exists = vi.spyOn(provider, 'exists');
      const download = vi.spyOn(provider, 'downloadToTemp');
      const getUrl = vi.spyOn(provider, 'getUrl');

      const privateImg = insertMedia({ mediaType: 'image', ext: 'jpg', bytes: await createTestImage(20, 20), visibility: 'private' });
      const uncompiledVid = insertMedia({ mediaType: 'video', ext: 'mp4', bytes: ORIGINAL_VIDEO });
      const trashedImg = insertMedia({ mediaType: 'image', ext: 'jpg', bytes: await createTestImage(20, 20), status: 'trashed' });

      for (const id of [privateImg, uncompiledVid, trashedImg]) {
        for (const [, h] of nonOwnerAuth()) {
          expectDenied(await get(`/api/media/${id}/thumbnail`, h));
          expectDenied(await get(`/api/media/${id}/original`, h));
          expectDenied(await get(`/api/media/${id}/raw`, h));
        }
        const r = getDb().prepare('SELECT thumbnail_path FROM media_items WHERE id = ?').get(id) as { thumbnail_path: string | null };
        expect(r.thumbnail_path).toBeNull();
        expect(fs.existsSync(path.join(tripDir, 'thumbnails', `${id}_thumb.webp`))).toBe(false);
      }

      expect(generateThumbnail).not.toHaveBeenCalled();
      expect(generateVideoThumbnail).not.toHaveBeenCalled();
      expect(exists).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
      expect(getUrl).not.toHaveBeenCalled();
    });
  });
});
