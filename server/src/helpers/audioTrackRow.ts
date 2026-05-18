import type { AudioTrack } from '../types';

export interface AudioTrackRow {
  id: string;
  user_id: string;
  title: string;
  file_path: string;
  format: string;
  duration: number;
  file_size: number;
  source: string;
  source_url: string | null;
  created_at: string;
}

/**
 * Convert a raw DB row (snake_case) to an AudioTrack object (camelCase).
 */
export function rowToAudioTrack(row: AudioTrackRow): AudioTrack {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    filePath: row.file_path,
    format: row.format as AudioTrack['format'],
    duration: row.duration,
    fileSize: row.file_size,
    source: row.source as AudioTrack['source'],
    sourceUrl: row.source_url ?? undefined,
    createdAt: row.created_at,
  };
}
