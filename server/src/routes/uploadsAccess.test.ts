/**
 * G-22: `/uploads` must not serve a file merely because it exists, its path is
 * known, or its name is hard to guess.
 *
 * - Files registered on a `media_items` row: owner/admin always (multi-user-system
 *   需求 9 AC 5); anyone else only for an active, public, non-merged row (a video
 *   only with a compiled version, AC 6) on a trip whose visibility is `public`
 *   or `unlisted` (AC 4 / AC 7).
 * - Derived_Artifacts (tier slideshow, photo slideshow, merged video): never to
 *   AC 4 requesters (AC 12–15, highlight-tier 需求 6 AC 9). Tier/photo slideshow
 *   files are not served via `/uploads` to anyone — their delivery is `/api`.
 * - Unregistered files, deleted-trip residue, dot-directories, path attacks: 404.
 * - Denials end the request (404 JSON, no file bytes) and never fall through.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import { authMiddleware } from '../middleware/auth';
import { createUploadsAccessHandler, parseUploadsPath } from './uploadsAccess';

const uploadsBase = path.resolve(__dirname, '..', '..', 'uploads');

const FELL_THROUGH = 'FELL_THROUGH_MARKER';

const app = express();
app.use('/uploads', authMiddleware, createUploadsAccessHandler(uploadsBase));
// Anything that reaches these handlers means a denial called next(): the old
// static mount, the SPA catch-all, or another route would have answered.
app.use('/uploads', express.static(uploadsBase));
app.use((_req, res) => {
  res.status(200).send(FELL_THROUGH);
});

type Requester = 'anonymous' | 'non-owner' | 'owner' | 'admin';
const REQUESTERS: Requester[] = ['anonymous', 'non-owner', 'owner', 'admin'];
type TripKind = 'public' | 'unlisted' | 'invalid';
const TRIP_KINDS: TripKind[] = ['public', 'unlisted', 'invalid'];

interface FileCase {
  label: string;
  rel: string; // path relative to uploads root
  content: string;
  /** Expected access for AC 4 requesters on a public/unlisted trip. */
  nonOwner: boolean;
  /** Expected access for owner/admin. */
  ownerAdmin: boolean;
}

interface TripFixture {
  tripId: string;
  files: FileCase[];
}

const tokens: Record<Exclude<Requester, 'anonymous'>, string> = {
  'non-owner': '',
  owner: '',
  admin: '',
};
const userIds: string[] = [];
const tripIds: string[] = [];
const trips = {} as Record<TripKind, TripFixture>;
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g22-outside-'));
const outsideSecret = 'OUTSIDE_SECRET_BYTES_' + uuidv4();

let server: http.Server;
let port = 0;

function createUser(role: 'admin' | 'regular'): { userId: string; token: string } {
  const db = getDb();
  const userId = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).run(userId, `g22_${userId.slice(0, 8)}`, 'hash', role, now, now);
  userIds.push(userId);
  return { userId, token: signToken({ userId, role }) };
}

function createTrip(userId: string, visibility: string): string {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO trips (id, title, description, visibility, user_id, created_at, updated_at)
     VALUES (?, 'G22 Trip', NULL, ?, ?, ?, ?)`,
  ).run(id, visibility, userId, now, now);
  tripIds.push(id);
  return id;
}

interface MediaOpts {
  tripId: string;
  mediaType: 'image' | 'video';
  status: 'active' | 'trashed';
  visibility: 'public' | 'private';
  filePath: string;
  thumbnailPath?: string | null;
  optimizedPath?: string | null;
  compiledPath?: string | null;
  previewProxyPath?: string | null;
  mediaSource?: 'upload' | 'merged';
}

function createMedia(opts: MediaOpts): string {
  const db = getDb();
  const id = uuidv4();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, file_path, thumbnail_path, optimized_path, compiled_path, preview_proxy_path,
        media_type, mime_type, original_filename, file_size, status, visibility, media_source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1024, ?, ?, ?, ?)`,
  ).run(
    id, opts.tripId, opts.filePath, opts.thumbnailPath ?? null, opts.optimizedPath ?? null,
    opts.compiledPath ?? null, opts.previewProxyPath ?? null, opts.mediaType,
    opts.mediaType === 'image' ? 'image/jpeg' : 'video/mp4', `${id}.bin`,
    opts.status, opts.visibility, opts.mediaSource ?? 'upload', new Date().toISOString(),
  );
  return id;
}

function writeUpload(rel: string, content: string): void {
  const abs = path.join(uploadsBase, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Seed one trip with every file type the matrix covers. */
function seedTrip(ownerId: string, visibility: string): TripFixture {
  const tripId = createTrip(ownerId, visibility);
  const files: FileCase[] = [];
  const add = (label: string, rel: string, nonOwner: boolean, ownerAdmin: boolean) => {
    const content = `BYTES:${label}:${uuidv4()}:0123456789`;
    writeUpload(rel, content);
    files.push({ label, rel, content, nonOwner, ownerAdmin });
  };

  // Public active image: original, thumbnail, optimized.
  const img = uuidv4();
  createMedia({
    tripId, mediaType: 'image', status: 'active', visibility: 'public',
    filePath: `${tripId}/originals/${img}.jpg`,
    thumbnailPath: `${tripId}/thumbnails/${img}_thumb.webp`,
    optimizedPath: `${tripId}/optimized/${img}_opt.jpg`,
  });
  add('public-original', `${tripId}/originals/${img}.jpg`, true, true);
  add('public-thumbnail', `${tripId}/thumbnails/${img}_thumb.webp`, true, true);
  add('public-optimized', `${tripId}/optimized/${img}_opt.jpg`, true, true);

  // Private active image.
  const priv = uuidv4();
  createMedia({
    tripId, mediaType: 'image', status: 'active', visibility: 'private',
    filePath: `${tripId}/originals/${priv}.jpg`,
    thumbnailPath: `${tripId}/thumbnails/${priv}_thumb.webp`,
  });
  add('private-original', `${tripId}/originals/${priv}.jpg`, false, true);
  add('private-thumbnail', `${tripId}/thumbnails/${priv}_thumb.webp`, false, true);

  // Trashed public image.
  const trashed = uuidv4();
  createMedia({
    tripId, mediaType: 'image', status: 'trashed', visibility: 'public',
    filePath: `${tripId}/originals/${trashed}.jpg`,
    thumbnailPath: `${tripId}/thumbnails/${trashed}_thumb.webp`,
  });
  add('trashed-original', `${tripId}/originals/${trashed}.jpg`, false, true);
  add('trashed-thumbnail', `${tripId}/thumbnails/${trashed}_thumb.webp`, false, true);

  // Trashed private image.
  const trashedPriv = uuidv4();
  createMedia({
    tripId, mediaType: 'image', status: 'trashed', visibility: 'private',
    filePath: `${tripId}/originals/${trashedPriv}.jpg`,
  });
  add('trashed-private-original', `${tripId}/originals/${trashedPriv}.jpg`, false, true);

  // Public compiled video: original, compiled, preview proxy, thumbnail.
  const vid = uuidv4();
  createMedia({
    tripId, mediaType: 'video', status: 'active', visibility: 'public',
    filePath: `${tripId}/originals/${vid}.mp4`,
    compiledPath: `${tripId}/compiled/${vid}_compiled.mp4`,
    previewProxyPath: `${tripId}/proxies/${vid}_preview.mp4`,
    thumbnailPath: `${tripId}/thumbnails/${vid}.jpg`,
  });
  add('video-original', `${tripId}/originals/${vid}.mp4`, true, true);
  add('video-compiled', `${tripId}/compiled/${vid}_compiled.mp4`, true, true);
  add('video-proxy', `${tripId}/proxies/${vid}_preview.mp4`, true, true);
  add('video-thumbnail', `${tripId}/thumbnails/${vid}.jpg`, true, true);

  // Private compiled video.
  const privVid = uuidv4();
  createMedia({
    tripId, mediaType: 'video', status: 'active', visibility: 'private',
    filePath: `${tripId}/originals/${privVid}.mp4`,
    compiledPath: `${tripId}/compiled/${privVid}_compiled.mp4`,
  });
  add('private-video-compiled', `${tripId}/compiled/${privVid}_compiled.mp4`, false, true);

  // Public uncompiled video: not part of the public gallery (需求 9 AC 6).
  const rawVid = uuidv4();
  createMedia({
    tripId, mediaType: 'video', status: 'active', visibility: 'public',
    filePath: `${tripId}/originals/${rawVid}.mp4`,
  });
  add('uncompiled-video-original', `${tripId}/originals/${rawVid}.mp4`, false, true);

  // Merged video (Derived_Artifact, media_source='merged').
  const merged = uuidv4();
  createMedia({
    tripId, mediaType: 'video', status: 'active', visibility: 'public',
    filePath: `${tripId}/merged/${merged}_merged.mp4`,
    compiledPath: `${tripId}/merged/${merged}_merged.mp4`,
    mediaSource: 'merged',
  });
  add('merged-video', `${tripId}/merged/${merged}_merged.mp4`, false, true);

  // Legacy `uploads/`-prefixed stored path for a public image.
  const legacy = uuidv4();
  createMedia({
    tripId, mediaType: 'image', status: 'active', visibility: 'public',
    filePath: `uploads/${tripId}/originals/${legacy}.jpg`,
  });
  add('legacy-prefixed-original', `${tripId}/originals/${legacy}.jpg`, true, true);

  // Derived artifacts without media rows: never via /uploads.
  add('tier-category', `${tripId}/tier-slideshow/landscape/slideshow_1700000000000.mp4`, false, false);
  add('tier-legacy-root', `${tripId}/tier-slideshow/slideshow_1700000000000.mp4`, false, false);
  add('photo-slideshow', `${tripId}/slideshow/slideshow_1700000000001.mp4`, false, false);
  // Even if some row ever pointed into a slideshow output directory, the
  // directory itself is not served via /uploads (delivery is the /api routes).
  createMedia({
    tripId, mediaType: 'image', status: 'active', visibility: 'public',
    filePath: `${tripId}/tier-slideshow/landscape/registered.mp4`,
  });
  add('tier-dir-registered-row', `${tripId}/tier-slideshow/landscape/registered.mp4`, false, false);
  createMedia({
    tripId, mediaType: 'image', status: 'active', visibility: 'public',
    filePath: `${tripId}/slideshow/registered.mp4`,
  });
  add('photo-slideshow-dir-registered-row', `${tripId}/slideshow/registered.mp4`, false, false);

  // Unregistered and staging files.
  add('unregistered', `${tripId}/originals/stray-${uuidv4()}.jpg`, false, false);
  add('dot-dir', `${tripId}/.tier-staging/landscape/staged.mp4`, false, false);
  add('dotfile', `${tripId}/originals/.hidden.jpg`, false, false);

  return { tripId, files };
}

function expectedAccess(requester: Requester, kind: TripKind, file: FileCase): boolean {
  if (requester === 'owner' || requester === 'admin') return file.ownerAdmin;
  if (kind === 'invalid') return false;
  return file.nonOwner;
}

function tokenOf(requester: Requester): string | undefined {
  return requester === 'anonymous' ? undefined : tokens[requester];
}

function urlOf(rel: string): string {
  return '/uploads/' + rel.split('/').map(encodeURIComponent).join('/');
}

/** Send a request with the exact raw path (no client-side normalisation). */
function rawRequest(
  rawPath: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      // agent: false — one connection per request, so no keep-alive socket
      // outlives the suite and delays server.close().
      { host: '127.0.0.1', port, path: rawPath, method: opts.method ?? 'GET', headers: opts.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function expectDenied(res: { status: number; body: unknown; text?: string }, forbiddenBytes: string[]): void {
  expect(res.status).toBe(404);
  const text = typeof res.text === 'string' ? res.text : JSON.stringify(res.body);
  expect(JSON.parse(text)).toEqual({ error: { code: 'NOT_FOUND', message: '文件不存在' } });
  expect(text).not.toContain(FELL_THROUGH);
  for (const bytes of forbiddenBytes) expect(text).not.toContain(bytes);
}

function allContents(): string[] {
  return [...Object.values(trips).flatMap((t) => t.files.map((f) => f.content)), outsideSecret];
}

let residueTripId = '';
let residueContent = '';
let symlinkRel = '';
let mismatchRel = '';
let mismatchContent = '';

beforeAll(async () => {
  const owner = createUser('regular');
  const other = createUser('regular');
  const admin = createUser('admin');
  tokens.owner = owner.token;
  tokens['non-owner'] = other.token;
  tokens.admin = admin.token;

  trips.public = seedTrip(owner.userId, 'public');
  trips.unlisted = seedTrip(owner.userId, 'unlisted');
  // AC 7 allows only public/unlisted; there is no CHECK constraint (G-13), so a
  // stray value can exist in data and must grant nothing.
  trips.invalid = seedTrip(owner.userId, 'private');

  // Deleted-trip residue: file stays on disk, rows are gone.
  residueTripId = createTrip(owner.userId, 'public');
  const residueMedia = createMedia({
    tripId: residueTripId, mediaType: 'image', status: 'active', visibility: 'public',
    filePath: `${residueTripId}/originals/residue.jpg`,
  });
  residueContent = `BYTES:residue:${uuidv4()}`;
  writeUpload(`${residueTripId}/originals/residue.jpg`, residueContent);
  getDb().prepare('DELETE FROM media_items WHERE id = ?').run(residueMedia);
  getDb().prepare('DELETE FROM trips WHERE id = ?').run(residueTripId);

  // Symlink registered as a public original, pointing outside uploads.
  fs.writeFileSync(path.join(outsideDir, 'secret.jpg'), outsideSecret);
  symlinkRel = `${trips.public.tripId}/originals/link-${uuidv4()}.jpg`;
  fs.symlinkSync(path.join(outsideDir, 'secret.jpg'), path.join(uploadsBase, symlinkRel));
  createMedia({
    tripId: trips.public.tripId, mediaType: 'image', status: 'active', visibility: 'public',
    filePath: symlinkRel,
  });

  // Row of the unlisted trip whose stored path claims the public trip's directory.
  mismatchRel = `${trips.public.tripId}/originals/mismatch-${uuidv4()}.jpg`;
  mismatchContent = `BYTES:mismatch:${uuidv4()}`;
  writeUpload(mismatchRel, mismatchContent);
  createMedia({
    tripId: trips.unlisted.tripId, mediaType: 'image', status: 'active', visibility: 'public',
    filePath: mismatchRel,
  });

  // Bind explicitly to 127.0.0.1 so the port cannot be shared with another
  // local listener (a dual-stack listen(0) can be, which made requests flaky).
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    const db = getDb();
    for (const tripId of tripIds) {
      db.prepare('DELETE FROM media_items WHERE trip_id = ?').run(tripId);
      db.prepare('DELETE FROM trips WHERE id = ?').run(tripId);
    }
    for (const userId of userIds) db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  } finally {
    for (const tripId of tripIds) {
      fs.rmSync(path.join(uploadsBase, tripId), { recursive: true, force: true });
    }
    fs.rmSync(outsideDir, { recursive: true, force: true });
    closeDb();
  }
  for (const tripId of tripIds) expect(fs.existsSync(path.join(uploadsBase, tripId))).toBe(false);
  expect(fs.existsSync(outsideDir)).toBe(false);
});

describe('G-22 /uploads access matrix (GET)', () => {
  for (const kind of TRIP_KINDS) {
    for (const requester of REQUESTERS) {
      it(`${requester} on ${kind} trip gets exactly the files its rule allows`, async () => {
        const fixture = trips[kind];
        for (const file of fixture.files) {
          const headers: Record<string, string> = {};
          const token = tokenOf(requester);
          if (token) headers.Authorization = `Bearer ${token}`;
          const res = await rawRequest(urlOf(file.rel), { headers });
          const text = res.body;
          if (expectedAccess(requester, kind, file)) {
            expect({ label: file.label, status: res.status }).toEqual({ label: file.label, status: 200 });
            expect(text).toBe(file.content);
            expect(res.headers['cache-control']).toBe('private, no-cache');
            expect(String(res.headers.vary)).toMatch(/Authorization/i);
          } else {
            expect({ label: file.label, status: res.status }).toEqual({ label: file.label, status: 404 });
            expectDenied({ status: res.status, body: null, text }, allContents());
          }
        }
      });
    }
  }
});

describe('G-22 /uploads HTTP semantics', () => {
  const pub = () => trips.public.files.find((f) => f.label === 'public-original')!;
  const priv = () => trips.public.files.find((f) => f.label === 'private-original')!;
  const tier = () => trips.public.files.find((f) => f.label === 'tier-category')!;

  it('HEAD on an allowed file returns headers only', async () => {
    const res = await rawRequest(urlOf(pub().rel), { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(pub().content));
    expect(res.body).toBe('');
  });

  it('HEAD on denied files returns 404 with no file bytes', async () => {
    for (const file of [priv(), tier()]) {
      const res = await rawRequest(urlOf(file.rel), { method: 'HEAD' });
      expect(res.status).toBe(404);
      expect(res.body).toBe('');
      expect(res.headers['content-type']).toMatch(/application\/json/);
    }
  });

  it('Range on an allowed file returns 206 with the exact slice', async () => {
    const res = await rawRequest(urlOf(pub().rel), { headers: { Range: 'bytes=2-9' } });
    expect(res.status).toBe(206);
    expect(res.body).toBe(pub().content.slice(2, 10));
    expect(res.headers['content-range']).toBe(`bytes 2-9/${Buffer.byteLength(pub().content)}`);
  });

  it('unsatisfiable Range on an allowed file returns 416', async () => {
    const res = await rawRequest(urlOf(pub().rel), { headers: { Range: 'bytes=99999-' } });
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${Buffer.byteLength(pub().content)}`);
    expect(res.body).toBe('');
  });

  it('Range on denied files returns the 404 JSON, never partial bytes', async () => {
    for (const requester of ['anonymous', 'non-owner'] as Requester[]) {
      for (const file of [priv(), tier()]) {
        const headers: Record<string, string> = { Range: 'bytes=0-5' };
        const token = tokenOf(requester);
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await rawRequest(urlOf(file.rel), { headers });
        expectDenied({ status: res.status, body: null, text: res.body }, allContents());
        expect(res.body).not.toContain('BYTES:');
      }
    }
  });

  it('If-None-Match / If-Modified-Since on an allowed file return 304', async () => {
    const first = await rawRequest(urlOf(pub().rel));
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    const lastModified = first.headers['last-modified'] as string;
    expect(etag).toBeTruthy();

    const byEtag = await rawRequest(urlOf(pub().rel), { headers: { 'If-None-Match': etag } });
    expect(byEtag.status).toBe(304);
    expect(byEtag.body).toBe('');

    const byDate = await rawRequest(urlOf(pub().rel), { headers: { 'If-Modified-Since': lastModified } });
    expect(byDate.status).toBe(304);
  });

  it('conditional request on a denied file is still the 404 JSON', async () => {
    const owner = await rawRequest(urlOf(priv().rel), { headers: { Authorization: `Bearer ${tokens.owner}` } });
    expect(owner.status).toBe(200);
    const res = await rawRequest(urlOf(priv().rel), { headers: { 'If-None-Match': owner.headers.etag as string } });
    expectDenied({ status: res.status, body: null, text: res.body }, allContents());
  });

  it('owner Range on a private file works (owner/admin keep access)', async () => {
    const res = await rawRequest(urlOf(priv().rel), {
      headers: { Range: 'bytes=0-4', Authorization: `Bearer ${tokens.admin}` },
    });
    expect(res.status).toBe(206);
    expect(res.body).toBe(priv().content.slice(0, 5));
  });

  it('non-GET methods are denied without falling through', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await rawRequest(urlOf(pub().rel), { method });
      expectDenied({ status: res.status, body: null, text: res.body }, allContents());
    }
  });
});

describe('G-22 /uploads residue, staging and provenance-less files', () => {
  it('deleted-trip residue is 404 for every requester', async () => {
    for (const requester of REQUESTERS) {
      const headers: Record<string, string> = {};
      const token = tokenOf(requester);
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await rawRequest(`/uploads/${residueTripId}/originals/residue.jpg`, { headers });
      expectDenied({ status: res.status, body: null, text: res.body }, [residueContent]);
    }
    // The file really is on disk — the denial is not an artefact of a missing file.
    expect(fs.existsSync(path.join(uploadsBase, residueTripId, 'originals', 'residue.jpg'))).toBe(true);
  });

  it('a row whose stored path names another trip directory is not served', async () => {
    for (const requester of REQUESTERS) {
      const headers: Record<string, string> = {};
      const token = tokenOf(requester);
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await rawRequest(urlOf(mismatchRel), { headers });
      expectDenied({ status: res.status, body: null, text: res.body }, [mismatchContent]);
    }
  });

  it('the uploads root, a trip directory and top-level paths are 404', async () => {
    const tripId = trips.public.tripId;
    for (const p of ['/uploads', '/uploads/', `/uploads/${tripId}`, `/uploads/${tripId}/`, `/uploads/${tripId}/originals`, '/uploads/frames/x.jpg', '/uploads/audio/u/t.mp3']) {
      const res = await rawRequest(p, { headers: { Authorization: `Bearer ${tokens.admin}` } });
      expectDenied({ status: res.status, body: null, text: res.body }, allContents());
    }
  });
});

describe('G-22 /uploads path safety', () => {
  it('symlink registered as a public file but pointing outside uploads is 404 for everyone', async () => {
    expect(fs.lstatSync(path.join(uploadsBase, symlinkRel)).isSymbolicLink()).toBe(true);
    for (const requester of REQUESTERS) {
      const headers: Record<string, string> = {};
      const token = tokenOf(requester);
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await rawRequest(urlOf(symlinkRel), { headers });
      expectDenied({ status: res.status, body: null, text: res.body }, [outsideSecret]);
    }
  });

  it('traversal and encoding attacks are 404 JSON and never reach a later handler', async () => {
    const t = trips.public.tripId;
    const priv = trips.public.files.find((f) => f.label === 'private-original')!;
    const privName = path.basename(priv.rel);
    const tierRel = trips.public.files.find((f) => f.label === 'tier-category')!.rel;
    const attacks = [
      `/uploads/${t}/originals/../originals/${privName}`,
      `/uploads/${t}/originals/%2e%2e/originals/${privName}`,
      `/uploads/${t}/originals/%2E%2E/%2E%2E/${t}/originals/${privName}`,
      `/uploads/${t}%2foriginals%2f${privName}`,
      `/uploads/${t}%2Foriginals%2F${privName}`,
      `/uploads/${t}%5coriginals%5c${privName}`,
      `/uploads/${t}/originals/%252e%252e/${privName}`,
      `/uploads/${t}%252foriginals%252f${privName}`,
      `/uploads/${t}/originals/${privName}%00.jpg`,
      `/uploads/${t}/originals/${privName}%00`,
      `/uploads//${uploadsBase.replace(/^\//, '')}/${priv.rel}`,
      `/uploads/${encodeURIComponent(path.join(uploadsBase, priv.rel))}`,
      `/uploads/..%2f..%2fpackage.json`,
      `/uploads/../package.json`,
      `/uploads/%2e%2e/package.json`,
      `/uploads/${t}/./originals/${privName}`,
      `/uploads/${t}//originals/${privName}`,
      `/uploads/${t}/.tier-staging/landscape/staged.mp4`,
      `/uploads/${t}/%2etier-staging/landscape/staged.mp4`,
      `/uploads/${tierRel}`,
      `/uploads/${tierRel.replace('tier-slideshow', 'Tier-Slideshow')}`,
      `/uploads/${t}/originals/%E0%A4%A`,
      `/uploads/C:/windows/win.ini`,
    ];
    for (const attack of attacks) {
      for (const requester of ['anonymous', 'owner'] as Requester[]) {
        const headers: Record<string, string> = {};
        const token = tokenOf(requester);
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await rawRequest(attack, { headers });
        expect({ attack, requester, status: res.status }).toEqual({ attack, requester, status: 404 });
        expectDenied({ status: res.status, body: null, text: res.body }, allContents());
      }
    }
  });

  it('parseUploadsPath accepts plain relative paths and rejects unsafe ones', () => {
    expect(parseUploadsPath('/trip/originals/a.jpg')).toEqual(['trip', 'originals', 'a.jpg']);
    expect(parseUploadsPath('/trip/originals/a%20b.jpg')).toEqual(['trip', 'originals', 'a b.jpg']);
    for (const bad of ['', '/', '/a', '/a/', '//a/b', '/a/../b', '/a/./b', '/a/.b', '/a%2fb/c', '/a/b%5cc', '/a/b%00', '/a/%252e', '/a/b\\c', '/a/%E0%A4%A', '/C:/x', 'a/b']) {
      expect({ bad, parsed: parseUploadsPath(bad) }).toEqual({ bad, parsed: null });
    }
  });
});
