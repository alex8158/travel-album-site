/**
 * known-issues 12g, re-edit race (round32): the same compiled path can hold two versions one after the other.
 * A thumbnail generation that started on the earlier version and finishes last must not overwrite the current
 * image, restore an old pointer, or return the earlier footage to a visitor.
 *
 * REAL ffmpeg, sharp, generator, local storage, mediaServing / clips (re-edit) / uploads routes. The original is
 * red 0-4 s, green 4-8 s, blue 8-12 s. Version 1 of the compiled file keeps blue, version 2 (same path) keeps green.
 *
 * Order is forced with sync points, not delays:
 *   - downloadToTemp copies the compiled file to a private temp file, as the S3 provider does, so the old task
 *     really holds version 1 (blue) while it waits;
 *   - the thumbnail generator (the real one, wrapped) stops the first compiled-source generation after that
 *     download and signals `paused`; it continues only when the test calls `release()`.
 * The test then publishes version 2, lets a second visitor request finish, and only then releases the old task.
 *
 * ffmpeg is a hard requirement: a missing binary FAILS this file unless ALLOW_MISSING_FFMPEG=1 is set explicitly.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';

const gate = vi.hoisted(() => {
  const s = {
    armed: false,
    pausedKey: null as string | null,
    onPaused: null as null | (() => void),
    release: null as null | (() => void),
    pausedPromise: null as null | Promise<void>,
  };
  return {
    s,
    arm() {
      s.armed = true; s.pausedKey = null;
      let released!: () => void;
      const releasePromise = new Promise<void>((r) => { released = r; });
      s.release = released;
      s.pausedPromise = new Promise<void>((r) => { s.onPaused = r; });
      return { paused: s.pausedPromise, releasePromise };
    },
    releasePromise: null as null | Promise<void>,
  };
});

vi.mock('../services/thumbnailGenerator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/thumbnailGenerator')>();
  return {
    ...actual,
    generateVideoThumbnail: async (videoPath: string, tripId: string, mediaId: string, outputKey?: string) => {
      if (gate.s.armed && outputKey) {
        gate.s.armed = false;
        gate.s.pausedKey = outputKey;
        gate.s.onPaused!();
        await gate.releasePromise;
      }
      return actual.generateVideoThumbnail(videoPath, tripId, mediaId, outputKey);
    },
  };
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync } from 'child_process';
import sharp from 'sharp';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import { getStorageProvider } from '../storage/factory';
import { authMiddleware } from '../middleware/auth';
import { globalErrorHandler } from '../middleware/errorHandler';
import mediaServingRouter from './mediaServing';
import clipsRouter from './clips';
import { createUploadsAccessHandler } from './uploadsAccess';

function hasFfmpeg(): boolean {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const FFMPEG = hasFfmpeg();
const allowMissing = process.env.ALLOW_MISSING_FFMPEG === '1';
const UPLOADS = path.resolve(__dirname, '..', '..', 'uploads');

const app = express();
app.use(express.json());
app.use('/api/media', mediaServingRouter);
app.use('/api/media', clipsRouter);
app.use('/uploads', authMiddleware, createUploadsAccessHandler(UPLOADS));
app.use(globalErrorHandler);
const openServers = new Set<http.Server>();
async function local(): Promise<http.Server> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  openServers.add(server);
  return server;
}

type Colour = 'red' | 'green' | 'blue' | 'other';
async function colourOf(buf: Buffer): Promise<Colour> {
  const { channels } = await sharp(buf).stats();
  const [r, g, b] = channels.map((c) => c.mean);
  if (r > 150 && g < 100 && b < 100) return 'red';
  if (g > 100 && r < 100 && b < 100) return 'green';
  if (b > 150 && r < 100 && g < 100) return 'blue';
  return 'other';
}
function makeVideo(file: string, parts: Array<[string, number]>): void {
  const inputs = parts.flatMap(([c, d]) => ['-f', 'lavfi', '-i', `color=c=${c}:s=320x240:r=10:d=${d}`]);
  const concat = parts.map((_, i) => `[${i}:v]`).join('') + `concat=n=${parts.length}:v=1:a=0[v]`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', concat, '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-keyint_min', '10', file], { stdio: 'pipe' });
}

describe.skipIf(!FFMPEG && allowMissing)('12g re-edit race: an older thumbnail task finishing last never wins (real ffmpeg)', () => {
  const tripId = `thumbrace-trip-${uuidv4().slice(0, 8)}`;
  const tripDir = path.join(UPLOADS, tripId);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbrace-'));
  let owner: { userId: string; token: string };
  let other: { userId: string; token: string };
  let ORIGINAL: Buffer;

  beforeAll(() => {
    if (!FFMPEG) throw new Error('ffmpeg/ffprobe not found: this real-ffmpeg test must run (set ALLOW_MISSING_FFMPEG=1 to skip explicitly)');
    const f = path.join(tmpDir, 'original.mp4');
    makeVideo(f, [['red', 4], ['green', 4], ['blue', 4]]);
    ORIGINAL = fs.readFileSync(f);
  });
  afterAll(() => { fs.rmSync(tripDir, { recursive: true, force: true }); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function createUser(role: 'admin' | 'regular') {
    const userId = uuidv4(); const now = new Date().toISOString();
    getDb().prepare(`INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, 'h', ?, 'active', ?, ?)`)
      .run(userId, `thumbrace_${userId.slice(0, 8)}`, role, now, now);
    return { userId, token: signToken({ userId, role }) };
  }
  function insertVideo(): string {
    const id = `m-${uuidv4().slice(0, 8)}`;
    const filePath = `${tripId}/originals/${id}.mp4`;
    fs.mkdirSync(path.join(tripDir, 'originals'), { recursive: true });
    fs.writeFileSync(path.join(UPLOADS, filePath), ORIGINAL);
    const db = getDb();
    db.prepare(`INSERT INTO media_items (id, trip_id, file_path, thumbnail_path, media_type, mime_type, original_filename, file_size, status, visibility, media_source, processing_status, compiled_path, created_at)
      VALUES (?, ?, ?, NULL, 'video', 'video/mp4', 'v.mp4', ?, 'active', 'public', 'upload', 'none', NULL, ?)`)
      .run(id, tripId, filePath, ORIGINAL.length, new Date().toISOString());
    for (let i = 0; i < 3; i++) {
      db.prepare(`INSERT INTO video_segments (id, media_id, segment_index, start_time, end_time, duration, sharpness_score, stability_score, exposure_score, overall_score, label, selected, created_at)
        VALUES (?, ?, ?, ?, ?, 4, 80, 80, 80, 80, 'good', 1, ?)`).run(uuidv4(), id, i, i * 4, i * 4 + 4, new Date().toISOString());
    }
    return id;
  }
  const row = (id: string) => getDb().prepare('SELECT thumbnail_path, compiled_path FROM media_items WHERE id = ?').get(id) as { thumbnail_path: string | null; compiled_path: string | null };
  async function thumb(id: string, h: Record<string, string> = {}): Promise<{ status: number; colour: Colour | null }> {
    const r = request(await local()).get(`/api/media/${id}/thumbnail`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    for (const [k, v] of Object.entries(h)) r.set(k, v);
    const res = await r;
    return { status: res.status, colour: res.status === 200 ? await colourOf(res.body as Buffer) : null };
  }
  async function uploads(rel: string): Promise<{ status: number; colour: Colour | null }> {
    const res = await request(await local()).get('/uploads/' + rel).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    return { status: res.status, colour: res.status === 200 ? await colourOf(res.body as Buffer) : null };
  }
  async function reEdit(id: string, excludeIndices: number[]): Promise<void> {
    const res = await request(await local()).post(`/api/media/${id}/re-edit`).set('Authorization', `Bearer ${owner.token}`).send({ excludeIndices });
    expect(res.status).toBe(202);
    for (let i = 0; i < 600; i++) {
      const j = getDb().prepare('SELECT status, error_message FROM processing_jobs WHERE id = ?').get(res.body.jobId) as { status: string; error_message: string | null };
      if (j.status === 'completed') return;
      if (j.status === 'failed') throw new Error(`re-edit failed: ${j.error_message}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('re-edit did not finish');
  }

  beforeEach(() => {
    const db = getDb();
    for (const t of ['merged_video_sources', 'video_segments', 'upload_sessions', 'media_tags', 'compile_jobs', 'processing_job_events', 'processing_jobs', 'media_items', 'duplicate_groups', 'trips']) db.exec(`DELETE FROM ${t}`);
    owner = createUser('regular'); other = createUser('regular');
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at) VALUES (?, 't', 'public', ?, ?, ?)`).run(tripId, owner.userId, now, now);
    // S3-like download semantics: a private copy of the compiled file at the time of the download.
    const provider = getStorageProvider();
    const realDownload = provider.downloadToTemp.bind(provider);
    vi.spyOn(provider, 'downloadToTemp').mockImplementation(async (rel: string) => {
      const p = await realDownload(rel);
      if (!/\/(merged|compiled)\//.test(rel)) return p;
      const copy = path.join(tmpDir, `${uuidv4()}.mp4`);
      fs.copyFileSync(p, copy);
      return copy;
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    gate.s.armed = false;
    await Promise.all([...openServers].map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })));
    openServers.clear();
    for (const d of ['originals', 'merged', 'thumbnails']) fs.rmSync(path.join(tripDir, d), { recursive: true, force: true });
    // Leave no rows that reference the trip (later files delete trips without knowing about jobs).
    const db = getDb();
    db.prepare('DELETE FROM processing_job_events WHERE job_id IN (SELECT id FROM processing_jobs WHERE trip_id = ?)').run(tripId);
    db.prepare('DELETE FROM processing_jobs WHERE trip_id = ?').run(tripId);
    db.prepare('DELETE FROM video_segments WHERE media_id IN (SELECT id FROM media_items WHERE trip_id = ?)').run(tripId);
    db.prepare('DELETE FROM media_items WHERE trip_id = ?').run(tripId);
    db.prepare('DELETE FROM trips WHERE id = ?').run(tripId);
    closeDb();
  });

  it('old task paused on the blue version, green published and served, old task released: visitors only ever get green', async () => {
    const id = insertVideo();
    await reEdit(id, [0, 1]); // version 1 at the merged path: blue
    const compiledPath = row(id).compiled_path!;

    const { paused, releasePromise } = gate.arm();
    gate.releasePromise = releasePromise;
    const oldTask = thumb(id); // anonymous visitor; its generation stops after downloading version 1
    await paused;
    const oldKey = gate.s.pausedKey!;

    await reEdit(id, [0, 2]); // version 2 at the same path: green
    expect(row(id).compiled_path).toBe(compiledPath);

    // A second visitor while the old task is still held. It must not wait for the old task.
    const newTask = thumb(id, { Authorization: `Bearer ${other.token}` });
    const failSafe = new Promise<'held'>((r) => setTimeout(() => r('held'), 15000));
    const first = await Promise.race([newTask.then(() => 'done' as const), failSafe]);
    const pointerAfterNew = row(id).thumbnail_path;

    gate.s.release!(); // let the old task finish last
    const [oldRes, newRes] = await Promise.all([oldTask, newTask]);

    // Observation line kept in the log for the evidence archive (what each request actually returned).
    const finalPointer = row(id).thumbnail_path;
    console.log('[thumbrace]', JSON.stringify({ first, oldRes, newRes, oldKey, pointerAfterNew, finalPointer,
      finalPointerColour: finalPointer && fs.existsSync(path.join(UPLOADS, finalPointer)) ? await colourOf(fs.readFileSync(path.join(UPLOADS, finalPointer))) : null,
      nextVisitor: await thumb(id), uploadsOldKey: await uploads(oldKey) }));
    expect(first).toBe('done'); // the new request finished before the old task was released
    expect(newRes).toEqual({ status: 200, colour: 'green' });
    expect(oldRes.colour).not.toBe('blue'); // the old task never returns the earlier footage
    expect(oldRes).toEqual({ status: 200, colour: 'green' });

    // The old task neither restored its pointer nor overwrote the current image.
    const pointer = row(id).thumbnail_path!;
    expect(pointer).toBe(pointerAfterNew);
    expect(pointer).not.toBe(oldKey);
    expect(await colourOf(fs.readFileSync(path.join(UPLOADS, pointer)))).toBe('green');
    expect(await thumb(id)).toEqual({ status: 200, colour: 'green' });

    // /uploads: the current image is the published one; the old task's file (if any) is not reachable.
    expect(await uploads(pointer)).toEqual({ status: 200, colour: 'green' });
    expect((await uploads(oldKey)).status).toBe(404);
  });
});
