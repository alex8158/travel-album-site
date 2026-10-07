/**
 * Access-checked file serving for `/uploads` (G-22).
 *
 * Replaces the former anonymous `express.static(uploadsBase)` mount. A file is
 * served only when it is exactly a path registered on an existing
 * `media_items` row of an existing trip, and the requester passes that row's
 * existing rule:
 *
 * - Trip owner or admin (multi-user-system 需求 9 AC 5): served.
 * - Any other requester (需求 9 AC 4): served only when every matching row is
 *   `status = 'active'`, `visibility = 'public'`, not a merged video
 *   (Derived_Artifact without verified provenance, 需求 9 AC 12–14), a video
 *   only when it has a compiled version (需求 9 AC 6), and the trip's
 *   visibility is one of the two values AC 7 allows (`public` / `unlisted`;
 *   any other value grants nothing, cf. AC 15).
 *
 * Tier slideshow (`<trip>/tier-slideshow/**`) and photo slideshow
 * (`<trip>/slideshow/**`) outputs are never served here, to anyone: they have
 * no `media_items` row, no client loads them through `/uploads`, and their
 * owner/admin delivery is the authenticated `/api` routes (C1, highlight-tier
 * 需求 6 AC 9; `/api/slideshow/:jobId/download`).
 *
 * Everything else — unregistered files, deleted-trip residue, `frames/`,
 * `audio/`, dot-directories such as `.tier-staging`, malformed or escaping
 * paths — gets the same 404 JSON. Denials end the request here: they never
 * fall through to a static handler, the SPA catch-all, or `/api/media/*`.
 */
import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getDb } from '../database';

const NOT_FOUND_BODY = { error: { code: 'NOT_FOUND', message: '文件不存在' } };

/** Directories under `<tripId>/` holding Derived_Artifacts with no media row. */
const DERIVED_ARTIFACT_DIRS = new Set(['tier-slideshow', 'slideshow']);

/** Trip visibility values that may grant exposure (需求 9 AC 7). */
const EXPOSABLE_TRIP_VISIBILITY = new Set(['public', 'unlisted']);

interface MatchedRow {
  id: string;
  trip_id: string;
  media_type: string;
  status: string;
  visibility: string;
  media_source: string | null;
  compiled_path: string | null;
  trip_row_id: string | null;
  trip_user_id: string | null;
  trip_visibility: string | null;
}

function sendNotFound(res: Response): void {
  res.status(404).set('Cache-Control', 'no-store').json(NOT_FOUND_BODY);
}

/**
 * Turn the raw (still percent-encoded) request path into safe path segments
 * relative to the uploads root, or `null` if it must be rejected.
 *
 * Decodes exactly once. Rejects encoded separators / NUL / encoded `%`
 * (double encoding), backslashes, `:`, empty segments (absolute paths,
 * `//`, trailing `/`), and any segment starting with `.` (`.`, `..`,
 * dotfiles, dot-directories). Requires at least `<dir>/<file>`.
 */
export function parseUploadsPath(rawPath: string): string[] | null {
  if (!rawPath.startsWith('/')) return null;
  const encoded = rawPath.slice(1);
  if (encoded === '') return null;
  if (/%(2f|5c|00|25)/i.test(encoded)) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (/[\0\\%:]/.test(decoded)) return null;

  const segments = decoded.split('/');
  if (segments.length < 2) return null;
  for (const segment of segments) {
    if (segment === '' || segment.startsWith('.')) return null;
  }
  return segments;
}

function isInside(child: string, parent: string): boolean {
  return child.startsWith(parent + path.sep);
}

function findMatchingRows(relPath: string): MatchedRow[] {
  // Stored paths are relative to the uploads root (`<tripId>/originals/...`);
  // localProvider also accepts a legacy `uploads/` prefix, so match both.
  const candidates = [relPath, `uploads/${relPath}`];
  const params = [
    ...candidates, ...candidates, ...candidates, ...candidates, ...candidates,
  ];
  return getDb()
    .prepare(
      `SELECT m.id, m.trip_id, m.media_type, m.status, m.visibility, m.media_source,
              m.compiled_path,
              t.id AS trip_row_id, t.user_id AS trip_user_id, t.visibility AS trip_visibility
         FROM media_items m
         LEFT JOIN trips t ON t.id = m.trip_id
        WHERE m.file_path IN (?, ?)
           OR m.thumbnail_path IN (?, ?)
           OR m.optimized_path IN (?, ?)
           OR m.compiled_path IN (?, ?)
           OR m.preview_proxy_path IN (?, ?)`,
    )
    .all(...params) as MatchedRow[];
}

function isExposableToNonOwner(row: MatchedRow): boolean {
  if (row.status !== 'active') return false;
  if (row.visibility !== 'public') return false;
  if ((row.media_source ?? 'upload') === 'merged') return false;
  if (row.media_type === 'video' && !row.compiled_path) return false;
  return row.trip_visibility != null && EXPOSABLE_TRIP_VISIBILITY.has(row.trip_visibility);
}

/** Decide whether the requester may read the file behind `segments`. */
function isAllowed(req: Request, segments: string[]): boolean {
  if (DERIVED_ARTIFACT_DIRS.has(segments[1].toLowerCase())) return false;

  const rows = findMatchingRows(segments.join('/'));
  if (rows.length === 0) return false;

  const urlTripId = segments[0];
  for (const row of rows) {
    if (row.trip_row_id == null || row.trip_id !== urlTripId) return false;
  }

  const user = req.user;
  const isOwnerOrAdmin =
    user != null && (user.role === 'admin' || user.userId === rows[0].trip_user_id);
  if (isOwnerOrAdmin) return true;

  return rows.every(isExposableToNonOwner);
}

/**
 * Build the `/uploads` handler. Mount after `authMiddleware` so requests that
 * carry `Authorization: Bearer` are recognised as owner/admin.
 */
export function createUploadsAccessHandler(uploadsBase: string): RequestHandler {
  const baseResolved = path.resolve(uploadsBase);

  return async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendNotFound(res);

      const segments = parseUploadsPath(req.path);
      if (!segments) return sendNotFound(res);

      const absPath = path.resolve(baseResolved, ...segments);
      if (!isInside(absPath, baseResolved)) return sendNotFound(res);

      if (!isAllowed(req, segments)) return sendNotFound(res);

      // Do not follow symlinks out of the uploads root.
      let baseReal: string;
      let realPath: string;
      try {
        baseReal = await fs.promises.realpath(baseResolved);
        realPath = await fs.promises.realpath(absPath);
      } catch {
        return sendNotFound(res);
      }
      if (!isInside(realPath, baseReal)) return sendNotFound(res);

      const stat = await fs.promises.stat(realPath).catch(() => null);
      if (!stat || !stat.isFile()) return sendNotFound(res);

      // Never cacheable by shared caches: visibility can change after delivery,
      // and owner/admin responses depend on the Authorization header.
      res.set('Cache-Control', 'private, no-cache');
      res.vary('Authorization');

      res.sendFile(
        path.relative(baseReal, realPath),
        { root: baseReal, dotfiles: 'deny', cacheControl: false },
        (err?: Error & { status?: number; statusCode?: number; headers?: Record<string, string> }) => {
          if (!err || res.headersSent) return;
          const status = err.status ?? err.statusCode;
          if (status === 416) {
            if (err.headers) res.set(err.headers);
            res.status(416).end();
            return;
          }
          sendNotFound(res);
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[uploadsAccess] path=${req.path} failed: ${message}`);
      if (!res.headersSent) {
        res.status(500).set('Cache-Control', 'no-store').json({
          error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' },
        });
      }
    }
  };
}
