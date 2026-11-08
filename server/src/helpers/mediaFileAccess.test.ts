import { describe, it, expect } from 'vitest';
import {
  classifyMediaFileEntry,
  decideMediaFileAccess,
  type MediaFileAccessRow,
  type MediaFileEntry,
  type MediaFileRequester,
} from './mediaFileAccess';

const OWNER: MediaFileRequester = { userId: 'owner-1', role: 'regular' };
const OTHER: MediaFileRequester = { userId: 'other-1', role: 'regular' };
const ADMIN: MediaFileRequester = { userId: 'admin-1', role: 'admin' };
const NON_OWNERS: Array<[string, MediaFileRequester | undefined]> = [['anonymous', undefined], ['non-owner', OTHER]];
const PRIVILEGED: Array<[string, MediaFileRequester]> = [['owner', OWNER], ['admin', ADMIN]];
const ENTRIES: MediaFileEntry[] = ['thumbnail', 'display', 'original-file'];

function row(overrides: Partial<MediaFileAccessRow> = {}): MediaFileAccessRow {
  return {
    id: 'm1',
    trip_id: 't1',
    file_path: 't1/originals/m1.jpg',
    thumbnail_path: null,
    media_type: 'image',
    status: 'active',
    visibility: 'public',
    media_source: 'upload',
    processing_status: 'none',
    optimized_path: null,
    compiled_path: null,
    preview_proxy_path: null,
    trip_row_id: 't1',
    trip_user_id: 'owner-1',
    trip_visibility: 'public',
    ...overrides,
  };
}

const video = (o: Partial<MediaFileAccessRow> = {}) =>
  row({ media_type: 'video', file_path: 't1/originals/m1.mp4', compiled_path: 't1/compiled/m1.mp4', ...o });

describe('classifyMediaFileEntry', () => {
  it('classifies /raw and /original?original=true as the original-file entry', () => {
    expect(classifyMediaFileEntry('raw', undefined)).toBe('original-file');
    expect(classifyMediaFileEntry('original', 'true')).toBe('original-file');
  });
  it('keeps every other /original request on the display entry', () => {
    expect(classifyMediaFileEntry('original', undefined)).toBe('display');
    expect(classifyMediaFileEntry('original', 'false')).toBe('display');
    // The route only picks the raw upload for the exact string 'true'.
    expect(classifyMediaFileEntry('original', ['true', 'true'])).toBe('display');
  });
  it('classifies the thumbnail route as thumbnail regardless of query', () => {
    expect(classifyMediaFileEntry('thumbnail', 'true')).toBe('thumbnail');
  });
});

describe('decideMediaFileAccess — shared denials (all requesters, including admin)', () => {
  const everyone: Array<[string, MediaFileRequester | undefined]> = [...NON_OWNERS, ...PRIVILEGED];
  it.each(everyone)('%s: missing row, deleted, unknown status and missing trip are denied', (_n, who) => {
    for (const entry of ENTRIES) {
      expect(decideMediaFileAccess(undefined, who, entry)).toEqual({ allowed: false, reason: 'media_missing' });
      expect(decideMediaFileAccess(row({ status: 'deleted' }), who, entry)).toEqual({ allowed: false, reason: 'media_deleted' });
      expect(decideMediaFileAccess(row({ status: 'pending' }), who, entry)).toEqual({ allowed: false, reason: 'status_not_servable' });
      expect(decideMediaFileAccess(row({ trip_row_id: null, trip_user_id: null, trip_visibility: null }), who, entry))
        .toEqual({ allowed: false, reason: 'trip_missing' });
    }
  });
});

describe('decideMediaFileAccess — owner and admin', () => {
  it.each(PRIVILEGED)('%s may read private, trashed, merged, uncompiled and raw entries', (_n, who) => {
    const rows = [
      row({ visibility: 'private' }),
      row({ status: 'trashed' }),
      video({ media_source: 'merged' }),
      video({ compiled_path: null, preview_proxy_path: 't1/proxy/m1.mp4' }),
      video({ processing_status: 'uploading' }),
      row({ trip_visibility: 'private' }),
      row({ media_type: 'unknown' }),
    ];
    for (const r of rows) {
      for (const entry of ENTRIES) {
        expect(decideMediaFileAccess(r, who, entry)).toEqual({ allowed: true, asOwnerOrAdmin: true, compiledOnly: false });
      }
    }
  });
  it('a trip without user_id has no owner; only admin passes', () => {
    const r = row({ trip_user_id: null, visibility: 'private' });
    expect(decideMediaFileAccess(r, OWNER, 'display').allowed).toBe(false);
    expect(decideMediaFileAccess(r, ADMIN, 'display').allowed).toBe(true);
  });
});

describe('decideMediaFileAccess — anonymous and non-owner (same rule)', () => {
  it.each(NON_OWNERS)('%s: public active image on a public or unlisted trip is allowed for thumbnail and display', (_n, who) => {
    for (const tv of ['public', 'unlisted']) {
      for (const entry of ['thumbnail', 'display'] as MediaFileEntry[]) {
        expect(decideMediaFileAccess(row({ trip_visibility: tv }), who, entry))
          .toEqual({ allowed: true, asOwnerOrAdmin: false, compiledOnly: false });
      }
    }
  });

  it.each(NON_OWNERS)('%s: denials', (_n, who) => {
    const cases: Array<[Partial<MediaFileAccessRow>, MediaFileEntry, string]> = [
      [{ trip_visibility: 'private' }, 'display', 'trip_visibility_not_exposable'],
      [{ trip_visibility: '' }, 'display', 'trip_visibility_not_exposable'],
      [{ trip_visibility: null }, 'thumbnail', 'trip_visibility_not_exposable'],
      [{ status: 'trashed' }, 'thumbnail', 'media_not_active'],
      [{ visibility: 'private' }, 'thumbnail', 'media_not_public'],
      [{ visibility: 'PUBLIC' }, 'display', 'media_not_public'],
      [{}, 'original-file', 'original_file_owner_only'],
    ];
    for (const [o, entry, reason] of cases) {
      expect(decideMediaFileAccess(row(o), who, entry)).toEqual({ allowed: false, reason });
    }
  });

  it.each(NON_OWNERS)('%s: ordinary compiled video is allowed compiled-only; NULL and none processing_status pass', (_n, who) => {
    for (const ps of [null, 'none', 'completed', 'ready']) {
      for (const entry of ['thumbnail', 'display'] as MediaFileEntry[]) {
        expect(decideMediaFileAccess(video({ processing_status: ps }), who, entry))
          .toEqual({ allowed: true, asOwnerOrAdmin: false, compiledOnly: true });
      }
    }
    // NULL media_source counts as an upload, not as merged.
    expect(decideMediaFileAccess(video({ media_source: null }), who, 'display').allowed).toBe(true);
  });

  it.each(NON_OWNERS)('%s: uncompiled, incomplete, merged videos and video raw entries are denied, thumbnail included', (_n, who) => {
    const cases: Array<[Partial<MediaFileAccessRow>, string]> = [
      [{ compiled_path: null, preview_proxy_path: 't1/proxy/m1.mp4' }, 'video_not_compiled'],
      [{ compiled_path: '' }, 'video_not_compiled'],
      [{ processing_status: 'uploading' }, 'video_processing_incomplete'],
      [{ processing_status: 'cancelled' }, 'video_processing_incomplete'],
      [{ media_source: 'merged' }, 'merged_provenance_unproven'],
    ];
    for (const [o, reason] of cases) {
      for (const entry of ['thumbnail', 'display'] as MediaFileEntry[]) {
        expect(decideMediaFileAccess(video(o), who, entry)).toEqual({ allowed: false, reason });
      }
    }
    expect(decideMediaFileAccess(video(), who, 'original-file')).toEqual({ allowed: false, reason: 'original_file_owner_only' });
  });

  it('a merged video is denied even when all of its state looks public and active', () => {
    const r = video({ media_source: 'merged', compiled_path: 't1/merged/x.mp4', processing_status: null });
    expect(decideMediaFileAccess(r, undefined, 'display')).toEqual({ allowed: false, reason: 'merged_provenance_unproven' });
  });
});
