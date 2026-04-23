import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import { signToken } from '../services/authService';
import { authMiddleware } from '../middleware/auth';
import tripsRouter from './trips';
import galleryRouter from './gallery';

/**
 * Feature: travel-album-site
 * Property 13: Gallery 数据的图片/视频分区
 *
 * For any 旅行的 Gallery 数据，images 数组中的每个元素的 mediaType 应为 `image`，
 * videos 数组中的每个元素的 mediaType 应为 `video`，
 * 且两个数组的元素总数应等于该旅行的全部可展示素材数。
 *
 * Validates: Requirements 6.4
 */

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

function insertMediaItem(
  tripId: string,
  mediaType: 'image' | 'video',
  duplicateGroupId: string | null
): string {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const mime = mediaType === 'image' ? 'image/jpeg' : 'video/mp4';
  const ext = mediaType === 'image' ? 'jpg' : 'mp4';
  // Retrieve the trip's user_id so media is owned correctly
  const trip = db.prepare('SELECT user_id FROM trips WHERE id = ?').get(tripId) as { user_id: string } | undefined;
  const userId = trip?.user_id ?? null;
  db.prepare(
    `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, duplicate_group_id, user_id, visibility, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'public', ?)`
  ).run(id, tripId, `${tripId}/originals/${id}.${ext}`, mediaType, mime, `file.${ext}`, 1024, duplicateGroupId, userId, now);
  return id;
}

function insertDuplicateGroup(tripId: string, defaultImageId: string, imageCount: number): string {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO duplicate_groups (id, trip_id, default_image_id, image_count, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, tripId, defaultImageId, imageCount, now);
  return id;
}

describe('Property 13: Gallery 数据的图片/视频分区', () => {
  let owner: { userId: string; token: string };

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM upload_sessions');
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');
    owner = createTestUser('regular');
  });

  afterEach(() => {
    closeDb();
  });

  it('images array contains only image items, videos array contains only video items, and total count equals all displayable media', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a random mix of ungrouped images, duplicate groups, and videos
        fc.record({
          ungroupedImageCount: fc.integer({ min: 0, max: 5 }),
          // Each group has a size >= 2 (a group of 1 wouldn't be a real duplicate group)
          duplicateGroups: fc.array(fc.integer({ min: 2, max: 4 }), { minLength: 0, maxLength: 3 }),
          videoCount: fc.integer({ min: 0, max: 5 }),
        }),
        async ({ ungroupedImageCount, duplicateGroups, videoCount }) => {
          // Clean slate for each run
          const db = getDb();
          db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM upload_sessions');
    db.exec('DELETE FROM media_tags');
          db.exec('DELETE FROM media_items');
          db.exec('DELETE FROM duplicate_groups');
          db.exec('DELETE FROM trips');

          // Create a trip with auth
          const tripRes = await request(app)
            .post('/api/trips')
            .set('Authorization', `Bearer ${owner.token}`)
            .send({ title: 'Property Test Trip' });
          expect(tripRes.status).toBe(201);
          const tripId = tripRes.body.id;

          // Track expected displayable counts
          // Each duplicate group contributes exactly 1 displayable image (the default)
          // Each ungrouped image contributes 1 displayable image
          const expectedDisplayableImages = ungroupedImageCount + duplicateGroups.length;

          // Insert ungrouped images
          for (let i = 0; i < ungroupedImageCount; i++) {
            insertMediaItem(tripId, 'image', null);
          }

          // Insert duplicate groups: for each group, create N images, pick first as default
          for (const groupSize of duplicateGroups) {
            // Create images for this group (without group assignment first)
            const imageIds: string[] = [];
            for (let i = 0; i < groupSize; i++) {
              imageIds.push(insertMediaItem(tripId, 'image', null));
            }
            // Create the group with first image as default
            const groupId = insertDuplicateGroup(tripId, imageIds[0], groupSize);
            // Assign all images to the group
            for (const imgId of imageIds) {
              db.prepare('UPDATE media_items SET duplicate_group_id = ? WHERE id = ?').run(groupId, imgId);
            }
          }

          // Insert videos
          for (let i = 0; i < videoCount; i++) {
            insertMediaItem(tripId, 'video', null);
          }

          // Fetch gallery as owner so all public media is visible
          const res = await request(app)
            .get(`/api/trips/${tripId}/gallery`)
            .set('Authorization', `Bearer ${owner.token}`);
          expect(res.status).toBe(200);

          const { images, videos } = res.body;

          // Property: every element in images has mediaType === 'image'
          for (const img of images) {
            expect(img.item.mediaType).toBe('image');
          }

          // Property: every element in videos has mediaType === 'video'
          for (const vid of videos) {
            expect(vid.mediaType).toBe('video');
          }

          // Property: images count equals expected displayable images
          expect(images.length).toBe(expectedDisplayableImages);

          // Property: videos count equals inserted video count
          expect(videos.length).toBe(videoCount);

          // Property: total displayable count = images + videos
          expect(images.length + videos.length).toBe(expectedDisplayableImages + videoCount);
        }
      ),
      { numRuns: 100 }
    );
  });
});
