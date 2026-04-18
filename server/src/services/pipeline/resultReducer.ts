import type {
  ImageProcessContext,
  DedupAssessment,
  PerImageFinalDecision,
} from './types';

/**
 * Merge assessments into final decisions.
 *
 * NOTE: Multi-source fallback is already resolved within each stage.
 * The reducer only receives the winning assessment per image.
 *
 * Reducer responsibilities:
 * - If blurry → add 'blur' to trashedReasons
 * - If dedup removed → add 'duplicate' to trashedReasons
 * - If trashedReasons non-empty → finalStatus = 'trashed'
 * - If all assessments null → active, category=other, blurStatus=suspect
 */
export function reduce(
  contexts: ImageProcessContext[],
  dedupAssessment: DedupAssessment | null,
): PerImageFinalDecision[] {
  const removedSet = new Set(dedupAssessment?.removed ?? []);

  return contexts.map((ctx): PerImageFinalDecision => {
    const trashedReasons: Array<'blur' | 'duplicate'> = [];

    // Blur → trash
    if (ctx.blur?.blurStatus === 'blurry') {
      trashedReasons.push('blur');
    }

    // Dedup removed → trash
    if (removedSet.has(ctx.mediaId)) {
      trashedReasons.push('duplicate');
    }

    const finalStatus = trashedReasons.length > 0 ? 'trashed' : 'active';

    // Classification: use assessment or fallback
    const finalCategory = ctx.classification?.category ?? 'other';
    const categorySource = ctx.classification?.source ?? 'fallback';

    // Blur: use assessment or fallback
    const finalBlurStatus = ctx.blur?.blurStatus ?? 'suspect';
    const blurSource = ctx.blur?.source ?? null;
    const sharpnessScore = ctx.blur?.sharpnessScore ?? null;

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
      sharpnessScore,
      qualityScore,
      categorySource,
      blurSource,
      processingError,
    };
  });
}
