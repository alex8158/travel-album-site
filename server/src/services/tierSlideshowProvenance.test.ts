/**
 * C2 publish protocol (multi-user-system G-20): generator output → exclusive candidate
 * copy (new inode, 0444, fsync, hash) → link (no overwrite) → unlink candidate →
 * re-hash final → IMMEDIATE supersede+insert. Failure at any step must leave the
 * previously published row untouched and register nothing; files that were already
 * published are never deleted or overwritten.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as realUuid } from 'uuid';

const { nextIds } = vi.hoisted(() => ({ nextIds: [] as string[] }));
vi.mock('uuid', async (orig) => {
  const actual = (await orig()) as typeof import('uuid');
  return { ...actual, v4: () => nextIds.shift() ?? actual.v4() };
});
vi.mock('./slideshowGenerator', () => ({ generateSlideshow: vi.fn() }));

import { getDb, closeDb } from '../database';
import { generateSlideshow } from './slideshowGenerator';
import { publishTierSlideshow, buildArtifactRelPath, canonicalManifest, sha256Hex } from './tierSlideshowProvenance';

const mockGenerate = vi.mocked(generateSlideshow);
const UPLOADS = path.resolve(__dirname, '..', '..', 'uploads');
const trips: string[] = [];
const openFds: number[] = [];

function seed(visibility = 'public') {
  const db = getDb();
  const userId = realUuid();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
              VALUES (?, ?, 'h', 'regular', 'active', ?, ?)`).run(userId, `u_${userId.slice(0, 8)}`, now, now);
  const tripId = realUuid();
  trips.push(tripId);
  db.prepare(`INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at) VALUES (?, 't', ?, ?, ?, ?)`)
    .run(tripId, visibility, userId, now, now);
  const ids = Array.from({ length: 4 }, () => {
    const id = realUuid();
    db.prepare(`INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename,
                  file_size, status, visibility, category, created_at)
                VALUES (?, ?, ?, 'image', 'image/jpeg', 'p.jpg', 1, 'active', 'public', 'animal', ?)`)
      .run(id, tripId, `${tripId}/originals/${id}.jpg`, now);
    return id;
  });
  return { tripId, ids, sources: ids.map((id) => ({ mediaId: id, localPath: `/nowhere/${id}.jpg` })) };
}

/** Mock generator: writes `bytes` to the staging outputDir; optionally keeps a writable fd open on it. */
function generatorWrites(bytes: string, skipped: number[] = [], keep?: { fd?: number; out?: string }) {
  mockGenerate.mockImplementation(async (opts: { outputDir: string }) => {
    fs.mkdirSync(opts.outputDir, { recursive: true });
    const out = path.join(opts.outputDir, `slideshow_${Date.now()}.mp4`);
    fs.writeFileSync(out, bytes);
    if (keep) {
      keep.fd = fs.openSync(out, 'r+'); // a writer that outlives the generator's return
      keep.out = out;
      openFds.push(keep.fd);
    }
    return { success: true, outputPath: out, totalDuration: 6, skippedPhotos: skipped };
  });
}

const rows = (tripId: string) =>
  getDb().prepare(`SELECT id, status, rel_path, file_sha256, file_size FROM tier_slideshow_artifacts WHERE trip_id=? ORDER BY created_at, id`)
    .all(tripId) as Array<{ id: string; status: string; rel_path: string; file_sha256: string; file_size: number }>;

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p)); else out.push(p);
  }
  return out;
}

describe('publishTierSlideshow — protocol and failure recovery', () => {
  beforeEach(() => {
    const db = getDb();
    for (const t of ['highlight_results', 'similar_group_members', 'similar_groups', 'video_segments',
      'upload_sessions', 'media_tags', 'media_versions', 'media_analysis', 'duplicate_group_items',
      'ai_invocations', 'compile_jobs', 'slideshow_jobs', 'highlight_jobs', 'media_items',
      'duplicate_groups', 'trips', 'users']) {
      db.exec(`DELETE FROM ${t}`);
    }
    vi.clearAllMocks();
    nextIds.length = 0;
  });
  afterEach(() => {
    for (const fd of openFds.splice(0)) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    closeDb();
    for (const t of trips.splice(0)) fs.rmSync(path.join(UPLOADS, t), { recursive: true, force: true });
  });

  async function publishV1(s: ReturnType<typeof seed>) {
    generatorWrites('v1');
    const r = await publishTierSlideshow({ tripId: s.tripId, category: 'animal', sources: s.sources, photoDuration: 3 });
    expect(r.ok).toBe(true);
    return r as Extract<typeof r, { ok: true }>;
  }

  it('publishes a separate read-only inode; candidate and generator output are gone; manifest excludes skipped indices', async () => {
    const s = seed();
    let stagedIno = -1;
    let candidateIno = -1;
    generatorWrites('video-bytes', [0, 3]);
    const r = await publishTierSlideshow({
      tripId: s.tripId, category: 'animal', sources: s.sources, photoDuration: 3,
      testHooks: { afterCopy: ({ staged, candidate }) => { stagedIno = fs.statSync(staged).ino; candidateIno = fs.statSync(candidate).ino; } },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.manifest).toEqual([s.ids[1], s.ids[2]]);
    expect(r.skippedMediaIds).toEqual([s.ids[0], s.ids[3]]);
    expect(r.relPath).toBe(buildArtifactRelPath(s.tripId, 'animal', r.artifactId, sha256Hex(canonicalManifest(r.manifest))));
    const final = path.join(UPLOADS, r.relPath);
    expect(fs.readFileSync(final, 'utf8')).toBe('video-bytes');
    expect(r.fileSha256).toBe(sha256Hex('video-bytes'));
    const st = fs.statSync(final);
    expect(st.ino).toBe(candidateIno);
    expect(st.ino).not.toBe(stagedIno);
    expect(st.nlink).toBe(1);
    expect(st.mode & 0o777).toBe(0o444);
    expect(filesUnder(path.join(UPLOADS, s.tripId, '.tier-staging'))).toEqual([]);
  });

  it('a writable fd held on the generator output cannot change the published bytes (same-size overwrite after commit)', async () => {
    const s = seed();
    const keep: { fd?: number; out?: string } = {};
    generatorWrites('ORIGINAL-BYTES', [], keep);
    const r = await publishTierSlideshow({
      tripId: s.tripId, category: 'animal', sources: s.sources, photoDuration: 3,
      testHooks: {
        // Also write through the fd inside the protocol windows: after copy and after link.
        afterCopy: () => { fs.writeSync(keep.fd!, Buffer.from('X'), 0, 1, 0); },
        afterLink: () => { fs.writeSync(keep.fd!, Buffer.from('Y'), 0, 1, 1); },
      },
    });
    if (!r.ok) throw new Error(r.error);
    // After commit: same-size, different bytes through the lingering fd.
    const n = fs.writeSync(keep.fd!, Buffer.from('TAMPERED-BYTES'), 0, 14, 0);
    expect(n).toBe(14);
    fs.fsyncSync(keep.fd!);
    const final = path.join(UPLOADS, r.relPath);
    expect(fs.readFileSync(final, 'utf8')).toBe('ORIGINAL-BYTES');
    expect(rows(s.tripId)).toEqual([expect.objectContaining({ status: 'published', file_sha256: sha256Hex('ORIGINAL-BYTES'), file_size: 14 })]);
    expect(fs.fstatSync(keep.fd!).ino).not.toBe(fs.statSync(final).ino);
  });

  it('writing to the generator output path after the copy cannot reach the published inode', async () => {
    const s = seed();
    generatorWrites('v1');
    const r = await publishTierSlideshow({
      tripId: s.tripId, category: 'animal', sources: s.sources, photoDuration: 3,
      testHooks: { afterCopy: ({ staged }) => fs.appendFileSync(staged, '-tampered') },
    });
    if (!r.ok) throw new Error(r.error);
    expect(fs.readFileSync(path.join(UPLOADS, r.relPath), 'utf8')).toBe('v1');
  });

  it.runIf(typeof process.getuid === 'function' && process.getuid() !== 0)(
    'the sealed candidate cannot be opened for writing by path', async () => {
      const s = seed();
      generatorWrites('v1');
      let err: NodeJS.ErrnoException | null = null;
      const r = await publishTierSlideshow({
        tripId: s.tripId, category: 'animal', sources: s.sources, photoDuration: 3,
        testHooks: { afterLink: ({ final }) => { try { fs.openSync(final, 'r+'); } catch (e) { err = e as NodeJS.ErrnoException; } } },
      });
      expect(r.ok).toBe(true);
      expect(err).not.toBeNull();
      expect((err as unknown as NodeJS.ErrnoException).code).toBe('EACCES');
    });

  it('second publish supersedes the first; the first file is untouched', async () => {
    const s = seed();
    const v1 = await publishV1(s);
    generatorWrites('v2');
    const v2 = await publishTierSlideshow({ tripId: s.tripId, category: 'animal', sources: s.sources.slice(1), photoDuration: 3 });
    expect(v2.ok).toBe(true);
    expect(rows(s.tripId).map((r) => [r.id, r.status])).toEqual([[v1.artifactId, 'superseded'], [(v2 as { artifactId: string }).artifactId, 'published']]);
    expect(fs.readFileSync(path.join(UPLOADS, v1.relPath), 'utf8')).toBe('v1');
  });

  it('EEXIST at link fails closed and never overwrites the existing file', async () => {
    const s = seed();
    const fixed = realUuid();
    const mj = canonicalManifest(s.ids);
    const final = path.join(UPLOADS, buildArtifactRelPath(s.tripId, 'animal', fixed, sha256Hex(mj)));
    fs.mkdirSync(path.dirname(final), { recursive: true });
    fs.writeFileSync(final, 'pre-existing');
    nextIds.push(fixed);
    generatorWrites('new-bytes');
    const r = await publishTierSlideshow({ tripId: s.tripId, category: 'animal', sources: s.sources, photoDuration: 3 });
    expect(r).toMatchObject({ ok: false, stage: 'link' });
    expect(fs.readFileSync(final, 'utf8')).toBe('pre-existing');
    expect(rows(s.tripId)).toEqual([]);
  });

  it('a write to the published inode before registration is caught by the re-hash', async () => {
    const s = seed();
    const v1 = await publishV1(s);
    generatorWrites('v2');
    const r = await publishTierSlideshow({
      tripId: s.tripId, category: 'animal', sources: s.sources, photoDuration: 3,
      testHooks: { afterUnlink: ({ final }) => { fs.chmodSync(final, 0o644); fs.appendFileSync(final, '-tampered'); } },
    });
    expect(r).toMatchObject({ ok: false, stage: 'verify' });
    expect(rows(s.tripId).map((x) => [x.id, x.status])).toEqual([[v1.artifactId, 'published']]);
  });

  it('an extra hard link to the published inode before registration fails closed', async () => {
    const s = seed();
    generatorWrites('v1');
    const r = await publishTierSlideshow({
      tripId: s.tripId, category: 'animal', sources: s.sources, photoDuration: 3,
      testHooks: { afterUnlink: ({ final }) => fs.linkSync(final, `${final}.extra`) },
    });
    expect(r).toMatchObject({ ok: false, stage: 'verify' });
    expect(rows(s.tripId)).toEqual([]);
  });

  it('transaction failure rolls back the supersede; the old row stays published; the new file is an unregistered orphan', async () => {
    const s = seed();
    const v1 = await publishV1(s);
    generatorWrites('v2');
    const r = await publishTierSlideshow({
      tripId: s.tripId, category: 'animal', sources: s.sources, photoDuration: 3,
      testHooks: { inTransaction: () => { throw new Error('injected'); } },
    });
    expect(r).toMatchObject({ ok: false, stage: 'register', error: 'injected' });
    expect(rows(s.tripId).map((x) => [x.id, x.status])).toEqual([[v1.artifactId, 'published']]);
    const dir = path.join(UPLOADS, s.tripId, 'tier-slideshow', 'animal');
    expect(fs.readdirSync(dir).length).toBe(2); // v1 + orphan, nothing deleted
    expect(fs.readFileSync(path.join(UPLOADS, v1.relPath), 'utf8')).toBe('v1');
  });

  it('a source deleted between generation and registration is refused by the insert trigger', async () => {
    const s = seed();
    const v1 = await publishV1(s);
    mockGenerate.mockImplementation(async (opts: { outputDir: string }) => {
      fs.mkdirSync(opts.outputDir, { recursive: true });
      const out = path.join(opts.outputDir, 'slideshow_2.mp4');
      fs.writeFileSync(out, 'v2');
      getDb().prepare('DELETE FROM media_items WHERE id=?').run(s.ids[0]);
      return { success: true, outputPath: out, totalDuration: 6, skippedPhotos: [] };
    });
    const r = await publishTierSlideshow({ tripId: s.tripId, category: 'animal', sources: s.sources, photoDuration: 3 });
    expect(r).toMatchObject({ ok: false, stage: 'register' });
    expect((r as { error: string }).error).toMatch(/manifest source missing/);
    expect(rows(s.tripId).map((x) => [x.id, x.status])).toEqual([[v1.artifactId, 'published']]);
  });

  it('rejects generator output outside the staging dir, out-of-range skip indices, all-skipped and empty output', async () => {
    const s = seed();
    mockGenerate.mockResolvedValueOnce({ success: true, outputPath: '/etc/hosts', totalDuration: 1, skippedPhotos: [] });
    expect(await publishTierSlideshow({ tripId: s.tripId, category: 'animal', sources: s.sources, photoDuration: 3 }))
      .toMatchObject({ ok: false, stage: 'stage' });
    generatorWrites('x', [9]);
    expect(await publishTierSlideshow({ tripId: s.tripId, category: 'animal', sources: s.sources, photoDuration: 3 }))
      .toMatchObject({ ok: false, stage: 'stage' });
    generatorWrites('x', [0, 1, 2, 3]);
    expect(await publishTierSlideshow({ tripId: s.tripId, category: 'animal', sources: s.sources, photoDuration: 3 }))
      .toMatchObject({ ok: false, stage: 'stage' });
    generatorWrites('');
    expect(await publishTierSlideshow({ tripId: s.tripId, category: 'animal', sources: s.sources, photoDuration: 3 }))
      .toMatchObject({ ok: false, stage: 'copy', error: '生成结果为空文件' });
    mockGenerate.mockResolvedValueOnce({ success: false, outputPath: null, totalDuration: 0, skippedPhotos: [], error: 'ffmpeg 处理失败' });
    expect(await publishTierSlideshow({ tripId: s.tripId, category: 'animal', sources: s.sources, photoDuration: 3 }))
      .toMatchObject({ ok: false, stage: 'generate', error: 'ffmpeg 处理失败' });
    expect(rows(s.tripId)).toEqual([]);
  });
});
