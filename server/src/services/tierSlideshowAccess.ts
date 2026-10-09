/**
 * Tier slideshow read side (multi-user-system G-20, 需求 9 AC 4/5, AC 12–15;
 * highlight-tier 需求 6 AC 9, 需求 8).
 *
 * AC 4 requesters (neither trip owner nor admin), public and unlisted alike:
 *   - list: only the category's `published` row, and only when every check passes;
 *   - file: judged by the requested row's own provenance (any status, so a superseded
 *     URL stays fetchable while it passes) — independent of what the list returned;
 *   - checks: sealed row self-consistent; every source currently exists, belongs to
 *     this trip, is public and active; the file is a regular file whose full sha256
 *     equals `file_sha256`. Unregistered (historical) files and the legacy root `all`
 *     are never listed or served.
 * Owner/admin (需求 9 AC 5):
 *   - a category with any registered row: only its unique `published` row, which must
 *     be self-consistent with an intact file (full hash) — no fallback to other files;
 *   - a category with no registered row (compatibility branch): the bc9545a selection,
 *     unchanged except that every `tsa_*` name is excluded.
 *
 * A file is served from the very descriptor it was verified through: open once
 * (no-follow), fstat + hash from that fd, then stream from the same fd. The path is
 * never re-opened after verification, and nothing is cached: there is no file
 * attribute that reliably reveals every content change (see report §B).
 */
import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import { getDb } from '../database';
import {
  ARTIFACT_FILE_PREFIX,
  ARTIFACT_FILE_RE,
  CATEGORY_RE,
  TierArtifactRow,
  artifactUrl,
  buildArtifactRelPath,
  canonicalManifest,
  digestFd,
  getUploadsBase,
  openNoFollow,
  sha256Hex,
} from './tierSlideshowProvenance';

const TRIP_VISIBILITIES_GRANTING_EXPOSURE = new Set(['public', 'unlisted']);
const MEDIA_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;

export interface TripRef {
  id: string;
  visibility: string;
}

/** Row is self-consistent: manifest shape, digest, and file-name binding. */
function parseSealedManifest(row: TierArtifactRow): string[] | null {
  let ids: unknown;
  try {
    ids = JSON.parse(row.manifest_json);
  } catch {
    return null;
  }
  if (!Array.isArray(ids) || ids.length === 0 || ids.length !== row.source_count) return null;
  if (!ids.every((v) => typeof v === 'string' && MEDIA_ID_RE.test(v))) return null;
  if (new Set(ids).size !== ids.length) return null;
  if (canonicalManifest(ids as string[]) !== row.manifest_json) return null;
  if (sha256Hex(row.manifest_json) !== row.manifest_sha256) return null;
  if (buildArtifactRelPath(row.trip_id, row.category, row.id, row.manifest_sha256) !== row.rel_path) return null;
  return ids as string[];
}

/** 需求 9 AC 12–15 source conditions for an AC 4 requester. */
function ac4SourcesOk(trip: TripRef, row: TierArtifactRow, ids: string[]): boolean {
  if (!TRIP_VISIBILITIES_GRANTING_EXPOSURE.has(trip.visibility)) return false;
  if (row.trip_id !== trip.id) return false;
  const placeholders = ids.map(() => '?').join(',');
  const sources = getDb()
    .prepare(`SELECT id, trip_id, visibility, status FROM media_items WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; trip_id: string; visibility: string; status: string }>;
  if (sources.length !== ids.length) return false;
  return sources.every((s) => s.trip_id === trip.id && s.visibility === 'public' && s.status === 'active');
}

/** An open descriptor whose bytes were verified against the sealed row. Caller owns `fd`. */
export interface VerifiedArtifactFile {
  fd: number;
  size: number;
}

/**
 * Open the artifact file once (no-follow) and verify it through that descriptor:
 * regular file, size = file_size, full sha256 = file_sha256. Returns the still-open
 * fd on success; closes it and returns null otherwise.
 */
async function openVerifiedArtifact(row: TierArtifactRow): Promise<VerifiedArtifactFile | null> {
  let fd: number;
  try {
    fd = openNoFollow(path.join(getUploadsBase(), row.rel_path));
  } catch {
    return null;
  }
  try {
    const d = await digestFd(fd);
    if (d.isFile && d.size === row.file_size && d.sha256 === row.file_sha256) return { fd, size: d.size };
  } catch {
    // unreadable → refused below
  }
  fs.closeSync(fd);
  return null;
}

async function artifactFileIntact(row: TierArtifactRow): Promise<boolean> {
  const v = await openVerifiedArtifact(row);
  if (!v) return false;
  fs.closeSync(v.fd);
  return true;
}

function rowsForTrip(tripId: string): TierArtifactRow[] {
  return getDb()
    .prepare('SELECT * FROM tier_slideshow_artifacts WHERE trip_id = ? ORDER BY category, created_at, id')
    .all(tripId) as TierArtifactRow[];
}

/**
 * `slideshowUrls` for GET /api/trips/:id/tier-photos and GET /api/my/trips/:id/tier-photos.
 * "Available" means enumerable to this requester, never "exists on disk".
 */
export async function listTierSlideshowUrls(trip: TripRef, isOwnerOrAdmin: boolean): Promise<Record<string, string>> {
  const rows = rowsForTrip(trip.id);
  const published = new Map<string, TierArtifactRow>();
  const registered = new Set<string>();
  for (const r of rows) {
    registered.add(r.category);
    if (r.status === 'published') published.set(r.category, r);
  }

  if (!isOwnerOrAdmin) {
    const urls: Record<string, string> = {};
    for (const [category, row] of published) {
      const ids = parseSealedManifest(row);
      if (ids && ac4SourcesOk(trip, row, ids) && (await artifactFileIntact(row))) {
        urls[category] = artifactUrl(trip.id, category, row.rel_path);
      }
    }
    return urls;
  }

  // Owner/admin, registered categories: the unique published row, nothing else.
  const registeredUrls = new Map<string, string>();
  for (const [category, row] of published) {
    if (parseSealedManifest(row) && (await artifactFileIntact(row))) {
      registeredUrls.set(category, artifactUrl(trip.id, category, row.rel_path));
    }
  }
  return compatibilityUrls(trip.id, registered, registeredUrls);
}

/**
 * Owner/admin directory listing. For categories with no registered row this is the
 * bc9545a algorithm verbatim — category: first `.mp4` in `fs.readdirSync` order (no
 * sort, silent files not filtered); legacy root: every root `.mp4` assigned to `all`
 * in readdir order, so the last one wins — except that `tsa_*` names are skipped.
 * Registered categories take their verified published URL (or nothing) instead.
 */
function compatibilityUrls(
  tripId: string,
  registered: Set<string>,
  registeredUrls: Map<string, string>,
): Record<string, string> {
  const urls: Record<string, string> = {};
  const tierSlideshowDir = path.join(getUploadsBase(), tripId, 'tier-slideshow');
  const isHistorical = (f: string) => f.endsWith('.mp4') && !f.startsWith(ARTIFACT_FILE_PREFIX);
  try {
    if (fs.existsSync(tierSlideshowDir)) {
      const entries = fs.readdirSync(tierSlideshowDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (registered.has(entry.name)) {
            const url = registeredUrls.get(entry.name);
            if (url) urls[entry.name] = url;
            continue;
          }
          const catDir = path.join(tierSlideshowDir, entry.name);
          const catFiles = fs.readdirSync(catDir);
          const mp4File = catFiles.find(isHistorical);
          if (mp4File) {
            urls[entry.name] = `/api/trips/${tripId}/tier-slideshow/${entry.name}/${mp4File}`;
          }
        } else if (entry.isFile() && isHistorical(entry.name)) {
          urls['all'] = `/api/trips/${tripId}/tier-slideshow/${entry.name}`;
        }
      }
    }
  } catch {
    // Directory not readable (bc9545a: keep what was collected so far)
  } finally {
    for (const [category, url] of registeredUrls) if (!(category in urls)) urls[category] = url;
  }
  return urls;
}

export type TierSlideshowFile =
  | { kind: 'verified'; fd: number; size: number }
  | { kind: 'historical'; path: string };

/**
 * Resolve GET /api/trips/:id/tier-slideshow/:category/:filename. Returns null when the
 * request must be refused (caller answers 404). `category`/`filename` are the
 * basename-normalised params. A `verified` result carries an open fd the caller must
 * stream from (and thereby close).
 */
export async function resolveTierSlideshowFile(
  trip: TripRef,
  isOwnerOrAdmin: boolean,
  category: string,
  filename: string,
): Promise<TierSlideshowFile | null> {
  if (category === '.' || category === '..') return null;

  if (filename.startsWith(ARTIFACT_FILE_PREFIX)) {
    if (!CATEGORY_RE.test(category) || !ARTIFACT_FILE_RE.test(filename)) return null;
    const row = getDb()
      .prepare('SELECT * FROM tier_slideshow_artifacts WHERE rel_path = ? AND trip_id = ? AND category = ?')
      .get(`${trip.id}/tier-slideshow/${category}/${filename}`, trip.id, category) as TierArtifactRow | undefined;
    if (!row) return null;
    const ids = parseSealedManifest(row);
    if (!ids) return null;
    if (!isOwnerOrAdmin && !ac4SourcesOk(trip, row, ids)) return null;
    const v = await openVerifiedArtifact(row);
    return v ? { kind: 'verified', fd: v.fd, size: v.size } : null;
  }

  // Historical (unregistered) files: owner/admin only, existing behaviour.
  if (!isOwnerOrAdmin) return null;
  const abs = path.join(getUploadsBase(), trip.id, 'tier-slideshow', category, filename);
  return fs.existsSync(abs) ? { kind: 'historical', path: abs } : null;
}

/**
 * Stream a verified artifact from its already-open descriptor (Range supported via
 * start/end on the same fd). The fd is closed when the stream ends, errors, or the
 * client goes away.
 */
export function streamVerifiedFd(req: Request, res: Response, fd: number, size: number): void {
  const range = req.headers.range;
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    start = parseInt(parts[0], 10);
    end = parts[1] ? Math.min(parseInt(parts[1], 10), size - 1) : size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end) {
      fs.closeSync(fd);
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
      res.end();
      return;
    }
    status = 206;
  }
  const headers: Record<string, string | number> = {
    'Content-Length': end - start + 1,
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  const stream = fs.createReadStream('', { fd, start, end, autoClose: true });
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
