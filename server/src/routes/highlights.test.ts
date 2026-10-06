/**
 * Media-level visibility on the public highlight/tier photo endpoints, plus the
 * tier slideshow exposure rule.
 *
 * - G-19: highlight/tier membership must not override `media_items.visibility`
 *   for anonymous or non-owner callers.
 * - Tier slideshow (C1): files carry no source-media provenance (G-20), so per
 *   multi-user-system 需求 9 AC 12–15 / highlight-tier 需求 6 AC 9 they are not
 *   exposed to non-owner, non-admin requesters on any trip. Fail-closed
 *   transitional state; owner/admin access unchanged (需求 9 AC 5).
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import { authMiddleware } from '../middleware/auth';
import highlightsRouter from './highlights';

const app = express();
app.use(express.json());
app.use(authMiddleware);
app.use('/api/trips', highlightsRouter);

function createTestUser(role: 'admin' | 'regular' = 'regular'): { userId: string; token: string } {
  const db = getDb();
  const userId = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).run(userId, `user_${userId.slice(0, 8)}`, 'hash', role, now, now);
  return { userId, token: signToken({ userId, role }) };
}

function createTrip(userId: string, visibility: 'public' | 'unlisted'): string {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO trips (id, title, description, visibility, user_id, created_at, updated_at)
     VALUES (?, 'Test Trip', NULL, ?, ?, ?, ?)`,
  ).run(id, visibility, userId, now, now);
  return id;
}

/** Create an active image and mark it as highlight, optionally also as tier. */
function createHighlightPhoto(
  tripId: string,
  opts: { visibility: 'public' | 'private'; tier?: boolean },
): string {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, file_path, media_type, mime_type, original_filename, file_size,
        status, visibility, category, created_at)
     VALUES (?, ?, ?, 'image', 'image/jpeg', ?, 1024, 'active', ?, 'landscape', ?)`,
  ).run(id, tripId, `${tripId}/originals/${id}.jpg`, `${id}.jpg`, opts.visibility, now);
  db.prepare(
    `INSERT INTO highlight_results
       (id, trip_id, photo_id, is_highlight, is_highlight_tier, reason, batch_index, evaluated_at)
     VALUES (?, ?, ?, 1, ?, 'nice', 0, ?)`,
  ).run(uuidv4(), tripId, id, opts.tier ? 1 : 0, now);
  return id;
}

function idsOf(body: { photos: Array<{ id: string }> }): string[] {
  return body.photos.map((p) => p.id);
}

/**
 * Write a real tier slideshow artifact — `getTierSlideshowUrls` discovers these
 * by scanning the filesystem, not the database, so without a real file any
 * assertion about slideshow URLs would hold for the wrong reason.
 * Returns the trip directory so the test can remove it.
 */
function writeTierSlideshowArtifact(tripId: string, category: string): string {
  const uploadsBase = path.resolve(__dirname, '..', '..', 'uploads');
  const tripDir = path.join(uploadsBase, tripId);
  fs.mkdirSync(path.join(tripDir, 'tier-slideshow', category), { recursive: true });
  fs.writeFileSync(path.join(tripDir, 'tier-slideshow', category, 'tier.mp4'), 'stub');
  return tripDir;
}

/** Write a legacy root-level tier slideshow (`tier-slideshow/legacy.mp4`, key `all`). */
function writeLegacyTierSlideshowArtifact(tripId: string, content: string): string {
  const uploadsBase = path.resolve(__dirname, '..', '..', 'uploads');
  const tripDir = path.join(uploadsBase, tripId);
  fs.mkdirSync(path.join(tripDir, 'tier-slideshow'), { recursive: true });
  fs.writeFileSync(path.join(tripDir, 'tier-slideshow', 'legacy.mp4'), content);
  return tripDir;
}

type RequesterKind = 'anonymous' | 'non-owner' | 'owner' | 'admin';

/** GET with an optional bearer token; video bodies are read as raw bytes. */
function getAs(url: string, token: string | undefined, raw = false) {
  let req = request(app).get(url);
  if (raw) req = req.responseType('blob');
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
}

describe('highlight/tier photo endpoints — media-level visibility (G-19)', () => {
  let owner: { userId: string; token: string };

  beforeEach(() => {
    const db = getDb();
    // These suites share one SQLite file, so every table referencing trips must
    // be cleared before trips itself. Mirrors myRegenerate.test.ts.
    db.exec('DELETE FROM highlight_results');
    db.exec('DELETE FROM similar_group_members');
    db.exec('DELETE FROM similar_groups');
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM upload_sessions');
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM media_versions');
    db.exec('DELETE FROM media_analysis');
    db.exec('DELETE FROM duplicate_group_items');
    db.exec('DELETE FROM ai_invocations');
    db.exec('DELETE FROM compile_jobs');
    db.exec('DELETE FROM slideshow_jobs');
    db.exec('DELETE FROM highlight_jobs');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');
    db.exec('DELETE FROM users');
    owner = createTestUser('regular');
  });

  afterEach(() => {
    closeDb();
  });

  describe('anonymous caller on a public trip', () => {
    it('excludes private photos from the highlight list', async () => {
      const tripId = createTrip(owner.userId, 'public');
      const publicId = createHighlightPhoto(tripId, { visibility: 'public' });
      const privateId = createHighlightPhoto(tripId, { visibility: 'private' });

      const res = await request(app).get(`/api/trips/${tripId}/highlight-photos`);
      expect(res.status).toBe(200);
      expect(idsOf(res.body)).toEqual([publicId]);
      // A leaked id is enough to fetch the file: the mediaServing routes perform
      // no visibility check of their own, so the id must not appear at all.
      expect(JSON.stringify(res.body)).not.toContain(privateId);
    });

    it('excludes private photos from the tier list', async () => {
      const tripId = createTrip(owner.userId, 'public');
      const publicId = createHighlightPhoto(tripId, { visibility: 'public', tier: true });
      const privateId = createHighlightPhoto(tripId, { visibility: 'private', tier: true });

      const res = await request(app).get(`/api/trips/${tripId}/tier-photos`);
      expect(res.status).toBe(200);
      expect(idsOf(res.body)).toEqual([publicId]);
      expect(JSON.stringify(res.body)).not.toContain(privateId);
    });

    it('still returns public highlight and tier photos with their media URLs', async () => {
      const tripId = createTrip(owner.userId, 'public');
      const publicId = createHighlightPhoto(tripId, { visibility: 'public', tier: true });

      const highlights = await request(app).get(`/api/trips/${tripId}/highlight-photos`);
      expect(highlights.status).toBe(200);
      expect(idsOf(highlights.body)).toEqual([publicId]);
      expect(highlights.body.photos[0].thumbnailUrl).toBe(`/api/media/${publicId}/thumbnail`);
      expect(highlights.body.photos[0].originalUrl).toBe(`/api/media/${publicId}/original`);

      const tier = await request(app).get(`/api/trips/${tripId}/tier-photos`);
      expect(tier.status).toBe(200);
      expect(idsOf(tier.body)).toEqual([publicId]);
    });

    it('returns an empty list when every highlight photo is private', async () => {
      const tripId = createTrip(owner.userId, 'public');
      const privateId = createHighlightPhoto(tripId, { visibility: 'private', tier: true });

      const highlights = await request(app).get(`/api/trips/${tripId}/highlight-photos`);
      expect(highlights.status).toBe(200);
      expect(idsOf(highlights.body)).toEqual([]);
      expect(JSON.stringify(highlights.body)).not.toContain(privateId);

      const tier = await request(app).get(`/api/trips/${tripId}/tier-photos`);
      expect(tier.status).toBe(200);
      expect(idsOf(tier.body)).toEqual([]);
    });
  });

  describe('authenticated non-owner on a public trip', () => {
    it('is filtered the same way as an anonymous caller', async () => {
      const tripId = createTrip(owner.userId, 'public');
      const publicId = createHighlightPhoto(tripId, { visibility: 'public', tier: true });
      const privateId = createHighlightPhoto(tripId, { visibility: 'private', tier: true });
      const stranger = createTestUser('regular');

      const res = await request(app)
        .get(`/api/trips/${tripId}/tier-photos`)
        .set('Authorization', `Bearer ${stranger.token}`);
      expect(res.status).toBe(200);
      expect(idsOf(res.body)).toEqual([publicId]);
      expect(JSON.stringify(res.body)).not.toContain(privateId);
    });
  });

  describe('owner and admin', () => {
    it('returns private highlight and tier photos to the owner', async () => {
      const tripId = createTrip(owner.userId, 'public');
      const publicId = createHighlightPhoto(tripId, { visibility: 'public', tier: true });
      const privateId = createHighlightPhoto(tripId, { visibility: 'private', tier: true });

      const highlights = await request(app)
        .get(`/api/trips/${tripId}/highlight-photos`)
        .set('Authorization', `Bearer ${owner.token}`);
      expect(highlights.status).toBe(200);
      expect(idsOf(highlights.body).sort()).toEqual([publicId, privateId].sort());

      const tier = await request(app)
        .get(`/api/trips/${tripId}/tier-photos`)
        .set('Authorization', `Bearer ${owner.token}`);
      expect(tier.status).toBe(200);
      expect(idsOf(tier.body).sort()).toEqual([publicId, privateId].sort());
    });

    it('returns private tier photos to an admin', async () => {
      const tripId = createTrip(owner.userId, 'public');
      const publicId = createHighlightPhoto(tripId, { visibility: 'public', tier: true });
      const privateId = createHighlightPhoto(tripId, { visibility: 'private', tier: true });
      const admin = createTestUser('admin');

      const res = await request(app)
        .get(`/api/trips/${tripId}/tier-photos`)
        .set('Authorization', `Bearer ${admin.token}`);
      expect(res.status).toBe(200);
      expect(idsOf(res.body).sort()).toEqual([publicId, privateId].sort());
    });
  });

  // `trips.visibility` controls discovery, not direct-link access. An `unlisted` trip
  // is absent from public listings but remains reachable by whoever holds its id; the
  // response is then narrowed per media, not per trip.
  // Authority: multi-user-system 需求 9 AC 9–11 + AC 4/AC 5; highlight-tier design
  // Property 10a/10b.
  describe('unlisted trip reached by direct link', () => {
    it('serves highlight-photos to an anonymous visitor, public media only', async () => {
      const tripId = createTrip(owner.userId, 'unlisted');
      const publicId = createHighlightPhoto(tripId, { visibility: 'public' });
      const privateId = createHighlightPhoto(tripId, { visibility: 'private' });

      const res = await request(app).get(`/api/trips/${tripId}/highlight-photos`);

      expect(res.status).toBe(200);
      expect(idsOf(res.body)).toEqual([publicId]);
      expect(JSON.stringify(res.body)).not.toContain(privateId);
    });

    it('serves tier-photos to an anonymous visitor, public media only', async () => {
      const tripId = createTrip(owner.userId, 'unlisted');
      const publicId = createHighlightPhoto(tripId, { visibility: 'public', tier: true });
      const privateId = createHighlightPhoto(tripId, { visibility: 'private', tier: true });

      const res = await request(app).get(`/api/trips/${tripId}/tier-photos`);

      expect(res.status).toBe(200);
      expect(idsOf(res.body)).toEqual([publicId]);
      expect(JSON.stringify(res.body)).not.toContain(privateId);
    });

    it('serves both endpoints to an authenticated non-owner, public media only', async () => {
      const tripId = createTrip(owner.userId, 'unlisted');
      const publicId = createHighlightPhoto(tripId, { visibility: 'public', tier: true });
      const privateId = createHighlightPhoto(tripId, { visibility: 'private', tier: true });
      const stranger = createTestUser('regular');

      const highlights = await request(app)
        .get(`/api/trips/${tripId}/highlight-photos`)
        .set('Authorization', `Bearer ${stranger.token}`);
      expect(highlights.status).toBe(200);
      expect(idsOf(highlights.body)).toEqual([publicId]);
      expect(JSON.stringify(highlights.body)).not.toContain(privateId);

      const tier = await request(app)
        .get(`/api/trips/${tripId}/tier-photos`)
        .set('Authorization', `Bearer ${stranger.token}`);
      expect(tier.status).toBe(200);
      expect(idsOf(tier.body)).toEqual([publicId]);
      expect(JSON.stringify(tier.body)).not.toContain(privateId);
    });

    // Opening the photo list must not widen tier slideshow *file* exposure. Those
    // artifacts are found by scanning the uploads directory and carry no source-media
    // provenance (G-20), so they cannot be narrowed per media. A real artifact is
    // written first, so this cannot pass vacuously: the URL map is empty because it
    // is withheld, not because there was nothing to advertise.
    it('withholds tier slideshow URLs from a non-owner even though a real artifact exists', async () => {
      const tripId = createTrip(owner.userId, 'unlisted');
      createHighlightPhoto(tripId, { visibility: 'public', tier: true });
      const tripDir = writeTierSlideshowArtifact(tripId, 'landscape');

      try {
        // Proof the fixture is real and discoverable: the owner does get the URL.
        const asOwner = await request(app)
          .get(`/api/trips/${tripId}/tier-photos`)
          .set('Authorization', `Bearer ${owner.token}`);
        expect(asOwner.status).toBe(200);
        expect(asOwner.body.slideshowUrls.landscape).toContain(
          `/api/trips/${tripId}/tier-slideshow/landscape/`,
        );

        const anon = await request(app).get(`/api/trips/${tripId}/tier-photos`);
        expect(anon.status).toBe(200);
        expect(anon.body.slideshowUrls).toEqual({});

        const stranger = createTestUser('regular');
        const asStranger = await request(app)
          .get(`/api/trips/${tripId}/tier-photos`)
          .set('Authorization', `Bearer ${stranger.token}`);
        expect(asStranger.status).toBe(200);
        expect(asStranger.body.slideshowUrls).toEqual({});
      } finally {
        fs.rmSync(tripDir, { recursive: true, force: true });
        expect(fs.existsSync(tripDir)).toBe(false);
      }
    });

    // The slideshow file routes check the requester themselves; the list is not the gate.
    it('refuses the tier slideshow file route to a non-owner', async () => {
      const tripId = createTrip(owner.userId, 'unlisted');
      const tripDir = writeTierSlideshowArtifact(tripId, 'landscape');

      try {
        const res = await request(app).get(
          `/api/trips/${tripId}/tier-slideshow/landscape/tier.mp4`,
        );
        expect(res.status).toBe(404);
      } finally {
        fs.rmSync(tripDir, { recursive: true, force: true });
        expect(fs.existsSync(tripDir)).toBe(false);
      }
    });
  });

  describe('behaviour this change deliberately leaves alone', () => {
    it('returns 404 for a trip that does not exist', async () => {
      const res = await request(app).get('/api/trips/no-such-trip/highlight-photos');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    // A public trip no longer advertises tier slideshow URLs to an anonymous caller
    // (C1, fail-closed until G-20 provenance exists). The owner still gets them, which
    // also proves the artifact is real so the anonymous `{}` is not vacuous.
    it('advertises tier slideshow URLs on a public trip to the owner only', async () => {
      const tripId = createTrip(owner.userId, 'public');
      createHighlightPhoto(tripId, { visibility: 'public', tier: true });
      const tripDir = writeTierSlideshowArtifact(tripId, 'landscape');

      try {
        const asOwner = await request(app)
          .get(`/api/trips/${tripId}/tier-photos`)
          .set('Authorization', `Bearer ${owner.token}`);
        expect(asOwner.status).toBe(200);
        expect(asOwner.body.slideshowUrls.landscape).toContain(
          `/api/trips/${tripId}/tier-slideshow/landscape/`,
        );

        const anon = await request(app).get(`/api/trips/${tripId}/tier-photos`);
        expect(anon.status).toBe(200);
        expect(anon.body.slideshowUrls).toEqual({});
      } finally {
        fs.rmSync(tripDir, { recursive: true, force: true });
        expect(fs.existsSync(tripDir)).toBe(false);
      }
    });
  });

  // C1 requester matrix. Authority: multi-user-system 需求 9 AC 4/5 and AC 12–15;
  // highlight-tier 需求 6 AC 9. Tier slideshow files carry no provenance (G-20), so
  // AC 4 requesters (anonymous, or authenticated non-owner non-admin) get no URLs
  // and 404 on both file routes, on public and unlisted trips alike. Owner/admin
  // keep today's behaviour, including the legacy root-level `all` key.
  describe('tier slideshow exposure — requester × trip visibility matrix (C1)', () => {
    const CATEGORY_BYTES = 'stub';
    const LEGACY_BYTES = 'legacy-stub';

    function tokenFor(kind: RequesterKind): string | undefined {
      switch (kind) {
        case 'anonymous':
          return undefined;
        case 'non-owner':
          return createTestUser('regular').token;
        case 'owner':
          return owner.token;
        case 'admin':
          return createTestUser('admin').token;
      }
    }

    const visibilities = ['public', 'unlisted'] as const;
    const ac4Requesters: RequesterKind[] = ['anonymous', 'non-owner'];
    const privileged: RequesterKind[] = ['owner', 'admin'];

    for (const visibility of visibilities) {
      describe(`${visibility} trip`, () => {
        for (const kind of [...ac4Requesters, ...privileged]) {
          const isAc4 = ac4Requesters.includes(kind);
          const title = isAc4
            ? `${kind}: no slideshowUrls, 404 on category and legacy file routes, public photos only`
            : `${kind}: slideshowUrls incl. legacy "all", 200 with file bytes on both file routes`;

          it(title, async () => {
            const tripId = createTrip(owner.userId, visibility);
            const publicId = createHighlightPhoto(tripId, { visibility: 'public', tier: true });
            const privateId = createHighlightPhoto(tripId, { visibility: 'private', tier: true });
            const tripDir = writeTierSlideshowArtifact(tripId, 'landscape');
            writeLegacyTierSlideshowArtifact(tripId, LEGACY_BYTES);

            const categoryUrl = `/api/trips/${tripId}/tier-slideshow/landscape/tier.mp4`;
            const legacyUrl = `/api/trips/${tripId}/tier-slideshow/legacy.mp4`;

            try {
              // Fixture proof: the owner sees both artifacts, so `{}` below is a
              // withholding, not an absence.
              const asOwner = await getAs(`/api/trips/${tripId}/tier-photos`, owner.token);
              expect(asOwner.status).toBe(200);
              expect(asOwner.body.slideshowUrls).toEqual({
                landscape: categoryUrl,
                all: legacyUrl,
              });

              const token = tokenFor(kind);
              const list = await getAs(`/api/trips/${tripId}/tier-photos`, token);
              const categoryFile = await getAs(categoryUrl, token, true);
              const legacyFile = await getAs(legacyUrl, token, true);

              expect(list.status).toBe(200);

              if (isAc4) {
                expect(list.body.slideshowUrls).toEqual({});
                // G-19 still applies in the same response.
                expect(idsOf(list.body)).toEqual([publicId]);
                expect(JSON.stringify(list.body)).not.toContain(privateId);

                for (const file of [categoryFile, legacyFile]) {
                  expect(file.status).toBe(404);
                  expect(file.headers['content-type']).toMatch(/application\/json/);
                  const body = JSON.parse(Buffer.from(file.body).toString('utf8'));
                  expect(body).toEqual({ error: { code: 'NOT_FOUND', message: '旅行不存在' } });
                }
              } else {
                expect(list.body.slideshowUrls).toEqual({
                  landscape: categoryUrl,
                  all: legacyUrl,
                });
                expect(idsOf(list.body).sort()).toEqual([publicId, privateId].sort());

                expect(categoryFile.status).toBe(200);
                expect(categoryFile.headers['content-type']).toBe('video/mp4');
                expect(Buffer.from(categoryFile.body).toString('utf8')).toBe(CATEGORY_BYTES);

                expect(legacyFile.status).toBe(200);
                expect(legacyFile.headers['content-type']).toBe('video/mp4');
                expect(Buffer.from(legacyFile.body).toString('utf8')).toBe(LEGACY_BYTES);
              }
            } finally {
              fs.rmSync(tripDir, { recursive: true, force: true });
              expect(fs.existsSync(tripDir)).toBe(false);
            }
          });
        }
      });
    }
  });
});
