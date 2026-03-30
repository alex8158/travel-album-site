import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import tripsRouter from './trips';

const app = express();
app.use(express.json());
app.use('/api/trips', tripsRouter);

describe('Trips CRUD API', () => {
  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');
  });

  afterEach(() => {
    closeDb();
  });

  describe('POST /api/trips', () => {
    it('should create a trip with title and description', async () => {
      const res = await request(app)
        .post('/api/trips')
        .send({ title: 'Tokyo Trip', description: 'Cherry blossoms' });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Tokyo Trip');
      expect(res.body.description).toBe('Cherry blossoms');
      expect(res.body.id).toBeDefined();
      expect(res.body.createdAt).toBeDefined();
      expect(res.body.updatedAt).toBeDefined();
    });

    it('should create a trip without description', async () => {
      const res = await request(app)
        .post('/api/trips')
        .send({ title: 'Paris Trip' });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Paris Trip');
      expect(res.body.description).toBeUndefined();
    });

    it('should return 400 when title is empty', async () => {
      const res = await request(app)
        .post('/api/trips')
        .send({ title: '' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TITLE');
    });

    it('should return 400 when title is whitespace only', async () => {
      const res = await request(app)
        .post('/api/trips')
        .send({ title: '   ' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when title is missing', async () => {
      const res = await request(app)
        .post('/api/trips')
        .send({ description: 'No title' });

      expect(res.status).toBe(400);
    });

    it('should trim the title', async () => {
      const res = await request(app)
        .post('/api/trips')
        .send({ title: '  Rome Trip  ' });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Rome Trip');
    });
  });

  describe('GET /api/trips', () => {
    it('should return empty array when no trips', async () => {
      const res = await request(app).get('/api/trips');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('should return trips ordered by created_at DESC', async () => {
      await request(app).post('/api/trips').send({ title: 'First' });
      // Small delay to ensure different timestamps
      await new Promise(r => setTimeout(r, 10));
      await request(app).post('/api/trips').send({ title: 'Second' });

      const res = await request(app).get('/api/trips');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].title).toBe('Second');
      expect(res.body[1].title).toBe('First');
    });

    it('should return TripSummary format with required fields', async () => {
      await request(app).post('/api/trips').send({ title: 'Trip', description: 'A nice trip' });

      const res = await request(app).get('/api/trips');
      expect(res.status).toBe(200);
      const summary = res.body[0];
      expect(summary).toHaveProperty('id');
      expect(summary).toHaveProperty('title', 'Trip');
      expect(summary).toHaveProperty('descriptionExcerpt', 'A nice trip');
      expect(summary).toHaveProperty('coverImageUrl');
      expect(summary).toHaveProperty('mediaCount', 0);
      expect(summary).toHaveProperty('createdAt');
    });

    it('should truncate long descriptions to excerpt', async () => {
      const longDesc = 'A'.repeat(150);
      await request(app).post('/api/trips').send({ title: 'Trip', description: longDesc });

      const res = await request(app).get('/api/trips');
      const summary = res.body[0];
      expect(summary.descriptionExcerpt).toBe('A'.repeat(100) + '...');
    });

    it('should return undefined descriptionExcerpt when no description', async () => {
      await request(app).post('/api/trips').send({ title: 'Trip' });

      const res = await request(app).get('/api/trips');
      expect(res.body[0].descriptionExcerpt).toBeUndefined();
    });

    it('should return coverImageUrl from cover_image_id', async () => {
      const trip = await request(app).post('/api/trips').send({ title: 'Trip' });
      const db = getDb();
      const mediaId = uuidv4();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(mediaId, trip.body.id, `uploads/${trip.body.id}/originals/${mediaId}.jpg`, 'image', 'image/jpeg', 'test.jpg', 1024, now);
      db.prepare('UPDATE trips SET cover_image_id = ? WHERE id = ?').run(mediaId, trip.body.id);

      const res = await request(app).get('/api/trips');
      expect(res.body[0].coverImageUrl).toBe(`/api/media/${mediaId}/thumbnail`);
    });

    it('should return empty coverImageUrl when no cover image', async () => {
      await request(app).post('/api/trips').send({ title: 'Trip' });

      const res = await request(app).get('/api/trips');
      expect(res.body[0].coverImageUrl).toBe('');
    });

    it('should return correct mediaCount', async () => {
      const trip = await request(app).post('/api/trips').send({ title: 'Trip' });
      const db = getDb();
      const now = new Date().toISOString();
      for (let i = 0; i < 3; i++) {
        const id = uuidv4();
        db.prepare(
          `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, trip.body.id, `uploads/${trip.body.id}/originals/${id}.jpg`, 'image', 'image/jpeg', `test${i}.jpg`, 1024, now);
      }

      const res = await request(app).get('/api/trips');
      expect(res.body[0].mediaCount).toBe(3);
    });
  });

  describe('GET /api/trips/:id', () => {
    it('should return a trip by id', async () => {
      const created = await request(app)
        .post('/api/trips')
        .send({ title: 'Berlin Trip' });

      const res = await request(app).get(`/api/trips/${created.body.id}`);
      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Berlin Trip');
      expect(res.body.id).toBe(created.body.id);
    });

    it('should return 404 for non-existent trip', async () => {
      const res = await request(app).get('/api/trips/non-existent-id');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('PUT /api/trips/:id', () => {
    it('should update trip title', async () => {
      const created = await request(app)
        .post('/api/trips')
        .send({ title: 'Old Title' });

      const res = await request(app)
        .put(`/api/trips/${created.body.id}`)
        .send({ title: 'New Title' });

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('New Title');
    });

    it('should update trip description', async () => {
      const created = await request(app)
        .post('/api/trips')
        .send({ title: 'Trip', description: 'Old desc' });

      const res = await request(app)
        .put(`/api/trips/${created.body.id}`)
        .send({ description: 'New desc' });

      expect(res.status).toBe(200);
      expect(res.body.description).toBe('New desc');
      expect(res.body.title).toBe('Trip');
    });

    it('should return 400 for empty title on update', async () => {
      const created = await request(app)
        .post('/api/trips')
        .send({ title: 'Trip' });

      const res = await request(app)
        .put(`/api/trips/${created.body.id}`)
        .send({ title: '' });

      expect(res.status).toBe(400);
    });

    it('should return 400 for whitespace-only title on update', async () => {
      const created = await request(app)
        .post('/api/trips')
        .send({ title: 'Trip' });

      const res = await request(app)
        .put(`/api/trips/${created.body.id}`)
        .send({ title: '   ' });

      expect(res.status).toBe(400);
    });

    it('should return 404 for non-existent trip', async () => {
      const res = await request(app)
        .put('/api/trips/non-existent-id')
        .send({ title: 'New Title' });

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/trips/:id/cover', () => {
    function createMediaItem(tripId: string): string {
      const db = getDb();
      const id = uuidv4();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, tripId, `uploads/${tripId}/originals/${id}.jpg`, 'image', 'image/jpeg', 'test.jpg', 1024, now);
      return id;
    }

    it('should set cover image for a trip', async () => {
      const trip = await request(app).post('/api/trips').send({ title: 'Trip' });
      const mediaId = createMediaItem(trip.body.id);

      const res = await request(app)
        .put(`/api/trips/${trip.body.id}/cover`)
        .send({ imageId: mediaId });

      expect(res.status).toBe(200);
      expect(res.body.coverImageId).toBe(mediaId);
    });

    it('should return 404 for non-existent trip', async () => {
      const res = await request(app)
        .put('/api/trips/non-existent-id/cover')
        .send({ imageId: 'some-id' });

      expect(res.status).toBe(404);
    });

    it('should return 400 when imageId is missing', async () => {
      const trip = await request(app).post('/api/trips').send({ title: 'Trip' });

      const res = await request(app)
        .put(`/api/trips/${trip.body.id}/cover`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_IMAGE_ID');
    });

    it('should return 404 when media item does not exist', async () => {
      const trip = await request(app).post('/api/trips').send({ title: 'Trip' });

      const res = await request(app)
        .put(`/api/trips/${trip.body.id}/cover`)
        .send({ imageId: 'non-existent-media' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('MEDIA_NOT_FOUND');
    });

    it('should return 400 when media item belongs to a different trip', async () => {
      const trip1 = await request(app).post('/api/trips').send({ title: 'Trip 1' });
      const trip2 = await request(app).post('/api/trips').send({ title: 'Trip 2' });
      const mediaId = createMediaItem(trip2.body.id);

      const res = await request(app)
        .put(`/api/trips/${trip1.body.id}/cover`)
        .send({ imageId: mediaId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MEDIA_NOT_IN_TRIP');
    });

    it('should allow changing cover image', async () => {
      const trip = await request(app).post('/api/trips').send({ title: 'Trip' });
      const mediaId1 = createMediaItem(trip.body.id);
      const mediaId2 = createMediaItem(trip.body.id);

      await request(app)
        .put(`/api/trips/${trip.body.id}/cover`)
        .send({ imageId: mediaId1 });

      const res = await request(app)
        .put(`/api/trips/${trip.body.id}/cover`)
        .send({ imageId: mediaId2 });

      expect(res.status).toBe(200);
      expect(res.body.coverImageId).toBe(mediaId2);
    });
  });
});
