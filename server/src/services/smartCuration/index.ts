/**
 * Smart Curation barrel export.
 *
 * Re-exports the public API of the smart curation engine so consumers can import
 * from `services/smartCuration` directly.
 */

export {
  runSmartCuration,
  type TrashReason,
  type GroupType,
  type SimilaritySource,
  type CurationCandidate,
  type CurationGroup,
  type CurationDecision,
  type SmartCurationResult,
  type SmartCurationOptions,
} from './smartCurationEngine';

export {
  writeDebugReport,
  buildDebugReport,
  type DebugReport,
  type DebugReportEntry,
  type DebugReportGroupSummary,
  type DebugReportGroupInput,
} from './debugReportWriter';

export {
  runAIReview,
  type AIReviewResult,
  type AIReviewOptions,
} from './aiReview';

export {
  runAIFinalDedup,
  type AIFinalDedupResult,
  type AIFinalDedupOptions,
} from './aiFinalDedup';
