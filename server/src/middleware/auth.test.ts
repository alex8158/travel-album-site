import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { signToken } from '../services/authService';
import { authMiddleware, requireAuth, requireAdmin, requireOwnership } from './auth';

function buildApp(
  middleware: Array<(req: Request, res: Response, next: NextFunction) => void>,
  handler?: (req: Request, res: Response) => void,
) {
  const app = express();
  app.use(express.json());
  for (const mw of middleware) {
    app.use(mw);
  }
  app.get(
    '/test',
    ...middleware,
    handler ?? ((req: Request, res: Response) => {
      res.json({ user: req.user ?? null });
    }),
  );
  return app;
}

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('should set req.user when a valid Bearer token is provided', async () => {
    const token = signToken({ userId: 'u1', role: 'admin' });
    const app = buildApp([authMiddleware]);

    const res = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ userId: 'u1', role: 'admin' });
  });

  it('should continue without req.user when no Authorization header', async () => {
    const app = buildApp([authMiddleware]);

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });

  it('should continue without req.user when Authorization is not Bearer', async () => {
    const app = buildApp([authMiddleware]);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Basic abc123');

    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });

  it('should continue without req.user when token is invalid', async () => {
    const app = buildApp([authMiddleware]);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer invalid.token.here');

    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });
});

describe('requireAuth', () => {
  it('should return 401 when req.user is not set', async () => {
    const app = buildApp([requireAuth]);

    const res = await request(app).get('/test');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('should call next when req.user is set', async () => {
    const token = signToken({ userId: 'u1', role: 'regular' });
    const app = buildApp([authMiddleware, requireAuth]);

    const res = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ userId: 'u1', role: 'regular' });
  });
});

describe('requireAdmin', () => {
  it('should return 401 when req.user is not set', async () => {
    const app = buildApp([requireAdmin]);

    const res = await request(app).get('/test');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('should return 403 when user is not admin', async () => {
    const token = signToken({ userId: 'u1', role: 'regular' });
    const app = buildApp([authMiddleware, requireAdmin]);

    const res = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('should call next when user is admin', async () => {
    const token = signToken({ userId: 'u1', role: 'admin' });
    const app = buildApp([authMiddleware, requireAdmin]);

    const res = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ userId: 'u1', role: 'admin' });
  });
});

describe('requireOwnership', () => {
  const ownershipMiddleware = requireOwnership((req) => req.query.ownerId as string | undefined);

  it('should return 401 when req.user is not set', async () => {
    const app = express();
    app.get('/test', ownershipMiddleware, (_req: Request, res: Response) => {
      res.json({ ok: true });
    });

    const res = await request(app).get('/test?ownerId=u1');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('should return 403 when user is not owner and not admin', async () => {
    const token = signToken({ userId: 'u2', role: 'regular' });
    const app = express();
    app.use(authMiddleware);
    app.get('/test', ownershipMiddleware, (_req: Request, res: Response) => {
      res.json({ ok: true });
    });

    const res = await request(app)
      .get('/test?ownerId=u1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('should allow access when user is the owner', async () => {
    const token = signToken({ userId: 'u1', role: 'regular' });
    const app = express();
    app.use(authMiddleware);
    app.get('/test', ownershipMiddleware, (_req: Request, res: Response) => {
      res.json({ ok: true });
    });

    const res = await request(app)
      .get('/test?ownerId=u1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should allow access when user is admin even if not owner', async () => {
    const token = signToken({ userId: 'admin-id', role: 'admin' });
    const app = express();
    app.use(authMiddleware);
    app.get('/test', ownershipMiddleware, (_req: Request, res: Response) => {
      res.json({ ok: true });
    });

    const res = await request(app)
      .get('/test?ownerId=u1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
