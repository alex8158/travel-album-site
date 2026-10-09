/**
 * C2 (multi-user-system G-20) — tier slideshow exposure with sealed provenance.
 *
 * Authority: multi-user-system 需求 9 AC 4/5, AC 12–15; highlight-tier 需求 6 AC 9,
 * 需求 8 AC 2. AC 4 requesters (anonymous, or authenticated non-owner non-admin)
 * get a video only when its registered manifest's every source is currently public,
 * active and in the trip, and the file is intact — identically on public and
 * unlisted trips. Owner/admin read the category's unique published row; categories
 * with no registered row use the historical compatibility branch (bc9545a selection,
 * `tsa_*` excluded), checked here against an inline copy of the bc9545a algorithm
 * under deliberately unsorted directory orders.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';

vi.mock('../services/slideshowGenerator', () => ({ generateSlideshow: vi.fn() }));
vi.mock('../storage/factory', () => ({
  getStorageProvider: () => ({ downloadToTemp: async (p: string) => `/tmp/${p.replace(/\//g, '_')}` }),
}));

import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import { authMiddleware } from '../middleware/auth';
import highlightsRouter from './highlights';
import myRouter from './my';
import { generateSlideshow } from '../services/slideshowGenerator';
import { canonicalManifest, sha256Hex, buildArtifactRelPath } from '../services/tierSlideshowProvenance';

const realReaddirSync = fs.readdirSync;

const mockGenerate = vi.mocked(generateSlideshow);

const app = express();
app.use(express.json());
app.use(authMiddleware);
app.use('/api/trips', highlightsRouter);
app.use('/api/my', myRouter);

const UPLOADS = path.resolve(__dirname, '..', '..', 'uploads');
const tripIds: string[] = [];

type Kind = 'anonymous' | 'non-owner' | 'owner' | 'admin';

function createUser(role: 'admin' | 'regular' = 'regular') {
  const userId = uuidv4();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, 'hash', ?, 'active', ?, ?)`,
    )
    .run(userId, `u_${userId.slice(0, 8)}`, role, now, now);
  return { userId, token: signToken({ userId, role }) };
}

function createTrip(userId: string, visibility: string): string {
  const id = uuidv4();
  tripIds.push(id);
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at) VALUES (?, 't', ?, ?, ?, ?)`,
    )
    .run(id, visibility, userId, now, now);
  return id;
}

function createPhoto(tripId: string, visibility: 'public' | 'private', category = 'landscape'): string {
  const id = uuidv4();
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size,
       status, visibility, category, created_at)
     VALUES (?, ?, ?, 'image', 'image/jpeg', 'p.jpg', 1, 'active', ?, ?, ?)`,
  ).run(id, tripId, `${tripId}/originals/${id}.jpg`, visibility, category, now);
  db.prepare(
    `INSERT INTO highlight_results (id, trip_id, photo_id, is_highlight, is_highlight_tier, reason, batch_index, evaluated_at)
     VALUES (?, ?, ?, 1, 1, 'r', 0, ?)`,
  ).run(uuidv4(), tripId, id, now);
  return id;
}

/** Register an artifact exactly as the publish protocol does (file first, then rows). */
function seedArtifact(tripId: string, category: string, manifest: string[], bytes: string) {
  const id = uuidv4();
  const mj = canonicalManifest(manifest);
  const ms = sha256Hex(mj);
  const rel = buildArtifactRelPath(tripId, category, id, ms);
  const abs = path.join(UPLOADS, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE tier_slideshow_artifacts SET status='superseded' WHERE trip_id=? AND category=? AND status='published'`,
    ).run(tripId, category);
    db.prepare(
      `INSERT INTO tier_slideshow_artifacts (id, trip_id, category, status, manifest_json, source_count,
         manifest_sha256, file_sha256, file_size, rel_path, created_at)
       VALUES (?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, tripId, category, mj, manifest.length, ms, sha256Hex(bytes), Buffer.byteLength(bytes), rel,
      new Date().toISOString());
  }).immediate();
  return { id, rel, abs, url: `/api/trips/${tripId}/tier-slideshow/${category}/${path.basename(rel)}` };
}

function writeHistorical(tripId: string, relUnderTier: string, bytes: string) {
  const abs = path.join(UPLOADS, tripId, 'tier-slideshow', relUnderTier);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return abs;
}

function get(url: string, token?: string, raw = false) {
  let r = request(app).get(url);
  if (raw) r = r.responseType('blob');
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
}

const bodyText = (res: request.Response) => Buffer.from(res.body).toString('utf8');

function expectDenied(res: request.Response) {
  expect(res.status).toBe(404);
  expect(JSON.parse(bodyText(res))).toEqual({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
}

describe('C2 tier slideshow provenance — HTTP exposure', () => {
  let owner: { userId: string; token: string };
  let tokens: Record<Kind, string | undefined>;

  beforeEach(() => {
    const db = getDb();
    for (const t of ['highlight_results', 'similar_group_members', 'similar_groups', 'video_segments',
      'upload_sessions', 'media_tags', 'media_versions', 'media_analysis', 'duplicate_group_items',
      'ai_invocations', 'compile_jobs', 'slideshow_jobs', 'highlight_jobs', 'media_items',
      'duplicate_groups', 'trips', 'users']) {
      db.exec(`DELETE FROM ${t}`);
    }
    owner = createUser('regular');
    tokens = {
      anonymous: undefined,
      'non-owner': createUser('regular').token,
      owner: owner.token,
      admin: createUser('admin').token,
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDb();
    for (const id of tripIds.splice(0)) fs.rmSync(path.join(UPLOADS, id), { recursive: true, force: true });
  });

  for (const visibility of ['public', 'unlisted'] as const) {
    describe(`${visibility} trip — requester matrix`, () => {
      for (const kind of ['anonymous', 'non-owner', 'owner', 'admin'] as Kind[]) {
        const ac4 = kind === 'anonymous' || kind === 'non-owner';

        it(`${kind}: all-public manifest is ${ac4 ? 'listed and served' : 'listed and served (published row)'}`, async () => {
          const trip = createTrip(owner.userId, visibility);
          const a = createPhoto(trip, 'public');
          const b = createPhoto(trip, 'public');
          const art = seedArtifact(trip, 'landscape', [a, b], 'video-public');

          const list = await get(`/api/trips/${trip}/tier-photos`, tokens[kind]);
          expect(list.status).toBe(200);
          expect(list.body.slideshowUrls).toEqual({ landscape: art.url });

          const file = await get(art.url, tokens[kind], true);
          expect(file.status).toBe(200);
          expect(file.headers['content-type']).toBe('video/mp4');
          expect(bodyText(file)).toBe('video-public');

          const range = await get(art.url, tokens[kind], true).set('Range', 'bytes=0-4');
          expect(range.status).toBe(206);
          expect(bodyText(range)).toBe('video');
        });

        it(`${kind}: manifest with one private source is ${ac4 ? 'withheld (list {} / 404)' : 'still listed and served'}`, async () => {
          const trip = createTrip(owner.userId, visibility);
          const pub = createPhoto(trip, 'public');
          const priv = createPhoto(trip, 'private');
          const art = seedArtifact(trip, 'landscape', [pub, priv], 'video-private');

          const list = await get(`/api/trips/${trip}/tier-photos`, tokens[kind]);
          const file = await get(art.url, tokens[kind], true);
          if (ac4) {
            expect(list.body.slideshowUrls).toEqual({});
            expect(list.body.photos.map((p: { id: string }) => p.id)).toEqual([pub]); // G-19 unchanged
            expectDenied(file);
          } else {
            expect(list.body.slideshowUrls).toEqual({ landscape: art.url });
            expect(file.status).toBe(200);
            expect(bodyText(file)).toBe('video-private');
          }
        });
      }

      it('legacy root `all` and unregistered historical files are never listed or served to AC 4 requesters', async () => {
        const trip = createTrip(owner.userId, visibility);
        createPhoto(trip, 'public');
        writeHistorical(trip, 'legacy.mp4', 'legacy');
        writeHistorical(trip, 'people/slideshow_1700000000000.mp4', 'hist');

        for (const kind of ['anonymous', 'non-owner'] as Kind[]) {
          const list = await get(`/api/trips/${trip}/tier-photos`, tokens[kind]);
          expect(list.body.slideshowUrls).toEqual({});
          expectDenied(await get(`/api/trips/${trip}/tier-slideshow/legacy.mp4`, tokens[kind], true));
          expectDenied(await get(`/api/trips/${trip}/tier-slideshow/people/slideshow_1700000000000.mp4`, tokens[kind], true));
        }
        const asOwner = await get(`/api/trips/${trip}/tier-photos`, owner.token);
        expect(asOwner.body.slideshowUrls).toEqual({
          people: `/api/trips/${trip}/tier-slideshow/people/slideshow_1700000000000.mp4`,
          all: `/api/trips/${trip}/tier-slideshow/legacy.mp4`,
        });
      });
    });
  }

  describe('AC 13 — source state changes after publish stop AC 4 exposure', () => {
    async function publishedPublicArtifact() {
      const trip = createTrip(owner.userId, 'public');
      const a = createPhoto(trip, 'public');
      const b = createPhoto(trip, 'public');
      const art = seedArtifact(trip, 'landscape', [a, b], 'bytes');
      const before = await get(art.url, undefined, true);
      expect(before.status).toBe(200);
      return { trip, a, b, art };
    }

    it('source made private', async () => {
      const { trip, b, art } = await publishedPublicArtifact();
      getDb().prepare(`UPDATE media_items SET visibility='private' WHERE id=?`).run(b);
      expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({});
      expectDenied(await get(art.url, undefined, true));
      expect((await get(art.url, owner.token, true)).status).toBe(200);
    });

    it('source trashed', async () => {
      const { trip, a, art } = await publishedPublicArtifact();
      getDb().prepare(`UPDATE media_items SET status='trashed' WHERE id=?`).run(a);
      expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({});
      expectDenied(await get(art.url, undefined, true));
    });

    it('source permanently deleted', async () => {
      const { trip, a, art } = await publishedPublicArtifact();
      getDb().prepare(`DELETE FROM highlight_results WHERE photo_id=?`).run(a);
      getDb().prepare(`DELETE FROM media_items WHERE id=?`).run(a);
      expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({});
      expectDenied(await get(art.url, undefined, true));
    });

    it('source moved to another trip', async () => {
      const { trip, a, art } = await publishedPublicArtifact();
      const other = createTrip(owner.userId, 'public');
      getDb().prepare(`UPDATE media_items SET trip_id=? WHERE id=?`).run(other, a);
      expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({});
      expectDenied(await get(art.url, undefined, true));
    });

    it('same-size different bytes: full-hash mismatch withholds from AC 4 and from owner/admin', async () => {
      const { trip, art } = await publishedPublicArtifact();
      fs.writeFileSync(art.abs, 'BYTES'); // same length as 'bytes'
      expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({});
      expectDenied(await get(art.url, undefined, true));
      expectDenied(await get(art.url, undefined, true).set('Range', 'bytes=0-1'));
      // Published file corrupt: owner/admin get no fallback either.
      expect((await get(`/api/trips/${trip}/tier-photos`, owner.token)).body.slideshowUrls).toEqual({});
      expect((await get(`/api/trips/${trip}/tier-photos`, tokens.admin)).body.slideshowUrls).toEqual({});
      expect((await get(art.url, owner.token, true)).status).toBe(404);
    });

    it('serves from the verified descriptor: one open per request, stream bound to that fd', async () => {
      const { art } = await publishedPublicArtifact();
      const openSpy = vi.spyOn(fs, 'openSync');
      const streamSpy = vi.spyOn(fs, 'createReadStream');
      const res = await get(art.url, undefined, true).set('Range', 'bytes=1-3');
      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe('bytes 1-3/5');
      expect(bodyText(res)).toBe('yte');
      const opens = openSpy.mock.calls.filter(([p]) => String(p) === art.abs);
      expect(opens).toHaveLength(1);
      const fd = openSpy.mock.results[openSpy.mock.calls.findIndex(([p]) => String(p) === art.abs)].value;
      expect(streamSpy).toHaveBeenCalledTimes(1);
      expect(streamSpy.mock.calls[0][1]).toMatchObject({ fd, start: 1, end: 3 });
    });

    it('HEAD, open-ended and unsatisfiable ranges on a verified artifact', async () => {
      const { art } = await publishedPublicArtifact();
      const head = await request(app).head(art.url);
      expect(head.status).toBe(200);
      expect(head.headers['content-length']).toBe('5');
      const tail = await get(art.url, undefined, true).set('Range', 'bytes=2-');
      expect(tail.status).toBe(206);
      expect(bodyText(tail)).toBe('tes');
      const bad = await get(art.url, undefined, true).set('Range', 'bytes=9-12');
      expect(bad.status).toBe(416);
      expect(bad.headers['content-range']).toBe('bytes */5');
    });

    it('file truncated, replaced by a symlink, or missing', async () => {
      const { trip, art } = await publishedPublicArtifact();
      fs.writeFileSync(art.abs, 'x');
      expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({});
      expectDenied(await get(art.url, undefined, true));

      const target = path.join(path.dirname(art.abs), 'target.bin');
      fs.writeFileSync(target, 'bytes');
      fs.unlinkSync(art.abs);
      fs.symlinkSync(target, art.abs);
      expectDenied(await get(art.url, undefined, true));

      fs.unlinkSync(art.abs);
      expectDenied(await get(art.url, undefined, true));
      expect((await get(`/api/trips/${trip}/tier-photos`, owner.token)).body.slideshowUrls).toEqual({});
    });

    it('a trip visibility outside AC 7 grants no exposure', async () => {
      const { trip, art } = await publishedPublicArtifact();
      getDb().prepare(`UPDATE trips SET visibility='private' WHERE id=?`).run(trip);
      expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({});
      expectDenied(await get(art.url, undefined, true));
    });
  });

  describe('source identity (revision A): a deleted referenced source cannot come back', () => {
    const insertMedia = (id: string, tripId: string, verb = 'INSERT') =>
      getDb().prepare(
        `${verb} INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size,
           status, visibility, category, created_at)
         VALUES (?, ?, ?, 'image', 'image/jpeg', 'p.jpg', 1, 'active', 'public', 'landscape', ?)`,
      ).run(id, tripId, `${tripId}/originals/${id}.jpg`, new Date().toISOString());

    it('deleting the private source, then re-inserting its id as public, is refused; the video stays withheld', async () => {
      const trip = createTrip(owner.userId, 'public');
      const pub = createPhoto(trip, 'public');
      const priv = createPhoto(trip, 'private');
      const art = seedArtifact(trip, 'landscape', [pub, priv], 'baked-with-private');
      expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({});

      getDb().prepare('DELETE FROM highlight_results WHERE photo_id=?').run(priv);
      getDb().prepare('DELETE FROM media_items WHERE id=?').run(priv);
      for (const verb of ['INSERT', 'INSERT OR REPLACE', 'REPLACE', 'INSERT OR IGNORE']) {
        expect(() => insertMedia(priv, trip, verb)).toThrow(/sealed tier slideshow source/);
      }
      expect(() => getDb().prepare('UPDATE media_items SET id=? WHERE id=?').run(priv, pub)).toThrow(/re-keyed/);

      for (const kind of ['anonymous', 'non-owner'] as Kind[]) {
        expect((await get(`/api/trips/${trip}/tier-photos`, tokens[kind])).body.slideshowUrls).toEqual({});
        expectDenied(await get(art.url, tokens[kind], true));
      }
      // Owner rules: the sealed row and file are intact, so the owner still sees it.
      expect((await get(`/api/trips/${trip}/tier-photos`, owner.token)).body.slideshowUrls).toEqual({ landscape: art.url });
    });

    it('deleting a public source withholds the video from AC 4 for good (re-insert refused)', async () => {
      const trip = createTrip(owner.userId, 'unlisted');
      const a = createPhoto(trip, 'public');
      const b = createPhoto(trip, 'public');
      const art = seedArtifact(trip, 'landscape', [a, b], 'bytes');
      expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({ landscape: art.url });
      getDb().prepare('DELETE FROM highlight_results WHERE photo_id=?').run(b);
      getDb().prepare('DELETE FROM media_items WHERE id=?').run(b);
      expect(() => insertMedia(b, trip)).toThrow(/sealed tier slideshow source/);
      expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({});
      expectDenied(await get(art.url, undefined, true));
    });
  });

  describe('sealing counter-example (DELETE + INSERT replacing a private source)', () => {
    it('is refused by the database, and the artifact stays withheld', async () => {
      const trip = createTrip(owner.userId, 'public');
      const pub = createPhoto(trip, 'public');
      const priv = createPhoto(trip, 'private');
      const other = createPhoto(trip, 'public');
      const art = seedArtifact(trip, 'landscape', [pub, priv], 'baked-with-private');
      const db = getDb();

      expect(() =>
        db.transaction(() => {
          db.prepare('DELETE FROM tier_slideshow_artifacts WHERE id = ?').run(art.id);
          const mj = canonicalManifest([pub, other]);
          db.prepare(
            `INSERT INTO tier_slideshow_artifacts (id, trip_id, category, status, manifest_json, source_count,
               manifest_sha256, file_sha256, file_size, rel_path, created_at)
             VALUES (?, ?, 'landscape', 'published', ?, 2, ?, ?, ?, ?, 'now')`,
          ).run(art.id, trip, mj, sha256Hex(mj), sha256Hex('x'), 18, art.rel);
        })(),
      ).toThrow(/tsa:/);
      expect(() =>
        db.prepare(`UPDATE tier_slideshow_artifacts SET manifest_json = ? WHERE id = ?`)
          .run(canonicalManifest([pub, other]), art.id),
      ).toThrow(/sealed/);

      expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({});
      expectDenied(await get(art.url, undefined, true));
    });

    it('a well-formed new publish naming public sources cannot reuse the old file', async () => {
      const trip = createTrip(owner.userId, 'public');
      const pub = createPhoto(trip, 'public');
      const priv = createPhoto(trip, 'private');
      const other = createPhoto(trip, 'public');
      const art = seedArtifact(trip, 'landscape', [pub, priv], 'baked-with-private');
      // The protocol shape (supersede + insert) is allowed by the DB, but the new row's
      // file name is bound to its own id + manifest digest, so it points at no bytes.
      const db = getDb();
      const id = uuidv4();
      const mj = canonicalManifest([pub, other]);
      const ms = sha256Hex(mj);
      db.transaction(() => {
        db.prepare(`UPDATE tier_slideshow_artifacts SET status='superseded' WHERE id=?`).run(art.id);
        db.prepare(
          `INSERT INTO tier_slideshow_artifacts (id, trip_id, category, status, manifest_json, source_count,
             manifest_sha256, file_sha256, file_size, rel_path, created_at)
           VALUES (?, ?, 'landscape', 'published', ?, 2, ?, ?, ?, ?, 'now')`,
        ).run(id, trip, mj, ms, sha256Hex('baked-with-private'), 18, buildArtifactRelPath(trip, 'landscape', id, ms));
      })();
      expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({});
      expectDenied(await get(art.url, undefined, true));
      expectDenied(await get(`/api/trips/${trip}/tier-slideshow/landscape/${path.basename(buildArtifactRelPath(trip, 'landscape', id, ms))}`, undefined, true));
    });
  });

  describe('owner/admin version selection', () => {
    it('registered category: published row only — never historical files, superseded rows or orphans', async () => {
      const trip = createTrip(owner.userId, 'public');
      const a = createPhoto(trip, 'public');
      writeHistorical(trip, 'landscape/slideshow_1000000000000.mp4', 'old-hist'); // sorts first
      const first = seedArtifact(trip, 'landscape', [a], 'v1');
      const second = seedArtifact(trip, 'landscape', [a], 'v2');
      // Orphan C2-pattern file (linked, never registered) that sorts before `second`.
      writeHistorical(trip, `landscape/tsa_00000000-0000-4000-8000-000000000000_${'0'.repeat(64)}.mp4`, 'orphan');

      for (const token of [owner.token, tokens.admin]) {
        const list = await get(`/api/trips/${trip}/tier-photos`, token);
        expect(list.body.slideshowUrls).toEqual({ landscape: second.url });
      }
      const my = await get(`/api/my/trips/${trip}/tier-photos`, owner.token);
      expect(my.body.slideshowUrls).toEqual({ landscape: second.url });
      // AC 4 requester gets the same published row.
      expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({ landscape: second.url });
      // Superseded file stays directly fetchable while it passes the checks.
      expect(bodyText(await get(first.url, undefined, true))).toBe('v1');
      // Orphan C2-pattern file: 404 for everyone, owner included.
      const orphanUrl = `/api/trips/${trip}/tier-slideshow/landscape/tsa_00000000-0000-4000-8000-000000000000_${'0'.repeat(64)}.mp4`;
      expect((await get(orphanUrl, owner.token, true)).status).toBe(404);
      expectDenied(await get(orphanUrl, undefined, true));
    });

    /** bc9545a getTierSlideshowUrls, verbatim, over a listing with `tsa_*` names removed. */
    function bc9545aOracle(tripId: string): Record<string, string> {
      const noTsa = <T extends string | fs.Dirent>(xs: T[]) =>
        xs.filter((x) => !(typeof x === 'string' ? x : x.name).startsWith('tsa_'));
      const tierSlideshowDir = path.join(UPLOADS, tripId, 'tier-slideshow');
      const urls: Record<string, string> = {};
      if (!fs.existsSync(tierSlideshowDir)) return urls;
      try {
        const entries = noTsa(fs.readdirSync(tierSlideshowDir, { withFileTypes: true }));
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const catDir = path.join(tierSlideshowDir, entry.name);
            const catFiles = noTsa(fs.readdirSync(catDir));
            const mp4File = catFiles.find((f) => f.endsWith('.mp4'));
            if (mp4File) urls[entry.name] = `/api/trips/${tripId}/tier-slideshow/${entry.name}/${mp4File}`;
          } else if (entry.isFile() && entry.name.endsWith('.mp4')) {
            urls['all'] = `/api/trips/${tripId}/tier-slideshow/${entry.name}`;
          }
        }
      } catch {
        // Directory not readable
      }
      return urls;
    }

    /** Make fs.readdirSync return this trip's tier-slideshow listings in a fixed, unsorted order. */
    function scrambleReaddir(tripId: string, salt: string) {
      const root = path.join(UPLOADS, tripId, 'tier-slideshow');
      const key = (n: string) => crypto.createHash('sha256').update(salt + n).digest('hex');
      vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, opts?: unknown) => {
        const out = (realReaddirSync as (p: fs.PathLike, o?: unknown) => Array<string | fs.Dirent>)(p, opts);
        if (!String(p).startsWith(root)) return out;
        const name = (x: string | fs.Dirent) => (typeof x === 'string' ? x : x.name);
        return out.slice().sort((x, y) => (key(name(x)) < key(name(y)) ? -1 : 1));
      }) as typeof fs.readdirSync);
    }

    it('unregistered categories: exactly the bc9545a selection (minus tsa_*) under unsorted readdir orders', async () => {
      const trip = createTrip(owner.userId, 'unlisted');
      const tsa = (n: number) => `tsa_00000000-0000-4000-8000-00000000000${n}_${String(n).repeat(64)}.mp4`;
      writeHistorical(trip, 'animal/slideshow_1700000000001.mp4', 'a1');
      writeHistorical(trip, 'animal/slideshow_1700000000002.mp4', 'a2');
      writeHistorical(trip, 'animal/slideshow_1700000000003.mp4', 'a3');
      writeHistorical(trip, 'animal/slideshow_silent_1500000000000.mp4', '');
      writeHistorical(trip, `animal/${tsa(1)}`, 'orphan');
      writeHistorical(trip, 'animal/notes.txt', 'x');
      writeHistorical(trip, 'people/slideshow_silent_1800000000000.mp4', ''); // silent is NOT filtered
      writeHistorical(trip, `people/${tsa(2)}`, 'orphan');
      writeHistorical(trip, `other/${tsa(3)}`, 'orphan'); // only tsa → omitted
      writeHistorical(trip, 'legacy_a.mp4', 'la');
      writeHistorical(trip, 'legacy_b.mp4', 'lb');
      writeHistorical(trip, 'legacy_c.mp4', 'lc');
      writeHistorical(trip, tsa(4), 'root-orphan');
      // A registered category next to them: published row only, regardless of order.
      const p = createPhoto(trip, 'public');
      writeHistorical(trip, 'landscape/slideshow_1000000000000.mp4', 'hist');
      seedArtifact(trip, 'landscape', [p], 'v1');
      const published = seedArtifact(trip, 'landscape', [p], 'v2');

      const seen: Array<Record<string, string>> = [];
      for (const salt of ['order-1', 'order-2', 'order-3']) {
        vi.restoreAllMocks();
        scrambleReaddir(trip, salt);
        const listing = realReaddirSync(path.join(UPLOADS, trip, 'tier-slideshow', 'animal')).sort();
        const scrambled = fs.readdirSync(path.join(UPLOADS, trip, 'tier-slideshow', 'animal')) as string[];
        expect(scrambled.slice().sort()).toEqual(listing); // same names ...
        const oracle = { ...bc9545aOracle(trip), landscape: published.url };
        for (const token of [owner.token, tokens.admin]) {
          expect((await get(`/api/trips/${trip}/tier-photos`, token)).body.slideshowUrls).toEqual(oracle);
        }
        expect((await get(`/api/my/trips/${trip}/tier-photos`, owner.token)).body.slideshowUrls).toEqual(oracle);
        expect(oracle.people).toBe(`/api/trips/${trip}/tier-slideshow/people/slideshow_silent_1800000000000.mp4`);
        expect(oracle).not.toHaveProperty('other');
        expect(Object.values(oracle).some((u) => u.includes('/tsa_') && u !== published.url)).toBe(false);
        // AC 4 requesters never see historical files or `all`.
        expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({ landscape: published.url });
        seen.push(oracle);
      }
      // ... in orders that actually change the bc9545a outcome, so a sorted listing could not pass by luck.
      expect(new Set(seen.map((o) => `${o.animal}|${o.all}`)).size).toBeGreaterThan(1);
      const sortedPick = { animal: `/api/trips/${trip}/tier-slideshow/animal/slideshow_1700000000001.mp4`, all: `/api/trips/${trip}/tier-slideshow/legacy_a.mp4` };
      expect(seen.some((o) => o.animal !== sortedPick.animal || o.all !== sortedPick.all)).toBe(true);
    });

    it('registered category with a missing published file: owner/admin get nothing, no fallback to history', async () => {
      const trip = createTrip(owner.userId, 'public');
      const p = createPhoto(trip, 'public');
      writeHistorical(trip, 'landscape/slideshow_1700000000000.mp4', 'hist');
      const art = seedArtifact(trip, 'landscape', [p], 'v1');
      fs.unlinkSync(art.abs);
      for (const token of [owner.token, tokens.admin]) {
        expect((await get(`/api/trips/${trip}/tier-photos`, token)).body.slideshowUrls).toEqual({});
      }
      expect((await get(`/api/my/trips/${trip}/tier-photos`, owner.token)).body.slideshowUrls).toEqual({});
    });

    it('a C2-pattern name in the legacy root is never served, not even to the owner', async () => {
      const trip = createTrip(owner.userId, 'public');
      const name = `tsa_00000000-0000-4000-8000-000000000003_${'3'.repeat(64)}.mp4`;
      writeHistorical(trip, name, 'root-orphan');
      expect((await get(`/api/trips/${trip}/tier-slideshow/${name}`, owner.token, true)).status).toBe(404);
      expect((await get(`/api/trips/${trip}/tier-photos`, owner.token)).body.slideshowUrls).toEqual({});
    });
  });

  describe('end to end through regenerate', () => {
    it('publishes a provenance row; AC 4 sees it only while every baked source is public', async () => {
      const trip = createTrip(owner.userId, 'unlisted');
      const ids = Array.from({ length: 6 }, () => createPhoto(trip, 'public', 'people'));
      mockGenerate.mockImplementation(async (opts: { outputDir: string; photoPaths: string[] }) => {
        fs.mkdirSync(opts.outputDir, { recursive: true });
        const out = path.join(opts.outputDir, 'slideshow_1.mp4');
        fs.writeFileSync(out, 'regen-bytes');
        // Index 2 unreadable: it must not enter the manifest.
        return { success: true, outputPath: out, totalDuration: 15, skippedPhotos: [2] };
      });

      const regen = await request(app)
        .post(`/api/my/trips/${trip}/tier-slideshow/regenerate`)
        .set('Authorization', `Bearer ${owner.token}`);
      expect(regen.status).toBe(200);
      const url = regen.body.slideshowUrls.people as string;
      expect(url).toMatch(/\/tier-slideshow\/people\/tsa_[0-9a-f-]{36}_[0-9a-f]{64}\.mp4$/);

      const row = getDb().prepare(`SELECT * FROM tier_slideshow_artifacts WHERE trip_id=?`).get(trip) as {
        manifest_json: string; status: string; file_sha256: string; rel_path: string;
      };
      // Manifest = generator input order (the regenerate query's order), minus index 2.
      const handed = (mockGenerate.mock.calls[0]![0] as { photoPaths: string[] }).photoPaths
        .map((p) => ids.find((id) => p.includes(id))!);
      expect(handed.slice().sort()).toEqual(ids.slice().sort());
      expect(JSON.parse(row.manifest_json)).toEqual(handed.filter((_, i) => i !== 2));
      expect(row.status).toBe('published');
      expect(row.file_sha256).toBe(crypto.createHash('sha256').update('regen-bytes').digest('hex'));
      // Staged name is gone; nothing left in staging but empty dirs.
      const stagingRoot = path.join(UPLOADS, trip, '.tier-staging');
      const leftovers: string[] = [];
      const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else leftovers.push(p); } };
      walk(stagingRoot);
      expect(leftovers).toEqual([]);

      expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({ people: url });
      expect(bodyText(await get(url, undefined, true))).toBe('regen-bytes');

      // The skipped photo turning private does not matter (it is not baked in) ...
      getDb().prepare(`UPDATE media_items SET visibility='private' WHERE id=?`).run(handed[2]);
      expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({ people: url });
      // ... a baked one does.
      getDb().prepare(`UPDATE media_items SET visibility='private' WHERE id=?`).run(handed[3]);
      expect((await get(`/api/trips/${trip}/tier-photos`)).body.slideshowUrls).toEqual({});
      expectDenied(await get(url, undefined, true));
    });

    it('legit trip delete cascades provenance rows and leaves files in place (no file deletion)', async () => {
      const trip = createTrip(owner.userId, 'public');
      const a = createPhoto(trip, 'public');
      const art = seedArtifact(trip, 'landscape', [a], 'bytes');
      const db = getDb();
      db.prepare('DELETE FROM highlight_results WHERE trip_id=?').run(trip);
      db.prepare('DELETE FROM media_items WHERE trip_id=?').run(trip);
      db.prepare('DELETE FROM trips WHERE id=?').run(trip);
      expect(db.prepare('SELECT count(*) n FROM tier_slideshow_artifacts WHERE trip_id=?').get(trip)).toEqual({ n: 0 });
      expect(fs.existsSync(art.abs)).toBe(true);
      expect((await get(art.url, owner.token, true)).status).toBe(404);
    });
  });
});
