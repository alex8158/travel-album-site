import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { globalErrorHandler, AppError } from './errorHandler';

function buildApp() {
  const app = express();
  app.use(express.json());

  // Route that throws an AppError
  app.get('/app-error', (_req: Request, _res: Response, next: NextFunction) => {
    next(new AppError(400, 'BAD_REQUEST', '请求参数无效'));
  });

  // Route that throws an unexpected error
  app.get('/unexpected', (_req: Request, _res: Response, next: NextFunction) => {
    next(new Error('database connection lost'));
  });

  // Route that throws synchronously (Express 4 catches sync throws in middleware)
  app.get('/sync-throw', () => {
    throw new Error('sync boom');
  });

  // Route that works fine
  app.get('/ok', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.use(globalErrorHandler);
  return app;
}

describe('globalErrorHandler', () => {
  beforeEach(() => {
    // Suppress console output during tests
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('should return unified error format for AppError', async () => {
    const app = buildApp();
    const res = await request(app).get('/app-error');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'BAD_REQUEST', message: '请求参数无效' },
    });
  });

  it('should return 500 with generic message for unexpected errors', async () => {
    const app = buildApp();
    const res = await request(app).get('/unexpected');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_SERVER_ERROR', message: '服务器内部错误' },
    });
    // Must NOT expose internal error details
    expect(JSON.stringify(res.body)).not.toContain('database connection lost');
  });

  it('should handle synchronous throws and return 500', async () => {
    const app = buildApp();
    const res = await request(app).get('/sync-throw');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_SERVER_ERROR', message: '服务器内部错误' },
    });
    expect(JSON.stringify(res.body)).not.toContain('sync boom');
  });

  it('should not interfere with successful responses', async () => {
    const app = buildApp();
    const res = await request(app).get('/ok');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('should log structured error for AppError', async () => {
    const errorSpy = vi.spyOn(console, 'error');
    const app = buildApp();
    await request(app).get('/app-error');

    expect(errorSpy).toHaveBeenCalled();
    const loggedJson = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(loggedJson.level).toBe('error');
    expect(loggedJson.code).toBe('BAD_REQUEST');
    expect(loggedJson.method).toBe('GET');
    expect(loggedJson.path).toBe('/app-error');
    expect(loggedJson.timestamp).toBeDefined();
  });

  it('should log structured error for unexpected errors', async () => {
    const errorSpy = vi.spyOn(console, 'error');
    const app = buildApp();
    await request(app).get('/unexpected');

    expect(errorSpy).toHaveBeenCalled();
    const loggedJson = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(loggedJson.level).toBe('error');
    expect(loggedJson.code).toBe('INTERNAL_SERVER_ERROR');
    expect(loggedJson.statusCode).toBe(500);
    expect(loggedJson.errorMessage).toBe('database connection lost');
  });

  it('should preserve AppError status codes (e.g. 404, 413)', async () => {
    const app = express();
    app.get('/not-found', (_req, _res, next) => {
      next(new AppError(404, 'NOT_FOUND', '资源不存在'));
    });
    app.get('/too-large', (_req, _res, next) => {
      next(new AppError(413, 'FILE_TOO_LARGE', '文件大小超限'));
    });
    app.use(globalErrorHandler);

    const res404 = await request(app).get('/not-found');
    expect(res404.status).toBe(404);
    expect(res404.body.error.code).toBe('NOT_FOUND');

    const res413 = await request(app).get('/too-large');
    expect(res413.status).toBe(413);
    expect(res413.body.error.code).toBe('FILE_TOO_LARGE');
  });
});

describe('AppError', () => {
  it('should be an instance of Error', () => {
    const err = new AppError(400, 'TEST', 'test message');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });

  it('should store code, statusCode, and message', () => {
    const err = new AppError(422, 'VALIDATION', 'invalid input');
    expect(err.code).toBe('VALIDATION');
    expect(err.statusCode).toBe(422);
    expect(err.message).toBe('invalid input');
  });
});
