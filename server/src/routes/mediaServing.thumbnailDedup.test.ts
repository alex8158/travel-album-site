/**
 * On-demand video thumbnail generation is shared by concurrent requests for the same video
 * (G-27 S3 diagnosis, round25). The storage provider and the generator are mocks; the tests
 * count how often the original is downloaded and the generator runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ctl = vi.hoisted(() => {
  const state = {
    originalDownloads: [] as string[],
    gates: new Map<string, { promise: Promise<void>; release: () => void; fail: (e: Error) => void }>(),
    thumbFile: '',
  };
  function gate(key: string) {
    let release!: () => void; let fail!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => { release = res; fail = rej; });
    const g = { promise, release, fail };
    state.gates.set(key, g);
    return g;
  }
  return { state, gate };
});

vi.mock('../storage/factory', () => ({
  getStorageProvider: () => ({
    exists: vi.fn(async () => true),
    getUrl: vi.fn(async (p: string) => `https://bucket.example.invalid/${p}`),
    downloadToTemp: vi.fn(async (p: string) => {
      if (p.includes('/thumbnails/')) return ctl.state.thumbFile;
      ctl.state.originalDownloads.push(p);
      const g = ctl.state.gates.get(p);
      if (g) await g.promise;
      return `/tmp/fake-original-${path.basename(p)}`;
    }),
  }),
}));
const genVideo = vi.hoisted(() => ({ fn: null as unknown as ReturnType<typeof import('vitest').vi.fn> }));
vi.mock('../services/thumbnailGenerator', async () => {
  const { vi: v } = await import('vitest');
  genVideo.fn = v.fn(async (_local: string, tripId: string, mediaId: string) => `${tripId}/thumbnails/${mediaId}_thumb.webp`);
  return { generateThumbnail: v.fn(async () => 'never'), generateVideoThumbnail: genVideo.fn };
});

import express from 'express';
import http from 'http';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import mediaServingRouter from './mediaServing';

const app = express();
app.use('/api/media', mediaServingRouter);
const openServers = new Set<http.Server>();
async function local(): Promise<http.Server> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  openServers.add(server);
  return server;
}
afterEach(async () => {
  await Promise.all([...openServers].map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })));
  openServers.clear();
});

describe('on-demand video thumbnail: in-flight de-duplication', () => {
  const tripId = `dedup-trip-${uuidv4().slice(0, 8)}`;
  let owner: { userId: string; token: string };
  let stranger: { userId: string; token: string };
  function user(role: 'regular' | 'admin') {
    const userId = uuidv4(); const now = new Date().toISOString();
    getDb().prepare(`INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, 'h', ?, 'active', ?, ?)`)
      .run(userId, `dedup_${userId.slice(0, 8)}`, role, now, now);
    return { userId, token: signToken({ userId, role }) };
  }
  function video(visibility = 'public'): string {
    const id = uuidv4();
    getDb().prepare(`INSERT INTO media_items (id, trip_id, file_path, thumbnail_path, media_type, mime_type, original_filename, file_size, status, visibility, media_source, processing_status, compiled_path, created_at)
      VALUES (?, ?, ?, NULL, 'video', 'video/mp4', 'v.mp4', 1, 'active', ?, 'upload', 'none', NULL, ?)`)
      .run(id, tripId, `${tripId}/originals/${id}.mp4`, visibility, new Date().toISOString());
    return id;
  }
  const get = async (id: string, token: string) => request(await local()).get(`/api/media/${id}/thumbnail`).set('Authorization', `Bearer ${token}`);
  const originalOf = (id: string) => `${tripId}/originals/${id}.mp4`;
  const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); };

  beforeEach(() => {
    const db = getDb();
    for (const t of ['merged_video_sources', 'video_segments', 'upload_sessions', 'media_tags', 'compile_jobs', 'media_items', 'duplicate_groups', 'trips']) db.exec(`DELETE FROM ${t}`);
    owner = user('regular'); stranger = user('regular');
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at) VALUES (?, 't', 'public', ?, ?, ?)`).run(tripId, owner.userId, now, now);
    ctl.state.originalDownloads.length = 0; ctl.state.gates.clear();
    ctl.state.thumbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-')), 'thumb.webp');
    fs.writeFileSync(ctl.state.thumbFile, Buffer.from('fake-webp-thumbnail'));
    genVideo.fn.mockClear();
  });
  afterEach(() => closeDb());

  it('five concurrent owner requests for one video: one original download, one generation, all get the thumbnail', async () => {
    const id = video('private');
    const g = ctl.gate(originalOf(id));
    const reqs = Array.from({ length: 5 }, () => get(id, owner.token));
    await until(() => ctl.state.originalDownloads.length >= 1);
    await new Promise((r) => setTimeout(r, 100)); // let the other four arrive while the first is in flight
    g.release();
    const res = await Promise.all(reqs);
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    for (const r of res) expect(Buffer.from(r.body).toString()).toBe('fake-webp-thumbnail');
    expect(ctl.state.originalDownloads.filter((p) => p === originalOf(id))).toHaveLength(1);
    expect(genVideo.fn).toHaveBeenCalledTimes(1);
    const row = getDb().prepare('SELECT thumbnail_path FROM media_items WHERE id = ?').get(id) as { thumbnail_path: string };
    expect(row.thumbnail_path).toBe(`${tripId}/thumbnails/${id}_thumb.webp`);
  });

  it('a failed generation is reported to every waiter, then the next request retries with a new download', async () => {
    const id = video();
    const g = ctl.gate(originalOf(id));
    const reqs = Array.from({ length: 3 }, () => get(id, owner.token));
    await until(() => ctl.state.originalDownloads.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    g.fail(new Error('simulated S3 failure'));
    const res = await Promise.all(reqs);
    expect(res.map((r) => r.status)).toEqual([404, 404, 404]);
    for (const r of res) expect(r.body.error.code).toBe('THUMBNAIL_FAILED');
    expect(ctl.state.originalDownloads).toHaveLength(1);
    ctl.state.gates.clear();
    const retry = await get(id, owner.token);
    expect(retry.status).toBe(200);
    expect(ctl.state.originalDownloads).toHaveLength(2);
    expect(genVideo.fn).toHaveBeenCalledTimes(1);
  });

  it('different videos do not wait for each other', async () => {
    const a = video(); const b = video();
    ctl.gate(originalOf(a)); // A stays in flight
    const pa = get(a, owner.token);
    await until(() => ctl.state.originalDownloads.includes(originalOf(a)));
    const rb = await get(b, owner.token);
    expect(rb.status).toBe(200);
    expect(ctl.state.originalDownloads).toEqual([originalOf(a), originalOf(b)]);
    ctl.state.gates.get(originalOf(a))!.release();
    expect((await pa).status).toBe(200);
  });

  it('the access decision runs before reuse: a non-owner of a private video gets 404 while the owner generation is in flight', async () => {
    const id = video('private');
    const g = ctl.gate(originalOf(id));
    const po = get(id, owner.token);
    await until(() => ctl.state.originalDownloads.length >= 1);
    const rs = await get(id, stranger.token);
    expect(rs.status).toBe(404);
    expect(rs.body.error.code).toBe('NOT_FOUND');
    g.release();
    expect((await po).status).toBe(200);
    expect(ctl.state.originalDownloads).toHaveLength(1);
  });
});
