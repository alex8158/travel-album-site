/**
 * Smart Curation Engine
 *
 * Replaces the existing aiScreening pipeline stage with a two-phase curation engine:
 *  - Phase 1: Group photos by visual similarity (DINOv2 embeddings, tiered thresholds).
 *  - Phase 2: Select the best photo(s) per group via technical quality scoring (exact
 *    duplicates) or VLM evaluation (near-duplicates).
 *
 * Orchestration flow
 * ------------------
 *   1. Load every active image for the trip from `media_items`.
 *   2. Call `groupBySimilarity` to produce similarity groups + ungrouped singletons.
 *   3. Resolve each group:
 *        - exact_duplicate            → `selectBestByQuality` (no VLM)
 *        - near_duplicate_candidate   → optional pre-selection (top 5 by quality) +
 *                                        `selectBestByVLM`, falling back to quality on
 *                                        any failure or unparseable response
 *      Singletons / ungrouped photos are auto-kept.
 *   4. Apply trash decisions to the database in a single transaction. Only the
 *      `status` and `trashed_reason` columns are mutated — `file_path` is preserved
 *      to satisfy the soft-delete invariant.
 *   5. Write a debug JSON report and return aggregate counters.
 *
 * Graceful degradation
 * --------------------
 *   - DASHSCOPE_API_KEY missing: skip VLM entirely. Every group (including
 *     near-duplicates) is resolved with `selectBestByQuality`, and trashed
 *     photos in near-duplicate groups receive the reason `near_duplicate_worse`.
 *   - VLM throws or returns an unparseable response: fall back to
 *     `selectBestByQuality` for that group only.
 *   - VLM calls run with a concurrency limit of 3 via Promise.allSettled batching.
 */

import { getDb } from '../../database';
import { groupBySimilarity } from './similarityGrouper';
import {
  selectBestByQuality,
  preselectTopCandidates,
} from './technicalQualitySelector';
import { selectBestByVLM, getKeepQuota } from './vlmSelector';
import { writeDebugReport, type DebugReportGroupInput } from './debugReportWriter';

/** Trash reasons as a union type. Stored in `media_items.trashed_reason`. */
export type TrashReason =
  | 'exact_duplicate'
  | 'near_duplicate_worse'
  | 'scene_redundant'
  | 'blurry'
  | 'low_subject_quality'
  | 'low_aesthetic_quality'
  | 'low_video_value';

/** Group classification based on similarity tier. */
export type GroupType = 'exact_duplicate' | 'near_duplicate_candidate';

/** Similarity source used for grouping. */
export type SimilaritySource = 'dinov2' | 'phash' | 'dhash' | 'clip';

/** A photo candidate within the curation pipeline. */
export interface CurationCandidate {
  mediaId: string;
  filePath: string;
  originalFilename: string;
  fileSize: number;
  width: number | null;
  height: number | null;
  sharpnessScore: number | null;
}

/** A group of similar photos. */
export interface CurationGroup {
  groupId: string;
  groupType: GroupType;
  similaritySource: SimilaritySource;
  maxSimilarity: number;
  candidates: CurationCandidate[];
}

/** Decision for a single photo. */
export interface CurationDecision {
  mediaId: string;
  decision: 'keep' | 'trash';
  reason: TrashReason | null;
  groupId: string;
  groupType: GroupType | 'ungrouped';
  similaritySource: SimilaritySource | null;
  similarityScore: number | null;
}

/** Result of the full curation run. */
export interface SmartCurationResult {
  totalProcessed: number;
  totalTrashed: number;
  totalKept: number;
  groupsProcessed: number;
  vlmCallsMade: number;
  fallbacksUsed: number;
  debugReportPath: string;
}

/** Options for the smart curation engine. */
export interface SmartCurationOptions {
  onProgress?: (
    stage: string,
    status: 'start' | 'progress' | 'complete',
    detail?: string
  ) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of candidates sent to the VLM in a single call. */
const VLM_MAX_CANDIDATES = 5;

/** Maximum number of VLM calls processed in parallel. */
const VLM_CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface MediaRow {
  id: string;
  file_path: string;
  original_filename: string;
  file_size: number;
  width: number | null;
  height: number | null;
  sharpness_score: number | null;
}

/**
 * Per-group resolution outcome. Decisions are produced for every candidate in
 * the original (pre-preselection) group so the caller can apply them all at
 * once and the totals are easy to reason about.
 */
interface GroupResolution {
  decisions: CurationDecision[];
  vlmCallMade: boolean;
  fallbackUsed: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadActiveCandidates(tripId: string): CurationCandidate[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, file_path, original_filename, file_size, width, height, sharpness_score
         FROM media_items
        WHERE trip_id = ?
          AND media_type = 'image'
          AND status = 'active'
        ORDER BY created_at ASC`
    )
    .all(tripId) as MediaRow[];

  return rows.map((r) => ({
    mediaId: r.id,
    filePath: r.file_path,
    originalFilename: r.original_filename,
    fileSize: r.file_size,
    width: r.width,
    height: r.height,
    sharpnessScore: r.sharpness_score,
  }));
}

/**
 * Build a `CurationDecision` for a candidate that belongs to a similarity
 * group. The group fields (groupId, groupType, similaritySource,
 * similarityScore) are pulled from the supplied group so all decisions for the
 * same group are consistent.
 *
 * Pure helper used by every group-resolution path to avoid the field-by-field
 * repetition that would otherwise creep into each branch.
 */
function buildGroupDecision(
  group: CurationGroup,
  candidate: CurationCandidate,
  decision: 'keep' | 'trash',
  reason: TrashReason | null
): CurationDecision {
  return {
    mediaId: candidate.mediaId,
    decision,
    reason,
    groupId: group.groupId,
    groupType: group.groupType,
    similaritySource: group.similaritySource,
    similarityScore: group.maxSimilarity,
  };
}

/**
 * Apply trash decisions to the database in a single transaction.
 *
 * Only `status` and `trashed_reason` are mutated — `file_path` is intentionally
 * left untouched to honour the soft-delete invariant (Property 6).
 */
function applyDecisions(decisions: CurationDecision[]): void {
  const trashed = decisions.filter((d) => d.decision === 'trash');
  if (trashed.length === 0) return;

  const db = getDb();
  const stmt = db.prepare(
    `UPDATE media_items
        SET status = 'trashed',
            trashed_reason = ?
      WHERE id = ?`
  );

  const apply = db.transaction(() => {
    for (const d of trashed) {
      stmt.run(d.reason, d.mediaId);
    }
  });
  apply();
}

/**
 * Build a "keep" decision for a single photo with no similar peers.
 */
function buildUngroupedKeepDecision(c: CurationCandidate): CurationDecision {
  return {
    mediaId: c.mediaId,
    decision: 'keep',
    reason: null,
    groupId: 'ungrouped',
    groupType: 'ungrouped',
    similaritySource: null,
    similarityScore: null,
  };
}

/**
 * Resolve an exact-duplicate group: pick the best candidate by technical
 * quality, trash the rest with reason `exact_duplicate`. Never invokes the VLM.
 */
async function resolveExactDuplicateGroup(
  group: CurationGroup
): Promise<GroupResolution> {
  const bestIdx = await selectBestByQuality(group.candidates);
  const decisions = group.candidates.map((c, idx) =>
    buildGroupDecision(
      group,
      c,
      idx === bestIdx ? 'keep' : 'trash',
      idx === bestIdx ? null : 'exact_duplicate'
    )
  );
  return { decisions, vlmCallMade: false, fallbackUsed: false };
}

/**
 * Build per-candidate decisions for a near-duplicate group when the VLM is
 * unavailable or has failed. Keeps the top-`keepCount` candidates (by
 * technical quality) from `candidatesForFallback` and trashes everyone else
 * in the original group with reason `near_duplicate_worse`.
 *
 * `keepCount` defaults to 1 (single-best fallback) but the orchestrator passes
 * `keepQuota.min` for near-duplicate groups so a 9+ photo group still keeps 2
 * survivors rather than collapsing to one.
 */
async function fallbackResolveNearDuplicate(
  group: CurationGroup,
  candidatesForFallback: CurationCandidate[],
  keepCount = 1
): Promise<CurationDecision[]> {
  // Pick the top `keepCount` candidates by quality. Reuse preselectTopCandidates
  // so tie-breaking and ordering match the rest of the pipeline.
  const { selected } = await preselectTopCandidates(
    candidatesForFallback,
    Math.max(1, Math.min(keepCount, candidatesForFallback.length))
  );
  const keepIds = new Set(selected.map((c) => c.mediaId));

  return group.candidates.map((c) =>
    buildGroupDecision(
      group,
      c,
      keepIds.has(c.mediaId) ? 'keep' : 'trash',
      keepIds.has(c.mediaId) ? null : 'near_duplicate_worse'
    )
  );
}

/**
 * Resolve a near-duplicate group. Pre-selects top 5 by quality (if needed),
 * then asks the VLM to pick the survivors. Falls back to quality-based
 * selection on any error or unparseable response.
 *
 * Photos that were *not* selected during pre-selection are auto-trashed with
 * reason `near_duplicate_worse` (they are objectively lower quality than the
 * survivors that the VLM is now evaluating).
 */
async function resolveNearDuplicateGroupWithVLM(
  group: CurationGroup
): Promise<GroupResolution> {
  // 1. Pre-select the candidates the VLM will actually see.
  const { selected, originalIndices } = await preselectTopCandidates(
    group.candidates,
    VLM_MAX_CANDIDATES
  );

  // Photos dropped during pre-selection are auto-trashed.
  const selectedSet = new Set(originalIndices);
  const dropDecisions: CurationDecision[] = group.candidates
    .filter((_, idx) => !selectedSet.has(idx))
    .map((c) => buildGroupDecision(group, c, 'trash', 'near_duplicate_worse'));

  // 2. Ask the VLM about the surviving candidates.
  const keepQuota = getKeepQuota(group.candidates.length);
  let vlmCallMade = false;
  let fallbackUsed = false;
  let vlmDecisions: CurationDecision[];

  try {
    const vlmResponse = await selectBestByVLM(selected, keepQuota);
    vlmCallMade = true;

    const keepLocal = new Set(vlmResponse.keep);
    const trashReasonByLocalIdx = new Map<number, TrashReason>();
    for (const t of vlmResponse.trash) {
      trashReasonByLocalIdx.set(t.index, t.reason);
    }

    vlmDecisions = selected.map((c, localIdx) => {
      if (keepLocal.has(localIdx)) {
        return buildGroupDecision(group, c, 'keep', null);
      }
      const reason = trashReasonByLocalIdx.get(localIdx) ?? 'near_duplicate_worse';
      return buildGroupDecision(group, c, 'trash', reason);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[smartCuration] VLM call failed for group ${group.groupId} (size=${group.candidates.length}), ` +
        `falling back to quality scoring: ${msg}`
    );
    fallbackUsed = true;

    // Fallback only operates on the pre-selected survivors; the dropped
    // candidates are already trashed via dropDecisions. Honour keepQuota.min
    // so 9+ photo groups still keep 2 survivors rather than collapsing to 1.
    const fallbackDecisions = await fallbackResolveNearDuplicate(
      { ...group, candidates: selected },
      selected,
      keepQuota.min
    );
    vlmDecisions = fallbackDecisions;
  }

  return {
    decisions: [...dropDecisions, ...vlmDecisions],
    vlmCallMade,
    fallbackUsed,
  };
}

/**
 * Process an array of items in fixed-size batches with `Promise.allSettled`.
 * Used to bound VLM concurrency at `VLM_CONCURRENCY`.
 */
async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(fn));
    results.push(...settled);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runSmartCuration(
  tripId: string,
  options?: SmartCurationOptions
): Promise<SmartCurationResult> {
  const onProgress = options?.onProgress ?? (() => {});

  onProgress('smartCuration', 'start');

  const candidates = loadActiveCandidates(tripId);

  // Empty trip — bail out before doing any work.
  if (candidates.length === 0) {
    onProgress('smartCuration', 'complete', '0 photos');
    return {
      totalProcessed: 0,
      totalTrashed: 0,
      totalKept: 0,
      groupsProcessed: 0,
      vlmCallsMade: 0,
      fallbacksUsed: 0,
      debugReportPath: '',
    };
  }

  // Filename map used solely for the debug report — keeps the report
  // human-readable without forcing the writer to touch the database.
  const filenameByMediaId = new Map<string, string>();
  for (const c of candidates) {
    filenameByMediaId.set(c.mediaId, c.originalFilename);
  }

  // Phase 1: similarity grouping.
  onProgress('smartCuration', 'progress', 'grouping');
  const { groups, ungrouped } = await groupBySimilarity(candidates);

  // Singletons (groups of size 1) are auto-kept; the grouper already returns
  // them in `ungrouped`. Multi-member groups go through resolution.
  const decisions: CurationDecision[] = [];
  for (const c of ungrouped) {
    decisions.push(buildUngroupedKeepDecision(c));
  }

  // Determine whether the VLM is even reachable. When DASHSCOPE_API_KEY is
  // missing we degrade gracefully and resolve every group (including
  // near-duplicates) with technical quality scoring.
  const vlmEnabled = !!process.env.DASHSCOPE_API_KEY;
  if (!vlmEnabled) {
    console.warn(
      '[smartCuration] DASHSCOPE_API_KEY not set — skipping VLM, using quality scoring only'
    );
  }

  // Phase 2a: exact-duplicate groups (and, when VLM is disabled, every group).
  // Resolve near-duplicate groups in concurrency-limited batches with VLM
  // calls — each call is independent so Promise.allSettled isolates failures.

  let vlmCallsMade = 0;
  let fallbacksUsed = 0;

  // Walk groups sequentially for exact_duplicate, batch-parallel for near_*.
  const exactGroups = groups.filter((g) => g.groupType === 'exact_duplicate');
  const nearGroups = groups.filter((g) => g.groupType === 'near_duplicate_candidate');

  let processedGroups = 0;
  const totalGroups = groups.length;

  // Resolve exact-duplicate groups serially — the work is cheap (CPU only).
  for (const g of exactGroups) {
    const resolution = await resolveExactDuplicateGroup(g);
    decisions.push(...resolution.decisions);
    processedGroups++;
    onProgress('smartCuration', 'progress', `${processedGroups}/${totalGroups} groups`);
  }

  // Resolve near-duplicate groups. When VLM is disabled, fall back to quality
  // scoring (no concurrency batching needed — work is CPU-only). Otherwise
  // batch VLM calls at VLM_CONCURRENCY.
  if (!vlmEnabled) {
    for (const g of nearGroups) {
      const quota = getKeepQuota(g.candidates.length);
      const fallbackDecisions = await fallbackResolveNearDuplicate(
        g,
        g.candidates,
        quota.min
      );
      decisions.push(...fallbackDecisions);
      processedGroups++;
      onProgress('smartCuration', 'progress', `${processedGroups}/${totalGroups} groups`);
    }
  } else {
    const settled = await processInBatches(nearGroups, VLM_CONCURRENCY, async (g) => {
      return resolveNearDuplicateGroupWithVLM(g);
    });

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      const g = nearGroups[i];
      if (result.status === 'fulfilled') {
        decisions.push(...result.value.decisions);
        if (result.value.vlmCallMade) vlmCallsMade++;
        if (result.value.fallbackUsed) fallbacksUsed++;
      } else {
        // Whole-group resolution rejected (e.g. download failed for all candidates).
        // Final fallback: quality scoring across the full group, honouring the
        // tier's keep quota.
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.warn(
          `[smartCuration] Group ${g.groupId} resolution rejected, applying quality fallback: ${reason}`
        );
        try {
          const quota = getKeepQuota(g.candidates.length);
          const fb = await fallbackResolveNearDuplicate(g, g.candidates, quota.min);
          decisions.push(...fb);
          fallbacksUsed++;
        } catch (innerErr) {
          // Last resort: keep every photo in the group rather than risk
          // arbitrary deletions.
          console.error(
            `[smartCuration] Group ${g.groupId} quality fallback also failed; keeping all candidates: ${innerErr}`
          );
          for (const c of g.candidates) {
            decisions.push(buildGroupDecision(g, c, 'keep', null));
          }
        }
      }
      processedGroups++;
      onProgress('smartCuration', 'progress', `${processedGroups}/${totalGroups} groups`);
    }
  }

  // Phase 3: persist trash decisions atomically. Only status + trashed_reason
  // are mutated — file_path is preserved (Property 6: Soft Delete Invariant).
  applyDecisions(decisions);

  // Phase 4: write the debug report. Failures here must not fail the pipeline.
  const groupSummaries: DebugReportGroupInput[] = groups.map((g) => ({
    groupId: g.groupId,
    groupType: g.groupType,
    candidateCount: g.candidates.length,
  }));

  let debugReportPath = '';
  try {
    debugReportPath = await writeDebugReport(
      tripId,
      decisions,
      groupSummaries,
      filenameByMediaId
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[smartCuration] Failed to write debug report: ${msg}`);
  }

  // Phase 5: aggregate counters.
  const totalProcessed = decisions.length;
  const totalKept = decisions.filter((d) => d.decision === 'keep').length;
  const totalTrashed = totalProcessed - totalKept;

  const result: SmartCurationResult = {
    totalProcessed,
    totalTrashed,
    totalKept,
    groupsProcessed: groups.length,
    vlmCallsMade,
    fallbacksUsed,
    debugReportPath,
  };

  onProgress(
    'smartCuration',
    'complete',
    `${totalTrashed} trashed / ${totalProcessed} processed`
  );

  return result;
}
