import type { ImageCategory } from '../pythonAnalyzer';

// --- Source type aliases ---

export type ClassifySource = 'python' | 'rekognition' | 'fallback';
export type BlurSource = 'python' | 'node';

// --- Assessment Types (pure data, no side effects) ---

export interface ClassificationAssessment {
  category: ImageCategory;
  categoryScores: Record<string, number> | null;
  source: ClassifySource;
  error?: string;
}

export interface BlurAssessment {
  sharpnessScore: number | null;
  blurStatus: 'clear' | 'suspect' | 'blurry';
  musiqScore?: number | null;
  source: BlurSource;
  error?: string;
}

export interface DedupAssessment {
  confirmedPairs: Array<{ i: number; j: number }>;
  groups: Array<{ indices: number[]; keepIndex: number }>;
  kept: string[];
  removed: string[];
  skippedIndices: number[];
  skippedReasons: Record<number, string>;
  capabilitiesUsed: {
    hash: boolean;
    clip: boolean;
    dinov2: boolean;
    llm: boolean;
  };
  evidenceByPair: Array<{
    i: number;
    j: number;
    hashMatched?: boolean;
    clipScore?: number;
    dinoScore?: number;
    llmConfirmed?: boolean;
  }>;
}

export interface OverexposureAssessment {
  overexposureStatus: 'overexposed' | 'normal' | 'unknown';
  overexposureRatio: number | null;
  qualityPenalty?: number;
  error?: string;
}

// --- Processing Context ---

export interface ImageProcessContext {
  mediaId: string;
  tripId: string;
  filePath: string;        // storage-relative path
  localPath: string | null; // local temp path (null if download failed)
  downloadOk: boolean;
  downloadError?: string | null;
  processingErrors: string[];
  index: number;            // position in the image list
  classification: ClassificationAssessment | null;
  blur: BlurAssessment | null;
  overexposure: OverexposureAssessment | null;
}

// --- Global Similarity Assessment ---

export interface GlobalSimilarityAssessment {
  trashed: string[];  // mediaIds that should be trashed due to global similarity
}

// --- Trash Reason Type ---

export type TrashReason = 'blur' | 'overexposure' | 'duplicate' | 'global_similarity';

// --- Final Decision ---

export interface PerImageFinalDecision {
  mediaId: string;
  finalBlurStatus: 'clear' | 'suspect' | 'blurry';
  finalCategory: ImageCategory;
  finalStatus: 'active' | 'trashed';
  trashedReasons: TrashReason[];
  overexposureSeverity?: 'none' | 'mild' | 'severe';
  sharpnessScore: number | null;
  qualityScore: number | null;
  categorySource: ClassifySource;
  blurSource: BlurSource | null;
  processingError: string | null;
}

// --- Pipeline Options & Result ---

export type PipelineStage =
  | 'collectInputs'
  | 'classify'
  | 'blur'
  | 'dedup'
  | 'globalSimilarity'
  | 'aiScreening'
  | 'smartCuration'
  | 'aiReview'
  | 'aiFinalDedup'
  | 'sceneDedup'
  | 'reduce'
  | 'write'
  | 'analyze'
  | 'optimize'
  | 'aiRefinement'
  | 'thumbnail'
  | 'videoAnalysis'
  | 'autoCompile'
  | 'videoEdit'
  | 'videoEnhance'
  | 'blackFrameDetect'
  | 'junkDetect'
  | 'versionGenerate'
  | 'cover'
  | 'aiAnalysis';

export interface PipelineProgressCallback {
  (stage: PipelineStage, status: 'start' | 'complete' | 'progress', detail?: string): void;
}

export interface PipelineOptions {
  onProgress?: PipelineProgressCallback;
  videoResolution?: number;
}

// --- VLM Status Reporting ---

export type VLMStatus =
  | 'not_configured'    // no VLM provider keys set
  | 'disabled'          // AI_REVIEW_ENABLED=false
  | 'skipped'           // VLM available but stage was skipped (e.g. <2 photos)
  | 'success'           // all VLM calls succeeded
  | 'partial_failure'   // some calls succeeded, some failed
  | 'failed';           // all calls failed (auth error, timeout, etc.)

export interface VLMCallStats {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  parseFailures: number;        // JSON parse failed (model returned bad format)
  timeoutFailures: number;      // request timed out
  providerAuthFailures: number; // 401/403/signature expired
  skippedStages: PipelineStage[];
  stageStats: Record<string, { calls: number; successes: number; failures: number }>;
  diagnostic: string;           // human-readable summary
}

/**
 * Derive VLM status from call stats and configuration.
 * Priority: disabled > not_configured > skipped > success > partial_failure > failed
 */
export function deriveVLMStatus(
  stats: VLMCallStats,
  vlmEnabled: boolean,
  vlmAvailable: boolean,
): VLMStatus {
  if (!vlmEnabled) return 'disabled';
  if (!vlmAvailable) return 'not_configured';
  if (stats.totalCalls === 0) return 'skipped';
  if (stats.failedCalls === 0 && stats.successfulCalls > 0) return 'success';
  if (stats.successfulCalls > 0 && stats.failedCalls > 0) return 'partial_failure';
  if (stats.failedCalls > 0 && stats.successfulCalls === 0) return 'failed';
  return 'skipped';
}

/**
 * Create a fresh VLMCallStats tracker with all counters at zero.
 * AI stages increment this tracker in real-time during VLM calls.
 * The tracker is the SOLE authority for final vlmStatus derivation.
 */
export function createVLMCallStatsTracker(): VLMCallStats {
  return {
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    parseFailures: 0,
    timeoutFailures: 0,
    providerAuthFailures: 0,
    skippedStages: [],
    stageStats: {},
    diagnostic: '',
  };
}

/**
 * Record a successful VLM call in the shared tracker.
 */
export function recordVLMSuccess(tracker: VLMCallStats, stage: string): void {
  tracker.totalCalls++;
  tracker.successfulCalls++;
  if (!tracker.stageStats[stage]) {
    tracker.stageStats[stage] = { calls: 0, successes: 0, failures: 0 };
  }
  tracker.stageStats[stage].calls++;
  tracker.stageStats[stage].successes++;
}

/**
 * Record a failed VLM call in the shared tracker.
 */
export function recordVLMFailure(
  tracker: VLMCallStats,
  stage: string,
  failureType: 'parse' | 'timeout' | 'auth' | 'other',
): void {
  tracker.totalCalls++;
  tracker.failedCalls++;
  if (failureType === 'parse') tracker.parseFailures++;
  if (failureType === 'timeout') tracker.timeoutFailures++;
  if (failureType === 'auth') tracker.providerAuthFailures++;
  if (!tracker.stageStats[stage]) {
    tracker.stageStats[stage] = { calls: 0, successes: 0, failures: 0 };
  }
  tracker.stageStats[stage].calls++;
  tracker.stageStats[stage].failures++;
}

/**
 * Record a skipped stage in the tracker.
 */
export function recordVLMSkippedStage(tracker: VLMCallStats, stage: PipelineStage): void {
  if (!tracker.skippedStages.includes(stage)) {
    tracker.skippedStages.push(stage);
  }
}

/**
 * Build a human-readable diagnostic string from VLM call stats.
 */
export function buildVLMDiagnostic(
  stats: VLMCallStats,
  vlmEnabled: boolean,
  vlmAvailable: boolean,
): string {
  if (!vlmEnabled) return 'AI review disabled by configuration (AI_REVIEW_ENABLED=false)';
  if (!vlmAvailable) return 'No VLM provider configured';
  if (stats.totalCalls === 0) {
    const skipped = stats.skippedStages.length > 0
      ? `Skipped stages: ${stats.skippedStages.join(', ')}`
      : 'No VLM calls needed';
    return skipped;
  }
  const parts: string[] = [];
  parts.push(`${stats.successfulCalls}/${stats.totalCalls} calls succeeded`);
  if (stats.parseFailures > 0) parts.push(`${stats.parseFailures} parse failures`);
  if (stats.timeoutFailures > 0) parts.push(`${stats.timeoutFailures} timeouts`);
  if (stats.providerAuthFailures > 0) parts.push(`${stats.providerAuthFailures} auth failures`);
  if (stats.skippedStages.length > 0) parts.push(`skipped: ${stats.skippedStages.join(', ')}`);
  return parts.join('; ');
}

export interface PipelineResult {
  tripId: string;
  totalImages: number;
  totalVideos: number;
  blurryDeletedCount: number;
  overexposureDeletedCount: number;
  dedupDeletedCount: number;
  globalSimilarityTrashedCount: number;
  aiReviewTrashedCount: number;
  sceneDedupTrashedCount: number;
  aiRefinementTrashedCount: number;
  analyzedCount: number;
  optimizedCount: number;
  classifiedCount: number;
  categoryStats: { people: number; animal: number; landscape: number; other: number };
  compiledCount: number;
  failedCount: number;
  skippedCount: number;
  partialFailureCount: number;
  downloadFailedCount: number;
  coverImageId: string | null;
  vlmStatus: VLMStatus;
  vlmCallStats: VLMCallStats;
}
