/**
 * Route-level regression tests for
 *   POST /api/my/trips/:id/tier-slideshow/regenerate
 *
 * Authority (frozen contract):
 *   - `.kiro/specs/manual-photo-management/requirements.md`
 *       glossary Eligible_Category, 5.5, 9.1–9.7
 *   - `.kiro/specs/manual-photo-management/design.md`
 *       §Components 3 terminal-state truth table + Error Handling table
 *   - `.kiro/specs/highlight-tier/requirements.md` 6.3 (skip+log) / 6.7 (record+continue)
 *
 * Terminal-state truth table under test:
 *
 *   | Eligible categories | Successful generations | Result                           |
 *   |---------------------|-----------------------:|----------------------------------|
 *   | 0                   |                      0 | 400 NO_ELIGIBLE_CATEGORIES       |
 *   | >= 1                |                   >= 1 | 200 { slideshowUrls, errors? }   |
 *   | >= 1                |                      0 | 500 GENERATION_FAILED            |
 *
 * Why this lives in its own file rather than in `my.test.ts`:
 * regenerate is the only handler that depends on `../storage/factory` and
 * `../services/slideshowGenerator`, and both must be mocked to drive the table.
 * `my.test.ts` additionally mounts `trashRouter` (which calls
 * `storageProvider.delete`) and `highlightsRouter` (which calls
 * `generateSlideshow`), so a module-level mock there would change the
 * environment of the 56 existing tests. This file mounts `myRouter` only and
 * keeps the fixture surface to what regenerate actually needs.
 */
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';

// --- mocks ------------------------------------------------------------------
// `vi.hoisted` is required because vi.mock factories are hoisted above imports.
const { mockDownloadToTemp } = vi.hoisted(() => ({ mockDownloadToTemp: vi.fn() }));

vi.mock('../storage/factory', () => ({
  getStorageProvider: () => ({ downloadToTemp: mockDownloadToTemp }),
}));

vi.mock('../services/slideshowGenerator', () => ({
  generateSlideshow: vi.fn(),
}));

import myRouter from './my';
import { globalErrorHandler } from '../middleware/errorHandler';
import { generateSlideshow } from '../services/slideshowGenerator';

const mockGenerateSlideshow = vi.mocked(generateSlideshow);

const app = express();
app.use(express.json());
app.use('/api/my', myRouter);
app.use(globalErrorHandler);

const MIN_PHOTOS_FOR_VIDEO = 6;

// --- fixtures ---------------------------------------------------------------
function seedUser(overrides: Partial<{ username: string; role: string }> = {}) {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const username = overrides.username ?? `user_${id.slice(0, 8)}`;
  const role = overrides.role ?? 'regular';

  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`
  ).run(id, username, bcrypt.hashSync('password123', 10), role, now, now);

  return { id, username, role };
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

/** Seed one active media item and mark it as a Tier_Photo. */
function seedTierPhoto(tripId: string, userId: string, category: string) {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, file_path, media_type, mime_type, original_filename, file_size,
        status, user_id, visibility, category, created_at)
     VALUES (?, ?, ?, 'image', 'image/jpeg', 'photo.jpg', 1024, 'active', ?, 'public', ?, ?)`
  ).run(id, tripId, `${id}/file.jpg`, userId, category, now);

  db.prepare(
    `INSERT INTO highlight_results
       (id, trip_id, photo_id, is_highlight, is_highlight_tier, reason, batch_index, evaluated_at)
     VALUES (?, ?, ?, 1, 1, 'seeded', 7, ?)`
  ).run(uuidv4(), tripId, id, now);

  return { id, category, filePath: `${id}/file.jpg` };
}

/** Seed `n` Tier_Photos in one category. Returns their ids in insertion order. */
function seedTierCategory(tripId: string, userId: string, category: string, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(seedTierPhoto(tripId, userId, category).id);
  }
  return ids;
}

/** The categories that were actually handed to the generator, in call order. */
function generatedCategories(): string[] {
  return mockGenerateSlideshow.mock.calls.map((call) => {
    const outputDir = (call[0] as { outputDir: string }).outputDir;
    return outputDir.split('/').filter(Boolean).pop() as string;
  });
}

function successResult(name = 'video.mp4') {
  return {
    success: true,
    outputPath: `/abs/out/${name}`,
    totalDuration: 18,
    skippedPhotos: [],
  };
}

function failureResult(error: string) {
  return {
    success: false,
    outputPath: null,
    totalDuration: 0,
    skippedPhotos: [],
    error,
  };
}

function regenerate(tripId: string, token?: string) {
  const req = request(app).post(`/api/my/trips/${tripId}/tier-slideshow/regenerate`);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
}

describe('POST /api/my/trips/:id/tier-slideshow/regenerate — terminal-state truth table', () => {
  beforeEach(() => {
    const db = getDb();
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

    vi.clearAllMocks();
    // Default: every download succeeds, every generation succeeds.
    mockDownloadToTemp.mockImplementation(async (p: string) => `/tmp/${p.replace(/\//g, '_')}`);
    mockGenerateSlideshow.mockResolvedValue(successResult());
  });

  afterEach(() => {
    closeDb();
  });

  // =========================================================================
  // A. Preconditions — auth / ownership / zero Tier_Photos
  // =========================================================================
  describe('A. preconditions', () => {
    it('9.1: rejects an unauthenticated request', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      seedTierCategory(trip.id, user.id, 'animal', MIN_PHOTOS_FOR_VIDEO);

      const res = await regenerate(trip.id);

      // Shared auth middleware contract (server/src/middleware/auth.ts).
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_INVALID');
      expect(mockGenerateSlideshow).not.toHaveBeenCalled();
    });

    it('returns 404 NOT_FOUND when the trip does not exist', async () => {
      const user = seedUser();
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await regenerate(uuidv4(), token);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(mockGenerateSlideshow).not.toHaveBeenCalled();
    });

    it('9.5: returns 403 FORBIDDEN when the requester is neither owner nor admin', async () => {
      const owner = seedUser({ username: 'rg-owner' });
      const stranger = seedUser({ username: 'rg-stranger' });
      const trip = seedTrip(owner.id);
      seedTierCategory(trip.id, owner.id, 'animal', MIN_PHOTOS_FOR_VIDEO);

      const token = signToken({ userId: stranger.id, role: 'regular' });
      const res = await regenerate(trip.id, token);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(mockGenerateSlideshow).not.toHaveBeenCalled();
    });

    it('9.5: allows an admin to regenerate a trip they do not own', async () => {
      const owner = seedUser({ username: 'rg-owner2' });
      const admin = seedUser({ username: 'rg-admin2', role: 'admin' });
      const trip = seedTrip(owner.id);
      seedTierCategory(trip.id, owner.id, 'animal', MIN_PHOTOS_FOR_VIDEO);

      const token = signToken({ userId: admin.id, role: 'admin' });
      const res = await regenerate(trip.id, token);

      expect(res.status).toBe(200);
    });

    it('9.4: returns 400 NO_TIER_PHOTOS when the trip has zero Tier_Photos', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      // An active photo that is a highlight but NOT in the tier.
      const db = getDb();
      const id = uuidv4();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO media_items
           (id, trip_id, file_path, media_type, mime_type, original_filename, file_size,
            status, user_id, visibility, category, created_at)
         VALUES (?, ?, ?, 'image', 'image/jpeg', 'p.jpg', 1024, 'active', ?, 'public', 'animal', ?)`
      ).run(id, trip.id, `${id}/file.jpg`, user.id, now);
      db.prepare(
        `INSERT INTO highlight_results
           (id, trip_id, photo_id, is_highlight, is_highlight_tier, reason, batch_index, evaluated_at)
         VALUES (?, ?, ?, 1, 0, 'seeded', 7, ?)`
      ).run(uuidv4(), trip.id, id, now);

      const token = signToken({ userId: user.id, role: 'regular' });
      const res = await regenerate(trip.id, token);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NO_TIER_PHOTOS');
      // 9.4 is decided before the truth table — the generator is never reached.
      expect(mockGenerateSlideshow).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // B. Truth table row 1 — eligible = 0, successful = 0 → 400
  // =========================================================================
  describe('B. zero Eligible_Category (row 1 → 400 NO_ELIGIBLE_CATEGORIES)', () => {
    it('9.7: returns 400 NO_ELIGIBLE_CATEGORIES when every category is below MIN_PHOTOS_FOR_VIDEO', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      seedTierCategory(trip.id, user.id, 'animal', MIN_PHOTOS_FOR_VIDEO - 1);
      seedTierCategory(trip.id, user.id, 'people', 3);
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await regenerate(trip.id, token);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NO_ELIGIBLE_CATEGORIES');
      // No Eligible_Category exists, so nothing may be handed to the generator.
      expect(mockGenerateSlideshow).not.toHaveBeenCalled();
      // 9.7: this is an eligibility precondition failure, not a generation failure.
      expect(res.body.error.code).not.toBe('GENERATION_FAILED');
      // The error branch carries no `errors[]` (design.md §Components 3).
      expect(res.body.errors).toBeUndefined();
      expect(res.body.slideshowUrls).toBeUndefined();
    });

    it('9.7: the NO_ELIGIBLE_CATEGORIES message describes only the photo-count shortfall', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      seedTierCategory(trip.id, user.id, 'animal', 2);
      const token = signToken({ userId: user.id, role: 'regular' });
      // Poison both downstream stages: if either were consulted, its detail
      // would be visible in the message.
      mockDownloadToTemp.mockRejectedValue(new Error('DOWNLOAD_MARKER'));
      mockGenerateSlideshow.mockResolvedValue(failureResult('GENERATOR_MARKER'));

      const res = await regenerate(trip.id, token);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NO_ELIGIBLE_CATEGORIES');
      // Mentions the threshold, so the user learns what the shortfall is.
      expect(res.body.error.message).toContain(String(MIN_PHOTOS_FOR_VIDEO));
      // 9.7: must NOT splice generator/download error detail into the message.
      expect(res.body.error.message).not.toContain('DOWNLOAD_MARKER');
      expect(res.body.error.message).not.toContain('GENERATOR_MARKER');
    });

    it('6.3: a skipped category never reaches the generator', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      seedTierCategory(trip.id, user.id, 'landscape', MIN_PHOTOS_FOR_VIDEO - 1);
      const token = signToken({ userId: user.id, role: 'regular' });

      await regenerate(trip.id, token);

      expect(generatedCategories()).toEqual([]);
    });
  });

  // =========================================================================
  // C. Truth table row 2 — eligible >= 1, successful >= 1 → 200
  // =========================================================================
  describe('C. partial success (row 2 → 200)', () => {
    it('9.3: one category succeeds and one fails — returns 200, keeps the success, records the failure', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      seedTierCategory(trip.id, user.id, 'animal', MIN_PHOTOS_FOR_VIDEO);
      seedTierCategory(trip.id, user.id, 'people', MIN_PHOTOS_FOR_VIDEO);
      const token = signToken({ userId: user.id, role: 'regular' });

      mockGenerateSlideshow.mockImplementation(async (opts: { outputDir: string }) =>
        opts.outputDir.includes('people')
          ? failureResult('ffmpeg exploded')
          : successResult('animal.mp4')
      );

      const res = await regenerate(trip.id, token);

      // 6.7 / 9.6: every Eligible_Category is attempted.
      expect(generatedCategories().sort()).toEqual(['animal', 'people']);
      expect(res.status).toBe(200);
      // Success survives the sibling failure.
      expect(Object.keys(res.body.slideshowUrls)).toEqual(['animal']);
      expect(res.body.slideshowUrls.animal).toContain(`/api/trips/${trip.id}/tier-slideshow/animal/`);
      // Failure is reported, not swallowed.
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0]).toContain('people');
      expect(res.body.errors[0]).toContain('ffmpeg exploded');
      // 9.3: a partial failure must not become a whole-request failure.
      expect(res.body.error).toBeUndefined();
    });

    it('9.3: a thrown generator error is recorded as a per-category failure, not a 500', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      seedTierCategory(trip.id, user.id, 'animal', MIN_PHOTOS_FOR_VIDEO);
      seedTierCategory(trip.id, user.id, 'people', MIN_PHOTOS_FOR_VIDEO);
      const token = signToken({ userId: user.id, role: 'regular' });

      mockGenerateSlideshow.mockImplementation(async (opts: { outputDir: string }) => {
        if (opts.outputDir.includes('animal')) throw new Error('spawn ENOENT');
        return successResult('people.mp4');
      });

      const res = await regenerate(trip.id, token);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.slideshowUrls)).toEqual(['people']);
      expect(res.body.errors[0]).toContain('animal');
      expect(res.body.errors[0]).toContain('spawn ENOENT');
    });

    it('9.3: `errors` is omitted entirely when no Eligible_Category failed', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      seedTierCategory(trip.id, user.id, 'animal', MIN_PHOTOS_FOR_VIDEO);
      seedTierCategory(trip.id, user.id, 'people', MIN_PHOTOS_FOR_VIDEO);
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await regenerate(trip.id, token);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.slideshowUrls).sort()).toEqual(['animal', 'people']);
      expect(res.body.errors).toBeUndefined();
    });
  });

  // =========================================================================
  // D. Truth table row 3 — eligible >= 1, successful = 0 → 500
  // =========================================================================
  describe('D. all Eligible_Categories fail (row 3 → 500 GENERATION_FAILED)', () => {
    it('9.6: returns 500 GENERATION_FAILED after attempting every Eligible_Category', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      seedTierCategory(trip.id, user.id, 'animal', MIN_PHOTOS_FOR_VIDEO);
      seedTierCategory(trip.id, user.id, 'people', MIN_PHOTOS_FOR_VIDEO);
      const token = signToken({ userId: user.id, role: 'regular' });

      mockGenerateSlideshow.mockImplementation(async (opts: { outputDir: string }) =>
        failureResult(`boom in ${opts.outputDir.includes('animal') ? 'animal' : 'people'}`)
      );

      const res = await regenerate(trip.id, token);

      // Complete traversal: the second category is attempted even though the
      // first already failed (6.7 — no early abort).
      expect(generatedCategories().sort()).toEqual(['animal', 'people']);
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('GENERATION_FAILED');
      // 9.6: must not be reported as an eligibility failure.
      expect(res.body.error.code).not.toBe('NO_ELIGIBLE_CATEGORIES');
      // Generation errors survive into the response.
      expect(res.body.error.message).toContain('boom in animal');
      expect(res.body.error.message).toContain('boom in people');
      expect(res.body.slideshowUrls).toBeUndefined();
    });

    it('9.6: a single Eligible_Category that fails yields 500, not 400', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      seedTierCategory(trip.id, user.id, 'animal', MIN_PHOTOS_FOR_VIDEO);
      const token = signToken({ userId: user.id, role: 'regular' });
      mockGenerateSlideshow.mockResolvedValue(failureResult('encoder unavailable'));

      const res = await regenerate(trip.id, token);

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('GENERATION_FAILED');
    });

    it('9.6: three eligible categories all failing are all attempted before the 500', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      seedTierCategory(trip.id, user.id, 'animal', MIN_PHOTOS_FOR_VIDEO);
      seedTierCategory(trip.id, user.id, 'landscape', MIN_PHOTOS_FOR_VIDEO);
      seedTierCategory(trip.id, user.id, 'people', MIN_PHOTOS_FOR_VIDEO);
      const token = signToken({ userId: user.id, role: 'regular' });
      mockGenerateSlideshow.mockResolvedValue(failureResult('nope'));

      const res = await regenerate(trip.id, token);

      // Proves the 500 is a post-traversal terminal state, not a first-failure abort.
      expect(generatedCategories().sort()).toEqual(['animal', 'landscape', 'people']);
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('GENERATION_FAILED');
    });
  });

  // =========================================================================
  // E. Download / preparation degradation of an Eligible_Category
  // =========================================================================
  describe('E. download degradation of an Eligible_Category', () => {
    /** Make `failCount` of the given category's photos fail to download. */
    function failDownloadsFor(categoryPhotoIds: string[], failCount: number) {
      const doomed = new Set(categoryPhotoIds.slice(0, failCount));
      mockDownloadToTemp.mockImplementation(async (p: string) => {
        const photoId = p.split('/')[0] as string;
        if (doomed.has(photoId)) throw new Error('storage offline');
        return `/tmp/${p.replace(/\//g, '_')}`;
      });
    }

    it('9.3: an eligible category degraded below the threshold is recorded in errors[], not silently skipped', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const animalIds = seedTierCategory(trip.id, user.id, 'animal', MIN_PHOTOS_FOR_VIDEO);
      seedTierCategory(trip.id, user.id, 'people', MIN_PHOTOS_FOR_VIDEO);
      const token = signToken({ userId: user.id, role: 'regular' });
      failDownloadsFor(animalIds, 2); // 6 - 2 = 4 usable, below the threshold

      const res = await regenerate(trip.id, token);

      // Partial success: the healthy sibling still produces a video.
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.slideshowUrls)).toEqual(['people']);
      // The degraded category is an eligible failure, so it must be reported.
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0]).toContain('animal');
      // It never reached the generator, yet is still not a silent skip.
      expect(generatedCategories()).toEqual(['people']);
    });

    it('9.6: a sole eligible category degraded below the threshold yields 500, not 400', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const animalIds = seedTierCategory(trip.id, user.id, 'animal', MIN_PHOTOS_FOR_VIDEO);
      const token = signToken({ userId: user.id, role: 'regular' });
      failDownloadsFor(animalIds, 3); // 3 usable

      const res = await regenerate(trip.id, token);

      // This is the discriminating case: a `< 6` *skip* would give 400, but this
      // category cleared eligibility on Tier_Photo count, so it is a failure.
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('GENERATION_FAILED');
      expect(res.body.error.code).not.toBe('NO_ELIGIBLE_CATEGORIES');
      expect(mockGenerateSlideshow).not.toHaveBeenCalled();
    });

    it('an eligible category still generates when downloads degrade it but keep it at the threshold', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const animalIds = seedTierCategory(trip.id, user.id, 'animal', MIN_PHOTOS_FOR_VIDEO + 2);
      const token = signToken({ userId: user.id, role: 'regular' });
      failDownloadsFor(animalIds, 2); // 8 - 2 = 6 usable, exactly at the threshold

      const res = await regenerate(trip.id, token);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.slideshowUrls)).toEqual(['animal']);
      expect(res.body.errors).toBeUndefined();
      // Only the downloadable photos are handed to the generator.
      const opts = mockGenerateSlideshow.mock.calls[0]![0] as { photoPaths: string[] };
      expect(opts.photoPaths).toHaveLength(MIN_PHOTOS_FOR_VIDEO);
    });
  });

  // =========================================================================
  // F. Skip vs failure boundary
  // =========================================================================
  describe('F. skipped category vs eligible failure', () => {
    it('6.3: a skipped category does not enter errors[] alongside a successful eligible category', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      seedTierCategory(trip.id, user.id, 'animal', MIN_PHOTOS_FOR_VIDEO);
      seedTierCategory(trip.id, user.id, 'people', 3); // skipped
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await regenerate(trip.id, token);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.slideshowUrls)).toEqual(['animal']);
      // 6.3: skipping is not a failure — nothing is recorded for `people`.
      expect(res.body.errors).toBeUndefined();
      expect(generatedCategories()).toEqual(['animal']);
    });

    it('6.3 + 9.6: a skipped category neither enters errors[] nor turns the 500 into a 400', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      seedTierCategory(trip.id, user.id, 'animal', MIN_PHOTOS_FOR_VIDEO);
      seedTierCategory(trip.id, user.id, 'people', 2); // skipped
      const token = signToken({ userId: user.id, role: 'regular' });
      mockGenerateSlideshow.mockResolvedValue(failureResult('render failed'));

      const res = await regenerate(trip.id, token);

      // One Eligible_Category existed and failed → row 3, not row 1.
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('GENERATION_FAILED');
      // Only the eligible category's error is present; the skip contributes none.
      expect(res.body.error.message).toContain('render failed');
      expect(res.body.error.message).not.toContain('people');
    });

    it('6.3: a skipped category does not consume the eligible slot that decides row 1 vs row 3', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      // Only skips → row 1.
      seedTierCategory(trip.id, user.id, 'animal', 5);
      seedTierCategory(trip.id, user.id, 'people', 5);
      const token = signToken({ userId: user.id, role: 'regular' });
      mockGenerateSlideshow.mockResolvedValue(failureResult('should never run'));

      const res = await regenerate(trip.id, token);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NO_ELIGIBLE_CATEGORIES');
      expect(res.body.error.message).not.toContain('should never run');
    });
  });
});
