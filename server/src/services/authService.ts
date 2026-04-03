import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { JwtPayload } from '../types';

/**
 * Get or generate JWT secret.
 * Priority: env var > persisted file > auto-generate and persist.
 */
function getJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  const secretFile = path.join(__dirname, '..', '..', 'data', '.jwt-secret');
  try {
    const existing = fs.readFileSync(secretFile, 'utf-8').trim();
    if (existing) return existing;
  } catch { /* file doesn't exist yet */ }

  const generated = crypto.randomBytes(32).toString('base64');
  try {
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  } catch { /* non-fatal, will regenerate next restart */ }
  return generated;
}

const JWT_SECRET = getJwtSecret();
const JWT_EXPIRES_IN = '7d';
const BCRYPT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload & jwt.JwtPayload;
  return { userId: decoded.userId, role: decoded.role };
}
