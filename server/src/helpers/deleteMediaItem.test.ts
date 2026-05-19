import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { deleteMediaItemFromDb } from './deleteMediaItem';

describe('deleteMediaItemFromDb - merged video source deletion', () => {
  beforeEach(() => {
    const db = getDb();
    db.pragma('foreign_keys = OFF');
    db.exec('DELETE FROM merged_video_sources');
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM upload_sessions');
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM compile_jobs');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');
    db.exec('DELETE FROM users');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    closeDb();
  });

  function setupTestData() {
    const db = getDb();
    const now = new Date().toISOString();
    const userId = uuidv4();
    const tripId = uuidv4();

    // Create user and trip
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'regular', 'active', ?, ?)`
    ).run(userId, `user_${userId.slice(0, 8)}`, 'hash', now, now);

    db.prepare(
      `INSERT INTO trips (id, title, visibility, user_id, created_at, updated_at)
       VALUES (?, ?, 'public', ?, ?, ?)`
    ).run(tripId, 'Test Trip', userId, now, now);

    // Create source videos
    const source1Id = uuidv4();
    const source2Id = uuidv4();

    db.prepare(
      `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, user_id, media_source, compiled_path, created_at)
       VALUES (?, ?, ?, 'video', 'video/mp4', 'source1.mp4', 1024, 'active', ?, 'upload', ?, ?)`
    ).run(source1Id, tripId, `${tripId}/originals/${source1Id}.mp4`, userId, `${tripId}/compiled/${source1Id}.mp4`, now);

    db.prepare(
      `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, user_id, media_source, compiled_path, created_at)
       VALUES (?, ?, ?, 'video', 'video/mp4', 'source2.mp4', 2048, 'active', ?, 'upload', ?, ?)`
    ).run(source2Id, tripId, `${tripId}/originals/${source2Id}.mp4`, userId, `${tripId}/compiled/${source2Id}.mp4`, now);

    // Create merged video
    const mergedId = uuidv4();
    const mergedPath = `${tripId}/merged/${mergedId}.mp4`;

    db.prepare(
      `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, user_id, media_source, compiled_path, created_at)
       VALUES (?, ?, ?, 'video', 'video/mp4', 'merged.mp4', 4096, 'active', ?, 'merged', ?, ?)`
    ).run(mergedId, tripId, mergedPath, userId, mergedPath, now);

    // Create merged_video_sources records
    db.prepare(
      `INSERT INTO merged_video_sources (id, merged_media_id, source_media_id, sort_order, created_at)
       VALUES (?, ?, ?, 0, ?)`
    ).run(uuidv4(), mergedId, source1Id, now);

    db.prepare(
      `INSERT INTO merged_video_sources (id, merged_media_id, source_media_id, sort_order, created_at)
       VALUES (?, ?, ?, 1, ?)`
    ).run(uuidv4(), mergedId, source2Id, now);

    return { userId, tripId, source1Id, source2Id, mergedId, mergedPath };
  }

  it('should preserve merged video when a source video is hard-deleted', () => {
    const { source1Id, mergedId } = setupTestData();
    const db = getDb();

    // Delete source video 1
    deleteMediaItemFromDb(source1Id);

    // Verify source video is gone
    const sourceRow = db.prepare('SELECT * FROM media_items WHERE id = ?').get(source1Id);
    expect(sourceRow).toBeUndefined();

    // Verify merged video still exists and is active
    const mergedRow = db.prepare('SELECT * FROM media_items WHERE id = ?').get(mergedId) as any;
    expect(mergedRow).toBeDefined();
    expect(mergedRow.status).toBe('active');
    expect(mergedRow.media_source).toBe('merged');
    expect(mergedRow.file_path).toBeTruthy();
  });

  it('should set source_media_id to NULL when source video is deleted', () => {
    const { source1Id, source2Id, mergedId } = setupTestData();
    const db = getDb();

    // Delete source video 1
    deleteMediaItemFromDb(source1Id);

    // Verify merged_video_sources: source1 reference should be NULL
    const sources = db.prepare(
      'SELECT * FROM merged_video_sources WHERE merged_media_id = ? ORDER BY sort_order'
    ).all(mergedId) as any[];

    expect(sources).toHaveLength(2);
    // First source should be NULL (deleted)
    expect(sources[0].source_media_id).toBeNull();
    expect(sources[0].sort_order).toBe(0);
    // Second source should still reference source2
    expect(sources[1].source_media_id).toBe(source2Id);
    expect(sources[1].sort_order).toBe(1);
  });

  it('should preserve merged video when all source videos are deleted', () => {
    const { source1Id, source2Id, mergedId, mergedPath } = setupTestData();
    const db = getDb();

    // Delete both source videos
    deleteMediaItemFromDb(source1Id);
    deleteMediaItemFromDb(source2Id);

    // Verify merged video still exists with its own file path
    const mergedRow = db.prepare('SELECT * FROM media_items WHERE id = ?').get(mergedId) as any;
    expect(mergedRow).toBeDefined();
    expect(mergedRow.status).toBe('active');
    expect(mergedRow.file_path).toBe(mergedPath);
    expect(mergedRow.compiled_path).toBe(mergedPath);

    // All source references should be NULL
    const sources = db.prepare(
      'SELECT * FROM merged_video_sources WHERE merged_media_id = ?'
    ).all(mergedId) as any[];
    expect(sources).toHaveLength(2);
    expect(sources.every((s: any) => s.source_media_id === null)).toBe(true);
  });

  it('should clean up merged_video_sources when merged video is deleted', () => {
    const { mergedId } = setupTestData();
    const db = getDb();

    // Delete the merged video
    deleteMediaItemFromDb(mergedId);

    // Verify merged_video_sources records are cleaned up
    const sources = db.prepare(
      'SELECT * FROM merged_video_sources WHERE merged_media_id = ?'
    ).all(mergedId) as any[];
    expect(sources).toHaveLength(0);
  });

  it('should not affect merged video when source video is soft-deleted (trashed)', () => {
    const { source1Id, mergedId } = setupTestData();
    const db = getDb();

    // Soft-delete (trash) source video 1
    db.prepare("UPDATE media_items SET status = 'trashed' WHERE id = ?").run(source1Id);

    // Verify merged video is unaffected
    const mergedRow = db.prepare('SELECT * FROM media_items WHERE id = ?').get(mergedId) as any;
    expect(mergedRow).toBeDefined();
    expect(mergedRow.status).toBe('active');

    // Verify merged_video_sources still has the reference (soft delete doesn't trigger FK)
    const sources = db.prepare(
      'SELECT * FROM merged_video_sources WHERE merged_media_id = ? ORDER BY sort_order'
    ).all(mergedId) as any[];
    expect(sources).toHaveLength(2);
    expect(sources[0].source_media_id).toBe(source1Id);
  });
});
