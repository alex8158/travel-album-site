import type {
  ImageProcessContext,
  DedupAssessment,
  GlobalSimilarityAssessment,
  TrashReason,
  PerImageFinalDecision,
} from './types';

/**
 * Merge assessments into final decisions.
 *
 * Priority ordering (highest first): blur > overexposure > duplicate > global_similarity
 *
 * An image can have multiple trash reasons. The reasons array is ordered by priority.
 * For example, a blurry AND overexposed image will have trashedReasons = ['blur', 'overexposure'].
 *
 * Reducer responsibilities:
 * - If blurry → add 'blur' to trashedReasons
 * - If overexposure severity=severe → add 'overexposure' to trashedReasons
 * - If dedup removed → add 'duplicate' to trashedReasons
 * - If global similarity trashed → add 'global_similarity' to trashedReasons
 * - finalStatus = 'trashed' if and only if trashedReasons.length > 0
 * - If all assessments null → active, category=other, blurStatus=suspect
 */
export function reduce(
  contexts: ImageProcessContext[],
  dedupAssessment: DedupAssessment | null,
  globalSimilarityAssessment: GlobalSimilarityAssessment | null,
): PerImageFinalDecision[] {
  const removedSet = new Set(dedupAssessment?.removed ?? []);
  const globalTrashedSet = new Set(globalSimilarityAssessment?.trashed ?? []);

  return contexts.map((ctx): PerImageFinalDecision => {
    const trashedReasons: TrashReason[] = [];

    // 1. Blur → trash (highest priority)
    const isBlurry = ctx.blur?.blurStatus === 'blurry';
    if (isBlurry) {
      trashedReasons.push('blur');
    }

    // 2. Overexposure (severity=severe) → trash
    const isOverexposed = ctx.overexposure?.overexposureStatus === 'overexposed';
    if (isOverexposed) {
      trashedReasons.push('overexposure');
    }

    // 3. Dedup removed → trash
    if (removedSet.has(ctx.mediaId)) {
      trashedReasons.push('duplicate');
    }

    // 4. Global similarity trashed → trash (lowest priority)
    if (globalTrashedSet.has(ctx.mediaId)) {
      trashedReasons.push('global_similarity');
    }

    const finalStatus = trashedReasons.length > 0 ? 'trashed' : 'active';

    // Classification: use assessment or fallback
    const finalCategory = ctx.classification?.category ?? 'other';
    const categorySource = ctx.classification?.source ?? 'fallback';

    // Blur: use assessment or fallback
    const finalBlurStatus = ctx.blur?.blurStatus ?? 'suspect';
    const blurSource = ctx.blur?.source ?? null;
    const sharpnessScore = ctx.blur?.sharpnessScore ?? null;

    // Overexposure severity
    const overexposureSeverity: 'none' | 'mild' | 'severe' | undefined =
      ctx.overexposure
        ? ctx.overexposure.overexposureStatus === 'overexposed'
          ? 'severe'
          : 'none'
        : undefined;

    // qualityScore is not computed in this pipeline phase
    const qualityScore: number | null = null;

    // Collect processing errors
    const processingError =
      ctx.processingErrors.length > 0
        ? ctx.processingErrors.join('; ')
        : null;

    return {
      mediaId: ctx.mediaId,
      finalBlurStatus,
      finalCategory,
      finalStatus,
      trashedReasons,
      overexposureSeverity,
      sharpnessScore,
      qualityScore,
      categorySource,
      blurSource,
      processingError,
    };
  });
}
