/**
 * Shared persistence helper for upserting analysis results
 * into the media_analysis table.
 *
 * Provides a generic upsert keyed by (media_id, segment_index, analysis_type)
 * using the analysis_version column as the composite discriminator.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';

export type AnalysisType = 'black_frame' | 'junk_clip';

export interface UpsertAnalysisParams {
  mediaId: string;
  segmentIndex: number;
  analysisType: AnalysisType;
  qualityScore: number;
  reasonJson: string;
}

/**
 * Build the analysis_version key from segment index and analysis type.
 * This serves as the composite discriminator in the media_analysis table.
 *
 * - black_frame: "segment_0", "segment_1", ...
 * - junk_clip: "segment_0_junk", "segment_1_junk", ...
 */
export function buildAnalysisVersion(segmentIndex: number, analysisType: AnalysisType): string {
  if (analysisType === 'junk_clip') {
    return `segment_${segmentIndex}_junk`;
  }
  return `segment_${segmentIndex}`;
}

/**
 * Upsert an analysis result into the media_analysis table.
 *
 * The record is keyed by (media_id, analysis_version) where analysis_version
 * encodes both the segment_index and analysis_type.
 *
 * If a matching record exists, it updates quality_score and reason.
 * Otherwise, it inserts a new record.
 *
 * @param params - The upsert parameters
 */
export function upsertAnalysisResult(params: UpsertAnalysisParams): void {
  const { mediaId, segmentIndex, analysisType, qualityScore, reasonJson } = params;
  const db = getDb();

  const analysisVersion = buildAnalysisVersion(segmentIndex, analysisType);

  // Check if a record already exists for this media_id + analysis_version
  const existing = db.prepare(
    `SELECT id FROM media_analysis WHERE media_id = ? AND analysis_version = ?`
  ).get(mediaId, analysisVersion) as { id: string } | undefined;

  if (existing) {
    // Update existing record
    db.prepare(
      `UPDATE media_analysis SET quality_score = ?, reason = ? WHERE id = ?`
    ).run(qualityScore, reasonJson, existing.id);
  } else {
    // Insert new record
    const id = uuidv4();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO media_analysis (id, media_id, quality_score, reason, analysis_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, mediaId, qualityScore, reasonJson, analysisVersion, now);
  }
}

/**
 * Retrieve an analysis result from the media_analysis table.
 *
 * @param mediaId - The media item ID
 * @param segmentIndex - The segment index
 * @param analysisType - The type of analysis
 * @returns The reason JSON string if found, or null
 */
export function getAnalysisResult(
  mediaId: string,
  segmentIndex: number,
  analysisType: AnalysisType
): { qualityScore: number; reasonJson: string } | null {
  const db = getDb();
  const analysisVersion = buildAnalysisVersion(segmentIndex, analysisType);

  const row = db.prepare(
    `SELECT quality_score, reason FROM media_analysis WHERE media_id = ? AND analysis_version = ?`
  ).get(mediaId, analysisVersion) as { quality_score: number; reason: string } | undefined;

  if (!row) return null;

  return {
    qualityScore: row.quality_score,
    reasonJson: row.reason,
  };
}
