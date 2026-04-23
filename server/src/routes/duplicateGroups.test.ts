import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import duplicateGroupsRouter from './duplicateGroups';

const app = express();
app.use(express.json());
app.use('/api/duplicate-groups', duplicateGroupsRouter);

function seedGroup(db: ReturnType<typeof getDb>) {
  const tripId = uuidv4();
  const groupId = uuidv4();
  const imageId1 = uuidv4();
  const imageId2 = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    'INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(tripId, 'Test Trip', now, now);

  db.prepare(
    'INSERT INTO duplicate_groups (id, trip_id, default_image_id, image_count, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(groupId, tripId, imageId1, 2, now);

  db.prepare(
    `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, duplicate_group_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(imageId1, tripId, '/fake/path1.jpg', 'image', 'image/jpeg', 'img1.jpg', 1000, groupId, now);

  db.prepare(
    `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, duplicate_group_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(imageId2, tripId, '/fake/path2.jpg', 'image', 'image/jpeg', 'img2.jpg', 2000, groupId, now);

  return { tripId, groupId, imageId1, imageId2 };
}

describe('PUT /api/duplicate-groups/:id/default', () => {
  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM upload_sessions');
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');
  });

  afterEach(() => {
    closeDb();
  });

  it('should swap the default image successfully', async () => {
    const db = getDb();
    const { groupId, imageId2 } = seedGroup(db);

    const res = await request(app)
      .put(`/api/duplicate-groups/${groupId}/default`)
      .send({ imageId: imageId2 });

    expect(res.status).toBe(200);
    expect(res.body.defaultImageId).toBe(imageId2);
    expect(res.body.id).toBe(groupId);
  });

  it('should return 404 for non-existent group', async () => {
    const res = await request(app)
      .put('/api/duplicate-groups/non-existent-id/default')
      .send({ imageId: 'some-image-id' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should return 400 when image does not belong to group', async () => {
    const db = getDb();
    const { groupId, tripId } = seedGroup(db);

    // Create an image that belongs to no group
    const outsideImageId = uuidv4();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(outsideImageId, tripId, '/fake/other.jpg', 'image', 'image/jpeg', 'other.jpg', 500, now);

    const res = await request(app)
      .put(`/api/duplicate-groups/${groupId}/default`)
      .send({ imageId: outsideImageId });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IMAGE_NOT_IN_GROUP');
  });

  it('should return 400 when imageId is missing', async () => {
    const db = getDb();
    const { groupId } = seedGroup(db);

    const res = await request(app)
      .put(`/api/duplicate-groups/${groupId}/default`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_IMAGE_ID');
  });
});
