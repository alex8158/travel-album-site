import type { MediaItem } from '../types';

export interface MediaItemRow {
  id: string;
  trip_id: string;
  file_path: string;
  thumbnail_path: string | null;
  media_type: string;
  mime_type: string;
  original_filename: string;
  file_size: number;
  width: number | null;
  height: number | null;
  perceptual_hash: string | null;
  quality_score: number | null;
  sharpness_score: number | null;
  duplicate_group_id: string | null;
  status: string;
  trashed_reason: string | null;
  processing_error: string | null;
  optimized_path: string | null;
  compiled_path: string | null;
  created_at: string;
}

/**
 * Convert a raw DB row to a MediaItem object.
 * Note: filePath is kept as the relative DB path. Callers that need
 * absolute paths should resolve it themselves using path.resolve(serverRoot, item.filePath).
 */
export function rowToMediaItem(row: MediaItemRow): MediaItem {
  return {
    id: row.id,
    tripId: row.trip_id,
    filePath: row.file_path,
    thumbnailPath: row.thumbnail_path ?? undefined,
    mediaType: row.media_type as MediaItem['mediaType'],
    mimeType: row.mime_type,
    originalFilename: row.original_filename,
    fileSize: row.file_size,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    perceptualHash: row.perceptual_hash ?? undefined,
    qualityScore: row.quality_score ?? undefined,
    sharpnessScore: row.sharpness_score ?? undefined,
    duplicateGroupId: row.duplicate_group_id ?? undefined,
    status: (row.status || 'active') as MediaItem['status'],
    trashedReason: row.trashed_reason ?? undefined,
    processingError: row.processing_error ?? undefined,
    optimizedPath: row.optimized_path ?? undefined,
    compiledPath: row.compiled_path ?? undefined,
    createdAt: row.created_at,
  };
}
