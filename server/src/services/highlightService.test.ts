/**
 * Service-level unit tests for `clearHighlightWithCascade()`.
 *
 * Authority:
 *   - `.kiro/specs/manual-photo-management/requirements.md` Requirement 10.3
 *       "WHEN a photo currently in the tier has its highlight status removed
 *        (`is_highlight` set to 0), THE system SHALL automatically set
 *        `is_highlight_tier = 0` for that photo."
 *   - `.kiro/specs/manual-photo-management/design.md` Property 8
 *       "Highlight removal cascades tier flag"
 *
 * Requirement 10.3 is a **dormant mutation invariant**: as of 2026-08-07 no
 * production path performs `is_highlight` 1 → 0, and this helper has zero
 * production call sites. These tests exercise the primitive directly so that the
 * invariant is protected if a caller is ever introduced. They deliberately do
 * **not** create a production call site, an API or any UI.
 *
 * The real SQL runs against the real database — nothing about the cascade itself
 * is mocked. The DB lifecycle mirrors `server/src/routes/my.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { clearHighlightWithCascade } from './highlightService';

// --- fixtures ---------------------------------------------------------------
function seedUser() {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'regular', 'active', ?, ?)`
  ).run(id, `user_${id.slice(0, 8)}`, bcrypt.hashSync('password123', 10), now, now);

  return { id };
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
 * Seed an active media item plus its `highlight_results` row.
 *
 * @param isHighlight     the evaluated highlight verdict
 * @param isHighlightTier whether the photo is promoted into the tier
 */
function seedPhoto(
  tripId: string,
  userId: string,
  isHighlight: number,
  isHighlightTier: number,
  reason: string | null = 'AI 评估：构图优秀'
) {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, file_path, media_type, mime_type, original_filename, file_size,
        status, user_id, visibility, category, created_at)
     VALUES (?, ?, ?, 'image', 'image/jpeg', 'photo.jpg', 1024, 'active', ?, 'public', 'animal', ?)`
  ).run(id, tripId, `${id}/file.jpg`, userId, now);

  db.prepare(
    `INSERT INTO highlight_results
       (id, trip_id, photo_id, is_highlight, is_highlight_tier, reason, batch_index, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, 7, ?)`
  ).run(uuidv4(), tripId, id, isHighlight, isHighlightTier, reason, now);

  return { id };
}

function readRow(tripId: string, photoId: string) {
  return getDb()
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

function rowCount(): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS cnt FROM highlight_results').get() as { cnt: number }
  ).cnt;
}

describe('clearHighlightWithCascade — Requirement 10.3 / Property 8', () => {
  beforeEach(() => {
    const db = getDb();
    // FK-safe delete order (mirrors my.test.ts).
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

  // =========================================================================
  // Case 1 — core cascade
  // =========================================================================
  describe('Case 1: core cascade behaviour', () => {
    it('Property 8: clears is_highlight AND is_highlight_tier for a tier photo', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedPhoto(trip.id, user.id, 1, 1, '入选理由');
      const before = readRow(trip.id, photo.id)!;
      expect(before.is_highlight).toBe(1);
      expect(before.is_highlight_tier).toBe(1);
      expect(before.reason).toBe('入选理由');

      clearHighlightWithCascade(trip.id, [photo.id]);

      const after = readRow(trip.id, photo.id)!;
      // Requirement 10.3 / Property 8: the tier flag follows the highlight flag.
      expect(after.is_highlight).toBe(0);
      expect(after.is_highlight_tier).toBe(0);
    });

    it('nulls `reason` — documenting the current implementation', async () => {
      // The helper also sets `reason = NULL`. Requirement 10.3 does not mention
      // `reason`; this assertion pins the behaviour as implemented today so a
      // future change to it is a deliberate decision rather than a silent drift.
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedPhoto(trip.id, user.id, 1, 1, 'AI 评估：光线极佳');

      clearHighlightWithCascade(trip.id, [photo.id]);

      expect(readRow(trip.id, photo.id)!.reason).toBeNull();
    });

    it('is a flag update, not a row deletion, and leaves evaluation metadata intact', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedPhoto(trip.id, user.id, 1, 1);
      const before = readRow(trip.id, photo.id)!;

      clearHighlightWithCascade(trip.id, [photo.id]);

      const after = readRow(trip.id, photo.id);
      expect(after).toBeDefined();
      expect(rowCount()).toBe(1);
      expect(after!.batch_index).toBe(before.batch_index);
      expect(after!.evaluated_at).toBe(before.evaluated_at);
    });

    it('clears a highlight that is not in the tier, leaving both flags at 0', async () => {
      // Property 8's precondition is `is_highlight_tier = 1`, but the helper is
      // safe for a plain highlight too: the tier flag simply stays 0.
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedPhoto(trip.id, user.id, 1, 0);

      clearHighlightWithCascade(trip.id, [photo.id]);

      const after = readRow(trip.id, photo.id)!;
      expect(after.is_highlight).toBe(0);
      expect(after.is_highlight_tier).toBe(0);
    });

    it('cascades every photo in a batch call', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const a = seedPhoto(trip.id, user.id, 1, 1);
      const b = seedPhoto(trip.id, user.id, 1, 1);
      const c = seedPhoto(trip.id, user.id, 1, 0);

      clearHighlightWithCascade(trip.id, [a.id, b.id, c.id]);

      for (const id of [a.id, b.id, c.id]) {
        const row = readRow(trip.id, id)!;
        expect(row.is_highlight).toBe(0);
        expect(row.is_highlight_tier).toBe(0);
      }
    });

    it('is idempotent — a second call leaves the row unchanged', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedPhoto(trip.id, user.id, 1, 1);

      clearHighlightWithCascade(trip.id, [photo.id]);
      const afterFirst = readRow(trip.id, photo.id)!;
      clearHighlightWithCascade(trip.id, [photo.id]);

      expect(readRow(trip.id, photo.id)).toEqual(afterFirst);
    });
  });

  // =========================================================================
  // Case 2 — scope isolation on (trip_id, photo_id)
  // =========================================================================
  describe('Case 2: scope isolation', () => {
    it('touches only the targeted photo, never a sibling in the same trip or a photo in another trip', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const otherTrip = seedTrip(user.id);
      const target = seedPhoto(trip.id, user.id, 1, 1, 'target');
      const sibling = seedPhoto(trip.id, user.id, 1, 1, 'sibling');
      const foreign = seedPhoto(otherTrip.id, user.id, 1, 1, 'foreign');
      const siblingBefore = readRow(trip.id, sibling.id)!;
      const foreignBefore = readRow(otherTrip.id, foreign.id)!;

      clearHighlightWithCascade(trip.id, [target.id]);

      // Target cascaded.
      const targetAfter = readRow(trip.id, target.id)!;
      expect(targetAfter.is_highlight).toBe(0);
      expect(targetAfter.is_highlight_tier).toBe(0);
      // Same-trip sibling untouched (photo_id scope).
      expect(readRow(trip.id, sibling.id)).toEqual(siblingBefore);
      // Other-trip photo untouched (trip_id scope).
      expect(readRow(otherTrip.id, foreign.id)).toEqual(foreignBefore);
    });

    it('does not cascade a matching photo_id that belongs to a different trip', async () => {
      // Locks the `trip_id` half of the WHERE clause specifically: the photo id
      // is passed, but with the wrong trip.
      const user = seedUser();
      const trip = seedTrip(user.id);
      const otherTrip = seedTrip(user.id);
      const foreign = seedPhoto(otherTrip.id, user.id, 1, 1, 'foreign');
      const foreignBefore = readRow(otherTrip.id, foreign.id)!;

      clearHighlightWithCascade(trip.id, [foreign.id]);

      expect(readRow(otherTrip.id, foreign.id)).toEqual(foreignBefore);
    });

    it('cascades only the listed subset of a trip', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const cleared = seedPhoto(trip.id, user.id, 1, 1);
      const keptA = seedPhoto(trip.id, user.id, 1, 1);
      const keptB = seedPhoto(trip.id, user.id, 1, 0);
      const keptABefore = readRow(trip.id, keptA.id)!;
      const keptBBefore = readRow(trip.id, keptB.id)!;

      clearHighlightWithCascade(trip.id, [cleared.id]);

      expect(readRow(trip.id, cleared.id)!.is_highlight).toBe(0);
      expect(readRow(trip.id, keptA.id)).toEqual(keptABefore);
      expect(readRow(trip.id, keptB.id)).toEqual(keptBBefore);
    });

    it('is a no-op for a photo id that does not exist', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const existing = seedPhoto(trip.id, user.id, 1, 1);
      const before = readRow(trip.id, existing.id)!;

      expect(() => clearHighlightWithCascade(trip.id, [uuidv4()])).not.toThrow();

      expect(readRow(trip.id, existing.id)).toEqual(before);
      expect(rowCount()).toBe(1);
    });
  });

  // =========================================================================
  // Cases 3 & 4 — early returns (guard is present in the implementation)
  // =========================================================================
  describe('Cases 3 & 4: early-return guards', () => {
    it('Case 3: an empty photoIds array does not throw and changes nothing', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedPhoto(trip.id, user.id, 1, 1);
      const before = readRow(trip.id, photo.id)!;

      expect(() => clearHighlightWithCascade(trip.id, [])).not.toThrow();

      expect(readRow(trip.id, photo.id)).toEqual(before);
    });

    it('Case 4: an empty tripId does not throw and changes nothing', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedPhoto(trip.id, user.id, 1, 1);
      const before = readRow(trip.id, photo.id)!;

      expect(() => clearHighlightWithCascade('', [photo.id])).not.toThrow();

      expect(readRow(trip.id, photo.id)).toEqual(before);
    });

    it('a non-array photoIds argument does not throw and changes nothing', async () => {
      const user = seedUser();
      const trip = seedTrip(user.id);
      const photo = seedPhoto(trip.id, user.id, 1, 1);
      const before = readRow(trip.id, photo.id)!;

      expect(() =>
        clearHighlightWithCascade(trip.id, null as unknown as string[])
      ).not.toThrow();

      expect(readRow(trip.id, photo.id)).toEqual(before);
    });
  });
});
