import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../database';
import { authMiddleware, requireAdmin } from '../middleware/auth';
import { TripRow, rowToTrip } from '../helpers/tripRow';
import {
  listUsers,
  listPendingUsers,
  approveUser,
  rejectUser,
  promoteToAdmin,
  resetPassword,
  disableUser,
} from '../services/userService';
import { migrateStorage } from '../services/migrationTool';
import { getStorageProvider, createStorageProviderForType } from '../storage/factory';
import type { StorageType } from '../storage/types';

const router = Router();

// All admin routes require authentication
router.use(authMiddleware);

// GET /api/admin/users - List all users
router.get('/users', requireAdmin, (_req: Request, res: Response) => {
  const users = listUsers();
  res.json({ users });
});

// GET /api/admin/users/pending - List pending users
router.get('/users/pending', requireAdmin, (_req: Request, res: Response) => {
  const users = listPendingUsers();
  res.json({ users });
});

// PUT /api/admin/users/:id/approve - Approve user
router.put('/users/:id/approve', requireAdmin, (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = approveUser(req.params.id);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/users/:id/reject - Reject user
router.put('/users/:id/reject', requireAdmin, (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = rejectUser(req.params.id);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/users/:id/promote - Promote to admin
router.put('/users/:id/promote', requireAdmin, (req: Request, res: Response, next: NextFunction) => {
  try {
    promoteToAdmin(req.params.id);
    res.json({ message: '用户已提升为管理员' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/users/:id/password - Reset password
router.put('/users/:id/password', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { password } = req.body;
    await resetPassword(req.params.id, password);
    res.json({ message: '密码已重置' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/users/:id - Delete user (disable)
router.delete('/users/:id', requireAdmin, (req: Request, res: Response, next: NextFunction) => {
  try {
    disableUser(req.params.id);
    res.json({ message: '用户已删除' });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users/:id/trips — Admin view any user's trips
router.get('/users/:id/trips', requireAdmin, (req: Request, res: Response) => {
  const db = getDb();
  const userId = req.params.id;

  const rows = db.prepare(
    `SELECT * FROM trips WHERE user_id = ? ORDER BY created_at DESC`
  ).all(userId) as TripRow[];

  const trips = rows.map(rowToTrip);
  return res.json({ trips });
});

// POST /api/admin/storage/migrate — Trigger storage migration
router.post('/storage/migrate', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { targetType } = req.body;
    const validTypes: StorageType[] = ['local', 's3', 'oss', 'cos'];

    if (!targetType || !validTypes.includes(targetType)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `targetType 必须为以下之一: ${validTypes.join(', ')}` },
      });
    }

    const currentType = (process.env.STORAGE_TYPE || 'local') as StorageType;

    if (targetType === currentType) {
      return res.status(400).json({
        error: { code: 'SAME_STORAGE_TYPE', message: '目标存储类型与当前类型相同' },
      });
    }

    const sourceProvider = getStorageProvider();
    const targetProvider = createStorageProviderForType(targetType as StorageType);

    const result = await migrateStorage(sourceProvider, targetProvider);
    res.json({ result });
  } catch (err) {
    next(err);
  }
});

export default router;
