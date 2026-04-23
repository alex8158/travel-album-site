import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../database';
import authRouter from './auth';
import { globalErrorHandler } from '../middleware/errorHandler';
import { signToken } from '../services/authService';

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use(globalErrorHandler);

function seedUser(overrides: Partial<{ username: string; password: string; role: string; status: string }> = {}) {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const username = overrides.username ?? `user_${id.slice(0, 8)}`;
  const password = overrides.password ?? 'password123';
  const passwordHash = bcrypt.hashSync(password, 10);
  const role = overrides.role ?? 'regular';
  const status = overrides.status ?? 'active';

  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, username, passwordHash, role, status, now, now);

  return { id, username, password, role, status };
}

describe('Auth Routes', () => {
  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM upload_sessions');
    db.exec('DELETE FROM media_tags');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM duplicate_groups');
    db.exec('DELETE FROM trips');
    db.exec('DELETE FROM users');
  });

  afterEach(() => {
    closeDb();
  });

  describe('POST /api/auth/login', () => {
    it('should return token and user for valid active user', async () => {
      const user = seedUser({ username: 'alice', password: 'secret123', status: 'active' });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'secret123' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.id).toBe(user.id);
      expect(res.body.user.username).toBe('alice');
      expect(res.body.user.role).toBe('regular');
    });

    it('should return 401 INVALID_CREDENTIALS for non-existent user', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'nobody', password: 'whatever' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('should return 401 INVALID_CREDENTIALS for wrong password', async () => {
      seedUser({ username: 'bob', password: 'correct123', status: 'active' });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'bob', password: 'wrongpass' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('should return 403 ACCOUNT_PENDING for pending user', async () => {
      seedUser({ username: 'pending_user', password: 'secret123', status: 'pending' });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'pending_user', password: 'secret123' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_PENDING');
    });

    it('should return 403 ACCOUNT_DISABLED for disabled user', async () => {
      seedUser({ username: 'disabled_user', password: 'secret123', status: 'disabled' });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'disabled_user', password: 'secret123' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
    });
  });

  describe('POST /api/auth/register', () => {
    it('should create a pending user and return 201', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'newuser', password: 'pass123456' });

      expect(res.status).toBe(201);
      expect(res.body.message).toBe('注册申请已提交，请等待管理员审批');
      expect(res.body.user.username).toBe('newuser');
      expect(res.body.user.status).toBe('pending');
      expect(res.body.user.id).toBeDefined();
    });

    it('should return 400 VALIDATION_ERROR for empty username', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: '', password: 'pass123456' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 VALIDATION_ERROR for short password', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'newuser', password: '12345' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 409 USERNAME_TAKEN for duplicate username', async () => {
      seedUser({ username: 'taken' });

      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'taken', password: 'pass123456' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('USERNAME_TAKEN');
    });

    it('should accept password with exactly 6 characters', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'sixchar', password: '123456' });

      expect(res.status).toBe(201);
    });

    it('should trim the username', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: '  trimmed  ', password: 'pass123456' });

      expect(res.status).toBe(201);
      expect(res.body.user.username).toBe('trimmed');
    });
  });

  describe('PUT /api/auth/password', () => {
    it('should change password with valid old password', async () => {
      const user = seedUser({ username: 'changer', password: 'oldpass123', status: 'active' });
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await request(app)
        .put('/api/auth/password')
        .set('Authorization', `Bearer ${token}`)
        .send({ oldPassword: 'oldpass123', newPassword: 'newpass456' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('密码修改成功');

      // Verify new password works for login
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'changer', password: 'newpass456' });
      expect(loginRes.status).toBe(200);
    });

    it('should return 400 WRONG_PASSWORD for incorrect old password', async () => {
      const user = seedUser({ username: 'wrongold', password: 'correct123', status: 'active' });
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await request(app)
        .put('/api/auth/password')
        .set('Authorization', `Bearer ${token}`)
        .send({ oldPassword: 'wrongpass', newPassword: 'newpass456' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('WRONG_PASSWORD');
    });

    it('should return 400 VALIDATION_ERROR for short new password', async () => {
      const user = seedUser({ username: 'shortpw', password: 'oldpass123', status: 'active' });
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await request(app)
        .put('/api/auth/password')
        .set('Authorization', `Bearer ${token}`)
        .send({ oldPassword: 'oldpass123', newPassword: '12345' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should return 401 without auth token', async () => {
      const res = await request(app)
        .put('/api/auth/password')
        .send({ oldPassword: 'old123', newPassword: 'new123456' });

      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/auth/account', () => {
    it('should deactivate own account', async () => {
      const user = seedUser({ username: 'deactivator', password: 'pass123456', status: 'active' });
      const token = signToken({ userId: user.id, role: 'regular' });

      const res = await request(app)
        .delete('/api/auth/account')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('账户已注销');

      // Verify user is now disabled and cannot login
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'deactivator', password: 'pass123456' });
      expect(loginRes.status).toBe(403);
      expect(loginRes.body.error.code).toBe('ACCOUNT_DISABLED');
    });

    it('should return 401 without auth token', async () => {
      const res = await request(app)
        .delete('/api/auth/account');

      expect(res.status).toBe(401);
    });
  });
});
