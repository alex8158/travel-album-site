import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/authService';

declare global {
  namespace Express {
    interface Request {
      user?: { userId: string; role: 'admin' | 'regular' };
    }
  }
}

/**
 * Parse JWT from Authorization header and set req.user.
 * Does NOT reject if no token — public routes use this middleware.
 */
export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next();
  }
  try {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    req.user = payload;
  } catch {
    // Invalid token, continue as unauthenticated
  }
  next();
}

/** Require valid JWT — returns 401 if not authenticated. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: { code: 'TOKEN_INVALID', message: '请先登录' } });
    return;
  }
  next();
}

/** Require admin role — returns 401 if unauthenticated, 403 if not admin. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: { code: 'TOKEN_INVALID', message: '请先登录' } });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: '需要管理员权限' } });
    return;
  }
  next();
}

/**
 * Factory: returns middleware that checks if the current user is the resource
 * owner or an admin. Returns 401 if unauthenticated, 403 if neither.
 */
export function requireOwnership(
  getResourceUserId: (req: Request) => string | undefined
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: { code: 'TOKEN_INVALID', message: '请先登录' } });
      return;
    }
    const resourceUserId = getResourceUserId(req);
    if (req.user.role === 'admin' || req.user.userId === resourceUserId) {
      return next();
    }
    res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权操作此资源' } });
  };
}
