/**
 * SegmentSelector — 片段选择器
 *
 * 基于 video_segments 的 overallScore 选择最佳片段，
 * 复用 editPlanner.ts 中 fallbackSelection 的核心逻辑，
 * 增加排除规则和邻近片段优先逻辑。
 *
 * Requirements: 1.2, 1.3, 1.5, 6.2, 6.3, 6.4, 6.5, 6.6
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SegmentCandidate {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  overallScore: number;
  label: string;
}

export interface SelectionResult {
  selectedIndices: number[];
  totalDuration: number;
  skippedCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Labels that indicate severely low quality — these segments are always excluded */
const SEVERELY_LOW_QUALITY_LABELS = new Set([
  'severely_blurry',
  'severely_shaky',
  'severely_exposed',
]);

/** Minimum overallScore threshold for inclusion */
const MIN_SCORE_THRESHOLD = 30;

/** Maximum score difference for adjacency preference */
const ADJACENCY_SCORE_DIFF = 10;

/** Maximum startTime gap (seconds) for adjacency preference */
const ADJACENCY_TIME_GAP = 5;

// ---------------------------------------------------------------------------
// Core Selection Logic
// ---------------------------------------------------------------------------

/**
 * Select segments based on quality score with greedy strategy.
 *
 * Strategy:
 * 1. Exclude segments with severely low quality labels
 * 2. Exclude segments with overallScore < 30
 * 3. Sort remaining by overallScore descending
 * 4. Greedy select until cumulative duration >= targetDuration
 *    (last segment is allowed to exceed targetDuration)
 * 5. Apply adjacency preference: when score diff <= 10 and startTime gap <= 5s,
 *    prefer segments that form contiguous intervals with already-selected segments
 * 6. Sort final selection by startTime ascending
 *
 * Requirements: 1.2, 1.3, 1.5, 6.2, 6.3, 6.4, 6.5, 6.6
 */
export function selectSegments(
  segments: SegmentCandidate[],
  targetDuration: number,
): SelectionResult {
  // Step 1 & 2: Filter out excluded segments
  const eligible = segments.filter(
    (seg) =>
      !SEVERELY_LOW_QUALITY_LABELS.has(seg.label) &&
      seg.overallScore >= MIN_SCORE_THRESHOLD,
  );

  const skippedCount = segments.length - eligible.length;

  if (eligible.length === 0) {
    return { selectedIndices: [], totalDuration: 0, skippedCount };
  }

  // Step 3: Sort by overallScore descending
  const sorted = [...eligible].sort((a, b) => b.overallScore - a.overallScore);

  // Step 4 & 5: Greedy selection with adjacency preference
  const selected: SegmentCandidate[] = [];
  const selectedSet = new Set<number>();
  let cumulativeDuration = 0;

  // Use a remaining pool that we pick from
  const remaining = [...sorted];

  while (remaining.length > 0 && cumulativeDuration < targetDuration) {
    // Pick the best candidate from remaining
    const bestCandidate = remaining[0];

    // Look for adjacency-preferred candidates among those with similar scores
    let chosenIdx = 0;

    if (selected.length > 0) {
      // Find candidates within ADJACENCY_SCORE_DIFF of the best candidate
      for (let i = 1; i < remaining.length; i++) {
        const candidate = remaining[i];
        const scoreDiff = bestCandidate.overallScore - candidate.overallScore;

        // Only consider candidates within the score difference threshold
        if (scoreDiff > ADJACENCY_SCORE_DIFF) break;

        // Check if this candidate is adjacent to any already-selected segment
        if (isAdjacentToSelected(candidate, selected)) {
          // And the best candidate is NOT adjacent (otherwise best candidate wins)
          if (!isAdjacentToSelected(bestCandidate, selected)) {
            chosenIdx = i;
            break;
          }
        }
      }
    }

    const chosen = remaining[chosenIdx];
    selected.push(chosen);
    selectedSet.add(chosen.index);
    cumulativeDuration += chosen.duration;

    // Remove chosen from remaining
    remaining.splice(chosenIdx, 1);
  }

  // Step 6: Sort final selection by startTime ascending
  selected.sort((a, b) => a.startTime - b.startTime);

  return {
    selectedIndices: selected.map((s) => s.index),
    totalDuration: cumulativeDuration,
    skippedCount,
  };
}

/**
 * Check if a candidate segment is adjacent to any already-selected segment.
 * Adjacent means startTime gap <= ADJACENCY_TIME_GAP seconds.
 */
function isAdjacentToSelected(
  candidate: SegmentCandidate,
  selected: SegmentCandidate[],
): boolean {
  for (const sel of selected) {
    const gap = Math.abs(candidate.startTime - sel.endTime);
    const gapReverse = Math.abs(sel.startTime - candidate.endTime);
    if (gap <= ADJACENCY_TIME_GAP || gapReverse <= ADJACENCY_TIME_GAP) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Target Duration Calculation
// ---------------------------------------------------------------------------

/**
 * Calculate target duration based on original video duration.
 *
 * - originalDuration < 60s → null (no upper limit, keep all valid segments)
 * - 60s <= originalDuration <= 600s → 60s
 * - originalDuration > 600s → 300s
 *
 * Requirements: 1.3, 1.4
 */
export function calculateTargetDuration(originalDuration: number): number | null {
  if (originalDuration < 60) return null;
  if (originalDuration <= 600) return 60;
  return 300;
}

// ---------------------------------------------------------------------------
// Validation Functions
// ---------------------------------------------------------------------------

/**
 * Validate targetDuration parameter.
 * Valid: positive integer in [10, 600].
 *
 * Requirements: 3.5, 3.6, 7.5, 7.10
 */
export function validateTargetDuration(value: unknown): { valid: boolean; error?: string } {
  if (value === undefined || value === null) {
    return { valid: false, error: 'targetDuration is required' };
  }

  const num = typeof value === 'string' ? Number(value) : value;

  if (typeof num !== 'number' || isNaN(num)) {
    return { valid: false, error: 'targetDuration must be a number' };
  }

  if (!Number.isInteger(num)) {
    return { valid: false, error: 'targetDuration must be a positive integer' };
  }

  if (num < 10 || num > 600) {
    return {
      valid: false,
      error: `targetDuration must be between 10 and 600 seconds, got ${num}`,
    };
  }

  return { valid: true };
}

/**
 * Validate segmentIndices parameter.
 * Valid: non-empty array of integers, all in [0, maxIndex].
 *
 * Requirements: 7.4, 7.9
 */
export function validateSegmentIndices(
  indices: unknown,
  maxIndex: number,
): { valid: boolean; error?: string } {
  if (!Array.isArray(indices)) {
    return { valid: false, error: 'segmentIndices must be an array' };
  }

  if (indices.length === 0) {
    return { valid: false, error: 'segmentIndices must not be empty' };
  }

  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (typeof idx !== 'number' || !Number.isInteger(idx)) {
      return { valid: false, error: `segmentIndices[${i}] must be an integer` };
    }
    if (idx < 0 || idx > maxIndex) {
      return {
        valid: false,
        error: `segmentIndices[${i}] = ${idx} is out of range [0, ${maxIndex}]`,
      };
    }
  }

  return { valid: true };
}
