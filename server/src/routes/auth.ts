import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import { hashPassword, verifyPassword, signToken } from '../services/authService';
import { AppError } from '../middleware/errorHandler';
import { authMiddleware, requireAuth } from '../middleware/auth';
import { changePassword, disableUser } from '../services/userService';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: string;
  updated_at: string;
}

const router = Router();

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = req.body;

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;

    if (!user) {
      throw new AppError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
    }

    if (user.status === 'pending') {
      throw new AppError(403, 'ACCOUNT_PENDING', '账户待审批');
    }

    if (user.status === 'disabled') {
      throw new AppError(403, 'ACCOUNT_DISABLED', '账户已禁用');
    }

    const passwordMatch = await verifyPassword(password, user.password_hash);
    if (!passwordMatch) {
      throw new AppError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
    }

    const token = signToken({ userId: user.id, role: user.role as 'admin' | 'regular' });

    return res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = req.body;

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

    return res.status(201).json({
      message: '注册申请已提交，请等待管理员审批',
      user: { id, username: username.trim(), status: 'pending' },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/auth/password
router.put('/password', authMiddleware, requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { oldPassword, newPassword } = req.body;
    await changePassword(req.user!.userId, oldPassword, newPassword);
    return res.json({ message: '密码修改成功' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/auth/account
router.delete('/account', authMiddleware, requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    disableUser(req.user!.userId);
    return res.json({ message: '账户已注销' });
  } catch (err) {
    next(err);
  }
});

export default router;
