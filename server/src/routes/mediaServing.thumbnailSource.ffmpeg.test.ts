/**
 * known-issues 12g (ruled 2026-11-17): a thumbnail that a non-owner can see for an ordinary
 * video must show only footage the compiled (publishable) file keeps (需求 9 AC 18). Footage
 * the edit removed must not come back through the thumbnail. Owner/admin keep their AC 5
 * exception.
 *
 * REAL ffmpeg, REAL sharp, REAL thumbnail generator, real local storage (the test trip
 * directory under server/uploads), the real mediaServing, clips (re-edit) and /uploads
 * routes. Each video is solid colour per part: the original is red 0-4 s, green 4-8 s,
 * blue 8-12 s, so its first frame is red. The tests decode the returned image and check its
 * colour, not paths or calls.
 *
 * ffmpeg is a hard requirement: a missing binary FAILS this file unless
 * ALLOW_MISSING_FFMPEG=1 is set explicitly (then it is reported as skipped).
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import { execFileSync } from 'child_process';
import sharp from 'sharp';
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import { generateThumbnailsForTrip } from '../services/thumbnailGenerator';
import { authMiddleware } from '../middleware/auth';
import { globalErrorHandler } from '../middleware/errorHandler';
import mediaServingRouter from './mediaServing';
import clipsRouter from './clips';
import { createUploadsAccessHandler } from './uploadsAccess';

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const FFMPEG = hasFfmpeg();
const allowMissing = process.env.ALLOW_MISSING_FFMPEG === '1';

const UPLOADS = path.resolve(__dirname, '..', '..', 'uploads');

// Mounted as in index.ts (the parts these tests use).
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

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' });
}
/** Solid-colour parts, 10 fps, a keyframe every second (segment cuts land on keyframes). */
function makeVideo(file: string, parts: Array<[string, number]>): void {
  const inputs = parts.flatMap(([c, d]) => ['-f', 'lavfi', '-i', `color=c=${c}:s=320x240:r=10:d=${d}`]);
  const concat = parts.map((_, i) => `[${i}:v]`).join('') + `concat=n=${parts.length}:v=1:a=0[v]`;
  ffmpeg([...inputs, '-filter_complex', concat, '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-keyint_min', '10', file]);
}

describe.skipIf(!FFMPEG && allowMissing)('12g: non-owner video thumbnails come only from kept footage (real ffmpeg)', () => {
  const tripId = `thumbsrc-trip-${uuidv4().slice(0, 8)}`;
  const tripDir = path.join(UPLOADS, tripId);
  let owner: { userId: string; token: string };
  let other: { userId: string; token: string };
  let admin: { userId: string; token: string };
  const fixtures = path.join(UPLOADS, tripId, '.fixtures-not-registered');
  let ORIGINAL: Buffer; // red 0-4, green 4-8, blue 8-12
  let BLUE_ONLY: Buffer; // what an edit that cut 0-8 s keeps

  beforeAll(() => {
    if (!FFMPEG) throw new Error('ffmpeg/ffprobe not found: this real-ffmpeg test must run (set ALLOW_MISSING_FFMPEG=1 to skip explicitly)');
    fs.mkdirSync(fixtures, { recursive: true });
    makeVideo(path.join(fixtures, 'original.mp4'), [['red', 4], ['green', 4], ['blue', 4]]);
    makeVideo(path.join(fixtures, 'blue.mp4'), [['blue', 4]]);
    ORIGINAL = fs.readFileSync(path.join(fixtures, 'original.mp4'));
    BLUE_ONLY = fs.readFileSync(path.join(fixtures, 'blue.mp4'));
  });

  function createUser(role: 'admin' | 'regular') {
    const userId = uuidv4(); const now = new Date().toISOString();
    getDb().prepare(`INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, 'h', ?, 'active', ?, ?)`)
      .run(userId, `thumbsrc_${userId.slice(0, 8)}`, role, now, now);
    return { userId, token: signToken({ userId, role }) };
  }

  /** An ordinary uploaded video with 3 analysed 4 s segments (red, green, blue), all 'good'. */
  function insertVideo(o: { visibility?: string; status?: string; compiled?: Buffer | null } = {}): string {
    const id = `m-${uuidv4().slice(0, 8)}`;
    const filePath = `${tripId}/originals/${id}.mp4`;
    fs.mkdirSync(path.join(tripDir, 'originals'), { recursive: true });
    fs.writeFileSync(path.join(UPLOADS, filePath), ORIGINAL);
    let compiledPath: string | null = null;
    if (o.compiled) {
      fs.mkdirSync(path.join(tripDir, 'compiled'), { recursive: true });
      compiledPath = `${tripId}/compiled/${id}.mp4`;
      fs.writeFileSync(path.join(UPLOADS, compiledPath), o.compiled);
    }
    const db = getDb();
    db.prepare(`INSERT INTO media_items (id, trip_id, file_path, thumbnail_path, media_type, mime_type, original_filename, file_size, status, visibility, media_source, processing_status, compiled_path, created_at)
      VALUES (?, ?, ?, NULL, 'video', 'video/mp4', 'v.mp4', ?, ?, ?, 'upload', 'none', ?, ?)`)
      .run(id, tripId, filePath, ORIGINAL.length, o.status ?? 'active', o.visibility ?? 'public', compiledPath, new Date().toISOString());
    for (let i = 0; i < 3; i++) {
      db.prepare(`INSERT INTO video_segments (id, media_id, segment_index, start_time, end_time, duration, sharpness_score, stability_score, exposure_score, overall_score, label, selected, created_at)
        VALUES (?, ?, ?, ?, ?, 4, 80, 80, 80, 80, 'good', 1, ?)`).run(uuidv4(), id, i, i * 4, i * 4 + 4, new Date().toISOString());
    }
    return id;
  }
  const row = (id: string) => getDb().prepare('SELECT thumbnail_path, compiled_path FROM media_items WHERE id = ?').get(id) as { thumbnail_path: string | null; compiled_path: string | null };

  const nonOwners = () => [['anonymous', {}], ['non-owner', { Authorization: `Bearer ${other.token}` }]] as Array<[string, Record<string, string>]>;
  async function get(url: string, h: Record<string, string> = {}) {
    const r = request(await local()).get(url).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    for (const [k, v] of Object.entries(h)) r.set(k, v);
    return r;
  }
  async function thumbColour(id: string, h: Record<string, string>): Promise<{ status: number; colour: Colour | null; body: string }> {
    const res = await get(`/api/media/${id}/thumbnail`, h);
    if (res.status !== 200) return { status: res.status, colour: null, body: (res.body as Buffer).toString() };
    return { status: 200, colour: await colourOf(res.body as Buffer), body: '' };
  }
  async function reEdit(id: string, excludeIndices: number[]): Promise<void> {
    const res = await request(await local()).post(`/api/media/${id}/re-edit`).set('Authorization', `Bearer ${owner.token}`).send({ excludeIndices });
    expect(res.status).toBe(202);
    const jobId = res.body.jobId as string;
    for (let i = 0; i < 600; i++) {
      const j = getDb().prepare('SELECT status, error_message FROM processing_jobs WHERE id = ?').get(jobId) as { status: string; error_message: string | null };
      if (j.status === 'completed') return;
      if (j.status === 'failed') throw new Error(`re-edit failed: ${j.error_message}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('re-edit did not finish within 30 s');
  }

  beforeEach(() => {
    const db = getDb();
    for (const t of ['merged_video_sources', 'video_segments', 'upload_sessions', 'media_tags', 'compile_jobs', 'processing_job_events', 'processing_jobs', 'media_items', 'duplicate_groups', 'trips']) db.exec(`DELETE FROM ${t}`);
    owner = createUser('regular'); other = createUser('regular'); admin = createUser('admin');
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at) VALUES (?, 't', 'public', ?, ?, ?)`).run(tripId, owner.userId, now, now);
  });
  afterEach(async () => {
    await Promise.all([...openServers].map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })));
    openServers.clear();
    for (const d of ['originals', 'compiled', 'merged', 'thumbnails']) fs.rmSync(path.join(tripDir, d), { recursive: true, force: true });
    closeDb();
  });
  afterAll(() => { fs.rmSync(tripDir, { recursive: true, force: true }); });

  it('first generation: anonymous and non-owner get a thumbnail of the kept (blue) footage, never the cut red opening', async () => {
    const id = insertVideo({ compiled: BLUE_ONLY });
    for (const [, h] of nonOwners()) expect(await thumbColour(id, h)).toEqual({ status: 200, colour: 'blue', body: '' });
    expect((await thumbColour(id, { Authorization: `Bearer ${owner.token}` })).status).toBe(200);
  });

  it('an existing original-derived thumbnail (background generateThumbnailsForTrip) is not reused for non-owners, on /api/media or /uploads', async () => {
    const id = insertVideo({ compiled: BLUE_ONLY });
    await generateThumbnailsForTrip(tripId); // the upload pipeline's step: thumbnail from the original
    const oldThumb = row(id).thumbnail_path!;
    expect(oldThumb).toBeTruthy();
    expect(await colourOf(fs.readFileSync(path.join(UPLOADS, oldThumb)))).toBe('red'); // the leak exists in storage

    for (const [, h] of nonOwners()) expect((await get(`/uploads/${oldThumb}`, h)).status).toBe(404);
    expect((await get(`/uploads/${oldThumb}`, { Authorization: `Bearer ${owner.token}` })).status).toBe(200); // AC 5 exception

    for (const [, h] of nonOwners()) expect(await thumbColour(id, h)).toEqual({ status: 200, colour: 'blue', body: '' });
    expect(fs.existsSync(path.join(UPLOADS, oldThumb))).toBe(true); // stored files are not rewritten or deleted
  });

  it('re-edit at the same compiled path: the non-owner thumbnail follows the new edit and is never stale', async () => {
    const id = insertVideo();
    await reEdit(id, [0, 1]); // keep blue only
    const firstPath = row(id).compiled_path;
    expect(firstPath).toBe(`${tripId}/merged/${id}_merged.mp4`);
    for (const [, h] of nonOwners()) expect(await thumbColour(id, h)).toEqual({ status: 200, colour: 'blue', body: '' });

    await reEdit(id, [0, 2]); // keep green only, written to the same path
    expect(row(id).compiled_path).toBe(firstPath);
    for (const [, h] of nonOwners()) expect(await thumbColour(id, h)).toEqual({ status: 200, colour: 'green', body: '' });
  });

  it('compiled result unavailable: non-owners get 404 and nothing is derived from the original', async () => {
    // compiled_path set but the file is missing
    const missing = insertVideo({ compiled: BLUE_ONLY });
    fs.unlinkSync(path.join(UPLOADS, row(missing).compiled_path!));
    for (const [, h] of nonOwners()) expect((await thumbColour(missing, h)).status).toBe(404);
    expect(row(missing).thumbnail_path).toBeNull();

    // never compiled
    const uncompiled = insertVideo();
    for (const [, h] of nonOwners()) expect((await thumbColour(uncompiled, h)).status).toBe(404);

    // compiled file present but unreadable: generation fails, no fallback to the original
    const broken = insertVideo({ compiled: Buffer.from('not a video') });
    for (const [, h] of nonOwners()) {
      const r = await thumbColour(broken, h);
      expect(r.status).toBe(404);
      expect(r.body).toContain('THUMBNAIL_FAILED');
    }
    expect(row(broken).thumbnail_path).toBeNull();

    // owner and admin keep the AC 5 exception (served from what is available)
    for (const t of [owner.token, admin.token]) expect((await thumbColour(missing, { Authorization: `Bearer ${t}` })).status).toBe(200);
  });

  it('existing permission rules hold: private and trashed are 404 for non-owners, owner and admin are served', async () => {
    const priv = insertVideo({ compiled: BLUE_ONLY, visibility: 'private' });
    const trashed = insertVideo({ compiled: BLUE_ONLY, status: 'trashed' });
    for (const id of [priv, trashed]) {
      for (const [, h] of nonOwners()) expect((await thumbColour(id, h)).status).toBe(404);
      for (const t of [owner.token, admin.token]) expect((await thumbColour(id, { Authorization: `Bearer ${t}` })).status).toBe(200);
    }
  });
});
