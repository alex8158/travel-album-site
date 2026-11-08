/**
 * S3 branch of the media file routes (G-21, 需求 9 AC 23).
 *
 * The storage provider is a mock: these tests prove only the route's order —
 * authorization before any storage call, signing or redirect — and the headers
 * on the 302. They do not exercise real S3, bucket ACL, presigned URL expiry,
 * CORS on redirected fetches, or any CDN.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

const fakeProvider = vi.hoisted(() => {
  // mediaServing reads STORAGE_TYPE at import time. Tests share one process
  // (singleFork), so the previous value is restored in afterAll.
  (globalThis as Record<string, unknown>).__g21PrevStorageType = process.env.STORAGE_TYPE;
  process.env.STORAGE_TYPE = 's3';
  return {
    exists: vi.fn(async () => true),
    getUrl: vi.fn(async (p: string) => `https://bucket.example.invalid/${p}?X-Amz-Expires=3600`),
    downloadToTemp: vi.fn(async () => '/nonexistent'),
  };
});

vi.mock('../storage/factory', () => ({
  getStorageProvider: () => fakeProvider,
}));

vi.mock('../services/thumbnailGenerator', () => ({
  generateThumbnail: vi.fn(async () => 'never'),
  generateVideoThumbnail: vi.fn(async () => 'never'),
}));

import express from 'express';
import http from 'http';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import { generateThumbnail, generateVideoThumbnail } from '../services/thumbnailGenerator';
import mediaServingRouter from './mediaServing';

const app = express();
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

function createUser(role: 'admin' | 'regular') {
  const userId = uuidv4();
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).run(userId, `g21s3_${userId.slice(0, 8)}`, 'hash', role, now, now);
  return { userId, token: signToken({ userId, role }) };
}

describe('Media Serving API — S3 branch (mocked provider)', () => {
  const tripId = `s3-trip-${uuidv4().slice(0, 8)}`;
  let owner: { userId: string; token: string };
  let other: { userId: string; token: string };

  function insert(o: { mediaType: 'image' | 'video'; visibility?: string; compiled?: boolean; thumb?: boolean }): string {
    const id = uuidv4();
    getDb().prepare(
      `INSERT INTO media_items (id, trip_id, file_path, thumbnail_path, media_type, mime_type, original_filename,
         file_size, status, visibility, media_source, processing_status, compiled_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'f', 1, 'active', ?, 'upload', 'none', ?, ?)`,
    ).run(
      id, tripId, `${tripId}/originals/${id}`, o.thumb ? `${tripId}/thumbnails/${id}_thumb.webp` : null,
      o.mediaType, o.mediaType === 'image' ? 'image/jpeg' : 'video/mp4', o.visibility ?? 'public',
      o.compiled ? `${tripId}/compiled/${id}.mp4` : null, new Date().toISOString(),
    );
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
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at) VALUES (?, 't', 'public', ?, ?, ?)`,
    ).run(tripId, owner.userId, now, now);
    fakeProvider.exists.mockClear();
    fakeProvider.getUrl.mockClear();
    fakeProvider.downloadToTemp.mockClear();
  });

  afterEach(() => closeDb());

  afterAll(() => {
    const prev = (globalThis as Record<string, unknown>).__g21PrevStorageType as string | undefined;
    if (prev === undefined) delete process.env.STORAGE_TYPE;
    else process.env.STORAGE_TYPE = prev;
  });

  it('allowed public image: authorizes, then signs and redirects with no-store', async () => {
    const id = insert({ mediaType: 'image', thumb: true });
    const res = await request(await local()).get(`/api/media/${id}/original`).redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers['location']).toContain(`${tripId}/originals/${id}`);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['vary']).toMatch(/Authorization/i);

    const thumb = await request(await local()).get(`/api/media/${id}/thumbnail`).redirects(0);
    expect(thumb.status).toBe(302);
    expect(thumb.headers['cache-control']).toBe('private, no-store');
  });

  it('allowed non-owner video is signed for the compiled file only, after an existence check', async () => {
    const id = insert({ mediaType: 'video', compiled: true });
    const res = await request(await local()).get(`/api/media/${id}/original`).redirects(0);
    expect(res.status).toBe(302);
    expect(fakeProvider.exists).toHaveBeenCalledWith(`${tripId}/compiled/${id}.mp4`);
    expect(fakeProvider.getUrl).toHaveBeenCalledWith(`${tripId}/compiled/${id}.mp4`);
  });

  it('non-owner video whose compiled file is missing is 404 and never signed', async () => {
    const id = insert({ mediaType: 'video', compiled: true });
    fakeProvider.exists.mockResolvedValueOnce(false);
    const res = await request(await local()).get(`/api/media/${id}/original`).redirects(0);
    expect(res.status).toBe(404);
    expect(fakeProvider.getUrl).not.toHaveBeenCalled();
  });

  it('denied requests never touch the provider: no exists, no sign, no download, no generation', async () => {
    const priv = insert({ mediaType: 'image', visibility: 'private' });
    const pub = insert({ mediaType: 'image' });
    const uncompiled = insert({ mediaType: 'video' });
    const cases: Array<[string, Record<string, string>]> = [
      [`/api/media/${priv}/original`, {}],
      [`/api/media/${priv}/thumbnail`, { Authorization: `Bearer ${other.token}` }],
      [`/api/media/${pub}/raw`, {}],
      [`/api/media/${pub}/original?original=true`, { Authorization: `Bearer ${other.token}` }],
      [`/api/media/${uncompiled}/thumbnail`, {}],
      ['/api/media/does-not-exist/original', {}],
    ];
    for (const [url, headers] of cases) {
      const r = request(await local()).get(url).redirects(0);
      for (const [k, v] of Object.entries(headers)) r.set(k, v);
      const res = await r;
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: '媒体文件不存在' } });
      expect(res.headers['location']).toBeUndefined();
      expect(res.headers['cache-control']).toBe('private, no-store');
    }
    expect(fakeProvider.exists).not.toHaveBeenCalled();
    expect(fakeProvider.getUrl).not.toHaveBeenCalled();
    expect(fakeProvider.downloadToTemp).not.toHaveBeenCalled();
    expect(generateThumbnail).not.toHaveBeenCalled();
    expect(generateVideoThumbnail).not.toHaveBeenCalled();
  });

  it('owner raw entry is signed for the original upload', async () => {
    const id = insert({ mediaType: 'image', visibility: 'private' });
    const res = await request(await local()).get(`/api/media/${id}/raw`).set('Authorization', `Bearer ${owner.token}`).redirects(0);
    expect(res.status).toBe(302);
    expect(fakeProvider.getUrl).toHaveBeenCalledWith(`${tripId}/originals/${id}`);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });
});
