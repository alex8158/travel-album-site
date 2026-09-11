/**
 * Media-level visibility on the public highlight/tier photo endpoints.
 *
 * Scope note: this suite covers G-19 only — highlight/tier membership must not
 * override `media_items.visibility` for anonymous or non-owner callers. The
 * trip-level gate on these endpoints is deliberately left as-is and is asserted
 * below, so this file does not encode any position on unlisted direct-link
 * access (that is tracked separately).
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
    // provenance, so they cannot be narrowed per media. A real artifact is written
    // first, so this cannot pass vacuously: the URL map is empty because it is
    // withheld, not because there was nothing to advertise.
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

    // The slideshow file routes keep their own trip-level gate.
    it('still refuses the tier slideshow file route to a non-owner', async () => {
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

    // Slideshow exposure on a public trip is unchanged by this fix. Asserted with
    // a real artifact so the expectation cannot pass vacuously.
    it('still advertises tier slideshow URLs on a public trip', async () => {
      const tripId = createTrip(owner.userId, 'public');
      createHighlightPhoto(tripId, { visibility: 'public', tier: true });
      const tripDir = writeTierSlideshowArtifact(tripId, 'landscape');

      try {
        const res = await request(app).get(`/api/trips/${tripId}/tier-photos`);
        expect(res.status).toBe(200);
        expect(res.body.slideshowUrls.landscape).toContain(
          `/api/trips/${tripId}/tier-slideshow/landscape/`,
        );
      } finally {
        fs.rmSync(tripDir, { recursive: true, force: true });
        expect(fs.existsSync(tripDir)).toBe(false);
      }
    });
  });
});
