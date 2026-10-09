/**
 * C2 acceptance with the REAL generator and REAL ffmpeg (no mocks):
 *   - unreadable sources at first / middle / last position are reported by index,
 *     and the sealed manifest equals the remaining ids in baked order;
 *   - the video's duration and the dominant colour of every segment match the
 *     manifest order (each source is a distinct solid colour);
 *   - two concurrent publishes for one category leave exactly one published row,
 *     each file matching its own recorded hash.
 *
 * ffmpeg is a hard requirement here: a missing binary FAILS this file unless
 * ALLOW_MISSING_FFMPEG=1 is set explicitly (then it is reported as skipped).
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import sharp from 'sharp';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { getTempDir } from '../helpers/tempDir';
import { publishTierSlideshow, hashFile, canonicalManifest, sha256Hex } from './tierSlideshowProvenance';

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
const COLOURS: Array<[string, [number, number, number]]> = [
  ['red', [255, 0, 0]], ['green', [0, 255, 0]], ['blue', [0, 0, 255]], ['yellow', [255, 255, 0]],
  ['magenta', [255, 0, 255]], ['cyan', [0, 255, 255]], ['white', [255, 255, 255]], ['orange', [255, 128, 0]],
];

function nearestColour(rgb: number[]): string {
  let best = '';
  let bestD = Infinity;
  for (const [name, c] of COLOURS) {
    const d = (rgb[0] - c[0]) ** 2 + (rgb[1] - c[1]) ** 2 + (rgb[2] - c[2]) ** 2;
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

function frameColour(video: string, t: number): number[] {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', video, '-frames:v', '1',
    '-vf', 'scale=8:6', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const sum = [0, 0, 0];
  for (let i = 0; i < raw.length; i += 3) { sum[0] += raw[i]; sum[1] += raw[i + 1]; sum[2] += raw[i + 2]; }
  const n = raw.length / 3;
  return sum.map((v) => v / n);
}

/** Files (not directories) below `dir`; plain recursion so it also runs on Node 18. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p)); else out.push(p);
  }
  return out;
}

function duration(video: string): number {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).toString().trim());
}

describe.runIf(FFMPEG || !allowMissing)('C2 publish with real ffmpeg', () => {
  const tripId = uuidv4();
  const ids: string[] = [];
  const photoPaths: string[] = [];
  let workDir = '';

  beforeAll(async () => {
    if (!FFMPEG) throw new Error('ffmpeg/ffprobe not on PATH: this acceptance test must run (set ALLOW_MISSING_FFMPEG=1 to skip explicitly)');
    workDir = fs.mkdtempSync(path.join(getTempDir(), 'c2-ffmpeg-'));
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO trips (id, title, visibility, created_at, updated_at) VALUES (?, 't', 'public', ?, ?)`).run(tripId, now, now);
    for (const [name, [r, g, b]] of COLOURS) {
      const id = uuidv4();
      const p = path.join(workDir, `${name}.jpg`);
      await sharp({ create: { width: 320, height: 240, channels: 3, background: { r, g, b } } }).jpeg({ quality: 95 }).toFile(p);
      db.prepare(`INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size,
                    status, visibility, category, created_at)
                  VALUES (?, ?, ?, 'image', 'image/jpeg', ?, 1, 'active', 'public', 'landscape', ?)`)
        .run(id, tripId, `${tripId}/originals/${id}.jpg`, `${name}.jpg`, now);
      ids.push(id);
      photoPaths.push(p);
    }
  });

  afterAll(() => {
    try {
      const db = getDb();
      db.prepare('DELETE FROM media_items WHERE trip_id=?').run(tripId);
      db.prepare('DELETE FROM trips WHERE id=?').run(tripId);
    } finally {
      closeDb();
      for (const p of photoPaths) { try { fs.chmodSync(p, 0o644); } catch { /* ignore */ } }
      if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(path.join(UPLOADS, tripId), { recursive: true, force: true });
    }
  });

  it('maps skipped indices (first, middle, last) to ids and bakes the rest in order', async () => {
    const unreadable = [0, 4, 7];
    for (const i of unreadable) fs.chmodSync(photoPaths[i], 0o000);
    try {
      const r = await publishTierSlideshow({
        tripId, category: 'landscape', photoDuration: 1,
        sources: ids.map((id, i) => ({ mediaId: id, localPath: photoPaths[i] })),
      });
      if (!r.ok) throw new Error(`${r.stage}: ${r.error}`);

      const expectedIdx = [1, 2, 3, 5, 6];
      expect(r.skippedMediaIds).toEqual(unreadable.map((i) => ids[i]));
      expect(r.manifest).toEqual(expectedIdx.map((i) => ids[i]));

      const row = getDb().prepare('SELECT * FROM tier_slideshow_artifacts WHERE id=?').get(r.artifactId) as {
        manifest_json: string; manifest_sha256: string; file_sha256: string; file_size: number; source_count: number;
      };
      expect(row.manifest_json).toBe(canonicalManifest(r.manifest));
      expect(row.manifest_sha256).toBe(sha256Hex(row.manifest_json));
      expect(row.source_count).toBe(5);

      const video = path.join(UPLOADS, r.relPath);
      const h = await hashFile(video);
      expect(h).toEqual({ sha256: row.file_sha256, size: row.file_size });
      // Published inode is read-only with a single name; the attempt's staging holds no files.
      expect(fs.statSync(video).mode & 0o777).toBe(0o444);
      expect(fs.statSync(video).nlink).toBe(1);
      const attemptDir = path.join(UPLOADS, tripId, '.tier-staging', r.artifactId);
      expect(filesUnder(attemptDir)).toEqual([]);
      expect(duration(video)).toBeCloseTo(expectedIdx.length * 1, 0);

      const seen = expectedIdx.map((_, seg) => nearestColour(frameColour(video, seg + 0.5)));
      expect(seen).toEqual(expectedIdx.map((i) => COLOURS[i][0]));
    } finally {
      for (const i of unreadable) fs.chmodSync(photoPaths[i], 0o644);
    }
  }, 120_000);

  it('two concurrent publishes for one category: one published, one superseded, both files intact', async () => {
    const setA = [0, 1, 2].map((i) => ({ mediaId: ids[i], localPath: photoPaths[i] }));
    const setB = [5, 6, 7].map((i) => ({ mediaId: ids[i], localPath: photoPaths[i] }));
    const [a, b] = await Promise.all([
      publishTierSlideshow({ tripId, category: 'people', sources: setA, photoDuration: 1 }),
      publishTierSlideshow({ tripId, category: 'people', sources: setB, photoDuration: 1 }),
    ]);
    if (!a.ok || !b.ok) throw new Error('both publishes should succeed');
    const rows = getDb().prepare(`SELECT id, status, rel_path, file_sha256, manifest_json FROM tier_slideshow_artifacts
                                  WHERE trip_id=? AND category='people'`).all(tripId) as Array<{
      id: string; status: string; rel_path: string; file_sha256: string; manifest_json: string;
    }>;
    expect(rows.filter((x) => x.status === 'published')).toHaveLength(1);
    expect(rows.filter((x) => x.status === 'superseded')).toHaveLength(1);
    for (const row of rows) {
      expect((await hashFile(path.join(UPLOADS, row.rel_path))).sha256).toBe(row.file_sha256);
      const first = JSON.parse(row.manifest_json)[0];
      const colour = nearestColour(frameColour(path.join(UPLOADS, row.rel_path), 0.5));
      expect(colour).toBe(COLOURS[ids.indexOf(first)][0]);
    }
  }, 120_000);
});
