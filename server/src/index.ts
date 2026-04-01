import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { getDb } from './database';
import tripsRouter from './routes/trips';
import mediaRouter from './routes/media';
import processRouter from './routes/process';
import duplicateGroupsRouter from './routes/duplicateGroups';
import mediaServingRouter from './routes/mediaServing';
import galleryRouter from './routes/gallery';
import trashRouter from './routes/trash';
import { globalErrorHandler } from './middleware/errorHandler';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize database
getDb();

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
app.use('/api/trips', tripsRouter);
app.use('/api/trips', mediaRouter);
app.use('/api/trips', processRouter);
app.use('/api/duplicate-groups', duplicateGroupsRouter);
app.use('/api/media', mediaServingRouter);
app.use('/api/trips', galleryRouter);
app.use('/api', trashRouter);

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
