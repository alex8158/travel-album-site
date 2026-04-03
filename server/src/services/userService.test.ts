import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';

// We need to mock getDb to use an in-memory database
let testDb: Database.Database;

import { vi } from 'vitest';

vi.mock('../database', () => ({
  getDb: () => testDb,
}));

import {
  register,
  approveUser,
  rejectUser,
  changePassword,
  resetPassword,
  disableUser,
  promoteToAdmin,
  listUsers,
  listPendingUsers,
  getUserById,
} from './userService';
import { verifyPassword } from './authService';

function initTestDb() {
  testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'regular',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      user_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_items (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'unknown',
      mime_type TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      user_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      FOREIGN KEY (trip_id) REFERENCES trips(id)
    );
  `);
}

function insertUser(overrides: Partial<{ id: string; username: string; password_hash: string; role: string; status: string }> = {}) {
  const id = overrides.id ?? uuidv4();
  const now = new Date().toISOString();
  const hash = overrides.password_hash ?? bcrypt.hashSync('validpass', 10);
  testDb.prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    overrides.username ?? `user-${id.slice(0, 8)}`,
    hash,
    overrides.role ?? 'regular',
    overrides.status ?? 'active',
    now,
    now,
  );
  return id;
}

describe('UserService', () => {
  beforeEach(() => {
    initTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  describe('register', () => {
    it('should create a pending user with hashed password', async () => {
      const user = await register('newuser', 'password123');
      expect(user.username).toBe('newuser');
      expect(user.status).toBe('pending');
      expect(user.role).toBe('regular');

      const row = testDb.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
      const match = await verifyPassword('password123', row.password_hash);
      expect(match).toBe(true);
    });

    it('should trim username', async () => {
      const user = await register('  spacey  ', 'password123');
      expect(user.username).toBe('spacey');
    });

    it('should reject empty username', async () => {
      await expect(register('', 'password123')).rejects.toThrow();
      await expect(register('   ', 'password123')).rejects.toThrow();
    });

    it('should reject password shorter than 6 chars', async () => {
      await expect(register('user1', '12345')).rejects.toThrow();
    });

    it('should accept password of exactly 6 chars', async () => {
      const user = await register('user1', '123456');
      expect(user.status).toBe('pending');
    });

    it('should reject duplicate username', async () => {
      await register('taken', 'password123');
      await expect(register('taken', 'password456')).rejects.toThrow(/已被占用/);
    });
  });

  describe('approveUser', () => {
    it('should set pending user to active', () => {
      const id = insertUser({ status: 'pending' });
      const user = approveUser(id);
      expect(user.status).toBe('active');
    });

    it('should reject non-pending user', () => {
      const id = insertUser({ status: 'active' });
      expect(() => approveUser(id)).toThrow();
    });

    it('should throw for non-existent user', () => {
      expect(() => approveUser('nonexistent')).toThrow();
    });
  });

  describe('rejectUser', () => {
    it('should set pending user to disabled', () => {
      const id = insertUser({ status: 'pending' });
      const user = rejectUser(id);
      expect(user.status).toBe('disabled');
    });

    it('should reject non-pending user', () => {
      const id = insertUser({ status: 'active' });
      expect(() => rejectUser(id)).toThrow();
    });
  });

  describe('changePassword', () => {
    it('should update password when old password is correct', async () => {
      const hash = await bcrypt.hash('oldpass1', 10);
      const id = insertUser({ password_hash: hash });

      await changePassword(id, 'oldpass1', 'newpass1');

      const row = testDb.prepare('SELECT password_hash FROM users WHERE id = ?').get(id) as { password_hash: string };
      expect(await verifyPassword('newpass1', row.password_hash)).toBe(true);
      expect(await verifyPassword('oldpass1', row.password_hash)).toBe(false);
    });

    it('should reject wrong old password', async () => {
      const hash = await bcrypt.hash('correct', 10);
      const id = insertUser({ password_hash: hash });

      await expect(changePassword(id, 'wrong', 'newpass1')).rejects.toThrow(/旧密码不正确/);
    });

    it('should reject new password shorter than 6 chars', async () => {
      const hash = await bcrypt.hash('oldpass1', 10);
      const id = insertUser({ password_hash: hash });

      await expect(changePassword(id, 'oldpass1', '12345')).rejects.toThrow();
    });
  });

  describe('resetPassword', () => {
    it('should update password without verifying old one', async () => {
      const id = insertUser();
      await resetPassword(id, 'newpass1');

      const row = testDb.prepare('SELECT password_hash FROM users WHERE id = ?').get(id) as { password_hash: string };
      expect(await verifyPassword('newpass1', row.password_hash)).toBe(true);
    });

    it('should reject new password shorter than 6 chars', async () => {
      const id = insertUser();
      await expect(resetPassword(id, 'short')).rejects.toThrow();
    });

    it('should throw for non-existent user', async () => {
      await expect(resetPassword('nonexistent', 'newpass1')).rejects.toThrow();
    });
  });

  describe('disableUser', () => {
    it('should set user status to disabled', () => {
      const id = insertUser({ status: 'active' });
      disableUser(id);

      const row = testDb.prepare('SELECT status FROM users WHERE id = ?').get(id) as { status: string };
      expect(row.status).toBe('disabled');
    });

    it('should throw for non-existent user', () => {
      expect(() => disableUser('nonexistent')).toThrow();
    });
  });

  describe('promoteToAdmin', () => {
    it('should set user role to admin', () => {
      const id = insertUser({ role: 'regular' });
      promoteToAdmin(id);

      const row = testDb.prepare('SELECT role FROM users WHERE id = ?').get(id) as { role: string };
      expect(row.role).toBe('admin');
    });

    it('should throw for non-existent user', () => {
      expect(() => promoteToAdmin('nonexistent')).toThrow();
    });
  });

  describe('listUsers', () => {
    it('should return all users without password_hash', () => {
      insertUser({ username: 'alice' });
      insertUser({ username: 'bob' });

      const users = listUsers();
      expect(users).toHaveLength(2);
      users.forEach(u => {
        expect(u).not.toHaveProperty('password_hash');
        expect(u).toHaveProperty('id');
        expect(u).toHaveProperty('username');
        expect(u).toHaveProperty('role');
        expect(u).toHaveProperty('status');
      });
    });

    it('should return empty array when no users', () => {
      expect(listUsers()).toHaveLength(0);
    });
  });

  describe('listPendingUsers', () => {
    it('should return only pending users', () => {
      insertUser({ username: 'active1', status: 'active' });
      insertUser({ username: 'pending1', status: 'pending' });
      insertUser({ username: 'pending2', status: 'pending' });
      insertUser({ username: 'disabled1', status: 'disabled' });

      const pending = listPendingUsers();
      expect(pending).toHaveLength(2);
      pending.forEach(u => expect(u.status).toBe('pending'));
    });
  });

  describe('getUserById', () => {
    it('should return user without password_hash', () => {
      const id = insertUser({ username: 'findme' });
      const user = getUserById(id);
      expect(user).not.toBeNull();
      expect(user!.username).toBe('findme');
      expect(user).not.toHaveProperty('password_hash');
    });

    it('should return null for non-existent user', () => {
      expect(getUserById('nonexistent')).toBeNull();
    });
  });
});
