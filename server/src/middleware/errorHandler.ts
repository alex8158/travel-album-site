import { Request, Response, NextFunction } from 'express';
import { logger } from './logger';

/**
 * Custom application error with a code and HTTP status.
 * Route handlers can throw this to produce a structured error response.
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    // Maintain proper prototype chain
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * Global Express error-handling middleware.
 *
 * - Known AppError instances → return their status + code/message.
 * - Unknown errors → return 500 with a generic message (no internal details).
 * - Every error is logged with structured metadata.
 */
export function globalErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    logger.error(err.message, {
      code: err.code,
      statusCode: err.statusCode,
      method: req.method,
      path: req.path,
    });

    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message },
    });
    return;
  }

  // Unhandled / unexpected error — never expose internals
  logger.error('Unhandled server error', {
    code: 'INTERNAL_SERVER_ERROR',
    statusCode: 500,
    method: req.method,
    path: req.path,
    errorMessage: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    error: { code: 'INTERNAL_SERVER_ERROR', message: '服务器内部错误' },
  });
}
