import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import type { JwtPayload } from '../types';

const JWT_SECRET = process.env.JWT_SECRET || 'travel-album-secret-key';
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
