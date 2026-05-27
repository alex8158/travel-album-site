/**
 * Technical Quality Selector
 *
 * Ranks CurationCandidates using technical quality signals (sharpness, resolution,
 * file size). Used by the Smart Curation engine in two situations:
 *
 *   1. Exact duplicate groups (similarity >= 0.94) — the VLM is skipped and the
 *      best candidate is selected purely on technical quality.
 *   2. Near-duplicate groups with > 5 candidates — pre-selection reduces the group
 *      to the top N candidates before invoking the VLM.
 *
 * The ranking is a weighted score that mirrors the priority order from the design:
 *   1. Sharpness  (highest weight, dominant signal)
 *   2. Resolution (width * height)
 *   3. File size  (proxy for compression quality / detail retention)
 *
 * Normalization functions are reused from `qualitySelector.ts` to keep the score
 * scale consistent with the rest of the pipeline.
 */

import {
  normalizeSharpness,
  normalizeResolution,
  normalizeFileSize,
} from '../qualitySelector';
import type { CurationCandidate } from './smartCurationEngine';

/** Weight assigned to the sharpness component of the technical quality score. */
const SHARPNESS_WEIGHT = 0.6;
/** Weight assigned to the resolution (width*height) component. */
const RESOLUTION_WEIGHT = 0.25;
/** Weight assigned to the file size component. */
const FILE_SIZE_WEIGHT = 0.15;

/**
 * Compute a single technical quality score for a candidate in the range [0, 1].
 *
 * Nulls are treated as zero — a candidate missing a sharpness score or dimensions
 * is penalised but still scored, so the function never returns NaN. The weights
 * encode the priority order (sharpness > resolution > file size).
 *
 * Exported for testability and reuse by the orchestrator if it ever needs the
 * raw score (e.g. for tie-breaking or debug logging).
 */
export function computeTechnicalScore(candidate: CurationCandidate): number {
  const sharpnessRaw = candidate.sharpnessScore ?? 0;
  const sharpnessNorm = normalizeSharpness(sharpnessRaw);

  const w = candidate.width ?? 0;
  const h = candidate.height ?? 0;
  const resolutionNorm = normalizeResolution(w * h);

  const fileSizeNorm = normalizeFileSize(candidate.fileSize);

  return (
    SHARPNESS_WEIGHT * sharpnessNorm +
    RESOLUTION_WEIGHT * resolutionNorm +
    FILE_SIZE_WEIGHT * fileSizeNorm
  );
}

/**
 * Selects the index of the candidate with the highest technical quality score.
 *
 * Used for exact-duplicate groups where the VLM is intentionally skipped, and
 * as the final fallback when the VLM is unavailable or returns an unparseable
 * response.
 *
 * Ties are broken deterministically by preferring the lower index (i.e. the
 * earlier candidate in the input array), which keeps behaviour stable across
 * runs given the same input ordering.
 *
 * @throws if `candidates` is empty.
 */
export async function selectBestByQuality(
  candidates: CurationCandidate[]
): Promise<number> {
  if (candidates.length === 0) {
    throw new Error('selectBestByQuality requires a non-empty candidate list');
  }

  let bestIdx = 0;
  let bestScore = computeTechnicalScore(candidates[0]);

  for (let i = 1; i < candidates.length; i++) {
    const score = computeTechnicalScore(candidates[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}

/**
 * Pre-selects the top `maxCount` candidates by technical quality score.
 *
 * Used to trim large near-duplicate groups before invoking the VLM, which has
 * a hard limit of 5 candidates per call. The returned `originalIndices` map
 * each selected candidate back to its position in the input array so callers
 * can reconstruct decisions for the full group.
 *
 * If `candidates.length <= maxCount` the input is returned unchanged (preserving
 * original order). If `maxCount <= 0` an empty selection is returned.
 */
export async function preselectTopCandidates(
  candidates: CurationCandidate[],
  maxCount: number
): Promise<{ selected: CurationCandidate[]; originalIndices: number[] }> {
  if (maxCount <= 0 || candidates.length === 0) {
    return { selected: [], originalIndices: [] };
  }

  if (candidates.length <= maxCount) {
    return {
      selected: [...candidates],
      originalIndices: candidates.map((_, i) => i),
    };
  }

  // Score every candidate and keep its original index for traceability.
  const scored = candidates.map((candidate, index) => ({
    index,
    candidate,
    score: computeTechnicalScore(candidate),
  }));

  // Sort by score descending; on ties, prefer the lower original index for
  // deterministic output.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  const top = scored.slice(0, maxCount);

  // Preserve the original order of the selected candidates so downstream
  // consumers (e.g. the VLM prompt) see candidates in their natural sequence.
  top.sort((a, b) => a.index - b.index);

  return {
    selected: top.map((entry) => entry.candidate),
    originalIndices: top.map((entry) => entry.index),
  };
}
