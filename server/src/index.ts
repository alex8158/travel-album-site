import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { getDb } from './database';
import { getStorageProvider, createStorageProviderForType } from './storage/factory';
import { migrateStorage } from './services/migrationTool';
import type { StorageType } from './storage/types';
import authRouter from './routes/auth';
import tripsRouter from './routes/trips';
import mediaRouter from './routes/media';
import processRouter from './routes/process';
import duplicateGroupsRouter from './routes/duplicateGroups';
import mediaServingRouter from './routes/mediaServing';
import galleryRouter from './routes/gallery';
import trashRouter from './routes/trash';
import adminRouter from './routes/admin';
import usersRouter from './routes/users';
import { globalErrorHandler } from './middleware/errorHandler';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize database
getDb();

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

  console.log(`[Storage] 检测到存储类型变更: ${previousType} → ${currentType}，开始自动迁移 ...`);

  try {
    const sourceProvider = createStorageProviderForType(previousType);
    const targetProvider = createStorageProviderForType(currentType);
    const result = await migrateStorage(sourceProvider, targetProvider);

    console.log(`[Storage] 自动迁移完成: 成功 ${result.successCount} 个, 失败 ${result.failedCount} 个`);
    if (result.failedCount > 0) {
      console.warn(`[Storage] 以下文件迁移失败:`);
      for (const f of result.failedFiles) {
        console.warn(`  - ${f.path}: ${f.error}`);
      }
      console.warn(`[Storage] 请在管理后台手动重试迁移，或参考 README.md 中的迁移指南`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Storage] 自动迁移失败: ${msg}`);
    console.error(`[Storage] 旧存储类型 (${previousType}) 的凭证可能已失效，无法读取源文件`);
    console.error(`[Storage] 请在管理后台手动迁移，或参考 README.md 中的迁移指南`);
    // Revert the saved type so next restart will retry
    fs.writeFileSync(STORAGE_TYPE_FILE, previousType);
  }
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
app.use('/api/trips', galleryRouter);
app.use('/api', trashRouter);
app.use('/api/admin', adminRouter);
app.use('/api/users', usersRouter);

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
