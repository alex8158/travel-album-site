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
}

// --- Final Decision ---

export interface PerImageFinalDecision {
  mediaId: string;
  finalBlurStatus: 'clear' | 'suspect' | 'blurry';
  finalCategory: ImageCategory;
  finalStatus: 'active' | 'trashed';
  trashedReasons: Array<'blur' | 'duplicate'>;
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
  | 'reduce'
  | 'write'
  | 'analyze'
  | 'optimize'
  | 'thumbnail'
  | 'videoAnalysis'
  | 'videoEdit'
  | 'cover';

export interface PipelineProgressCallback {
  (stage: PipelineStage, status: 'start' | 'complete' | 'progress', detail?: string): void;
}

export interface PipelineOptions {
  onProgress?: PipelineProgressCallback;
  videoResolution?: number;
}

export interface PipelineResult {
  tripId: string;
  totalImages: number;
  totalVideos: number;
  blurryDeletedCount: number;
  dedupDeletedCount: number;
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
}
