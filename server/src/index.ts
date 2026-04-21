import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { getDb } from './database';
import { getStorageProvider, createStorageProviderForType } from './storage/factory';
import type { StorageType } from './storage/types';
import authRouter from './routes/auth';
import tripsRouter from './routes/trips';
import mediaRouter from './routes/media';
import processRouter from './routes/process';
import duplicateGroupsRouter from './routes/duplicateGroups';
import mediaServingRouter from './routes/mediaServing';
import mediaProcessRouter from './routes/mediaProcess';
import mediaEditRouter from './routes/mediaEdit';
import galleryRouter from './routes/gallery';
import trashRouter from './routes/trash';
import adminRouter from './routes/admin';
import usersRouter from './routes/users';
import myRouter from './routes/my';
import clipsRouter from './routes/clips';
import uploadsRouter from './routes/uploads';
import { cleanupExpiredUploads } from './services/uploadCleanup';
import { tripScopedRouter as processJobsTripRouter, jobScopedRouter as processJobsRouter } from './routes/processJobs';
import { globalErrorHandler } from './middleware/errorHandler';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize database
getDb();

// Cleanup expired uploads (fire-and-forget)
cleanupExpiredUploads().catch(console.error);

// Auto-migrate storage if STORAGE_TYPE changed since last startup
const STORAGE_TYPE_FILE = path.join(__dirname, '..', 'data', '.storage-type');

async function checkAndAutoMigrate(): Promise<void> {
  const currentType = (process.env.STORAGE_TYPE || 'local') as StorageType;

  // Read previously used storage type
  let previousType: StorageType | null = null;
  try {
    previousType = fs.readFileSync(STORAGE_TYPE_FILE, 'utf-8').trim() as StorageType;
  } catch { /* first run, no file yet */ }

  // Save current type for next startup
  fs.mkdirSync(path.dirname(STORAGE_TYPE_FILE), { recursive: true });
  fs.writeFileSync(STORAGE_TYPE_FILE, currentType);

  // No change or first run — nothing to do
  if (!previousType || previousType === currentType) return;

  // Check if there are any files to migrate
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as c FROM media_items').get() as { c: number }).c;
  if (count === 0) {
    console.log(`[Storage] 存储类型从 ${previousType} 切换到 ${currentType}，无文件需要迁移`);
    return;
  }

  console.warn(`[Storage] 检测到存储类型变更: ${previousType} → ${currentType}`);
  console.warn(`[Storage] 不会自动迁移文件。如需迁移，请在管理后台手动触发，或参考 README.md 中的迁移指南`);
  // Update saved type so this warning only shows once
  // (if the change was intentional, no need to warn every restart)
}

checkAndAutoMigrate().catch(console.error);

// Ensure upload directories exist
const uploadsBase = path.join(__dirname, '..', 'uploads');
const dirs = [
  uploadsBase,
  path.join(uploadsBase, 'frames'),
];
for (const dir of dirs) {
  fs.mkdirSync(dir, { recursive: true });
}

// Routes
app.use('/api/auth', authRouter);
app.use('/api/trips', tripsRouter);
app.use('/api/trips', mediaRouter);
app.use('/api/trips', processRouter);
app.use('/api/duplicate-groups', duplicateGroupsRouter);
app.use('/api/media', mediaServingRouter);
app.use('/api/media', mediaProcessRouter);
app.use('/api/media', mediaEditRouter);
app.use('/api/trips', galleryRouter);
app.use('/api', trashRouter);
app.use('/api/admin', adminRouter);
app.use('/api/users', usersRouter);
app.use('/api/my', myRouter);
app.use('/api/media', clipsRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/trips', processJobsTripRouter);
app.use('/api/process-jobs', processJobsRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Static file serving for uploads
app.use('/uploads', express.static(uploadsBase));

// In production, serve the client build
const clientBuildPath = path.join(__dirname, '..', 'public');
if (fs.existsSync(clientBuildPath)) {
  app.use(express.static(clientBuildPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientBuildPath, 'index.html'));
  });
}

// Global error handler — must be registered after all routes
app.use(globalErrorHandler);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

export default app;
