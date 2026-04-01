import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import tripsRouter from './trips';
import galleryRouter from './gallery';

const app = express();
app.use(express.json());
app.use('/api/trips', tripsRouter);
app.use('/api/trips', galleryRouter);

function createMediaItem(
  tripId: string,
  mediaType: 'image' | 'video',
  opts?: { duplicateGroupId?: string; mimeType?: string }
): string {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const mime = opts?.mimeType ?? (mediaType === 'image' ? 'image/jpeg' : 'video/mp4');
  db.prepare(
    `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, duplicate_group_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, tripId, `uploads/${tripId}/originals/${id}.${mediaType === 'image' ? 'jpg' : 'mp4'}`,
    mediaType, mime, `test.${mediaType === 'image' ? 'jpg' : 'mp4'}`, 1024,
    opts?.duplicateGroupId ?? null, now
  );
  return id;
}

function createDuplicateGroup(tripId: string, defaultImageId: string, imageCount: number): string {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO duplicate_groups (id, trip_id, default_image_id, image_count, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, tripId, defaultImageId, imageCount, now);
  return id;
}

describe('GET /api/trips/:id/gallery', () => {
  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');
  });

  afterEach(() => {
    closeDb();
  });

  it('should return 404 for non-existent trip', async () => {
    const res = await request(app).get('/api/trips/non-existent-id/gallery');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return empty images and videos for trip with no media', async () => {
    const trip = await request(app).post('/api/trips').send({ title: 'Empty Trip' });

    const res = await request(app).get(`/api/trips/${trip.body.id}/gallery`);
    expect(res.status).toBe(200);
    expect(res.body.trip.id).toBe(trip.body.id);
    expect(res.body.trip.title).toBe('Empty Trip');
    expect(res.body.images).toEqual([]);
    expect(res.body.videos).toEqual([]);
  });

  it('should return mixed images and videos correctly partitioned', async () => {
    const trip = await request(app).post('/api/trips').send({ title: 'Mixed Trip' });
    const tripId = trip.body.id;

    // Create ungrouped images and videos
    const img1 = createMediaItem(tripId, 'image');
    const img2 = createMediaItem(tripId, 'image');
    const vid1 = createMediaItem(tripId, 'video');
    const vid2 = createMediaItem(tripId, 'video');

    const res = await request(app).get(`/api/trips/${tripId}/gallery`);
    expect(res.status).toBe(200);

    // All images should be ungrouped
    expect(res.body.images).toHaveLength(2);
    for (const img of res.body.images) {
      expect(img.item.mediaType).toBe('image');
      expect(img.isDefault).toBe(false);
      expect(img.duplicateGroup).toBeUndefined();
      expect(img.thumbnailUrl).toMatch(/^\/api\/media\/.+\/thumbnail$/);
      expect(img.originalUrl).toMatch(/^\/api\/media\/.+\/original$/);
    }

    // All videos
    expect(res.body.videos).toHaveLength(2);
    for (const vid of res.body.videos) {
      expect(vid.mediaType).toBe('video');
      // Videos without thumbnail_path should have empty thumbnailUrl
      expect(vid.thumbnailUrl).toBe('');
    }

    // Verify specific IDs are present
    const imageIds = res.body.images.map((i: any) => i.item.id);
    expect(imageIds).toContain(img1);
    expect(imageIds).toContain(img2);

    const videoIds = res.body.videos.map((v: any) => v.id);
    expect(videoIds).toContain(vid1);
    expect(videoIds).toContain(vid2);
  });

  it('should only show default images for duplicate groups', async () => {
    const trip = await request(app).post('/api/trips').send({ title: 'Dedup Trip' });
    const tripId = trip.body.id;

    // Create images first (without group assignment)
    const img1 = createMediaItem(tripId, 'image');
    const img2 = createMediaItem(tripId, 'image');
    const img3 = createMediaItem(tripId, 'image'); // ungrouped

    // Create a duplicate group with img1 as default
    const groupId = createDuplicateGroup(tripId, img1, 2);

    // Assign images to the group
    const db = getDb();
    db.prepare('UPDATE media_items SET duplicate_group_id = ? WHERE id = ?').run(groupId, img1);
    db.prepare('UPDATE media_items SET duplicate_group_id = ? WHERE id = ?').run(groupId, img2);

    const res = await request(app).get(`/api/trips/${tripId}/gallery`);
    expect(res.status).toBe(200);

    // Should have 2 images: the default from the group + the ungrouped one
    expect(res.body.images).toHaveLength(2);

    const defaultImg = res.body.images.find((i: any) => i.isDefault);
    expect(defaultImg).toBeDefined();
    expect(defaultImg.item.id).toBe(img1);
    expect(defaultImg.duplicateGroup).toBeDefined();
    expect(defaultImg.duplicateGroup.id).toBe(groupId);
    expect(defaultImg.duplicateGroup.defaultImageId).toBe(img1);

    const ungroupedImg = res.body.images.find((i: any) => !i.isDefault);
    expect(ungroupedImg).toBeDefined();
    expect(ungroupedImg.item.id).toBe(img3);
    expect(ungroupedImg.duplicateGroup).toBeUndefined();

    // img2 should NOT appear (it's in the group but not the default)
    const allImageIds = res.body.images.map((i: any) => i.item.id);
    expect(allImageIds).not.toContain(img2);
  });

  it('should include correct thumbnail and original URLs', async () => {
    const trip = await request(app).post('/api/trips').send({ title: 'URL Trip' });
    const tripId = trip.body.id;
    const imgId = createMediaItem(tripId, 'image');

    const res = await request(app).get(`/api/trips/${tripId}/gallery`);
    expect(res.status).toBe(200);
    expect(res.body.images).toHaveLength(1);
    expect(res.body.images[0].thumbnailUrl).toBe(`/api/media/${imgId}/thumbnail`);
    expect(res.body.images[0].originalUrl).toBe(`/api/media/${imgId}/original`);
  });

  it('should return thumbnailUrl for videos with thumbnail_path', async () => {
    const trip = await request(app).post('/api/trips').send({ title: 'Video Thumb Trip' });
    const tripId = trip.body.id;
    const vidId = createMediaItem(tripId, 'video');

    // Set thumbnail_path in DB
    const db = getDb();
    db.prepare('UPDATE media_items SET thumbnail_path = ? WHERE id = ?').run(
      `uploads/${tripId}/thumbnails/${vidId}_thumb.webp`, vidId
    );

    const res = await request(app).get(`/api/trips/${tripId}/gallery`);
    expect(res.status).toBe(200);
    expect(res.body.videos).toHaveLength(1);
    expect(res.body.videos[0].thumbnailUrl).toBe(`/api/media/${vidId}/thumbnail`);
  });

  it('should return empty thumbnailUrl for videos without thumbnail_path', async () => {
    const trip = await request(app).post('/api/trips').send({ title: 'No Thumb Trip' });
    const tripId = trip.body.id;
    const vidId = createMediaItem(tripId, 'video');

    const res = await request(app).get(`/api/trips/${tripId}/gallery`);
    expect(res.status).toBe(200);
    expect(res.body.videos).toHaveLength(1);
    expect(res.body.videos[0].thumbnailUrl).toBe('');
  });
});
