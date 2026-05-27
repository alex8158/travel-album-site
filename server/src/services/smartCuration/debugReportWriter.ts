/**
 * Debug Report Writer
 *
 * Persists a JSON-formatted audit trail of every Smart Curation run so engineers
 * and operators can inspect grouping quality and per-photo VLM/quality decisions
 * after the fact.
 *
 * The report is written to:
 *   <server-root>/data/debug/smart-curation-{tripId}-{timestamp}.json
 *
 * The directory is created on demand (recursive: true) so callers do not have to
 * worry about provisioning it.
 *
 * Filename source
 * ---------------
 * The CurationDecision objects produced by the engine intentionally carry only
 * the information needed to apply a database update and do NOT include the
 * `original_filename` of the photo. To keep this module pure (no DB lookup) the
 * caller is expected to pass an optional `filenameByMediaId` map alongside the
 * decisions. When a mediaId is missing from the map (or the map is omitted) the
 * report falls back to the mediaId itself as the filename.
 *
 * This is a small, additive deviation from the signature documented in
 * design.md and is preferred over an embedded DB lookup because:
 *   1. The engine already knows every CurationCandidate.originalFilename, so
 *      threading the map through is essentially free.
 *   2. It keeps debugReportWriter trivially unit-testable without a database.
 */

import fs from 'fs/promises';
import path from 'path';
import type { CurationDecision } from './smartCurationEngine';

/** Debug report entry for a single photo. */
export interface DebugReportEntry {
  mediaId: string;
  filename: string;
  groupId: string;
  groupType: 'exact_duplicate' | 'near_duplicate_candidate' | 'ungrouped';
  similaritySource: 'dinov2' | 'phash' | 'dhash' | 'clip' | null;
  similarityScore: number | null;
  decision: 'keep' | 'trash';
  reason: string | null;
}

/** A summary row in the report's `groups` array. */
export interface DebugReportGroupSummary {
  groupId: string;
  groupType: string;
  candidateCount: number;
  keptCount: number;
}

/** Full debug report structure. */
export interface DebugReport {
  tripId: string;
  timestamp: string;
  totalProcessed: number;
  totalKept: number;
  totalTrashed: number;
  groups: DebugReportGroupSummary[];
  entries: DebugReportEntry[];
}

/** Group input from the caller (without keptCount, which is derived). */
export interface DebugReportGroupInput {
  groupId: string;
  groupType: string;
  candidateCount: number;
}

/**
 * Resolve the directory where debug reports are stored.
 *
 * Mirrors the convention used by `database.ts` (which resolves the data dir as
 * `<server-root>/data`). From this file's location
 * (`server/src/services/smartCuration/`) the server root is three levels up.
 */
function getDebugDir(): string {
  return path.join(__dirname, '..', '..', '..', 'data', 'debug');
}

/**
 * Convert an ISO timestamp into a filename-safe form.
 *
 * Filesystems on Windows (and some shell tooling everywhere) dislike `:` in
 * names, so we replace the time-portion separators with `-`.
 */
function timestampForFilename(date: Date): string {
  // 2024-01-15T10:30:00.000Z -> 2024-01-15T10-30-00-000Z
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Build the structured report from raw decisions and group metadata.
 * Pure function - useful for testing without writing to disk.
 */
export function buildDebugReport(
  tripId: string,
  decisions: CurationDecision[],
  groups: DebugReportGroupInput[],
  filenameByMediaId?: Map<string, string>,
  now: Date = new Date()
): DebugReport {
  // Derive keptCount per group from the decisions.
  const keptCountByGroup = new Map<string, number>();
  for (const d of decisions) {
    if (d.decision === 'keep') {
      keptCountByGroup.set(d.groupId, (keptCountByGroup.get(d.groupId) ?? 0) + 1);
    }
  }

  const groupSummaries: DebugReportGroupSummary[] = groups.map((g) => ({
    groupId: g.groupId,
    groupType: g.groupType,
    candidateCount: g.candidateCount,
    keptCount: keptCountByGroup.get(g.groupId) ?? 0,
  }));

  const entries: DebugReportEntry[] = decisions.map((d) => ({
    mediaId: d.mediaId,
    filename: filenameByMediaId?.get(d.mediaId) ?? d.mediaId,
    groupId: d.groupId,
    groupType: d.groupType,
    similaritySource: d.similaritySource,
    similarityScore: d.similarityScore,
    decision: d.decision,
    reason: d.reason,
  }));

  const totalProcessed = decisions.length;
  const totalKept = decisions.filter((d) => d.decision === 'keep').length;
  const totalTrashed = totalProcessed - totalKept;

  return {
    tripId,
    timestamp: now.toISOString(),
    totalProcessed,
    totalKept,
    totalTrashed,
    groups: groupSummaries,
    entries,
  };
}

/**
 * Writes the debug report JSON to a predictable path and returns the absolute
 * path of the file that was written.
 *
 * - Creates `<server-root>/data/debug/` if it does not yet exist.
 * - Filename pattern: `smart-curation-{tripId}-{timestamp}.json` where
 *   timestamp is the current time in a filename-safe ISO form.
 *
 * @param tripId - The trip the curation run was for.
 * @param decisions - One CurationDecision per processed photo.
 * @param groups - Group metadata produced by the SimilarityGrouper. The
 *   `keptCount` for each group is derived internally from `decisions`.
 * @param filenameByMediaId - Optional map providing the original filename for
 *   each mediaId. When omitted (or for missing keys) the mediaId is used.
 * @returns The absolute filesystem path of the written report.
 */
export async function writeDebugReport(
  tripId: string,
  decisions: CurationDecision[],
  groups: DebugReportGroupInput[],
  filenameByMediaId?: Map<string, string>
): Promise<string> {
  const now = new Date();
  const report = buildDebugReport(tripId, decisions, groups, filenameByMediaId, now);

  const debugDir = getDebugDir();
  await fs.mkdir(debugDir, { recursive: true });

  const filename = `smart-curation-${tripId}-${timestampForFilename(now)}.json`;
  const filePath = path.join(debugDir, filename);

  await fs.writeFile(filePath, JSON.stringify(report, null, 2), 'utf8');

  return filePath;
}
