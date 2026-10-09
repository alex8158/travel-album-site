/**
 * C2 schema (multi-user-system G-20): sealing of `tier_slideshow_artifacts`, the two
 * trips guards, and source-identity protection on `media_items`.
 *
 * Runs against the real database (initTables). Every case runs with
 * PRAGMA recursive_triggers OFF (production) and ON: none of the guards may depend on it.
 */
import crypto from 'crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from './database';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const COLS =
  'id, trip_id, category, status, manifest_json, source_count, manifest_sha256, file_sha256, file_size, rel_path, created_at';

function artifact(tripId: string, category: string, manifest: string[], id = uuidv4()) {
  const manifest_json = JSON.stringify(manifest);
  const manifest_sha256 = sha(manifest_json);
  return {
    id, trip_id: tripId, category, status: 'published', manifest_json, source_count: manifest.length,
    manifest_sha256, file_sha256: sha(`bytes:${id}`), file_size: 10,
    rel_path: `${tripId}/tier-slideshow/${category}/tsa_${id}_${manifest_sha256}.mp4`,
    created_at: new Date().toISOString(),
  };
}

const MEDIA_INSERT = (verb: string, tail = '') =>
  `${verb} INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, visibility, status, created_at)
   VALUES (@id, @trip, @fp, 'image', 'image/jpeg', 'p.jpg', 1, @vis, 'active', 'now') ${tail}`;

describe.each([['OFF'], ['ON']])('C2 schema guards — recursive_triggers=%s', (recursive) => {
  const created: string[] = [];
  let tripId: string;
  let m: Record<'priv' | 'pub' | 'other' | 'free', string>;
  let a0: ReturnType<typeof artifact>;
  let a1: ReturnType<typeof artifact>;

  const db = () => getDb();
  const media = (id: string, vis = 'public', trip = tripId) => ({ id, trip, fp: `${trip}/originals/${id}.jpg`, vis });
  const insertArtifact = (row: ReturnType<typeof artifact>) =>
    db().prepare(`INSERT INTO tier_slideshow_artifacts (${COLS}) VALUES (@id, @trip_id, @category, @status, @manifest_json,
      @source_count, @manifest_sha256, @file_sha256, @file_size, @rel_path, @created_at)`).run(row);
  const publish = (row: ReturnType<typeof artifact>) =>
    db().transaction(() => {
      db().prepare(`UPDATE tier_slideshow_artifacts SET status='superseded' WHERE trip_id=? AND category=? AND status='published'`)
        .run(row.trip_id, row.category);
      insertArtifact(row);
    }).immediate();
  const sealed = () => db().prepare(`SELECT ${COLS} FROM tier_slideshow_artifacts WHERE trip_id=? ORDER BY id`).all(tripId);
  const mediaIds = () => (db().prepare('SELECT id FROM media_items WHERE trip_id=? ORDER BY id').all(tripId) as Array<{ id: string }>).map((r) => r.id);

  function newTrip(): string {
    const id = uuidv4();
    created.push(id);
    db().prepare(`INSERT INTO trips (id, title, visibility, created_at, updated_at) VALUES (?, 't', 'public', 'c', 'u')`).run(id);
    return id;
  }

  beforeEach(() => {
    db().pragma(`recursive_triggers = ${recursive}`);
    tripId = newTrip();
    m = { priv: uuidv4(), pub: uuidv4(), other: uuidv4(), free: uuidv4() };
    const ins = db().prepare(MEDIA_INSERT('INSERT'));
    ins.run(media(m.priv, 'private'));
    ins.run(media(m.pub));
    ins.run(media(m.other));
    ins.run(media(m.free));
    a0 = artifact(tripId, 'animal', [m.pub, m.other]);
    a1 = artifact(tripId, 'animal', [m.priv, m.pub]);
    publish(a0);
    publish(a1); // a0 -> superseded, a1 published (contains the private source)
  });

  afterEach(() => {
    db().pragma('recursive_triggers = OFF');
    for (const id of created.splice(0)) {
      db().prepare('DELETE FROM media_items WHERE trip_id = ?').run(id);
      db().prepare('DELETE FROM trips WHERE id = ?').run(id);
    }
    closeDb();
  });

  it('creates the table, indexes and all seven triggers', () => {
    const names = (db().prepare(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining([
      'media_items_artifact_source_insert_guard', 'media_items_artifact_source_rekey_guard',
      'trips_artifact_owner_insert_guard', 'trips_identity_guard',
      'tsa_delete_guard', 'tsa_insert_guard', 'tsa_update_guard',
    ]));
    const sql = (db().prepare(`SELECT sql FROM sqlite_master WHERE name='tier_slideshow_artifacts'`).get() as { sql: string }).sql;
    expect(sql).toMatch(/STRICT, WITHOUT ROWID/);
    expect(db().prepare(`SELECT status FROM tier_slideshow_artifacts WHERE trip_id=? ORDER BY status`).all(tripId))
      .toEqual([{ status: 'published' }, { status: 'superseded' }]);
  });

  describe('artifact rows are sealed', () => {
    it('refuses manifest edits, resurrection, direct delete and REPLACE / UPSERT collisions', () => {
      const before = sealed();
      expect(() => db().prepare(`UPDATE tier_slideshow_artifacts SET manifest_json=? WHERE id=?`).run(JSON.stringify([m.pub]), a1.id)).toThrow(/sealed/);
      expect(() => db().prepare(`UPDATE tier_slideshow_artifacts SET status='published' WHERE id=?`).run(a0.id)).toThrow(/sealed/);
      expect(() => db().prepare(`DELETE FROM tier_slideshow_artifacts WHERE id=?`).run(a0.id)).toThrow(/removed only by deleting their trip/);
      const swap = { ...artifact(tripId, 'animal', [m.pub, m.other], a1.id) };
      for (const verb of ['INSERT OR REPLACE', 'REPLACE', 'INSERT OR IGNORE']) {
        expect(() => db().prepare(`${verb} INTO tier_slideshow_artifacts (${COLS}) VALUES (@id, @trip_id, @category, @status,
          @manifest_json, @source_count, @manifest_sha256, @file_sha256, @file_size, @rel_path, @created_at)`).run(swap)).toThrow(/already registered/);
      }
      expect(sealed()).toEqual(before);
    });

    it('accepts only the plain canonical manifest form with id-safe characters', () => {
      const escaped = artifact(tripId, 'people', [m.pub]);
      escaped.manifest_json = JSON.stringify([m.pub]).replace(m.pub[0], `\\u00${m.pub.charCodeAt(0).toString(16)}`);
      escaped.manifest_sha256 = sha(escaped.manifest_json);
      escaped.rel_path = `${tripId}/tier-slideshow/people/tsa_${escaped.id}_${escaped.manifest_sha256}.mp4`;
      expect(() => insertArtifact(escaped)).toThrow(/plain canonical form/);

      const odd = `${uuidv4()}.x`;
      db().prepare(MEDIA_INSERT('INSERT')).run(media(odd));
      expect(() => insertArtifact(artifact(tripId, 'people', [odd]))).toThrow(/distinct non-empty text ids/);
    });

    it('trip REPLACE / re-key cannot wipe registered provenance', () => {
      expect(() => db().prepare(`INSERT OR REPLACE INTO trips (id, title, created_at, updated_at) VALUES (?, 'x', 'c', 'u')`).run(tripId))
        .toThrow(/owns tier slideshow artifacts/);
      expect(() => db().prepare(`UPDATE trips SET id = ? WHERE id = ?`).run(uuidv4(), tripId)).toThrow(/immutable/);
      expect(sealed()).toHaveLength(2);
    });

    it('legit trip deletion (media first, then trip) cascades the artifact rows', () => {
      db().prepare('DELETE FROM media_items WHERE trip_id = ?').run(tripId);
      db().prepare('DELETE FROM trips WHERE id = ?').run(tripId);
      expect(sealed()).toEqual([]);
    });
  });

  describe('media_items source identity (referenced ids only)', () => {
    it('refuses same-id INSERT OR REPLACE / REPLACE / UPSERT / INSERT OR IGNORE of a referenced source', () => {
      const before = { rows: sealed(), ids: mediaIds() };
      const row = media(m.priv, 'public');
      expect(() => db().prepare(MEDIA_INSERT('INSERT OR REPLACE')).run(row)).toThrow(/sealed tier slideshow source/);
      expect(() => db().prepare(MEDIA_INSERT('REPLACE')).run(media(m.pub))).toThrow(/sealed tier slideshow source/);
      expect(() => db().prepare(MEDIA_INSERT('INSERT', `ON CONFLICT(id) DO UPDATE SET visibility='public'`)).run(row)).toThrow(/sealed tier slideshow source/);
      expect(() => db().prepare(MEDIA_INSERT('INSERT', 'ON CONFLICT DO NOTHING')).run(row)).toThrow(/sealed tier slideshow source/);
      expect(() => db().prepare(MEDIA_INSERT('INSERT OR IGNORE')).run(row)).toThrow(/sealed tier slideshow source/);
      expect({ rows: sealed(), ids: mediaIds() }).toEqual(before);
      expect(db().prepare('SELECT visibility FROM media_items WHERE id=?').get(m.priv)).toEqual({ visibility: 'private' });
    });

    it('a deleted private source cannot be re-inserted as public (separately or in one transaction)', () => {
      expect(() => db().transaction(() => {
        db().prepare('DELETE FROM media_items WHERE id=?').run(m.priv);
        db().prepare(MEDIA_INSERT('INSERT')).run(media(m.priv, 'public'));
      })()).toThrow(/sealed tier slideshow source/);
      expect(db().prepare('SELECT visibility FROM media_items WHERE id=?').get(m.priv)).toEqual({ visibility: 'private' });

      db().prepare('DELETE FROM media_items WHERE id=?').run(m.priv);
      expect(() => db().prepare(MEDIA_INSERT('INSERT')).run(media(m.priv, 'public'))).toThrow(/sealed tier slideshow source/);
      const elsewhere = newTrip();
      expect(() => db().prepare(MEDIA_INSERT('INSERT')).run(media(m.priv, 'public', elsewhere))).toThrow(/sealed tier slideshow source/);
      expect(mediaIds()).not.toContain(m.priv);
    });

    it('refuses re-keying onto or off a referenced id (UPDATE, UPDATE OR REPLACE, UPSERT DO UPDATE SET id)', () => {
      expect(() => db().prepare('UPDATE media_items SET id=? WHERE id=?').run(uuidv4(), m.pub)).toThrow(/cannot be re-keyed/);
      expect(() => db().prepare('UPDATE OR REPLACE media_items SET id=? WHERE id=?').run(m.priv, m.free)).toThrow(/cannot be re-keyed/);
      db().prepare('DELETE FROM media_items WHERE id=?').run(m.priv);
      expect(() => db().prepare('UPDATE media_items SET id=? WHERE id=?').run(m.priv, m.free)).toThrow(/cannot be re-keyed/);
      expect(() => db().prepare(MEDIA_INSERT('INSERT', 'ON CONFLICT(id) DO UPDATE SET id=?')).run({ ...media(m.free) }, m.priv))
        .toThrow(/cannot be re-keyed/);
      expect(mediaIds().sort()).toEqual([m.pub, m.other, m.free].sort());
    });

    it('explicit-rowid REPLACE only deletes the victim; its id can never come back', () => {
      const rowid = (db().prepare('SELECT rowid AS r FROM media_items WHERE id=?').get(m.priv) as { r: number }).r;
      const replacer = uuidv4();
      db().prepare(`INSERT OR REPLACE INTO media_items (rowid, id, trip_id, file_path, mime_type, original_filename, file_size, created_at)
                    VALUES (?, ?, ?, 'x', 'image/jpeg', 'x.jpg', 1, 'now')`).run(rowid, replacer, tripId);
      expect(mediaIds()).not.toContain(m.priv);
      expect(() => db().prepare(MEDIA_INSERT('INSERT')).run(media(m.priv, 'public'))).toThrow(/sealed tier slideshow source/);
    });

    it('keeps the normal lifecycle: new media, visibility/status/trash/restore, deletion, unreferenced REPLACE', () => {
      db().prepare(MEDIA_INSERT('INSERT')).run(media(uuidv4()));
      db().prepare(`UPDATE media_items SET visibility='public' WHERE id=?`).run(m.priv);
      db().prepare(`UPDATE media_items SET status='trashed', trashed_reason='manual' WHERE id=?`).run(m.pub);
      db().prepare(`UPDATE media_items SET status='active', trashed_reason=NULL WHERE id=?`).run(m.pub);
      db().prepare(`UPDATE media_items SET status='deleted' WHERE id=?`).run(m.other);
      db().prepare(`UPDATE media_items SET visibility='private' WHERE trip_id=? AND status='active'`).run(tripId);
      db().prepare(`UPDATE media_items SET category='people' WHERE id=?`).run(m.pub);
      db().prepare(`INSERT OR REPLACE INTO media_items (id, trip_id, file_path, mime_type, original_filename, file_size, created_at)
                    VALUES (?, ?, 'y', 'image/jpeg', 'y.jpg', 1, 'now')`).run(m.free, tripId);
      db().prepare('UPDATE media_items SET duplicate_group_id = NULL WHERE id = ?').run(m.pub);
      db().prepare('DELETE FROM media_items WHERE id=?').run(m.pub);
      expect(mediaIds()).not.toContain(m.pub);
      expect(sealed()).toHaveLength(2);
    });

    it('ids are free again once the trip (and so every referencing artifact) is deleted', () => {
      db().prepare('DELETE FROM media_items WHERE trip_id = ?').run(tripId);
      db().prepare('DELETE FROM trips WHERE id = ?').run(tripId);
      const next = newTrip();
      expect(() => db().prepare(MEDIA_INSERT('INSERT')).run(media(m.priv, 'public', next))).not.toThrow();
    });
  });
});
