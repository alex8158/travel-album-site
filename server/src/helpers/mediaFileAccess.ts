/**
 * Access rules for the media file entries `/api/media/:id/{thumbnail,original,raw}`
 * (multi-user-system G-21; 需求 9 AC 16–23).
 *
 * Two parts, kept apart on purpose:
 *
 * - `loadMediaFileAccessRow()` reads the database (one SELECT, media LEFT JOIN trips).
 * - `decideMediaFileAccess()` is a pure function of that row, the requester and
 *   the entry. It touches no database, storage or response object, so it can be
 *   tested exhaustively and always runs before any file, thumbnail, UPDATE,
 *   signing or redirect work in the route.
 *
 * Rules (owner = the trip's `user_id`, same as gallery.ts and uploadsAccess.ts):
 *
 * - Shared denials, for every requester including admin (AC 17, AC 19):
 *   media row missing; `status = 'deleted'`; trip row missing; any status other
 *   than `active` / `trashed`.
 * - Owner or admin (AC 5): `active` or `trashed`, every entry. A trip whose
 *   visibility is outside AC 7 does not affect them.
 * - Anyone else, anonymous or logged in (AC 4, AC 16–19):
 *   - trip visibility must be `public` or `unlisted` (AC 19);
 *   - media must be `active` and `public` (AC 4, AC 17);
 *   - `/raw` and `/original?original=true` are never served (AC 18);
 *   - merged videos are never served: their source set cannot currently be
 *     proven complete, so AC 12 / AC 14 fail closed (AC 18);
 *   - an ordinary video needs a non-empty `compiled_path`, a `processing_status`
 *     that is not `uploading` / `cancelled` (NULL and the historical default
 *     `none` pass), and — checked by the route, because it needs storage — the
 *     compiled file must actually exist. Only the compiled file is served; there
 *     is no fallback to the preview proxy or the original upload. The same rule
 *     gates the video's thumbnail (AC 18).
 *   - images keep the existing display selection (optimized if present, else the
 *     original). This is not an EXIF/GPS isolation.
 */
import type Database from 'better-sqlite3';

/** Which kind of file the request asks for, after classifying `?original=true`. */
export type MediaFileEntry = 'thumbnail' | 'display' | 'original-file';

/** Route the request came in on. */
export type MediaFileRoute = 'thumbnail' | 'original' | 'raw';

export interface MediaFileAccessRow {
  id: string;
  trip_id: string;
  file_path: string;
  thumbnail_path: string | null;
  media_type: string;
  status: string;
  visibility: string;
  media_source: string | null;
  processing_status: string | null;
  optimized_path: string | null;
  compiled_path: string | null;
  preview_proxy_path: string | null;
  trip_row_id: string | null;
  trip_user_id: string | null;
  trip_visibility: string | null;
}

export interface MediaFileRequester {
  userId: string;
  role: 'admin' | 'regular';
}

export type MediaFileDenyReason =
  | 'media_missing'
  | 'media_deleted'
  | 'status_not_servable'
  | 'trip_missing'
  | 'trip_visibility_not_exposable'
  | 'media_not_active'
  | 'media_not_public'
  | 'original_file_owner_only'
  | 'merged_provenance_unproven'
  | 'video_not_compiled'
  | 'video_processing_incomplete';

export type MediaFileDecision =
  | { allowed: false; reason: MediaFileDenyReason }
  | {
      allowed: true;
      asOwnerOrAdmin: boolean;
      /**
       * Non-owner video: the route must confirm the compiled file exists before
       * serving anything, and must serve only `compiled_path`.
       */
      compiledOnly: boolean;
    };

const SERVABLE_STATUSES = new Set(['active', 'trashed']);
const EXPOSABLE_TRIP_VISIBILITY = new Set(['public', 'unlisted']);
const INCOMPLETE_VIDEO_PROCESSING = new Set(['uploading', 'cancelled']);

/**
 * `/original?original=true` asks for the raw upload and is classified with
 * `/raw` before any decision is made (AC 18). Only the exact single value
 * `'true'` selects the raw upload in the route, so it is the only value
 * classified here.
 */
export function classifyMediaFileEntry(route: MediaFileRoute, originalQuery: unknown): MediaFileEntry {
  if (route === 'thumbnail') return 'thumbnail';
  if (route === 'raw') return 'original-file';
  return originalQuery === 'true' ? 'original-file' : 'display';
}

/** Reads the media row and its trip. Executes SQL; not pure. */
export function loadMediaFileAccessRow(db: Database.Database, mediaId: string): MediaFileAccessRow | undefined {
  return db
    .prepare(
      `SELECT m.id, m.trip_id, m.file_path, m.thumbnail_path, m.media_type, m.status,
              m.visibility, m.media_source, m.processing_status, m.optimized_path,
              m.compiled_path, m.preview_proxy_path,
              t.id AS trip_row_id, t.user_id AS trip_user_id, t.visibility AS trip_visibility
         FROM media_items m
         LEFT JOIN trips t ON t.id = m.trip_id
        WHERE m.id = ?`,
    )
    .get(mediaId) as MediaFileAccessRow | undefined;
}

/** Pure decision. No I/O. */
export function decideMediaFileAccess(
  row: MediaFileAccessRow | undefined,
  requester: MediaFileRequester | undefined,
  entry: MediaFileEntry,
): MediaFileDecision {
  if (!row) return { allowed: false, reason: 'media_missing' };
  if (row.status === 'deleted') return { allowed: false, reason: 'media_deleted' };
  if (!SERVABLE_STATUSES.has(row.status)) return { allowed: false, reason: 'status_not_servable' };
  if (row.trip_row_id == null) return { allowed: false, reason: 'trip_missing' };

  const isOwnerOrAdmin =
    requester != null &&
    (requester.role === 'admin' || (row.trip_user_id != null && requester.userId === row.trip_user_id));
  if (isOwnerOrAdmin) return { allowed: true, asOwnerOrAdmin: true, compiledOnly: false };

  if (row.trip_visibility == null || !EXPOSABLE_TRIP_VISIBILITY.has(row.trip_visibility)) {
    return { allowed: false, reason: 'trip_visibility_not_exposable' };
  }
  if (row.status !== 'active') return { allowed: false, reason: 'media_not_active' };
  if (row.visibility !== 'public') return { allowed: false, reason: 'media_not_public' };
  if (entry === 'original-file') return { allowed: false, reason: 'original_file_owner_only' };
  if ((row.media_source ?? 'upload') === 'merged') {
    return { allowed: false, reason: 'merged_provenance_unproven' };
  }

  if (row.media_type === 'video') {
    if (row.compiled_path == null || row.compiled_path === '') {
      return { allowed: false, reason: 'video_not_compiled' };
    }
    if (row.processing_status != null && INCOMPLETE_VIDEO_PROCESSING.has(row.processing_status)) {
      return { allowed: false, reason: 'video_processing_incomplete' };
    }
    return { allowed: true, asOwnerOrAdmin: false, compiledOnly: true };
  }

  return { allowed: true, asOwnerOrAdmin: false, compiledOnly: false };
}
