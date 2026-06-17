/**
 * Highlight Tier Selector — 精华 (Tier) 二次筛选服务
 *
 * 在精选（highlight）评估完成后，对已入选精华的照片按 category 进行二次筛选，
 * 选出绝对最佳的照片作为 highlight tier，并生成 slideshow 视频。
 *
 * 本模块提供：
 *   - 类型定义与常量配置
 *   - 候选照片查询函数（按 category 分组获取 highlight 照片）
 *   - buildCategoryPrompt — 生成 category 专属 VLM prompt
 *   - createTierBatches — 将照片列表拆分为 VLM 可处理的 batch
 *   - parseTierResponse — 解析 VLM 返回的 JSON
 *   - runTierSelection — 主入口编排函数
 *   - persistTierResults — 持久化 tier 结果
 */

import path from 'path';
import { getDb } from '../database';
import { extractJSON, resizeForAnalysis } from './bedrockClient';
import { detectConfiguredProviders, ProviderConfig } from './llmPairReviewer';
import { getStorageProvider } from '../storage/factory';
import { generateSlideshow } from './slideshowGenerator';

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/** Category types used for tier selection quotas and prompts */
export type TierCategory = 'animal' | 'landscape' | 'people';

/** Quota configuration per category */
export interface CategoryQuota {
  min: number;
  max: number;
}

/** Category quota map */
export const CATEGORY_QUOTAS: Record<TierCategory, CategoryQuota> = {
  animal: { min: 6, max: 9 },
  landscape: { min: 3, max: 9 },
  people: { min: 3, max: 9 },
};

/** Minimum batch size for VLM calls */
export const TIER_BATCH_MIN = 10;

/** Maximum batch size for VLM calls */
export const TIER_BATCH_MAX = 15;

/** A candidate photo for tier selection */
export interface TierCandidate {
  id: string;
  filePath: string;
  category: string;
  /** 0-based index within the batch (assigned at batch creation time) */
  batchIndex?: number;
}

/** A photo selected by VLM for the tier */
export interface TierPick {
  photoId: string;
  reason: string;
}

/** Result of the full tier selection pass */
export interface TierSelectionResult {
  tripId: string;
  totalCandidates: number;
  tierCount: number;
  categoryCounts: Record<string, number>;
  slideshowGenerated: boolean;
}

// ---------------------------------------------------------------------------
// Candidate Query
// ---------------------------------------------------------------------------

/**
 * Fetch highlight photos grouped by category for tier selection.
 *
 * Returns only photos where:
 *   - highlight_results.is_highlight = 1
 *   - media_items.status = 'active'
 *   - media_items.category IN ('animal', 'landscape', 'people')
 *
 * Results are ordered by category then id, suitable for grouping.
 *
 * @param tripId The trip ID to query candidates for
 * @returns Array of TierCandidate objects grouped by category
 */
export function getTierCandidates(tripId: string): TierCandidate[] {
  if (!tripId || typeof tripId !== 'string') {
    return [];
  }

  const db = getDb();

  const rows = db
    .prepare(
      `SELECT mi.id, mi.file_path, mi.category
       FROM highlight_results hr
       INNER JOIN media_items mi ON mi.id = hr.photo_id
       WHERE hr.trip_id = ?
         AND hr.is_highlight = 1
         AND mi.status = 'active'
         AND mi.category IN ('animal', 'landscape', 'people')
       ORDER BY mi.category, mi.id`,
    )
    .all(tripId) as Array<{ id: string; file_path: string; category: string }>;

  return rows.map((row) => ({
    id: row.id,
    filePath: row.file_path,
    category: row.category,
  }));
}

/**
 * Group an array of TierCandidate objects by their category.
 *
 * @param candidates Flat array of candidates (typically from getTierCandidates)
 * @returns Map from category string to array of candidates in that category
 */
export function groupCandidatesByCategory(
  candidates: TierCandidate[],
): Map<string, TierCandidate[]> {
  const grouped = new Map<string, TierCandidate[]>();
  for (const candidate of candidates) {
    const existing = grouped.get(candidate.category);
    if (existing) {
      existing.push(candidate);
    } else {
      grouped.set(candidate.category, [candidate]);
    }
  }
  return grouped;
}

// ---------------------------------------------------------------------------
// Category Prompt Builder
// ---------------------------------------------------------------------------

/**
 * Returns the category-specific base instruction for the VLM prompt.
 *
 * @param category The tier category
 * @param quota The quota configuration for the category
 * @returns The instruction string specific to the category
 */
function getBaseInstruction(category: TierCategory, quota: CategoryQuota): string {
  switch (category) {
    case 'animal':
      return `Select ${quota.min} to ${quota.max} photos where each shows a completely different animal subject. Each photo must be sharp with good focus on the animal. None should be overexposed. Prioritize diversity of species/subjects over quantity.`;
    case 'people':
      return `Select ${quota.min} to ${quota.max} photos where each shows a completely different scene or setting. Prioritize diversity in location, activity, and composition. Avoid multiple photos from the same moment or angle.`;
    case 'landscape':
      return `Select ${quota.min} to ${quota.max} of the most visually distinct and compelling landscape photos. Prioritize variety in scenery, lighting conditions, and color palettes. Each selected photo should offer a unique visual perspective.`;
  }
}

/**
 * Build a category-specific VLM prompt for tier selection.
 *
 * Generates a complete prompt that includes:
 *   - Category-specific selection instructions with quota bounds
 *   - Underwater-photo handling instruction for fair evaluation of dive shots
 *   - Photo count and index reference system
 *   - Structured JSON response format specification
 *
 * @param category The tier category (animal, landscape, or people)
 * @param photoCount Number of photos in the batch being evaluated
 * @returns The complete VLM prompt string
 */
export function buildCategoryPrompt(category: TierCategory, photoCount: number): string {
  const quota = CATEGORY_QUOTAS[category];
  const baseInstruction = getBaseInstruction(category, quota);
  const underwaterClause = `Note: Some photos may have a blue/green tint from underwater photography. Evaluate these fairly based on subject clarity, composition, and color vibrancy within the underwater context.`;

  return `You are a professional travel photography curator performing a final selection of the absolute best photos.

${baseInstruction}

${underwaterClause}

You are viewing ${photoCount} photos indexed 0 to ${photoCount - 1}.

Return ONLY a JSON object:
{
  "selected": [
    {"index": 0, "reason": "Brief explanation (max 100 chars)"}
  ]
}

Rules:
- "index" is the 0-based position of the photo
- "reason" must be concise (max 100 characters)
- Select between ${quota.min} and ${quota.max} photos (or all if fewer than ${quota.min} are available)`;
}

// ---------------------------------------------------------------------------
// Batch Splitting
// ---------------------------------------------------------------------------

/**
 * Split a list of tier candidates into batches suitable for VLM calls.
 *
 * - If the list has ≤ TIER_BATCH_MAX (15) photos, return a single batch.
 * - If the list has > 15 photos, split into sub-batches targeting 10–12 each.
 *   The algorithm ensures every batch has between TIER_BATCH_MIN (10) and
 *   TIER_BATCH_MAX (15) photos, except when total candidates < TIER_BATCH_MIN
 *   (in that case all form a single batch).
 *
 * @param photos Array of TierCandidate to split
 * @returns Array of batches (each batch is an array of TierCandidate)
 */
export function createTierBatches(photos: TierCandidate[]): TierCandidate[][] {
  const n = photos.length;

  // ≤15 photos: single batch (includes the case where n < TIER_BATCH_MIN)
  if (n <= TIER_BATCH_MAX) {
    return [photos];
  }

  // >15 photos: split into sub-batches of 10-12
  // Target sub-batch size: ceil(n / ceil(n / 12))
  const numBatches = Math.ceil(n / 12);
  const batchSize = Math.ceil(n / numBatches);

  const batches: TierCandidate[][] = [];
  for (let i = 0; i < n; i += batchSize) {
    batches.push(photos.slice(i, Math.min(i + batchSize, n)));
  }
  return batches;
}

// ---------------------------------------------------------------------------
// Response Parsing
// ---------------------------------------------------------------------------

/** Maximum length for a tier pick reason string */
const TIER_MAX_REASON_LENGTH = 100;

/**
 * Truncate a reason string to at most {@link TIER_MAX_REASON_LENGTH} characters.
 *
 * - If the input is not a string, returns an empty string.
 * - If the input length is ≤ 100, returns it unchanged.
 * - If the input length is > 100, returns the first 100 characters.
 *
 * @param reason The raw reason string from VLM response
 * @returns Truncated string of length ≤ 100
 */
function truncateReason(reason: string): string {
  if (typeof reason !== 'string') {
    return '';
  }
  if (reason.length > TIER_MAX_REASON_LENGTH) {
    return reason.slice(0, TIER_MAX_REASON_LENGTH);
  }
  return reason;
}

/**
 * Parse a VLM response for tier selection, extracting photo picks.
 *
 * Steps:
 *   1. Extract JSON from the response text using the shared `extractJSON` utility.
 *   2. Validate that the response contains a `selected` array.
 *   3. Map each entry's `index` to the corresponding photo ID from the batch,
 *      filtering out entries with invalid or out-of-range indices.
 *   4. Truncate each `reason` string to 100 characters.
 *
 * @param responseText Raw text response from the VLM
 * @param batchPhotos The batch of candidates that was sent to the VLM (order matters)
 * @returns Array of TierPick objects with photoId and reason
 * @throws Error if JSON extraction fails or the response is missing the "selected" array
 */
export function parseTierResponse(
  responseText: string,
  batchPhotos: TierCandidate[],
): TierPick[] {
  // 1. Extract JSON from response text (reuse extractJSON from bedrockClient)
  const raw = extractJSON<{ selected?: unknown[] }>(responseText);

  // 2. Validate structure
  if (!raw || !Array.isArray(raw.selected)) {
    throw new Error('Invalid tier VLM response: missing "selected" array');
  }

  // 3. Map indices to photo IDs, filtering out-of-range indices
  const picks: TierPick[] = [];
  for (const entry of raw.selected) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { index, reason } = entry as { index?: number; reason?: string };
    if (typeof index !== 'number' || !Number.isInteger(index)) continue;
    if (index < 0 || index >= batchPhotos.length) continue;

    picks.push({
      photoId: batchPhotos[index].id,
      reason: truncateReason(typeof reason === 'string' ? reason : ''),
    });
  }

  return picks;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist tier selection results to the database.
 *
 * Operates in a single transaction:
 *   1. Resets all `is_highlight_tier` flags to 0 for the given trip.
 *   2. Sets `is_highlight_tier = 1` for each selected photo ID.
 *
 * Key invariant: `is_highlight_tier = 1` can only exist on rows where
 * `is_highlight = 1`, which is maintained because we only update rows
 * already in `highlight_results` (which only contains highlighted photos).
 *
 * @param tripId The trip ID to persist results for
 * @param picks Array of TierPick objects with photo IDs to mark as tier
 */
export function persistTierResults(tripId: string, picks: TierPick[]): void {
  const db = getDb();
  db.transaction(() => {
    // Reset all tier flags for this trip
    db.prepare(
      'UPDATE highlight_results SET is_highlight_tier = 0 WHERE trip_id = ?',
    ).run(tripId);

    // Set tier flag for selected photos
    const stmt = db.prepare(
      'UPDATE highlight_results SET is_highlight_tier = 1 WHERE trip_id = ? AND photo_id = ?',
    );
    for (const pick of picks) {
      stmt.run(tripId, pick.photoId);
    }
  })();
}


// ---------------------------------------------------------------------------
// VLM Batch Evaluation (Tier-specific)
// ---------------------------------------------------------------------------

/**
 * Evaluate a single tier batch via the VLM provider chain.
 *
 * Resizes images, invokes the VLM with the given prompt, and returns raw response text.
 * Retries once on invalid response before cascading to the next provider.
 *
 * @param photos The batch of candidates to evaluate
 * @param prompt The category-specific prompt to send
 * @param providerChain Available LLM providers in priority order
 * @returns Raw VLM response text, or null if all providers fail
 */
async function invokeTierVLM(
  photos: TierCandidate[],
  prompt: string,
  providerChain: ProviderConfig[],
): Promise<string | null> {
  if (photos.length === 0 || providerChain.length === 0) {
    return null;
  }

  // Resolve and resize images
  const storageProvider = getStorageProvider();
  const images: Array<{ base64: string; mediaType: 'image/jpeg' }> = [];
  const validPhotos: TierCandidate[] = [];

  for (const photo of photos) {
    try {
      const localPath = await storageProvider.downloadToTemp(photo.filePath);
      const base64 = await resizeForAnalysis(localPath);
      images.push({ base64, mediaType: 'image/jpeg' });
      validPhotos.push(photo);
    } catch (err) {
      console.warn(
        `[tierSelector] Failed to process photo ${photo.id} (${photo.filePath}): ${err}`,
      );
    }
  }

  if (images.length === 0) {
    console.error('[tierSelector] All photos in batch failed to process');
    return null;
  }

  // Cascade through providers with retry on invalid response
  for (const provider of providerChain) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const responseText = await provider.client.invokeModel({
          images,
          prompt,
          maxTokens: 2048,
        });
        console.log(
          `[tierSelector] VLM call succeeded via provider '${provider.type}'` +
            (attempt > 1 ? ` (attempt ${attempt})` : ''),
        );
        return responseText;
      } catch (err) {
        if (attempt === 1) {
          console.warn(
            `[tierSelector] Provider '${provider.type}' failed (attempt 1), retrying: ${err}`,
          );
          continue;
        }
        console.error(
          `[tierSelector] Provider '${provider.type}' failed after retry: ${err}`,
        );
        break; // Try next provider
      }
    }
  }

  console.error('[tierSelector] All providers failed for tier VLM call');
  return null;
}



// ---------------------------------------------------------------------------
// Orchestrator: runTierSelection
// ---------------------------------------------------------------------------

/**
 * Main orchestrator for highlight tier selection (精华).
 *
 * This function:
 *   1. Queries all highlight candidates for the trip grouped by category
 *   2. For each category (animal, landscape, people):
 *      - Skips if 0 candidates
 *      - Single VLM call if ≤15 candidates
 *      - Multi-round selection if >15 candidates:
 *        a) Split into sub-batches of 10–12
 *        b) Pick proportional winners from each sub-batch
 *        c) Combine winners and run final VLM call for category quota
 *   3. Collects all TierPick results across categories
 *   4. Persists `is_highlight_tier = 1` for selected photos
 *   5. Triggers slideshow generation if ≥1 photo was selected
 *   6. Returns a TierSelectionResult summary
 *
 * Error handling:
 *   - If a VLM batch call fails: skip that batch, log error, continue
 *   - If all VLM calls fail: return result with tierCount=0
 *   - If slideshow generation fails: log error, set slideshowGenerated=false
 *
 * @param tripId The trip ID to run tier selection for
 * @returns TierSelectionResult summarizing the tier selection outcome
 */
export async function runTierSelection(tripId: string): Promise<TierSelectionResult> {
  console.log(`[tierSelector] Starting tier selection for trip ${tripId}`);

  // 1. Query candidates grouped by category
  const allCandidates = getTierCandidates(tripId);
  const totalCandidates = allCandidates.length;

  if (totalCandidates === 0) {
    console.log(`[tierSelector] No tier candidates for trip ${tripId}, skipping`);
    return {
      tripId,
      totalCandidates: 0,
      tierCount: 0,
      categoryCounts: {},
      slideshowGenerated: false,
    };
  }

  const grouped = groupCandidatesByCategory(allCandidates);

  // 2. Detect VLM providers
  const providerChain = detectConfiguredProviders();
  if (providerChain.length === 0) {
    console.error('[tierSelector] No LLM providers configured, cannot run tier selection');
    return {
      tripId,
      totalCandidates,
      tierCount: 0,
      categoryCounts: {},
      slideshowGenerated: false,
    };
  }

  // 3. Process each category
  const allPicks: TierPick[] = [];
  const categoryCounts: Record<string, number> = {};
  const categories: TierCategory[] = ['animal', 'landscape', 'people'];

  for (const category of categories) {
    const candidates = grouped.get(category);
    if (!candidates || candidates.length === 0) {
      continue; // Skip categories with no candidates
    }

    console.log(
      `[tierSelector] Processing category '${category}' with ${candidates.length} candidates`,
    );

    try {
      const categoryPicks = await processCategorySelection(
        category,
        candidates,
        providerChain,
      );
      allPicks.push(...categoryPicks);
      categoryCounts[category] = categoryPicks.length;
      console.log(
        `[tierSelector] Category '${category}': selected ${categoryPicks.length} tier photos`,
      );
    } catch (err) {
      console.error(
        `[tierSelector] Category '${category}' processing failed: ${err}`,
      );
      categoryCounts[category] = 0;
    }
  }

  // 4. Persist tier results
  const tierCount = allPicks.length;
  let persistSucceeded = false;
  try {
    persistTierResults(tripId, allPicks);
    persistSucceeded = true;
    console.log(`[tierSelector] Persisted ${tierCount} tier results for trip ${tripId}`);
  } catch (err) {
    console.error(`[tierSelector] Failed to persist tier results: ${err}`);
  }

  // 5. Trigger slideshow generation if persistence succeeded and we have picks
  let slideshowGenerated = false;
  if (persistSucceeded && tierCount > 0) {
    try {
      slideshowGenerated = await triggerTierSlideshow(tripId, allPicks);
    } catch (err) {
      console.error(`[tierSelector] Slideshow generation failed: ${err}`);
      slideshowGenerated = false;
    }
  }

  console.log(
    `[tierSelector] Tier selection complete for trip ${tripId}: ${tierCount} photos selected, slideshow=${slideshowGenerated}`,
  );

  return {
    tripId,
    totalCandidates,
    tierCount,
    categoryCounts,
    slideshowGenerated,
  };
}

// ---------------------------------------------------------------------------
// Category Processing
// ---------------------------------------------------------------------------

/**
 * Process tier selection for a single category.
 *
 * - If ≤15 candidates: single VLM call
 * - If >15 candidates: multi-round selection
 *
 * @param category The tier category
 * @param candidates Array of candidates for this category
 * @param providerChain Available LLM providers
 * @returns Array of TierPick results for this category
 */
async function processCategorySelection(
  category: TierCategory,
  candidates: TierCandidate[],
  providerChain: ProviderConfig[],
): Promise<TierPick[]> {
  if (candidates.length <= TIER_BATCH_MAX) {
    // Single VLM call — send all candidates at once
    return await evaluateSingleBatch(category, candidates, providerChain);
  }

  // Multi-round selection for >15 candidates
  return await evaluateMultiRound(category, candidates, providerChain);
}

/**
 * Evaluate a single batch of candidates for tier selection.
 *
 * @param category The tier category
 * @param candidates The batch of candidates (≤15)
 * @param providerChain Available LLM providers
 * @returns Array of TierPick results
 */
async function evaluateSingleBatch(
  category: TierCategory,
  candidates: TierCandidate[],
  providerChain: ProviderConfig[],
): Promise<TierPick[]> {
  const prompt = buildCategoryPrompt(category, candidates.length);
  const responseText = await invokeTierVLM(candidates, prompt, providerChain);

  if (!responseText) {
    console.warn(`[tierSelector] VLM returned no response for category '${category}'`);
    return [];
  }

  try {
    return parseTierResponse(responseText, candidates);
  } catch (err) {
    console.error(
      `[tierSelector] Failed to parse VLM response for category '${category}': ${err}`,
    );
    return [];
  }
}

/**
 * Multi-round tier selection for categories with >15 candidates.
 *
 * Round 1: Split into sub-batches. For each sub-batch, pick proportional winners
 *          (quota / numBatches, rounded up).
 * Final Round: Combine all Round 1 winners into a single batch (should be ≤15).
 *              Run one final VLM call to select the category quota.
 *
 * @param category The tier category
 * @param candidates All candidates for this category (>15)
 * @param providerChain Available LLM providers
 * @returns Final array of TierPick results for this category
 */
async function evaluateMultiRound(
  category: TierCategory,
  candidates: TierCandidate[],
  providerChain: ProviderConfig[],
): Promise<TierPick[]> {
  const batches = createTierBatches(candidates);
  const quota = CATEGORY_QUOTAS[category];
  const numBatches = batches.length;

  // Round 1: Pick proportional winners from each sub-batch
  const perBatchQuota = Math.ceil(quota.max / numBatches);
  const round1Winners: TierCandidate[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(
      `[tierSelector] Multi-round: batch ${i + 1}/${numBatches} (${batch.length} photos, picking up to ${perBatchQuota})`,
    );

    // Build a sub-batch prompt asking for perBatchQuota selections
    const subPrompt = buildSubBatchPrompt(category, batch.length, perBatchQuota);
    const responseText = await invokeTierVLM(batch, subPrompt, providerChain);

    if (!responseText) {
      console.warn(
        `[tierSelector] Multi-round batch ${i + 1}/${numBatches} VLM call failed, skipping`,
      );
      continue;
    }

    try {
      const picks = parseTierResponse(responseText, batch);
      // Convert picks back to candidates for the final round
      const pickedIds = new Set(picks.map((p) => p.photoId));
      const winners = batch.filter((c) => pickedIds.has(c.id));
      round1Winners.push(...winners);
    } catch (err) {
      console.warn(
        `[tierSelector] Multi-round batch ${i + 1}/${numBatches} parse failed, skipping: ${err}`,
      );
    }
  }

  // If no winners from round 1, return empty
  if (round1Winners.length === 0) {
    console.warn(`[tierSelector] Multi-round: no winners from Round 1 for '${category}'`);
    return [];
  }

  // Final Round: If combined winners ≤ TIER_BATCH_MAX, do final selection
  // If winners already within quota range, we can return them directly
  if (round1Winners.length <= quota.max) {
    // Winners already fit within quota — run a final evaluation to get reasons
    return await evaluateSingleBatch(category, round1Winners, providerChain);
  }

  // Otherwise run final VLM call on the combined winners
  console.log(
    `[tierSelector] Multi-round final: ${round1Winners.length} winners → final selection`,
  );
  return await evaluateSingleBatch(category, round1Winners, providerChain);
}

/**
 * Build a prompt for a sub-batch in multi-round selection.
 *
 * Similar to buildCategoryPrompt but asks for a specific number of picks
 * rather than the full quota range.
 *
 * @param category The tier category
 * @param photoCount Number of photos in this sub-batch
 * @param pickCount How many photos to select from this sub-batch
 * @returns The VLM prompt string
 */
function buildSubBatchPrompt(
  category: TierCategory,
  photoCount: number,
  pickCount: number,
): string {
  const underwaterClause = `Note: Some photos may have a blue/green tint from underwater photography. Evaluate these fairly based on subject clarity, composition, and color vibrancy within the underwater context.`;

  let categoryInstruction: string;
  switch (category) {
    case 'animal':
      categoryInstruction = `Select the top ${pickCount} photos where each shows a completely different animal subject. Each photo must be sharp with good focus on the animal. None should be overexposed. Prioritize diversity of species/subjects over quantity.`;
      break;
    case 'people':
      categoryInstruction = `Select the top ${pickCount} photos where each shows a completely different scene or setting. Prioritize diversity in location, activity, and composition. Avoid multiple photos from the same moment or angle.`;
      break;
    case 'landscape':
      categoryInstruction = `Select the top ${pickCount} of the most visually distinct and compelling landscape photos. Prioritize variety in scenery, lighting conditions, and color palettes. Each selected photo should offer a unique visual perspective.`;
      break;
  }

  return `You are a professional travel photography curator performing a preliminary selection of the best photos.

${categoryInstruction}

${underwaterClause}

You are viewing ${photoCount} photos indexed 0 to ${photoCount - 1}.

Return ONLY a JSON object:
{
  "selected": [
    {"index": 0, "reason": "Brief explanation (max 100 chars)"}
  ]
}

Rules:
- "index" is the 0-based position of the photo
- "reason" must be concise (max 100 characters)
- Select exactly ${pickCount} photos (or all if fewer than ${pickCount} are available)`;
}

// ---------------------------------------------------------------------------
// Slideshow Trigger
// ---------------------------------------------------------------------------

/**
 * Trigger slideshow generation for tier photos.
 *
 * Resolves file paths for all picked photos and invokes the slideshow generator.
 *
 * @param tripId The trip ID
 * @param picks Array of TierPick with photo IDs
 * @returns true if slideshow was generated successfully, false otherwise
 */
async function triggerTierSlideshow(
  tripId: string,
  picks: TierPick[],
): Promise<boolean> {
  if (picks.length === 0) return false;

  const db = getDb();
  const storageProvider = getStorageProvider();

  // Resolve file paths for the tier photos
  const photoPaths: string[] = [];
  for (const pick of picks) {
    const row = db
      .prepare('SELECT file_path FROM media_items WHERE id = ?')
      .get(pick.photoId) as { file_path: string } | undefined;

    if (!row) {
      console.warn(`[tierSelector] Photo ${pick.photoId} not found in media_items, skipping for slideshow`);
      continue;
    }

    try {
      const localPath = await storageProvider.downloadToTemp(row.file_path);
      photoPaths.push(localPath);
    } catch (err) {
      console.warn(`[tierSelector] Failed to resolve path for photo ${pick.photoId}: ${err}`);
    }
  }

  if (photoPaths.length < 2) {
    console.warn('[tierSelector] Not enough photos for slideshow (need at least 2)');
    return false;
  }

  // Generate the slideshow
  const uploadsBase = path.resolve(__dirname, '..', '..', 'uploads');
  const outputDir = path.join(uploadsBase, tripId, 'tier-slideshow');

  const result = await generateSlideshow({
    photoPaths,
    audioPath: null,
    outputDir,
    photoDuration: 3,
  });

  if (result.success && result.outputPath) {
    console.log(
      `[tierSelector] Tier slideshow generated: ${result.outputPath} (${result.totalDuration}s)`,
    );
    return true;
  }

  console.error(`[tierSelector] Slideshow generation failed: ${result.error}`);
  return false;
}
