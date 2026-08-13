import express from 'express';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import myRouter from './my';
import trashRouter from './trash';
import highlightsRouter from './highlights';
import { globalErrorHandler } from '../middleware/errorHandler';
import { signToken } from '../services/authService';

const app = express();
app.use(express.json());
app.use('/api/my', myRouter);
// trashRouter is mounted alongside myRouter so the trash → restore → add-to-tier
// invariants can be exercised across both routers in one request flow.
app.use('/api', trashRouter);
// highlightsRouter serves the public read-side of the same data (tier-photos and
// highlight-photos), mounted at the same path as production (`server/src/index.ts`).
app.use('/api/trips', highlightsRouter);
app.use(globalErrorHandler);

function seedUser(overrides: Partial<{ username: string; role: string; status: string }> = {}) {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const username = overrides.username ?? `user_${id.slice(0, 8)}`;
  const passwordHash = bcrypt.hashSync('password123', 10);
  const role = overrides.role ?? 'regular';
  const status = overrides.status ?? 'active';

  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, username, passwordHash, role, status, now, now);

  return { id, username, role, status };
}

function seedTrip(userId: string) {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at)
     VALUES (?, ?, 'public', ?, ?, ?)`
  ).run(id, `Trip ${id.slice(0, 6)}`, userId, now, now);

  return { id };
}

/**
 * Change a trip's visibility. `seedTrip` always creates a `public` trip; the
 * public highlight-photos endpoint gates non-owners on `visibility = 'public'`
 * (Requirement 6.5), so tests need a way to produce a non-public trip.
 */
function setTripVisibility(tripId: string, visibility: 'public' | 'unlisted') {
  getDb().prepare('UPDATE trips SET visibility = ? WHERE id = ?').run(visibility, tripId);
}

function seedMedia(
  tripId: string,
  userId: string,
  overrides: Partial<{ category: string; status: string }> = {}
) {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const category = overrides.category ?? 'animal';
  const status = overrides.status ?? 'active';

  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, file_path, media_type, mime_type, original_filename, file_size,
        status, user_id, visibility, category, created_at)
     VALUES (?, ?, ?, 'image', 'image/jpeg', 'photo.jpg', 1024, ?, ?, 'public', ?, ?)`
  ).run(id, tripId, `${id}/file.jpg`, status, userId, category, now);

  return { id, category, status };
}

/**
 * Insert a highlight_results row.
 *
 * @param inTier      whether the photo is already promoted into the tier
 * @param isHighlight the evaluated highlight verdict (defaults to 1, i.e. the
 *                    photo is in the Highlight_Pool). Pass 0 to simulate a photo
 *                    the AI evaluated and judged NOT to be a highlight.
 */
function seedHighlight(tripId: string, photoId: string, inTier: boolean, isHighlight = 1) {
  const db = getDb();
  db.prepare(
    `INSERT INTO highlight_results
       (id, trip_id, photo_id, is_highlight, is_highlight_tier, reason, batch_index, evaluated_at)
     VALUES (?, ?, ?, ?, ?, 'seeded', 7, ?)`
  ).run(uuidv4(), tripId, photoId, isHighlight, inTier ? 1 : 0, new Date().toISOString());
}

/** Read the raw highlight_results row for a photo, or undefined if absent. */
function readHighlightRow(tripId: string, photoId: string) {
  const db = getDb();
  return db
    .prepare('SELECT * FROM highlight_results WHERE trip_id = ? AND photo_id = ?')
    .get(tripId, photoId) as
    | {
        is_highlight: number;
        is_highlight_tier: number;
        reason: string | null;
        batch_index: number;
        evaluated_at: string;
      }
    | undefined;
}

/** Total highlight_results rows for a trip — used to prove no row was created. */
function highlightRowCount(tripId: string): number {
  const db = getDb();
  return (
    db.prepare('SELECT COUNT(*) AS cnt FROM highlight_results WHERE trip_id = ?').get(tripId) as {
      cnt: number;
    }
  ).cnt;
}

/** Count active tier photos in a category for a trip. */
function tierCount(tripId: string, category: string): number {
  const db = getDb();
  return (
    db.prepare(
      `SELECT COUNT(*) AS cnt FROM highlight_results hr
       INNER JOIN media_items mi ON mi.id = hr.photo_id
       WHERE hr.trip_id = ? AND hr.is_highlight_tier = 1
         AND mi.status = 'active' AND mi.category = ?`
    ).get(tripId, category) as { cnt: number }
  ).cnt;
}

/** Seed `n` photos of one category that are already in the tier. */
function fillTier(tripId: string, userId: string, category: string, n: number) {
  for (let i = 0; i < n; i++) {
    const photo = seedMedia(tripId, userId, { category });
    seedHighlight(tripId, photo.id, true);
  }
}

describe('My Space Routes — tier photo management', () => {
  beforeEach(() => {
    const db = getDb();
    // Delete in FK-safe order (mirrors users.test.ts).
    db.exec('DELETE FROM highlight_results');
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM upload_sessions');
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM media_versions');
    db.exec('DELETE FROM media_analysis');
    db.exec('DELETE FROM duplicate_group_items');
    db.exec('DELETE FROM ai_invocations');
    db.exec('DELETE FROM compile_jobs');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');
    db.exec('DELETE FROM users');
  });

  afterEach(() => {
    closeDb();
  });

  describe('PUT /api/my/trips/:id/tier-photos/:photoId — soft category quotas', () => {
    // Requirement 4.1: the API must allow adding a photo to the tier even if the
    // photo's category already holds the maximum recommended quota (9).
    // design.md Key Design Decision 2 / Property 4: quotas never block add/remove.
    it('allows adding a 10th photo when the category already holds the recommended maximum of 9', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      fillTier(trip.id, user.id, 'animal', 9);

      const candidate = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, candidate.id, false);

      expect(tierCount(trip.id, 'animal')).toBe(9);

      const token = signToken({ userId: user.id, role: 'regular' });
      const res = await request(app)
        .put(`/api/my/trips/${trip.id}/tier-photos/${candidate.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.photo).toBeDefined();
      expect(res.body.photo.id).toBe(candidate.id);
      // No quota rejection of any kind.
      expect(res.body.error).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('CATEGORY_FULL');

      // The category now legitimately holds 10.
      expect(tierCount(trip.id, 'animal')).toBe(10);
    });

    // Guards against a fix that merely moves the hard ceiling from 9 to 10.
    it('keeps allowing additions when the category is already above the recommended maximum', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      fillTier(trip.id, user.id, 'animal', 12);

      const candidate = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, candidate.id, false);

      expect(tierCount(trip.id, 'animal')).toBe(12);

      const token = signToken({ userId: user.id, role: 'regular' });
      const res = await request(app)
        .put(`/api/my/trips/${trip.id}/tier-photos/${candidate.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(tierCount(trip.id, 'animal')).toBe(13);
    });

    it('applies no quota ceiling across repeated additions', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      fillTier(trip.id, user.id, 'landscape', 9);
      const token = signToken({ userId: user.id, role: 'regular' });

      // Add three more one at a time; every one must succeed.
      for (let i = 0; i < 3; i++) {
        const candidate = seedMedia(trip.id, user.id, { category: 'landscape' });
        seedHighlight(trip.id, candidate.id, false);

        const res = await request(app)
          .put(`/api/my/trips/${trip.id}/tier-photos/${candidate.id}`)
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
      }

      expect(tierCount(trip.id, 'landscape')).toBe(12);
    });

    it('counts quotas per category, so a full category does not block a different one', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      fillTier(trip.id, user.id, 'animal', 9);

      const candidate = seedMedia(trip.id, user.id, { category: 'people' });
      seedHighlight(trip.id, candidate.id, false);

      const token = signToken({ userId: user.id, role: 'regular' });
      const res = await request(app)
        .put(`/api/my/trips/${trip.id}/tier-photos/${candidate.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(tierCount(trip.id, 'people')).toBe(1);
      expect(tierCount(trip.id, 'animal')).toBe(9);
    });
  });

  describe('PUT /api/my/trips/:id/tier-photos/:photoId — Highlight_Pool eligibility', () => {
    // Requirements 2.5, 3.1, 7.2, 7.5, 10.1 and design.md Property 3: the add
    // succeeds if and only if the photo ALREADY satisfies is_highlight = 1.
    // The endpoint must never create a highlight_results row nor flip
    // is_highlight, because that column is owned by the AI evaluation flow.

    it('succeeds when the row exists with is_highlight = 1, and leaves is_highlight untouched', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, false, 1);

      const before = readHighlightRow(trip.id, photo.id)!;
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await request(app)
        .put(`/api/my/trips/${trip.id}/tier-photos/${photo.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.photo.id).toBe(photo.id);

      const after = readHighlightRow(trip.id, photo.id)!;
      // Tier flag flipped on...
      expect(after.is_highlight_tier).toBe(1);
      // ...and nothing else changed. Evaluation metadata must be preserved.
      expect(after.is_highlight).toBe(1);
      expect(after.reason).toBe(before.reason);
      expect(after.batch_index).toBe(before.batch_index);
      expect(after.evaluated_at).toBe(before.evaluated_at);
      // The response echoes the stored reason, not a fabricated one.
      expect(res.body.photo.reason).toBe('seeded');
    });

    it('rejects with NOT_ELIGIBLE when the row exists but is_highlight = 0, leaving the row unchanged', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, false, 0);

      const before = readHighlightRow(trip.id, photo.id)!;
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await request(app)
        .put(`/api/my/trips/${trip.id}/tier-photos/${photo.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NOT_ELIGIBLE');

      // The AI verdict must NOT be overwritten, and no tier promotion happened.
      const after = readHighlightRow(trip.id, photo.id)!;
      expect(after.is_highlight).toBe(0);
      expect(after.is_highlight_tier).toBe(0);
      expect(after.reason).toBe(before.reason);
      expect(after.batch_index).toBe(before.batch_index);
      expect(after.evaluated_at).toBe(before.evaluated_at);
      expect(tierCount(trip.id, 'animal')).toBe(0);
    });

    it('rejects with NOT_ELIGIBLE when no highlight_results row exists, and creates no row', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });
      // Deliberately no seedHighlight() — the photo has not been evaluated.

      expect(highlightRowCount(trip.id)).toBe(0);
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await request(app)
        .put(`/api/my/trips/${trip.id}/tier-photos/${photo.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NOT_ELIGIBLE');

      // No row may be fabricated for an unevaluated photo.
      expect(highlightRowCount(trip.id)).toBe(0);
      expect(readHighlightRow(trip.id, photo.id)).toBeUndefined();
      expect(tierCount(trip.id, 'animal')).toBe(0);
    });

    it('does not promote an unevaluated photo into the public highlight set', async () => {
      // Guards the spill-over path: highlights.ts serves the public 精选 tab from
      // `is_highlight = 1`, so a fabricated row would leak into public output.
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'landscape' });
      const token = signToken({ userId: user.id, role: 'regular' });

      await request(app)
        .put(`/api/my/trips/${trip.id}/tier-photos/${photo.id}`)
        .set('Authorization', `Bearer ${token}`);

      const db = getDb();
      const publicHighlightCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM highlight_results hr
             INNER JOIN media_items mi ON mi.id = hr.photo_id
             WHERE hr.trip_id = ? AND hr.is_highlight = 1 AND mi.status = 'active'`
          )
          .get(trip.id) as { cnt: number }
      ).cnt;

      expect(publicHighlightCount).toBe(0);
    });
  });

  describe('GET /api/my/trips/:id/highlight-pool — Highlight_Pool membership', () => {
    // Highlight_Pool is defined in requirements.md as "All photos with
    // is_highlight = 1 and media_items.status = 'active'". Requirements 2.2,
    // 2.6 and 3.3 require the picker to show ONLY pool photos not already in
    // the tier; design.md Property 2 states the query returns only photos where
    // is_highlight = 1 AND status = 'active' AND is_highlight_tier = 0.

    /** GET the pool and return the photo ids it contains. */
    async function fetchPoolIds(tripId: string, token: string): Promise<string[]> {
      const res = await request(app)
        .get(`/api/my/trips/${tripId}/highlight-pool`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      return (res.body.photos as Array<{ id: string }>).map((p) => p.id);
    }

    it('includes an active highlight photo that is not yet in the tier', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const eligible = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, eligible.id, false, 1);

      const token = signToken({ userId: user.id, role: 'regular' });
      const ids = await fetchPoolIds(trip.id, token);

      expect(ids).toContain(eligible.id);
      expect(ids).toHaveLength(1);
    });

    it('excludes an active photo whose highlight verdict is is_highlight = 0', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const notHighlight = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, notHighlight.id, false, 0);

      const token = signToken({ userId: user.id, role: 'regular' });
      const ids = await fetchPoolIds(trip.id, token);

      expect(ids).not.toContain(notHighlight.id);
      expect(ids).toHaveLength(0);
    });

    it('excludes an active photo that has no highlight_results row at all', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const unevaluated = seedMedia(trip.id, user.id, { category: 'animal' });
      // Deliberately no seedHighlight() — never evaluated, so not in the pool.

      const token = signToken({ userId: user.id, role: 'regular' });
      const ids = await fetchPoolIds(trip.id, token);

      expect(ids).not.toContain(unevaluated.id);
      expect(ids).toHaveLength(0);
    });

    it('excludes a highlight photo that is already a Tier_Photo', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const alreadyTier = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, alreadyTier.id, true, 1);

      const token = signToken({ userId: user.id, role: 'regular' });
      const ids = await fetchPoolIds(trip.id, token);

      expect(ids).not.toContain(alreadyTier.id);
      expect(ids).toHaveLength(0);
    });

    it('excludes a trashed highlight photo', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const trashedHighlight = seedMedia(trip.id, user.id, {
        category: 'animal',
        status: 'trashed',
      });
      seedHighlight(trip.id, trashedHighlight.id, false, 1);

      const token = signToken({ userId: user.id, role: 'regular' });
      const ids = await fetchPoolIds(trip.id, token);

      expect(ids).not.toContain(trashedHighlight.id);
      expect(ids).toHaveLength(0);
    });

    // Locks Property 2's set-filtering semantics: one request over a trip that
    // holds every state at once must return exactly the eligible subset.
    it('returns exactly the eligible subset for a trip holding every state at once', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);

      // Eligible (2)
      const okAnimal = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, okAnimal.id, false, 1);
      const okLandscape = seedMedia(trip.id, user.id, { category: 'landscape' });
      seedHighlight(trip.id, okLandscape.id, false, 1);

      // Ineligible (4), one per exclusion reason
      const notHighlight = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, notHighlight.id, false, 0);

      const unevaluated = seedMedia(trip.id, user.id, { category: 'people' });

      const alreadyTier = seedMedia(trip.id, user.id, { category: 'people' });
      seedHighlight(trip.id, alreadyTier.id, true, 1);

      const trashedHighlight = seedMedia(trip.id, user.id, {
        category: 'landscape',
        status: 'trashed',
      });
      seedHighlight(trip.id, trashedHighlight.id, false, 1);

      const token = signToken({ userId: user.id, role: 'regular' });
      const ids = await fetchPoolIds(trip.id, token);

      // Exact set equality — not merely "contains the good ones".
      expect(ids.slice().sort()).toEqual([okAnimal.id, okLandscape.id].slice().sort());
      expect(ids).toHaveLength(2);

      // Spelled out per exclusion reason so a regression names its own cause.
      expect(ids).not.toContain(notHighlight.id);
      expect(ids).not.toContain(unevaluated.id);
      expect(ids).not.toContain(alreadyTier.id);
      expect(ids).not.toContain(trashedHighlight.id);
    });

    it('does not leak photos from another trip', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const otherTrip = seedTrip(user.id);

      const mine = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, mine.id, false, 1);
      const theirs = seedMedia(otherTrip.id, user.id, { category: 'animal' });
      seedHighlight(otherTrip.id, theirs.id, false, 1);

      const token = signToken({ userId: user.id, role: 'regular' });
      const ids = await fetchPoolIds(trip.id, token);

      expect(ids).toEqual([mine.id]);
    });

    it('returns 404 when the trip does not exist', async () => {
      const user = seedUser();
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await request(app)
        .get(`/api/my/trips/${uuidv4()}/highlight-pool`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 403 when the requester is neither owner nor admin', async () => {
      const owner = seedUser({ username: 'pool-owner' });
      const stranger = seedUser({ username: 'pool-stranger' });
      const trip = seedTrip(owner.id);

      const token = signToken({ userId: stranger.id, role: 'regular' });
      const res = await request(app)
        .get(`/api/my/trips/${trip.id}/highlight-pool`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('DELETE /api/my/trips/:id/tier-photos/:photoId — remove from tier', () => {
    // Authority: Requirements 8.1–8.6 (and 1.2), design.md §Components 2 contract
    // and Property 1 ("Remove clears tier flag").

    function removeFromTier(tripId: string, photoId: string, token?: string) {
      const req = request(app).delete(`/api/my/trips/${tripId}/tier-photos/${photoId}`);
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    }

    /** Read the tier photo ids the GET tier-photos endpoint reports. */
    async function fetchTierPhotoIds(tripId: string, token: string): Promise<string[]> {
      const res = await request(app)
        .get(`/api/my/trips/${tripId}/tier-photos`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      return (res.body.photos as Array<{ id: string }>).map((p) => p.id);
    }

    // --- 8.1: authenticated endpoint ----------------------------------------
    it('8.1: requires authentication', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, true, 1);

      const res = await removeFromTier(trip.id, photo.id);

      expect(res.status).toBe(401);
      // The tier flag must survive an unauthenticated attempt.
      expect(readHighlightRow(trip.id, photo.id)!.is_highlight_tier).toBe(1);
    });

    // --- 8.2 / 8.3 + Property 1 ---------------------------------------------
    it('8.3 + Property 1: removes a tier photo, returns 200 { success: true }, and clears only is_highlight_tier', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, true, 1);
      const before = readHighlightRow(trip.id, photo.id)!;
      expect(before.is_highlight_tier).toBe(1);
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await removeFromTier(trip.id, photo.id, token);

      // Contract: 200 with { success: true } (design.md §Components 2).
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });

      const after = readHighlightRow(trip.id, photo.id)!;
      // Property 1: tier flag cleared...
      expect(after.is_highlight_tier).toBe(0);
      // ...while highlight membership is preserved (subset invariant: removing
      // from the tier must NOT eject the photo from the Highlight_Pool).
      expect(after.is_highlight).toBe(1);
      // Evaluation metadata untouched.
      expect(after.reason).toBe(before.reason);
      expect(after.batch_index).toBe(before.batch_index);
      expect(after.evaluated_at).toBe(before.evaluated_at);
      // The row itself must still exist — remove is a flag flip, not a delete.
      expect(highlightRowCount(trip.id)).toBe(1);
    });

    it('Property 1: the removed photo no longer appears in tier photo queries', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const removed = seedMedia(trip.id, user.id, { category: 'animal' });
      const kept = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, removed.id, true, 1);
      seedHighlight(trip.id, kept.id, true, 1);
      const token = signToken({ userId: user.id, role: 'regular' });

      expect((await fetchTierPhotoIds(trip.id, token)).sort()).toEqual(
        [removed.id, kept.id].sort()
      );

      const res = await removeFromTier(trip.id, removed.id, token);
      expect(res.status).toBe(200);

      // Second half of Property 1: gone from tier queries, and only that one.
      const idsAfter = await fetchTierPhotoIds(trip.id, token);
      expect(idsAfter).toEqual([kept.id]);
      expect(tierCount(trip.id, 'animal')).toBe(1);
    });

    it('the removed photo returns to the Highlight_Pool and can be re-added', async () => {
      // Confirms remove does not delete the photo from the highlight set: after
      // removal it becomes an eligible pool candidate again.
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, true, 1);
      const token = signToken({ userId: user.id, role: 'regular' });

      // While in the tier it is excluded from the pool.
      const poolBefore = await request(app)
        .get(`/api/my/trips/${trip.id}/highlight-pool`)
        .set('Authorization', `Bearer ${token}`);
      expect((poolBefore.body.photos as Array<{ id: string }>).map((p) => p.id)).not.toContain(
        photo.id
      );

      await removeFromTier(trip.id, photo.id, token);

      const poolAfter = await request(app)
        .get(`/api/my/trips/${trip.id}/highlight-pool`)
        .set('Authorization', `Bearer ${token}`);
      expect((poolAfter.body.photos as Array<{ id: string }>).map((p) => p.id)).toContain(photo.id);

      // And can be promoted back into the tier.
      const readd = await request(app)
        .put(`/api/my/trips/${trip.id}/tier-photos/${photo.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(readd.status).toBe(200);
      expect(readHighlightRow(trip.id, photo.id)!.is_highlight_tier).toBe(1);
    });

    // --- 8.4: NOT_FOUND ------------------------------------------------------
    it('8.4: returns 404 NOT_FOUND when the trip does not exist', async () => {
      const user = seedUser();
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await removeFromTier(uuidv4(), uuidv4(), token);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('8.4: returns 404 NOT_FOUND when the photo does not belong to the trip', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const otherTrip = seedTrip(user.id);
      const foreign = seedMedia(otherTrip.id, user.id, { category: 'animal' });
      seedHighlight(otherTrip.id, foreign.id, true, 1);
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await removeFromTier(trip.id, foreign.id, token);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      // 8.4 must not touch the foreign photo's tier state.
      expect(readHighlightRow(otherTrip.id, foreign.id)!.is_highlight_tier).toBe(1);
    });

    it('8.4: returns 404 NOT_FOUND when the photo id does not exist at all', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await removeFromTier(trip.id, uuidv4(), token);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    // --- 8.5: NOT_IN_TIER ---------------------------------------------------
    it('8.5: returns 400 NOT_IN_TIER when the photo is a highlight but not in the tier', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, false, 1); // highlight, tier = 0
      const before = readHighlightRow(trip.id, photo.id)!;
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await removeFromTier(trip.id, photo.id, token);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NOT_IN_TIER');
      // Row must be completely unchanged.
      const after = readHighlightRow(trip.id, photo.id)!;
      expect(after.is_highlight).toBe(before.is_highlight);
      expect(after.is_highlight_tier).toBe(0);
      expect(after.reason).toBe(before.reason);
    });

    it('8.5: returns 400 NOT_IN_TIER when the photo has no highlight_results row', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });
      // No seedHighlight() at all.
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await removeFromTier(trip.id, photo.id, token);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NOT_IN_TIER');
      // Must not fabricate a row on the rejection path.
      expect(highlightRowCount(trip.id)).toBe(0);
    });

    it('8.5: a second removal of the same photo is rejected as NOT_IN_TIER (idempotency boundary)', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, true, 1);
      const token = signToken({ userId: user.id, role: 'regular' });

      const first = await removeFromTier(trip.id, photo.id, token);
      expect(first.status).toBe(200);

      const second = await removeFromTier(trip.id, photo.id, token);
      expect(second.status).toBe(400);
      expect(second.body.error.code).toBe('NOT_IN_TIER');
      expect(readHighlightRow(trip.id, photo.id)!.is_highlight).toBe(1);
    });

    // --- 8.6: FORBIDDEN -----------------------------------------------------
    it('8.6: returns 403 FORBIDDEN when the requester is neither owner nor admin', async () => {
      const owner = seedUser({ username: 'del-owner' });
      const stranger = seedUser({ username: 'del-stranger' });
      const trip = seedTrip(owner.id);
      const photo = seedMedia(trip.id, owner.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, true, 1);

      const token = signToken({ userId: stranger.id, role: 'regular' });
      const res = await removeFromTier(trip.id, photo.id, token);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      // A rejected request must not modify state.
      expect(readHighlightRow(trip.id, photo.id)!.is_highlight_tier).toBe(1);
    });

    it('8.6: allows an admin to remove from a trip they do not own', async () => {
      const owner = seedUser({ username: 'del-owner2' });
      const admin = seedUser({ username: 'del-admin2', role: 'admin' });
      const trip = seedTrip(owner.id);
      const photo = seedMedia(trip.id, owner.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, true, 1);

      const token = signToken({ userId: admin.id, role: 'admin' });
      const res = await removeFromTier(trip.id, photo.id, token);

      expect(res.status).toBe(200);
      expect(readHighlightRow(trip.id, photo.id)!.is_highlight_tier).toBe(0);
      expect(readHighlightRow(trip.id, photo.id)!.is_highlight).toBe(1);
    });

    // --- isolation ----------------------------------------------------------
    it('removes only the targeted photo and leaves sibling tier photos untouched', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const target = seedMedia(trip.id, user.id, { category: 'animal' });
      const sibling = seedMedia(trip.id, user.id, { category: 'animal' });
      const otherCategory = seedMedia(trip.id, user.id, { category: 'people' });
      seedHighlight(trip.id, target.id, true, 1);
      seedHighlight(trip.id, sibling.id, true, 1);
      seedHighlight(trip.id, otherCategory.id, true, 1);
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await removeFromTier(trip.id, target.id, token);
      expect(res.status).toBe(200);

      expect(readHighlightRow(trip.id, target.id)!.is_highlight_tier).toBe(0);
      expect(readHighlightRow(trip.id, sibling.id)!.is_highlight_tier).toBe(1);
      expect(readHighlightRow(trip.id, otherCategory.id)!.is_highlight_tier).toBe(1);
      expect(tierCount(trip.id, 'animal')).toBe(1);
      expect(tierCount(trip.id, 'people')).toBe(1);
    });

    it('does not affect an identically-positioned photo in another trip', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const otherTrip = seedTrip(user.id);
      const mine = seedMedia(trip.id, user.id, { category: 'animal' });
      const theirs = seedMedia(otherTrip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, mine.id, true, 1);
      seedHighlight(otherTrip.id, theirs.id, true, 1);
      const token = signToken({ userId: user.id, role: 'regular' });

      await removeFromTier(trip.id, mine.id, token);

      expect(readHighlightRow(trip.id, mine.id)!.is_highlight_tier).toBe(0);
      expect(readHighlightRow(otherTrip.id, theirs.id)!.is_highlight_tier).toBe(1);
    });
  });

  describe('trash → restore invariants across highlight / tier state', () => {
    // Locks the verified production semantics:
    //   trash:   status active→trashed, is_highlight unchanged, is_highlight_tier→0
    //   restore: status trashed→active, is_highlight unchanged, is_highlight_tier stays 0
    //
    // Authority: Requirement 10.2 and design.md Property 7 require the trash
    // cascade to clear ONLY is_highlight_tier. Requirement 3.2 says a trashed
    // photo must be "restored to the highlight pool first". Property 3 governs
    // whether add-to-tier may then succeed.

    /** Read media status + trashed_reason straight from the DB. */
    function readMediaRow(photoId: string) {
      const db = getDb();
      return db
        .prepare('SELECT status, trashed_reason FROM media_items WHERE id = ?')
        .get(photoId) as { status: string; trashed_reason: string | null };
    }

    function trashPhoto(tripId: string, photoId: string, token: string) {
      return request(app)
        .put(`/api/trips/${tripId}/media/trash`)
        .set('Authorization', `Bearer ${token}`)
        .send({ mediaIds: [photoId] });
    }

    function restorePhoto(photoId: string, token: string) {
      return request(app)
        .put(`/api/media/${photoId}/restore`)
        .set('Authorization', `Bearer ${token}`);
    }

    function addToTier(tripId: string, photoId: string, token: string) {
      return request(app)
        .put(`/api/my/trips/${tripId}/tier-photos/${photoId}`)
        .set('Authorization', `Bearer ${token}`);
    }

    // --- Case A: highlight photo not in tier ---------------------------------
    it('A: highlight non-tier photo survives trash → restore with identity intact, then can be added to tier', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, false, 1);
      const seeded = readHighlightRow(trip.id, photo.id)!;
      const token = signToken({ userId: user.id, role: 'regular' });

      // trash
      const trashRes = await trashPhoto(trip.id, photo.id, token);
      expect(trashRes.status).toBe(200);
      expect(readMediaRow(photo.id).status).toBe('trashed');
      expect(readMediaRow(photo.id).trashed_reason).toBe('manual');
      const afterTrash = readHighlightRow(trip.id, photo.id)!;
      expect(afterTrash.is_highlight).toBe(1);
      expect(afterTrash.is_highlight_tier).toBe(0);

      // restore
      const restoreRes = await restorePhoto(photo.id, token);
      expect(restoreRes.status).toBe(200);
      const media = readMediaRow(photo.id);
      expect(media.status).toBe('active');
      expect(media.trashed_reason).toBeNull();
      const afterRestore = readHighlightRow(trip.id, photo.id)!;
      expect(afterRestore.is_highlight).toBe(1);
      expect(afterRestore.is_highlight_tier).toBe(0);
      // Evaluation metadata must survive the round trip untouched.
      expect(afterRestore.reason).toBe(seeded.reason);
      expect(afterRestore.batch_index).toBe(seeded.batch_index);
      expect(afterRestore.evaluated_at).toBe(seeded.evaluated_at);

      // Back in the Highlight_Pool → add-to-tier succeeds again (Property 3).
      const addRes = await addToTier(trip.id, photo.id, token);
      expect(addRes.status).toBe(200);
      const afterAdd = readHighlightRow(trip.id, photo.id)!;
      expect(afterAdd.is_highlight_tier).toBe(1);
      expect(afterAdd.is_highlight).toBe(1);
    });

    // --- Case B: photo already in tier --------------------------------------
    it('B: trashing a tier photo clears is_highlight_tier but not is_highlight (Requirement 10.2 / Property 7)', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, true, 1);
      expect(readHighlightRow(trip.id, photo.id)!.is_highlight_tier).toBe(1);
      const token = signToken({ userId: user.id, role: 'regular' });

      const trashRes = await trashPhoto(trip.id, photo.id, token);
      expect(trashRes.status).toBe(200);

      expect(readMediaRow(photo.id).status).toBe('trashed');
      const afterTrash = readHighlightRow(trip.id, photo.id)!;
      expect(afterTrash.is_highlight_tier).toBe(0); // cascade fired
      expect(afterTrash.is_highlight).toBe(1); // highlight identity NOT revoked
    });

    it('B: restore does not automatically re-add the photo to the tier, but a manual add succeeds', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, true, 1);
      const token = signToken({ userId: user.id, role: 'regular' });

      await trashPhoto(trip.id, photo.id, token);
      const restoreRes = await restorePhoto(photo.id, token);
      expect(restoreRes.status).toBe(200);

      const afterRestore = readHighlightRow(trip.id, photo.id)!;
      expect(readMediaRow(photo.id).status).toBe('active');
      expect(afterRestore.is_highlight).toBe(1);
      // No spec clause requires restore to resurrect tier membership.
      expect(afterRestore.is_highlight_tier).toBe(0);
      expect(tierCount(trip.id, 'animal')).toBe(0);

      const addRes = await addToTier(trip.id, photo.id, token);
      expect(addRes.status).toBe(200);
      expect(readHighlightRow(trip.id, photo.id)!.is_highlight_tier).toBe(1);
    });

    // --- Case C: non-highlight photo ----------------------------------------
    it('C: a non-highlight photo is not promoted by trash → restore and still cannot be added to tier', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, false, 0);
      const seeded = readHighlightRow(trip.id, photo.id)!;
      const token = signToken({ userId: user.id, role: 'regular' });

      await trashPhoto(trip.id, photo.id, token);
      const afterTrash = readHighlightRow(trip.id, photo.id)!;
      expect(afterTrash.is_highlight).toBe(0);
      expect(afterTrash.is_highlight_tier).toBe(0);

      const restoreRes = await restorePhoto(photo.id, token);
      expect(restoreRes.status).toBe(200);
      const afterRestore = readHighlightRow(trip.id, photo.id)!;
      expect(readMediaRow(photo.id).status).toBe('active');
      expect(afterRestore.is_highlight).toBe(0); // still not a highlight
      expect(afterRestore.is_highlight_tier).toBe(0);
      expect(afterRestore.reason).toBe(seeded.reason);
      expect(afterRestore.batch_index).toBe(seeded.batch_index);
      expect(afterRestore.evaluated_at).toBe(seeded.evaluated_at);

      const addRes = await addToTier(trip.id, photo.id, token);
      expect(addRes.status).toBe(400);
      expect(addRes.body.error.code).toBe('NOT_ELIGIBLE');
      expect(readHighlightRow(trip.id, photo.id)!.is_highlight_tier).toBe(0);
    });

    // --- Case D: no highlight_results row -----------------------------------
    it('D: trash → restore creates no highlight_results row, and add-to-tier stays rejected', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });
      // Deliberately no seedHighlight() — never evaluated.
      expect(highlightRowCount(trip.id)).toBe(0);
      const token = signToken({ userId: user.id, role: 'regular' });

      await trashPhoto(trip.id, photo.id, token);
      expect(readMediaRow(photo.id).status).toBe('trashed');
      // The cascade runs over the trashed ids but must not fabricate a row.
      expect(highlightRowCount(trip.id)).toBe(0);
      expect(readHighlightRow(trip.id, photo.id)).toBeUndefined();

      const restoreRes = await restorePhoto(photo.id, token);
      expect(restoreRes.status).toBe(200);
      expect(readMediaRow(photo.id).status).toBe('active');
      expect(highlightRowCount(trip.id)).toBe(0);
      expect(readHighlightRow(trip.id, photo.id)).toBeUndefined();

      const addRes = await addToTier(trip.id, photo.id, token);
      expect(addRes.status).toBe(400);
      expect(addRes.body.error.code).toBe('NOT_ELIGIBLE');
      expect(highlightRowCount(trip.id)).toBe(0);
    });
  });

  describe('PUT /api/my/trips/:id/tier-photos/:photoId — validations still enforced', () => {
    // Removing the quota gate must not weaken the checks that Requirement 7
    // does mandate: 404 NOT_FOUND, 400 NOT_ELIGIBLE, 403 FORBIDDEN.
    it('returns 404 NOT_FOUND when the trip does not exist', async () => {
      const user = seedUser();
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await request(app)
        .put(`/api/my/trips/${uuidv4()}/tier-photos/${uuidv4()}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 NOT_FOUND when the photo does not belong to the trip', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const otherTrip = seedTrip(user.id);
      const foreignPhoto = seedMedia(otherTrip.id, user.id, { category: 'animal' });
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await request(app)
        .put(`/api/my/trips/${trip.id}/tier-photos/${foreignPhoto.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 NOT_ELIGIBLE when the photo is trashed', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const trashed = seedMedia(trip.id, user.id, { category: 'animal', status: 'trashed' });
      seedHighlight(trip.id, trashed.id, false);
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await request(app)
        .put(`/api/my/trips/${trip.id}/tier-photos/${trashed.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NOT_ELIGIBLE');
      expect(tierCount(trip.id, 'animal')).toBe(0);
    });

    it('returns 403 FORBIDDEN when the requester is neither owner nor admin', async () => {
      const owner = seedUser({ username: 'owner' });
      const stranger = seedUser({ username: 'stranger' });
      const trip = seedTrip(owner.id);
      const photo = seedMedia(trip.id, owner.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, false);

      const token = signToken({ userId: stranger.id, role: 'regular' });
      const res = await request(app)
        .put(`/api/my/trips/${trip.id}/tier-photos/${photo.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(tierCount(trip.id, 'animal')).toBe(0);
    });

    it('allows an admin to add a photo to a trip they do not own', async () => {
      const owner = seedUser({ username: 'owner2' });
      const admin = seedUser({ username: 'admin2', role: 'admin' });
      const trip = seedTrip(owner.id);
      const photo = seedMedia(trip.id, owner.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, false);

      const token = signToken({ userId: admin.id, role: 'admin' });
      const res = await request(app)
        .put(`/api/my/trips/${trip.id}/tier-photos/${photo.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(tierCount(trip.id, 'animal')).toBe(1);
    });

    it('requires authentication', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });

      const res = await request(app).put(`/api/my/trips/${trip.id}/tier-photos/${photo.id}`);

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/trips/:id/highlight-photos — public highlight photos', () => {
    // Authority: Requirement 6.3 ("show all photos where is_highlight = 1"),
    // Requirement 6.5 (tabs only for public trips), design.md §Components 5
    // ("All photos where is_highlight = 1 and status = 'active'"; auth optional,
    // non-owners restricted to public trips) and Property 6.
    //
    // Implementation: server/src/routes/highlights.ts, GET /:id/highlight-photos.

    function getHighlightPhotos(tripId: string, token?: string) {
      const req = request(app).get(`/api/trips/${tripId}/highlight-photos`);
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    }

    async function fetchIds(tripId: string, token?: string): Promise<string[]> {
      const res = await getHighlightPhotos(tripId, token);
      expect(res.status).toBe(200);
      return (res.body.photos as Array<{ id: string }>).map((p) => p.id);
    }

    // --- 6.3 / Property 6: completeness ------------------------------------
    it('6.3 + Property 6: returns every active highlight, including photos promoted into the tier', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const plainHighlight = seedMedia(trip.id, user.id, { category: 'animal' });
      const tierHighlight = seedMedia(trip.id, user.id, { category: 'people' });
      seedHighlight(trip.id, plainHighlight.id, false, 1);
      seedHighlight(trip.id, tierHighlight.id, true, 1);

      const ids = await fetchIds(trip.id);

      // Tier photos are a subset of highlights, so both must be present.
      expect(ids.sort()).toEqual([plainHighlight.id, tierHighlight.id].sort());
    });

    it('Property 6: excludes photos evaluated as non-highlights (is_highlight = 0)', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const highlight = seedMedia(trip.id, user.id, { category: 'animal' });
      const nonHighlight = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, highlight.id, false, 1);
      seedHighlight(trip.id, nonHighlight.id, false, 0);

      const ids = await fetchIds(trip.id);

      expect(ids).toEqual([highlight.id]);
      expect(ids).not.toContain(nonHighlight.id);
    });

    it("Property 6: excludes highlights whose media is no longer active (status != 'active')", async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const active = seedMedia(trip.id, user.id, { category: 'animal' });
      const trashed = seedMedia(trip.id, user.id, { category: 'animal', status: 'trashed' });
      seedHighlight(trip.id, active.id, false, 1);
      seedHighlight(trip.id, trashed.id, false, 1);

      const ids = await fetchIds(trip.id);

      expect(ids).toEqual([active.id]);
      expect(ids).not.toContain(trashed.id);
    });

    it('Property 6: excludes photos that have no highlight_results row at all', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const highlight = seedMedia(trip.id, user.id, { category: 'animal' });
      const unevaluated = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, highlight.id, false, 1);
      // `unevaluated` intentionally has no highlight_results row.

      const ids = await fetchIds(trip.id);

      expect(ids).toEqual([highlight.id]);
      expect(ids).not.toContain(unevaluated.id);
    });

    it('returns an empty photos array when the trip has no highlights', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      seedMedia(trip.id, user.id, { category: 'animal' });

      const res = await getHighlightPhotos(trip.id);

      expect(res.status).toBe(200);
      expect(res.body.photos).toEqual([]);
    });

    it('returns the documented TierPhotoItem shape', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'landscape' });
      seedHighlight(trip.id, photo.id, false, 1);

      const res = await getHighlightPhotos(trip.id);

      expect(res.status).toBe(200);
      expect(res.body.photos).toHaveLength(1);
      // design.md §Components 5: { photos: TierPhotoItem[] }
      expect(res.body.photos[0]).toEqual({
        id: photo.id,
        filePath: `${photo.id}/file.jpg`,
        thumbnailUrl: `/api/media/${photo.id}/thumbnail`,
        originalUrl: `/api/media/${photo.id}/original`,
        category: 'landscape',
        reason: 'seeded',
      });
      // The response carries no slideshow payload — that belongs to tier-photos.
      expect(res.body.slideshowUrls).toBeUndefined();
    });

    // --- trip isolation -----------------------------------------------------
    it('does not leak highlights from another trip', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const otherTrip = seedTrip(user.id);
      const mine = seedMedia(trip.id, user.id, { category: 'animal' });
      const theirs = seedMedia(otherTrip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, mine.id, false, 1);
      seedHighlight(otherTrip.id, theirs.id, false, 1);

      const ids = await fetchIds(trip.id);

      expect(ids).toEqual([mine.id]);
      expect(ids).not.toContain(theirs.id);
    });

    // --- 6.5 / auth ---------------------------------------------------------
    it('6.5: an anonymous visitor can read a public trip (auth is optional)', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, false, 1);

      const res = await getHighlightPhotos(trip.id);

      expect(res.status).toBe(200);
      expect((res.body.photos as Array<{ id: string }>).map((p) => p.id)).toEqual([photo.id]);
    });

    it('6.5: an anonymous visitor gets 404 NOT_FOUND for a non-public trip', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      setTripVisibility(trip.id, 'unlisted');
      const photo = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, false, 1);

      const res = await getHighlightPhotos(trip.id);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      // Must not disclose the photo list for a non-public trip.
      expect(res.body.photos).toBeUndefined();
    });

    it('6.5: an authenticated non-owner gets 404 NOT_FOUND for a non-public trip', async () => {
      const owner = seedUser({ username: 'hp-owner' });
      const stranger = seedUser({ username: 'hp-stranger' });
      const trip = seedTrip(owner.id);
      setTripVisibility(trip.id, 'unlisted');
      const photo = seedMedia(trip.id, owner.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, false, 1);

      const token = signToken({ userId: stranger.id, role: 'regular' });
      const res = await getHighlightPhotos(trip.id, token);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('6.5: the owner can read their own non-public trip', async () => {
      const owner = seedUser({ username: 'hp-owner2' });
      const trip = seedTrip(owner.id);
      setTripVisibility(trip.id, 'unlisted');
      const photo = seedMedia(trip.id, owner.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, false, 1);

      const token = signToken({ userId: owner.id, role: 'regular' });
      const ids = await fetchIds(trip.id, token);

      expect(ids).toEqual([photo.id]);
    });

    it('6.5: an admin can read a non-public trip they do not own', async () => {
      const owner = seedUser({ username: 'hp-owner3' });
      const admin = seedUser({ username: 'hp-admin3', role: 'admin' });
      const trip = seedTrip(owner.id);
      setTripVisibility(trip.id, 'unlisted');
      const photo = seedMedia(trip.id, owner.id, { category: 'animal' });
      seedHighlight(trip.id, photo.id, false, 1);

      const token = signToken({ userId: admin.id, role: 'admin' });
      const ids = await fetchIds(trip.id, token);

      expect(ids).toEqual([photo.id]);
    });

    it('returns 404 NOT_FOUND when the trip does not exist', async () => {
      const res = await getHighlightPhotos(uuidv4());

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    // --- read-only guarantee ------------------------------------------------
    it('is a pure read: querying does not alter highlight or tier state', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const plain = seedMedia(trip.id, user.id, { category: 'animal' });
      const tier = seedMedia(trip.id, user.id, { category: 'animal' });
      seedHighlight(trip.id, plain.id, false, 1);
      seedHighlight(trip.id, tier.id, true, 1);
      const beforePlain = readHighlightRow(trip.id, plain.id)!;
      const beforeTier = readHighlightRow(trip.id, tier.id)!;

      await getHighlightPhotos(trip.id);

      expect(readHighlightRow(trip.id, plain.id)).toEqual(beforePlain);
      expect(readHighlightRow(trip.id, tier.id)).toEqual(beforeTier);
      expect(highlightRowCount(trip.id)).toBe(2);
      expect(tierCount(trip.id, 'animal')).toBe(1);
    });
  });
});
