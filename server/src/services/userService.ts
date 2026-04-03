import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import type Database from 'better-sqlite3';
import type { User } from '../types';
import { getDb } from '../database';
import { AppError } from '../middleware/errorHandler';
import { hashPassword, verifyPassword } from './authService';

const BCRYPT_ROUNDS = 12;
const DEFAULT_ADMIN_PASSWORD = 'P8ssw2rd';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    role: row.role as User['role'],
    status: row.status as User['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createDefaultAdmin(db: Database.Database): void {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (existing) return;

  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, BCRYPT_ROUNDS);
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', 'active', ?, ?)`
  ).run(id, 'admin', passwordHash, now, now);
}

export function migrateOrphanedData(db: Database.Database): void {
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin') as { id: string } | undefined;
  if (!admin) return;

  db.prepare('UPDATE trips SET user_id = ? WHERE user_id IS NULL').run(admin.id);
  db.prepare('UPDATE media_items SET user_id = ? WHERE user_id IS NULL').run(admin.id);
}

export function initDefaultData(db: Database.Database): void {
  createDefaultAdmin(db);
  migrateOrphanedData(db);
}

export async function register(username: string, password: string): Promise<User> {
  if (!username || typeof username !== 'string' || username.trim().length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', '用户名不能为空');
  }

  if (!password || typeof password !== 'string' || password.length < 6) {
    throw new AppError(400, 'VALIDATION_ERROR', '密码长度不能少于6个字符');
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) {
    throw new AppError(409, 'USERNAME_TAKEN', '用户名已被占用');
  }

  const id = uuidv4();
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'regular', 'pending', ?, ?)`
  ).run(id, username.trim(), passwordHash, now, now);

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
  return rowToUser(row);
}

export function approveUser(userId: string): User {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;

  if (!row) {
    throw new AppError(404, 'NOT_FOUND', '用户不存在');
  }

  if (row.status !== 'pending') {
    throw new AppError(400, 'INVALID_STATUS', '只能审批 pending 状态的用户');
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run('active', now, userId);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow;
  return rowToUser(updated);
}

export function rejectUser(userId: string): User {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;

  if (!row) {
    throw new AppError(404, 'NOT_FOUND', '用户不存在');
  }

  if (row.status !== 'pending') {
    throw new AppError(400, 'INVALID_STATUS', '只能拒绝 pending 状态的用户');
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run('disabled', now, userId);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow;
  return rowToUser(updated);
}

export async function changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    throw new AppError(400, 'VALIDATION_ERROR', '新密码长度不能少于6个字符');
  }

  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;

  if (!row) {
    throw new AppError(404, 'NOT_FOUND', '用户不存在');
  }

  const match = await verifyPassword(oldPassword, row.password_hash);
  if (!match) {
    throw new AppError(400, 'WRONG_PASSWORD', '旧密码不正确');
  }

  const newHash = await hashPassword(newPassword);
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(newHash, now, userId);
}

export async function resetPassword(userId: string, newPassword: string): Promise<void> {
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    throw new AppError(400, 'VALIDATION_ERROR', '新密码长度不能少于6个字符');
  }

  const db = getDb();
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as { id: string } | undefined;

  if (!row) {
    throw new AppError(404, 'NOT_FOUND', '用户不存在');
  }

  const newHash = await hashPassword(newPassword);
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(newHash, now, userId);
}

export function disableUser(userId: string): void {
  const db = getDb();
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as { id: string } | undefined;

  if (!row) {
    throw new AppError(404, 'NOT_FOUND', '用户不存在');
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run('disabled', now, userId);
}

export function promoteToAdmin(userId: string): void {
  const db = getDb();
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as { id: string } | undefined;

  if (!row) {
    throw new AppError(404, 'NOT_FOUND', '用户不存在');
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run('admin', now, userId);
}

export function listUsers(): User[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM users').all() as UserRow[];
  return rows.map(rowToUser);
}

export function listPendingUsers(): User[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM users WHERE status = ?').all('pending') as UserRow[];
  return rows.map(rowToUser);
}

export function getUserById(userId: string): User | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  if (!row) return null;
  return rowToUser(row);
}
