import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { hashPassword, verifyPassword, signToken, verifyToken } from './authService';

describe('AuthService', () => {
  describe('hashPassword', () => {
    it('should return a bcrypt hash string', async () => {
      const hash = await hashPassword('mypassword');
      expect(hash).toMatch(/^\$2[aby]\$/);
    });

    it('should produce different hashes for the same input', async () => {
      const hash1 = await hashPassword('same');
      const hash2 = await hashPassword('same');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyPassword', () => {
    it('should return true for matching password and hash', async () => {
      const hash = await hashPassword('correct');
      const result = await verifyPassword('correct', hash);
      expect(result).toBe(true);
    });

    it('should return false for non-matching password', async () => {
      const hash = await hashPassword('correct');
      const result = await verifyPassword('wrong', hash);
      expect(result).toBe(false);
    });
  });

  describe('signToken', () => {
    it('should return a valid JWT string', () => {
      const token = signToken({ userId: 'u1', role: 'admin' });
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('should embed userId and role in the token', () => {
      const token = signToken({ userId: 'u1', role: 'regular' });
      const decoded = jwt.decode(token) as Record<string, unknown>;
      expect(decoded.userId).toBe('u1');
      expect(decoded.role).toBe('regular');
    });

    it('should set expiration to 7 days', () => {
      const token = signToken({ userId: 'u1', role: 'admin' });
      const decoded = jwt.decode(token) as Record<string, unknown>;
      const iat = decoded.iat as number;
      const exp = decoded.exp as number;
      expect(exp - iat).toBe(7 * 24 * 60 * 60);
    });
  });

  describe('verifyToken', () => {
    it('should return the payload for a valid token', () => {
      const token = signToken({ userId: 'u1', role: 'admin' });
      const payload = verifyToken(token);
      expect(payload).toEqual({ userId: 'u1', role: 'admin' });
    });

    it('should throw on an invalid token', () => {
      expect(() => verifyToken('invalid.token.here')).toThrow();
    });

    it('should throw on an expired token', () => {
      const secret = process.env.JWT_SECRET || 'travel-album-secret-key';
      const token = jwt.sign({ userId: 'u1', role: 'admin' }, secret, { expiresIn: '0s' });
      expect(() => verifyToken(token)).toThrow();
    });
  });
});
