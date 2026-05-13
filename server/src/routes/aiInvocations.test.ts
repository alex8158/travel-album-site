import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import aiInvocationsRouter from './aiInvocations';

const app = express();
app.use(express.json());
app.use('/api/ai-invocations', aiInvocationsRouter);

describe('AI Invocations API', () => {
  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM media_versions');
    db.exec('DELETE FROM media_analysis');
    db.exec('DELETE FROM duplicate_group_items');
    db.exec('DELETE FROM ai_invocations');
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM upload_sessions');
    db.exec('DELETE FROM compile_jobs');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM processing_job_events');
    db.exec('DELETE FROM processing_jobs');
    db.exec('DELETE FROM trips');
    db.exec('DELETE FROM users');
  });

  afterEach(() => {
    closeDb();
  });

  describe('POST /api/ai-invocations', () => {
    it('should create an invocation record and return 201', async () => {
      const res = await request(app)
        .post('/api/ai-invocations')
        .send({
          provider: 'bedrock',
          model_name: 'claude-3-haiku',
          task_type: 'image_analysis',
          request_payload: '{"prompt": "analyze"}',
          input_tokens: 500,
          output_tokens: 200,
          estimated_cost: 0.01,
          status: 'completed',
          started_at: '2025-01-01T00:00:00.000Z',
          finished_at: '2025-01-01T00:00:01.000Z',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.provider).toBe('bedrock');
      expect(res.body.model_name).toBe('claude-3-haiku');
      expect(res.body.task_type).toBe('image_analysis');
      expect(res.body.request_payload).toBe('{"prompt": "analyze"}');
      expect(res.body.input_tokens).toBe(500);
      expect(res.body.output_tokens).toBe(200);
      expect(res.body.estimated_cost).toBe(0.01);
      expect(res.body.status).toBe('completed');
      expect(res.body.created_at).toBeDefined();
    });

    it('should create an invocation with optional media_id', async () => {
      const res = await request(app)
        .post('/api/ai-invocations')
        .send({
          media_id: null,
          provider: 'openai',
          task_type: 'pair_review',
          status: 'pending',
        });

      expect(res.status).toBe(201);
      expect(res.body.media_id).toBeNull();
      expect(res.body.task_type).toBe('pair_review');
    });
  });

  describe('GET /api/ai-invocations', () => {
    it('should return paginated list with default page=1, pageSize=20', async () => {
      // Create 3 records
      for (let i = 0; i < 3; i++) {
        await request(app)
          .post('/api/ai-invocations')
          .send({ provider: 'bedrock', task_type: 'image_analysis', status: 'completed' });
      }

      const res = await request(app).get('/api/ai-invocations');

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(3);
      expect(res.body.total).toBe(3);
      expect(res.body.page).toBe(1);
      expect(res.body.pageSize).toBe(20);
    });

    it('should filter by media_id', async () => {
      const mediaId = uuidv4();
      await request(app)
        .post('/api/ai-invocations')
        .send({ media_id: mediaId, task_type: 'image_analysis', status: 'completed' });
      await request(app)
        .post('/api/ai-invocations')
        .send({ media_id: uuidv4(), task_type: 'image_analysis', status: 'completed' });

      const res = await request(app).get(`/api/ai-invocations?media_id=${mediaId}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].media_id).toBe(mediaId);
      expect(res.body.total).toBe(1);
    });

    it('should filter by task_type', async () => {
      await request(app)
        .post('/api/ai-invocations')
        .send({ task_type: 'image_analysis', status: 'completed' });
      await request(app)
        .post('/api/ai-invocations')
        .send({ task_type: 'pair_review', status: 'completed' });
      await request(app)
        .post('/api/ai-invocations')
        .send({ task_type: 'image_analysis', status: 'completed' });

      const res = await request(app).get('/api/ai-invocations?task_type=image_analysis');

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items.every((i: { task_type: string }) => i.task_type === 'image_analysis')).toBe(true);
      expect(res.body.total).toBe(2);
    });

    it('should filter by status', async () => {
      await request(app)
        .post('/api/ai-invocations')
        .send({ task_type: 'image_analysis', status: 'completed' });
      await request(app)
        .post('/api/ai-invocations')
        .send({ task_type: 'image_analysis', status: 'failed' });
      await request(app)
        .post('/api/ai-invocations')
        .send({ task_type: 'pair_review', status: 'completed' });

      const res = await request(app).get('/api/ai-invocations?status=completed');

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items.every((i: { status: string }) => i.status === 'completed')).toBe(true);
      expect(res.body.total).toBe(2);
    });

    it('should support pagination with page and pageSize', async () => {
      // Create 5 records
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/api/ai-invocations')
          .send({ task_type: 'image_analysis', status: 'completed', input_tokens: i });
      }

      const res = await request(app).get('/api/ai-invocations?page=2&pageSize=2');

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.total).toBe(5);
      expect(res.body.page).toBe(2);
      expect(res.body.pageSize).toBe(2);
    });
  });

  describe('PUT /api/ai-invocations/:id', () => {
    it('should update status and response data', async () => {
      const createRes = await request(app)
        .post('/api/ai-invocations')
        .send({
          provider: 'bedrock',
          task_type: 'image_analysis',
          status: 'pending',
          input_tokens: 500,
        });

      const id = createRes.body.id;

      const res = await request(app)
        .put(`/api/ai-invocations/${id}`)
        .send({
          status: 'completed',
          response_payload: '{"result": "good"}',
          output_tokens: 300,
          estimated_cost: 0.02,
          finished_at: '2025-01-01T00:00:05.000Z',
        });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(id);
      expect(res.body.status).toBe('completed');
      expect(res.body.response_payload).toBe('{"result": "good"}');
      expect(res.body.output_tokens).toBe(300);
      expect(res.body.estimated_cost).toBe(0.02);
      expect(res.body.finished_at).toBe('2025-01-01T00:00:05.000Z');
      // Original fields preserved
      expect(res.body.input_tokens).toBe(500);
      expect(res.body.provider).toBe('bedrock');
    });

    it('should return 404 for non-existent id', async () => {
      const res = await request(app)
        .put('/api/ai-invocations/non-existent-id')
        .send({ status: 'completed' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/ai-invocations/summary', () => {
    it('should return aggregated statistics', async () => {
      await request(app)
        .post('/api/ai-invocations')
        .send({ task_type: 'image_analysis', input_tokens: 500, output_tokens: 200, estimated_cost: 0.01 });
      await request(app)
        .post('/api/ai-invocations')
        .send({ task_type: 'pair_review', input_tokens: 1000, output_tokens: 400, estimated_cost: 0.03 });
      await request(app)
        .post('/api/ai-invocations')
        .send({ task_type: 'image_analysis', input_tokens: 300, output_tokens: 100, estimated_cost: 0.005 });

      const res = await request(app).get('/api/ai-invocations/summary');

      expect(res.status).toBe(200);
      expect(res.body.total_invocations).toBe(3);
      expect(res.body.total_input_tokens).toBe(1800);
      expect(res.body.total_output_tokens).toBe(700);
      expect(res.body.total_estimated_cost).toBeCloseTo(0.045, 5);
    });

    it('should return correct by_task_type breakdown', async () => {
      await request(app)
        .post('/api/ai-invocations')
        .send({ task_type: 'image_analysis', estimated_cost: 0.01 });
      await request(app)
        .post('/api/ai-invocations')
        .send({ task_type: 'image_analysis', estimated_cost: 0.02 });
      await request(app)
        .post('/api/ai-invocations')
        .send({ task_type: 'pair_review', estimated_cost: 0.05 });

      const res = await request(app).get('/api/ai-invocations/summary');

      expect(res.status).toBe(200);
      expect(res.body.by_task_type).toBeDefined();
      expect(res.body.by_task_type['image_analysis'].count).toBe(2);
      expect(res.body.by_task_type['image_analysis'].cost).toBeCloseTo(0.03, 5);
      expect(res.body.by_task_type['pair_review'].count).toBe(1);
      expect(res.body.by_task_type['pair_review'].cost).toBeCloseTo(0.05, 5);
    });
  });
});
