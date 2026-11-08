/**
 * Owner/admin gate for media processing write routes
 * (multi-user-system G-27, 需求 7 AC 8):
 *
 * - POST /api/media/:mediaId/clips    (routes/clips.ts)
 * - POST /api/media/:mediaId/merge    (routes/clips.ts)
 * - POST /api/media/:mediaId/re-edit  (routes/clips.ts)
 * - POST /api/media/:mediaId/compile  (routes/compile.ts)
 *
 * Decision order (first match wins), evaluated on the URL `:mediaId` only;
 * request bodies carry segment indices that are resolved inside that media:
 *   1. media row missing, `status = 'deleted'`, or trip row missing → 404 (everyone)
 *   2. requester fails Owner_Or_Admin_Rule (trip owner or admin)    → 403 FORBIDDEN
 *   3. owner/admin but media is not `active` (e.g. trashed)          → 404
 *   4. otherwise allowed
 *
 * `decideOwnerMediaWrite` is pure; `authorizeOwnerMediaWrite` reads the DB.
 */
import type { Request } from 'express';
import { getDb } from '../database';
import { loadMediaFileAccessRow, type MediaFileAccessRow, type MediaFileRequester } from './mediaFileAccess';

export const OWNER_WRITE_FORBIDDEN_BODY = { error: { code: 'FORBIDDEN', message: '无权操作此资源' } } as const;

export type OwnerWriteDecision =
  | { allowed: true }
  | { allowed: false; status: 404; reason: 'media_missing' | 'media_deleted' | 'trip_missing' | 'media_not_active' }
  | { allowed: false; status: 403; reason: 'not_owner_or_admin' };

/** Pure decision. No I/O. */
export function decideOwnerMediaWrite(
  row: MediaFileAccessRow | undefined,
  requester: MediaFileRequester | undefined,
): OwnerWriteDecision {
  if (!row) return { allowed: false, status: 404, reason: 'media_missing' };
  if (row.status === 'deleted') return { allowed: false, status: 404, reason: 'media_deleted' };
  if (row.trip_row_id == null) return { allowed: false, status: 404, reason: 'trip_missing' };
  const isOwnerOrAdmin =
    requester != null &&
    (requester.role === 'admin' || (row.trip_user_id != null && requester.userId === row.trip_user_id));
  if (!isOwnerOrAdmin) return { allowed: false, status: 403, reason: 'not_owner_or_admin' };
  if (row.status !== 'active') return { allowed: false, status: 404, reason: 'media_not_active' };
  return { allowed: true };
}

/** Reads the media row and its trip, then decides. Executes SQL; not pure. */
export function authorizeOwnerMediaWrite(req: Request, mediaId: string): OwnerWriteDecision {
  return decideOwnerMediaWrite(loadMediaFileAccessRow(getDb(), mediaId), req.user);
}
