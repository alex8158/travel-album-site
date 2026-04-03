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
    const user = approveUser(req.params.id as string);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/users/:id/reject - Reject user
router.put('/users/:id/reject', requireAdmin, (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = rejectUser(req.params.id as string);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/users/:id/promote - Promote to admin
router.put('/users/:id/promote', requireAdmin, (req: Request, res: Response, next: NextFunction) => {
  try {
    promoteToAdmin(req.params.id as string);
    res.json({ message: '用户已提升为管理员' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/users/:id/password - Reset password
router.put('/users/:id/password', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { password } = req.body;
    await resetPassword(req.params.id as string, password);
    res.json({ message: '密码已重置' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/users/:id - Delete user (disable)
router.delete('/users/:id', requireAdmin, (req: Request, res: Response, next: NextFunction) => {
  try {
    disableUser(req.params.id as string);
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
    `SELECT t.*, COUNT(m.id) AS media_count
     FROM trips t
     LEFT JOIN media_items m ON m.trip_id = t.id AND m.status = 'active'
     WHERE t.user_id = ?
     GROUP BY t.id
     ORDER BY t.created_at DESC`
  ).all(userId) as (TripRow & { media_count: number })[];

  const trips = rows.map(row => ({
    ...rowToTrip(row),
    mediaCount: row.media_count,
    coverImageUrl: row.cover_image_id ? `/api/media/${row.cover_image_id}/thumbnail` : '',
  }));

  return res.json({ trips });
});

// GET /api/admin/storage/status — Return current storage config status
router.get('/storage/status', requireAdmin, (_req: Request, res: Response) => {
  const currentType = (process.env.STORAGE_TYPE || 'local') as StorageType;

  const providers: { type: StorageType; label: string; configured: boolean; missing: string[] }[] = [
    { type: 'local', label: '本地存储', configured: true, missing: [] },
    {
      type: 's3',
      label: 'AWS S3',
      configured: !!(process.env.S3_BUCKET && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
      missing: [
        ...(!process.env.S3_BUCKET ? ['S3_BUCKET'] : []),
        ...(!process.env.AWS_ACCESS_KEY_ID ? ['AWS_ACCESS_KEY_ID'] : []),
        ...(!process.env.AWS_SECRET_ACCESS_KEY ? ['AWS_SECRET_ACCESS_KEY'] : []),
      ],
    },
    {
      type: 'oss',
      label: '阿里 OSS',
      configured: !!(process.env.OSS_BUCKET && process.env.OSS_ACCESS_KEY_ID && process.env.OSS_ACCESS_KEY_SECRET),
      missing: [
        ...(!process.env.OSS_BUCKET ? ['OSS_BUCKET'] : []),
        ...(!process.env.OSS_ACCESS_KEY_ID ? ['OSS_ACCESS_KEY_ID'] : []),
        ...(!process.env.OSS_ACCESS_KEY_SECRET ? ['OSS_ACCESS_KEY_SECRET'] : []),
      ],
    },
    {
      type: 'cos',
      label: '腾讯 COS',
      configured: !!(process.env.COS_BUCKET && process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY),
      missing: [
        ...(!process.env.COS_BUCKET ? ['COS_BUCKET'] : []),
        ...(!process.env.COS_SECRET_ID ? ['COS_SECRET_ID'] : []),
        ...(!process.env.COS_SECRET_KEY ? ['COS_SECRET_KEY'] : []),
      ],
    },
  ];

  res.json({ currentType, providers });
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
