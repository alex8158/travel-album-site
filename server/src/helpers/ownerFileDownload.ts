/**
 * Owner/admin-only gate for the compiled-video download routes
 * (multi-user-system G-24, 需求 9 AC 24):
 *
 * - GET /api/media/:mediaId/download-compiled  (routes/clips.ts)
 * - GET /api/media/:mediaId/compile/download   (routes/compile.ts)
 *
 * Reuses the G-21 loader and pure decision with the `original-file` entry,
 * which already refuses every non-owner (public and unlisted media included)
 * and applies the shared denials (missing row, `deleted` and other non
 * `active`/`trashed` statuses, missing trip row) to everyone. The explicit
 * `asOwnerOrAdmin` check below pins the owner/admin boundary at this route
 * edge so a future change to the `original-file` rule cannot widen downloads.
 */
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../database';
import { decideMediaFileAccess, loadMediaFileAccessRow, type MediaFileAccessRow } from './mediaFileAccess';

/** Same body for "no such media" and "not yours", so the two cannot be told apart. */
export const OWNER_FILE_NOT_FOUND_BODY = { error: { code: 'NOT_FOUND', message: '媒体文件不存在' } } as const;

/**
 * Mounted before `requireAuth` so the 401 it returns early also carries the
 * headers. `res.vary` merges with any existing Vary value.
 */
export function privateNoStore(_req: Request, res: Response, next: NextFunction): void {
  res.set('Cache-Control', 'private, no-store');
  res.vary('Authorization');
  next();
}

/** Returns the row when the requester is the owner or an admin; otherwise null. */
export function authorizeOwnerFileDownload(req: Request, mediaId: string): MediaFileAccessRow | null {
  const row = loadMediaFileAccessRow(getDb(), mediaId);
  const decision = decideMediaFileAccess(row, req.user, 'original-file');
  if (!row || !decision.allowed || !decision.asOwnerOrAdmin) return null;
  return row;
}
