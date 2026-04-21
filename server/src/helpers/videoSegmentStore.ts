import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import type { VideoSegment } from '../services/videoAnalyzer';

export interface VideoSegmentRow {
  id: string;
  media_id: string;
  segment_index: number;
  start_time: number;
  end_time: number;
  duration: number;
  sharpness_score: number | null;
  stability_score: number | null;
  exposure_score: number | null;
  overall_score: number | null;
  label: string;
  selected: number;
  created_at: string;
}

/**
 * Persist an array of VideoSegments for a given media item.
 * Uses INSERT OR REPLACE so re-analysis overwrites previous results.
 */
export function saveSegments(mediaId: string, segments: VideoSegment[]): void {
  const db = getDb();
  const now = new Date().toISOString();

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO video_segments
       (id, media_id, segment_index, start_time, end_time, duration,
        sharpness_score, stability_score, exposure_score, overall_score,
        label, selected, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const upsert = db.transaction(() => {
    for (const seg of segments) {
      // Check if a row already exists for this media_id + segment_index
      const existing = db.prepare(
        'SELECT id, selected FROM video_segments WHERE media_id = ? AND segment_index = ?'
      ).get(mediaId, seg.index) as { id: string; selected: number } | undefined;

      const id = existing?.id ?? uuidv4();
      const selected = existing?.selected ?? 0;

      stmt.run(
        id, mediaId, seg.index,
        seg.startTime, seg.endTime, seg.duration,
        seg.sharpnessScore, seg.stabilityScore, seg.exposureScore, seg.overallScore,
        seg.label, selected, now,
      );
    }
  });

  upsert();
}

/**
 * Retrieve all segments for a media item, ordered by segment_index.
 */
export function getSegments(mediaId: string): VideoSegment[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM video_segments WHERE media_id = ? ORDER BY segment_index ASC`
  ).all(mediaId) as VideoSegmentRow[];

  return rows.map(rowToVideoSegment);
}

/**
 * Update the selected flag for a specific segment.
 */
export function updateSegmentSelected(
  mediaId: string,
  segmentIndex: number,
  selected: boolean,
): void {
  const db = getDb();
  db.prepare(
    `UPDATE video_segments SET selected = ? WHERE media_id = ? AND segment_index = ?`
  ).run(selected ? 1 : 0, mediaId, segmentIndex);
}

function rowToVideoSegment(row: VideoSegmentRow): VideoSegment {
  return {
    index: row.segment_index,
    startTime: row.start_time,
    endTime: row.end_time,
    duration: row.duration,
    sharpnessScore: row.sharpness_score ?? 0,
    stabilityScore: row.stability_score ?? 0,
    exposureScore: row.exposure_score ?? 0,
    overallScore: row.overall_score ?? 0,
    label: row.label as VideoSegment['label'],
  };
}
