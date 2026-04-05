import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import { authMiddleware } from '../middleware/auth';
import tripsRouter from './trips';
import galleryRouter from './gallery';

const app = express();
app.use(express.json());
app.use(authMiddleware);
app.use('/api/trips', tripsRouter);
app.use('/api/trips', galleryRouter);

function createTestUser(role: 'admin' | 'regular' = 'regular'): { userId: string; token: string } {
  const db = getDb();
  const userId = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`
  ).run(userId, `user_${userId.slice(0, 8)}`, 'hash', role, now, now);
  const token = signToken({ userId, role });
  return { userId, token };
}

function createTrip(userId: string): string {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO trips (id, title, description, visibility, user_id, created_at, updated_at)
     VALUES (?, ?, ?, 'public', ?, ?, ?)`
  ).run(id, 'Test Trip', null, userId, now, now);
  return id;
}

function createMediaItem(
  tripId: string,
  mediaType: 'image' | 'video',
  opts?: { duplicateGroupId?: string; mimeType?: string; visibility?: string }
): string {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const mime = opts?.mimeType ?? (mediaType === 'image' ? 'image/jpeg' : 'video/mp4');
  const visibility = opts?.visibility ?? 'public';
  db.prepare(
    `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, duplicate_group_id, visibility, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, tripId, `${tripId}/originals/${id}.${mediaType === 'image' ? 'jpg' : 'mp4'}`,
    mediaType, mime, `test.${mediaType === 'image' ? 'jpg' : 'mp4'}`, 1024,
    opts?.duplicateGroupId ?? null, visibility, now
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

function createTag(mediaId: string, tagName: string): void {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_tags (id, media_id, tag_name, created_at) VALUES (?, ?, ?, ?)`
  ).run(id, mediaId, tagName, now);
}

describe('GET /api/trips/:id/gallery', () => {
  let owner: { userId: string; token: string };

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');
    owner = createTestUser('regular');
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
    const tripId = createTrip(owner.userId);

    const res = await request(app).get(`/api/trips/${tripId}/gallery`);
    expect(res.status).toBe(200);
    expect(res.body.trip.id).toBe(tripId);
    expect(res.body.images).toEqual([]);
    expect(res.body.videos).toEqual([]);
  });

  it('should return mixed images and videos correctly partitioned', async () => {
    const tripId = createTrip(owner.userId);

    const img1 = createMediaItem(tripId, 'image');
    const img2 = createMediaItem(tripId, 'image');
    const vid1 = createMediaItem(tripId, 'video');
    const vid2 = createMediaItem(tripId, 'video');

    const res = await request(app).get(`/api/trips/${tripId}/gallery`);
    expect(res.status).toBe(200);

    expect(res.body.images).toHaveLength(2);
    for (const img of res.body.images) {
      expect(img.item.mediaType).toBe('image');
      expect(img.isDefault).toBe(false);
      expect(img.duplicateGroup).toBeUndefined();
      expect(img.thumbnailUrl).toMatch(/^\/api\/media\/.+\/thumbnail$/);
      expect(img.originalUrl).toMatch(/^\/api\/media\/.+\/original$/);
    }

    expect(res.body.videos).toHaveLength(2);
    for (const vid of res.body.videos) {
      expect(vid.mediaType).toBe('video');
      expect(vid.thumbnailUrl).toBe('');
    }

    const imageIds = res.body.images.map((i: any) => i.item.id);
    expect(imageIds).toContain(img1);
    expect(imageIds).toContain(img2);

    const videoIds = res.body.videos.map((v: any) => v.id);
    expect(videoIds).toContain(vid1);
    expect(videoIds).toContain(vid2);
  });

  it('should only show default images for duplicate groups', async () => {
    const tripId = createTrip(owner.userId);

    const img1 = createMediaItem(tripId, 'image');
    const img2 = createMediaItem(tripId, 'image');
    const img3 = createMediaItem(tripId, 'image');

    const groupId = createDuplicateGroup(tripId, img1, 2);

    const db = getDb();
    db.prepare('UPDATE media_items SET duplicate_group_id = ? WHERE id = ?').run(groupId, img1);
    db.prepare('UPDATE media_items SET duplicate_group_id = ? WHERE id = ?').run(groupId, img2);

    const res = await request(app).get(`/api/trips/${tripId}/gallery`);
    expect(res.status).toBe(200);

    expect(res.body.images).toHaveLength(2);

    const defaultImg = res.body.images.find((i: any) => i.isDefault);
    expect(defaultImg).toBeDefined();
    expect(defaultImg.item.id).toBe(img1);
    expect(defaultImg.duplicateGroup).toBeDefined();
    expect(defaultImg.duplicateGroup.id).toBe(groupId);

    const ungroupedImg = res.body.images.find((i: any) => !i.isDefault);
    expect(ungroupedImg).toBeDefined();
    expect(ungroupedImg.item.id).toBe(img3);

    const allImageIds = res.body.images.map((i: any) => i.item.id);
    expect(allImageIds).not.toContain(img2);
  });

  it('should include correct thumbnail and original URLs', async () => {
    const tripId = createTrip(owner.userId);
    const imgId = createMediaItem(tripId, 'image');

    const res = await request(app).get(`/api/trips/${tripId}/gallery`);
    expect(res.status).toBe(200);
    expect(res.body.images).toHaveLength(1);
    expect(res.body.images[0].thumbnailUrl).toBe(`/api/media/${imgId}/thumbnail`);
    expect(res.body.images[0].originalUrl).toBe(`/api/media/${imgId}/original`);
  });

  it('should return thumbnailUrl for videos with thumbnail_path', async () => {
    const tripId = createTrip(owner.userId);
    const vidId = createMediaItem(tripId, 'video');

    const db = getDb();
    db.prepare('UPDATE media_items SET thumbnail_path = ? WHERE id = ?').run(
      `${tripId}/thumbnails/${vidId}_thumb.webp`, vidId
    );

    const res = await request(app).get(`/api/trips/${tripId}/gallery`);
    expect(res.status).toBe(200);
    expect(res.body.videos).toHaveLength(1);
    expect(res.body.videos[0].thumbnailUrl).toBe(`/api/media/${vidId}/thumbnail`);
  });

  it('should return empty thumbnailUrl for videos without thumbnail_path', async () => {
    const tripId = createTrip(owner.userId);
    createMediaItem(tripId, 'video');

    const res = await request(app).get(`/api/trips/${tripId}/gallery`);
    expect(res.status).toBe(200);
    expect(res.body.videos).toHaveLength(1);
    expect(res.body.videos[0].thumbnailUrl).toBe('');
  });

  describe('visibility filtering', () => {
    it('should only return public media items for unauthenticated access', async () => {
      const tripId = createTrip(owner.userId);

      const publicImg = createMediaItem(tripId, 'image', { visibility: 'public' });
      createMediaItem(tripId, 'image', { visibility: 'private' });
      const publicVid = createMediaItem(tripId, 'video', { visibility: 'public' });
      createMediaItem(tripId, 'video', { visibility: 'private' });

      const res = await request(app).get(`/api/trips/${tripId}/gallery`);
      expect(res.status).toBe(200);

      expect(res.body.images).toHaveLength(1);
      expect(res.body.images[0].item.id).toBe(publicImg);
      expect(res.body.videos).toHaveLength(1);
      expect(res.body.videos[0].id).toBe(publicVid);
    });

    it('should only return public media items for non-owner authenticated user', async () => {
      const tripId = createTrip(owner.userId);

      const publicImg = createMediaItem(tripId, 'image', { visibility: 'public' });
      createMediaItem(tripId, 'image', { visibility: 'private' });
      const publicVid = createMediaItem(tripId, 'video', { visibility: 'public' });
      createMediaItem(tripId, 'video', { visibility: 'private' });

      const other = createTestUser('regular');
      const res = await request(app)
        .get(`/api/trips/${tripId}/gallery`)
        .set('Authorization', `Bearer ${other.token}`);
      expect(res.status).toBe(200);

      expect(res.body.images).toHaveLength(1);
      expect(res.body.images[0].item.id).toBe(publicImg);
      expect(res.body.videos).toHaveLength(1);
      expect(res.body.videos[0].id).toBe(publicVid);
    });

    it('should return all media items for the trip owner', async () => {
      const tripId = createTrip(owner.userId);

      createMediaItem(tripId, 'image', { visibility: 'public' });
      createMediaItem(tripId, 'image', { visibility: 'private' });
      createMediaItem(tripId, 'video', { visibility: 'public' });
      createMediaItem(tripId, 'video', { visibility: 'private' });

      const res = await request(app)
        .get(`/api/trips/${tripId}/gallery`)
        .set('Authorization', `Bearer ${owner.token}`);
      expect(res.status).toBe(200);

      expect(res.body.images).toHaveLength(2);
      expect(res.body.videos).toHaveLength(2);
    });

    it('should return all media items for an admin', async () => {
      const tripId = createTrip(owner.userId);

      createMediaItem(tripId, 'image', { visibility: 'public' });
      createMediaItem(tripId, 'image', { visibility: 'private' });
      createMediaItem(tripId, 'video', { visibility: 'public' });
      createMediaItem(tripId, 'video', { visibility: 'private' });

      const admin = createTestUser('admin');
      const res = await request(app)
        .get(`/api/trips/${tripId}/gallery`)
        .set('Authorization', `Bearer ${admin.token}`);
      expect(res.status).toBe(200);

      expect(res.body.images).toHaveLength(2);
      expect(res.body.videos).toHaveLength(2);
    });

    it('should return empty arrays when all media is private and user is not owner', async () => {
      const tripId = createTrip(owner.userId);

      createMediaItem(tripId, 'image', { visibility: 'private' });
      createMediaItem(tripId, 'video', { visibility: 'private' });

      const res = await request(app).get(`/api/trips/${tripId}/gallery`);
      expect(res.status).toBe(200);

      expect(res.body.images).toHaveLength(0);
      expect(res.body.videos).toHaveLength(0);
    });
  });

  describe('category filtering', () => {
    function setCategory(mediaId: string, category: string): void {
      const db = getDb();
      db.prepare('UPDATE media_items SET category = ? WHERE id = ?').run(category, mediaId);
    }

    it('should return only images matching the specified category', async () => {
      const tripId = createTrip(owner.userId);

      const img1 = createMediaItem(tripId, 'image');
      const img2 = createMediaItem(tripId, 'image');
      const img3 = createMediaItem(tripId, 'image');
      setCategory(img1, 'landscape');
      setCategory(img2, 'people');
      setCategory(img3, 'landscape');

      const res = await request(app).get(`/api/trips/${tripId}/gallery?category=landscape`);
      expect(res.status).toBe(200);

      expect(res.body.images).toHaveLength(2);
      const ids = res.body.images.map((i: any) => i.item.id);
      expect(ids).toContain(img1);
      expect(ids).toContain(img3);
    });

    it('should return all media when no category parameter is provided', async () => {
      const tripId = createTrip(owner.userId);

      const img1 = createMediaItem(tripId, 'image');
      const img2 = createMediaItem(tripId, 'image');
      setCategory(img1, 'landscape');
      setCategory(img2, 'people');

      const res = await request(app).get(`/api/trips/${tripId}/gallery`);
      expect(res.status).toBe(200);

      expect(res.body.images).toHaveLength(2);
    });

    it('should return empty results when no media matches the category', async () => {
      const tripId = createTrip(owner.userId);

      createMediaItem(tripId, 'image');
      setCategory(createMediaItem(tripId, 'image'), 'landscape');

      const res = await request(app).get(`/api/trips/${tripId}/gallery?category=animal`);
      expect(res.status).toBe(200);

      expect(res.body.images).toHaveLength(0);
    });

    it('should ignore invalid category values and return all media', async () => {
      const tripId = createTrip(owner.userId);

      createMediaItem(tripId, 'image');
      createMediaItem(tripId, 'image');

      const res = await request(app).get(`/api/trips/${tripId}/gallery?category=invalid`);
      expect(res.status).toBe(200);

      expect(res.body.images).toHaveLength(2);
    });

    it('should include category field in image items', async () => {
      const tripId = createTrip(owner.userId);

      const img1 = createMediaItem(tripId, 'image');
      setCategory(img1, 'people');

      const res = await request(app).get(`/api/trips/${tripId}/gallery`);
      expect(res.status).toBe(200);

      expect(res.body.images).toHaveLength(1);
      expect(res.body.images[0].item.category).toBe('people');
    });

    it('should filter videos by category too', async () => {
      const tripId = createTrip(owner.userId);

      const vid1 = createMediaItem(tripId, 'video');
      const vid2 = createMediaItem(tripId, 'video');
      setCategory(vid1, 'animal');
      setCategory(vid2, 'landscape');

      const res = await request(app).get(`/api/trips/${tripId}/gallery?category=animal`);
      expect(res.status).toBe(200);

      expect(res.body.videos).toHaveLength(1);
      expect(res.body.videos[0].id).toBe(vid1);
    });
  });

  describe('tag filtering', () => {
    it('should return only images with the specified tag', async () => {
      const tripId = createTrip(owner.userId);

      const img1 = createMediaItem(tripId, 'image');
      const img2 = createMediaItem(tripId, 'image');
      createTag(img1, 'sunset');

      const res = await request(app).get(`/api/trips/${tripId}/gallery?tag=sunset`);
      expect(res.status).toBe(200);

      expect(res.body.images).toHaveLength(1);
      expect(res.body.images[0].item.id).toBe(img1);
    });

    it('should return only videos with the specified tag', async () => {
      const tripId = createTrip(owner.userId);

      const vid1 = createMediaItem(tripId, 'video');
      const vid2 = createMediaItem(tripId, 'video');
      createTag(vid1, 'beach');

      const res = await request(app).get(`/api/trips/${tripId}/gallery?tag=beach`);
      expect(res.status).toBe(200);

      expect(res.body.videos).toHaveLength(1);
      expect(res.body.videos[0].id).toBe(vid1);
      expect(res.body.images).toHaveLength(0);
    });

    it('should normalize the tag query parameter (lowercase, no spaces)', async () => {
      const tripId = createTrip(owner.userId);

      const img1 = createMediaItem(tripId, 'image');
      createTag(img1, 'mytrip');

      const res = await request(app).get(`/api/trips/${tripId}/gallery?tag=My Trip`);
      expect(res.status).toBe(200);

      expect(res.body.images).toHaveLength(1);
      expect(res.body.images[0].item.id).toBe(img1);
    });

    it('should return empty results when no media matches the tag', async () => {
      const tripId = createTrip(owner.userId);

      createMediaItem(tripId, 'image');
      createMediaItem(tripId, 'video');

      const res = await request(app).get(`/api/trips/${tripId}/gallery?tag=nonexistent`);
      expect(res.status).toBe(200);

      expect(res.body.images).toHaveLength(0);
      expect(res.body.videos).toHaveLength(0);
    });

    it('should return all media when no tag parameter is provided', async () => {
      const tripId = createTrip(owner.userId);

      const img1 = createMediaItem(tripId, 'image');
      const vid1 = createMediaItem(tripId, 'video');
      createTag(img1, 'sunset');

      const res = await request(app).get(`/api/trips/${tripId}/gallery`);
      expect(res.status).toBe(200);

      expect(res.body.images).toHaveLength(1);
      expect(res.body.videos).toHaveLength(1);
    });

    it('should filter both images and videos with the same tag', async () => {
      const tripId = createTrip(owner.userId);

      const img1 = createMediaItem(tripId, 'image');
      const vid1 = createMediaItem(tripId, 'video');
      const img2 = createMediaItem(tripId, 'image');
      createTag(img1, '2024-01');
      createTag(vid1, '2024-01');

      const res = await request(app).get(`/api/trips/${tripId}/gallery?tag=2024-01`);
      expect(res.status).toBe(200);

      expect(res.body.images).toHaveLength(1);
      expect(res.body.images[0].item.id).toBe(img1);
      expect(res.body.videos).toHaveLength(1);
      expect(res.body.videos[0].id).toBe(vid1);
    });
  });
});
