import fs from 'fs';
import Database from 'better-sqlite3';
import { getDb } from '../../database';
import { getStorageProvider } from '../../storage/factory';
import { TempPathCache } from '../../helpers/tempPathCache';
import {
  isPythonAvailable,
  analyzeImages,
  PythonAnalyzeResult,
} from '../pythonAnalyzer';
import { assessClassification } from '../imageClassifier';
import { computeSharpness, assessBlur } from '../blurDetector';
import { PROCESS_THRESHOLDS } from '../dedupThresholds';
import { assessDedup, ImageRow } from '../hybridDedupEngine';
import { analyzeTrip } from '../imageAnalyzer';
import { optimizeTrip } from '../imageOptimizer';
import { generateThumbnailsForTrip, generateVideoThumbnail } from '../thumbnailGenerator';
import { selectCoverImage } from '../coverSelector';
import { analyzeVideo, VideoSegment } from '../videoAnalyzer';
import { saveSegments } from '../../helpers/videoSegmentStore';
import { editVideo } from '../videoEditor';
import { detectBlackFrames, BlackFrameResult } from '../blackFrameDetector';
import { detectJunkClip, JunkClipResult } from '../junkClipDetector';
import { generateVersions, DEFAULT_PROFILES } from '../multiVersionGenerator';
import { runAiScreening } from '../aiImageScreener';
import { runAiRefinement } from '../aiImageOptimizer';
import { runAIReview, runAIFinalDedup, runSceneDedup } from '../smartCuration';
import { runGlobalSimilarity } from '../smartCuration/globalSimilarity';
import { isVLMAvailable } from '../smartCuration/vlmClient';
import { reduce } from './resultReducer';
import { runHighlightEvaluation } from '../highlightService';
import { writeDecisions } from './resultWriter';
import { CompilationEngine } from '../compilationEngine';
import type {
  ImageProcessContext,
  ClassificationAssessment,
  BlurAssessment,
  DedupAssessment,
  GlobalSimilarityAssessment,
  PipelineOptions,
  PipelineResult,
  PipelineProgressCallback,
  VLMCallStats,
} from './types';
import {
  createVLMCallStatsTracker,
  deriveVLMStatus,
  buildVLMDiagnostic,
  recordVLMSkippedStage,
} from './types';
import type { MediaItemRow } from '../../helpers/mediaItemRow';

// ---------------------------------------------------------------------------
// DB row type for collectInputs query
// ---------------------------------------------------------------------------

interface CollectRow {
  id: string;
  file_path: string;
  original_filename: string;
  sharpness_score: number | null;
  width: number | null;
  height: number | null;
  file_size: number;
  status: string;
  trashed_reason: string | null;
}

// ---------------------------------------------------------------------------
// Shared Python results map — classify and blur share one analyzeImages call
// ---------------------------------------------------------------------------

type PythonResultsMap = Map<string, PythonAnalyzeResult>;

// ---------------------------------------------------------------------------
// collectInputs
// ---------------------------------------------------------------------------

async function collectInputs(
  tripId: string,
  tempCache: TempPathCache,
): Promise<ImageProcessContext[]> {
  const db = getDb();

  const rows = db.prepare(
    `SELECT id, file_path, original_filename, sharpness_score, width, height, file_size, status, trashed_reason
     FROM media_items
     WHERE trip_id = ? AND media_type = 'image' AND status = 'active'`
  ).all(tripId) as CollectRow[];

  // Download all images concurrently (10 at a time) for speed
  const DOWNLOAD_CONCURRENCY = 10;
  const contexts: ImageProcessContext[] = rows.map((row, i) => ({
    mediaId: row.id,
    tripId,
    filePath: row.file_path,
    localPath: null,
    downloadOk: false,
    downloadError: null,
    processingErrors: [],
    index: i,
    classification: null,
    blur: null,
    overexposure: null,
  }));

  // Process in waves of DOWNLOAD_CONCURRENCY
  for (let waveStart = 0; waveStart < contexts.length; waveStart += DOWNLOAD_CONCURRENCY) {
    const waveEnd = Math.min(waveStart + DOWNLOAD_CONCURRENCY, contexts.length);
    await Promise.allSettled(
      contexts.slice(waveStart, waveEnd).map(async (ctx) => {
        try {
          const localPath = await tempCache.get(ctx.filePath);
          ctx.localPath = localPath;
          ctx.downloadOk = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.downloadOk = false;
          ctx.downloadError = msg;
          ctx.processingErrors.push(`[download] ${msg}`);
        }
      })
    );
  }

  return contexts;
}


// ---------------------------------------------------------------------------
// runClassifyStage — owns the Python → Rekognition → fallback chain
// ---------------------------------------------------------------------------

async function runClassifyStage(
  contexts: ImageProcessContext[],
  pythonResults: PythonResultsMap,
): Promise<void> {
  const downloadedContexts = contexts.filter(c => c.downloadOk && c.localPath);

  if (downloadedContexts.length === 0) return;

  const pythonAvailable = isPythonAvailable();

  // If Python is available and we haven't already called analyzeImages, do it now
  if (pythonAvailable && pythonResults.size === 0) {
    const tempPaths = downloadedContexts.map(c => c.localPath!);
    try {
      const results = await analyzeImages(tempPaths);
      // Store results keyed by mediaId
      for (let i = 0; i < downloadedContexts.length; i++) {
        pythonResults.set(downloadedContexts[i].mediaId, results[i]);
      }
    } catch (err) {
      console.warn(`[pipeline] Python analyzeImages batch failed: ${err}`);
      // Python batch failed — will fall through to per-image Rekognition below
    }
  }

  // Apply classification per image
  for (const ctx of contexts) {
    if (!ctx.downloadOk || !ctx.localPath) continue;

    try {
      // Try Python result first
      const pyResult = pythonResults.get(ctx.mediaId);
      if (pyResult && !pyResult.classifyError && pyResult.category) {
        ctx.classification = {
          category: pyResult.category,
          categoryScores: pyResult.categoryScores,
          source: 'python',
        };
        continue;
      }

      // Python classify failed or unavailable — try Rekognition
      const classifyError = pyResult?.classifyError;
      if (classifyError) {
        ctx.processingErrors.push(`[python-classify] ${classifyError}`);
      }

      try {
        const imageBytes = fs.readFileSync(ctx.localPath);
        ctx.classification = await assessClassification(imageBytes);
      } catch (rekErr) {
        const rekMsg = rekErr instanceof Error ? rekErr.message : String(rekErr);
        ctx.processingErrors.push(`[rekognition-classify] ${rekMsg}`);
        // Both Python and Rekognition failed — fallback
        ctx.classification = {
          category: 'other',
          categoryScores: null,
          source: 'fallback',
          error: rekMsg,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.processingErrors.push(`[classify] ${msg}`);
      ctx.classification = {
        category: 'other',
        categoryScores: null,
        source: 'fallback',
        error: msg,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// runBlurStage — owns the Python → Node.js Laplacian fallback chain
// ---------------------------------------------------------------------------

async function runBlurStage(
  contexts: ImageProcessContext[],
  pythonResults: PythonResultsMap,
): Promise<void> {
  // Process blur assessment in parallel (10 at a time) — CPU-bound sharp operations
  const BLUR_CONCURRENCY = 10;
  const eligible = contexts.filter(c => c.downloadOk && c.localPath);

  for (let i = 0; i < eligible.length; i += BLUR_CONCURRENCY) {
    const chunk = eligible.slice(i, i + BLUR_CONCURRENCY);
    await Promise.allSettled(chunk.map(async (ctx) => {
      try {
        const assessment = await assessBlur(ctx.localPath!);
        ctx.blur = {
          sharpnessScore: assessment.sharpnessScore,
          blurStatus: assessment.blurStatus,
          musiqScore: assessment.musiqScore,
          source: assessment.source,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.blur = { blurStatus: 'suspect', sharpnessScore: null, source: 'node', error: msg };
      }
    }));
  }

  const blurry = contexts.filter(c => c.blur?.blurStatus === 'blurry').length;
  const suspect = contexts.filter(c => c.blur?.blurStatus === 'suspect').length;
  const clear = contexts.filter(c => c.blur?.blurStatus === 'clear').length;
  console.log(`[blur] dual-condition: ${blurry} blurry, ${suspect} suspect, ${clear} clear`);
}

// ---------------------------------------------------------------------------
// runOverexposureStage — detect overexposed images using Python results
// ---------------------------------------------------------------------------

async function runOverexposureStage(
  contexts: ImageProcessContext[],
  pythonResults: PythonResultsMap,
): Promise<void> {
  // Process overexposure in parallel (10 at a time)
  const OVEREXPOSURE_CONCURRENCY = 10;
  const eligible = contexts.filter(c => c.downloadOk && c.localPath);

  for (let i = 0; i < eligible.length; i += OVEREXPOSURE_CONCURRENCY) {
    const chunk = eligible.slice(i, i + OVEREXPOSURE_CONCURRENCY);
    await Promise.allSettled(chunk.map(async (ctx) => {
      // Use Python result if available
      const pyResult = pythonResults.get(ctx.mediaId);
      if (pyResult && !pyResult.overexposureError && pyResult.overexposureStatus !== 'unknown') {
        if (pyResult.overexposureStatus === 'overexposed') {
          ctx.overexposure = { overexposureStatus: 'overexposed', overexposureRatio: pyResult.overexposureRatio, qualityPenalty: 0 };
          return;
        }
        if (pyResult.subjectOverexposure) {
          const { severity, qualityPenalty, largestRegionRatio } = pyResult.subjectOverexposure;
          if (severity === 'severe') {
            ctx.overexposure = { overexposureStatus: 'overexposed', overexposureRatio: largestRegionRatio, qualityPenalty: 0 };
          } else if (severity === 'mild') {
            ctx.overexposure = { overexposureStatus: 'normal', overexposureRatio: largestRegionRatio, qualityPenalty };
          } else {
            ctx.overexposure = { overexposureStatus: 'normal', overexposureRatio: pyResult.overexposureRatio, qualityPenalty: 0 };
          }
          return;
        }
        ctx.overexposure = { overexposureStatus: pyResult.overexposureStatus, overexposureRatio: pyResult.overexposureRatio, qualityPenalty: 0 };
        return;
      }

      // Node.js fallback using sharp
      if (pyResult?.overexposureError || pyResult?.subjectOverexposure === null) {
        console.warn(`[overexposure] OpenCV/decode failure for ${ctx.mediaId}, falling back to sharp`);
      }
      try {
        const sharp = (await import('sharp')).default;
        const { data, info } = await sharp(ctx.localPath!)
          .grayscale()
          .raw()
          .toBuffer({ resolveWithObject: true });

        const totalPixels = info.width * info.height;
        let overexposedPixels = 0;
        for (let i = 0; i < data.length; i++) {
          if (data[i] > 240) overexposedPixels++;
        }
        const ratio = totalPixels > 0 ? overexposedPixels / totalPixels : 0;
        const THRESHOLD = PROCESS_THRESHOLDS.overexposureGlobalRatio;
        ctx.overexposure = { overexposureStatus: ratio >= THRESHOLD ? 'overexposed' : 'normal', overexposureRatio: Math.round(ratio * 10000) / 10000, qualityPenalty: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.overexposure = { overexposureStatus: 'unknown', overexposureRatio: null, qualityPenalty: 0, error: msg };
      }
    }));
  }

  const overexposed = contexts.filter(c => c.overexposure?.overexposureStatus === 'overexposed').length;
  const normal = contexts.filter(c => c.overexposure?.overexposureStatus === 'normal').length;
  console.log(`[overexposure] ${overexposed} overexposed, ${normal} normal`);
}

// ---------------------------------------------------------------------------
// applyOverexposureTrash — persist overexposure results, trash overexposed images
// ---------------------------------------------------------------------------

export function applyOverexposureTrash(
  contexts: ImageProcessContext[],
  db: Database.Database,
): { trashedCount: number } {
  const trashStmt = db.prepare(
    `UPDATE media_items 
     SET status = 'trashed', trashed_reason = CASE
       WHEN trashed_reason IS NULL THEN 'overexposure'
       ELSE trashed_reason || ',overexposure'
     END
     WHERE id = ?`
  );

  let trashedCount = 0;
  for (const ctx of contexts) {
    if (!ctx.overexposure) continue;
    if (ctx.overexposure.overexposureStatus === 'overexposed') {
      // Only trash if not already trashed by blur
      if (ctx.blur?.blurStatus !== 'blurry') {
        trashStmt.run(ctx.mediaId);
        trashedCount++;
      }
    }
  }
  return { trashedCount };
}

// ---------------------------------------------------------------------------
// applyBlurTrash — persist blur results to DB, trash confirmed blurry images
// ---------------------------------------------------------------------------

export function applyBlurTrash(
  contexts: ImageProcessContext[],
  db: Database.Database,
): { trashedCount: number } {
  const trashStmt = db.prepare(
    `UPDATE media_items 
     SET status = 'trashed', trashed_reason = 'blur', 
         blur_status = 'blurry', sharpness_score = ?
     WHERE id = ?`
  );
  const updateStmt = db.prepare(
    `UPDATE media_items SET blur_status = ?, sharpness_score = ? WHERE id = ?`
  );
  const errorStmt = db.prepare(
    `UPDATE media_items 
     SET blur_status = 'suspect', status = 'active',
         processing_error = CASE
           WHEN processing_error IS NULL THEN ?
           ELSE processing_error || char(10) || ?
         END
     WHERE id = ?`
  );

  let trashedCount = 0;
  for (const ctx of contexts) {
    if (!ctx.blur) continue;

    // Handle error case: blur assessment had an error (source='node' with null sharpnessScore
    // and blurStatus='suspect' indicates a catch block was hit during assessment)
    if (ctx.blur.error) {
      const errorMsg = `[blur] assessment error: ${ctx.blur.error}`;
      errorStmt.run(errorMsg, errorMsg, ctx.mediaId);
      continue;
    }

    if (ctx.blur.blurStatus === 'blurry') {
      trashStmt.run(ctx.blur.sharpnessScore, ctx.mediaId);
      trashedCount++;
    } else {
      // 'suspect' or 'clear' — just update blur_status and sharpness_score
      updateStmt.run(ctx.blur.blurStatus, ctx.blur.sharpnessScore, ctx.mediaId);
    }
  }
  return { trashedCount };
}

// ---------------------------------------------------------------------------
// runDedupStage
// ---------------------------------------------------------------------------

async function runDedupStage(
  contexts: ImageProcessContext[],
  tempCache: TempPathCache,
): Promise<DedupAssessment | null> {
  // Only exclude confirmed blurry images from dedup; suspect images should still participate
  const dedupEligibleContexts = contexts.filter(
    ctx => ctx.downloadOk && !!ctx.localPath && ctx.blur?.blurStatus !== 'blurry'
  );

  const excluded = contexts.length - dedupEligibleContexts.length;
  console.log(`[dedup] ${contexts.length} total, ${excluded} excluded by blur gate (only clear images enter dedup), ${dedupEligibleContexts.length} entering dedup`);

  if (dedupEligibleContexts.length < 2) {
    return {
      confirmedPairs: [],
      groups: [],
      kept: dedupEligibleContexts.map(c => c.mediaId),
      removed: [],
      skippedIndices: [],
      skippedReasons: {},
      capabilitiesUsed: { hash: false, clip: false, dinov2: false, llm: false },
      evidenceByPair: [],
    };
  }

  const rows: ImageRow[] = dedupEligibleContexts.map(ctx => ({
    id: ctx.mediaId,
    file_path: ctx.filePath,
    original_filename: '',
    sharpness_score: ctx.blur?.sharpnessScore ?? null,
    blur_status: ctx.blur?.blurStatus ?? null,
    width: null,
    height: null,
    file_size: 0,
    status: 'active',
    trashed_reason: null,
    created_at: '',
  }));

  const db = getDb();
  for (let i = 0; i < dedupEligibleContexts.length; i++) {
    const dbRow = db.prepare(
      'SELECT width, height, file_size, original_filename, created_at FROM media_items WHERE id = ?'
    ).get(dedupEligibleContexts[i].mediaId) as { width: number | null; height: number | null; file_size: number; original_filename: string; created_at: string } | undefined;
    if (dbRow) {
      rows[i].width = dbRow.width;
      rows[i].height = dbRow.height;
      rows[i].file_size = dbRow.file_size;
      rows[i].original_filename = dbRow.original_filename;
      rows[i].created_at = dbRow.created_at;
    }
  }

  return assessDedup(rows, tempCache);
}


// ---------------------------------------------------------------------------
// Main pipeline orchestrator
// ---------------------------------------------------------------------------

export async function runTripProcessingPipeline(
  tripId: string,
  options?: PipelineOptions,
): Promise<PipelineResult> {
  const onProgress: PipelineProgressCallback = options?.onProgress ?? (() => {});
  const storageProvider = getStorageProvider();
  const tempCache = new TempPathCache(storageProvider);
  const db = getDb();

  // Shared Python results — classify and blur share one analyzeImages call
  const pythonResults: PythonResultsMap = new Map();

  const stageErrors: Array<{ stage: string; error: string }> = [];

  let contexts: ImageProcessContext[] = [];
  let dedupAssessment: DedupAssessment | null = null;
  const vlmCallStats = createVLMCallStatsTracker();

  try {
    const pipelineStart = Date.now();

    // ---- Stage: collectInputs ----
    console.log(`[pipeline] ===== START trip=${tripId} =====`);
    console.log(
      `[pipeline] thresholds: blur=${PROCESS_THRESHOLDS.blurThreshold}, overexposureGlobal=${PROCESS_THRESHOLDS.overexposureGlobalRatio}, ` +
      `overexposureSubjectV=${PROCESS_THRESHOLDS.overexposureSubjectVThreshold}, overexposureSubjectS=${PROCESS_THRESHOLDS.overexposureSubjectSThreshold}, ` +
      `overexposureSevereTotalArea=${PROCESS_THRESHOLDS.overexposureSubjectSevereTotalAreaRatio}, ` +
      `dinov2Confirmed=${PROCESS_THRESHOLDS.dinov2ConfirmedThreshold}, dinov2GrayLow=${PROCESS_THRESHOLDS.dinov2GrayLowThreshold}, dinov2Dedup=${PROCESS_THRESHOLDS.dinov2DedupThreshold}, ` +
      `clipConfirmed=${PROCESS_THRESHOLDS.clipConfirmedThreshold}, globalSimilarityTopK=${PROCESS_THRESHOLDS.globalSimilarityTopK}`
    );
    onProgress('collectInputs', 'start');
    let t0 = Date.now();
    try {
      contexts = await collectInputs(tripId, tempCache);
      console.log(`[pipeline] collectInputs: ${contexts.length} images, ${contexts.filter(c => c.downloadOk).length} downloaded, ${Date.now() - t0}ms`);
      onProgress('collectInputs', 'complete', `${contexts.length} images collected`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'collectInputs', error: msg });
      console.error(`[pipeline] collectInputs FAILED: ${msg} (${Date.now() - t0}ms)`);
      onProgress('collectInputs', 'complete', `failed: ${msg}`);
    }

    // ---- Stage: classify ----
    onProgress('classify', 'start');
    t0 = Date.now();
    try {
      await runClassifyStage(contexts, pythonResults);
      const classifiedCount = contexts.filter(c => c.classification !== null).length;
      console.log(`[pipeline] classify: ${classifiedCount}/${contexts.length} classified, ${Date.now() - t0}ms`);
      onProgress('classify', 'complete', `${classifiedCount} classified`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'classify', error: msg });
      console.error(`[pipeline] classify FAILED: ${msg} (${Date.now() - t0}ms)`);
      onProgress('classify', 'complete', `failed: ${msg}`);
    }

    // ---- Stage: blur ----
    onProgress('blur', 'start');
    t0 = Date.now();
    try {
      await runBlurStage(contexts, pythonResults);
      // Apply blur results to DB: trash blurry images, update others
      const { trashedCount } = applyBlurTrash(contexts, db);
      const blurCount = contexts.filter(c => c.blur !== null).length;
      const blurryCount = contexts.filter(c => c.blur?.blurStatus === 'blurry').length;
      console.log(`[pipeline] blur: ${blurCount} assessed, ${blurryCount} blurry, ${trashedCount} trashed, ${Date.now() - t0}ms`);
      onProgress('blur', 'complete', `${blurCount} blur-assessed, ${trashedCount} trashed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'blur', error: msg });
      console.error(`[pipeline] blur FAILED: ${msg} (${Date.now() - t0}ms)`);
      onProgress('blur', 'complete', `failed: ${msg}`);
    }

    // ---- Stage: overexposure ----
    t0 = Date.now();
    try {
      await runOverexposureStage(contexts, pythonResults);
      const { trashedCount: overexposureTrashedCount } = applyOverexposureTrash(contexts, db);
      const overexposedCount = contexts.filter(c => c.overexposure?.overexposureStatus === 'overexposed').length;
      console.log(`[pipeline] overexposure: ${overexposedCount} overexposed, ${overexposureTrashedCount} trashed, ${Date.now() - t0}ms`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'overexposure', error: msg });
      console.error(`[pipeline] overexposure FAILED: ${msg} (${Date.now() - t0}ms)`);
    }

    // ---- Stage: dedup ----
    onProgress('dedup', 'start');
    t0 = Date.now();
    try {
      dedupAssessment = await runDedupStage(contexts, tempCache);
      const removedCount = dedupAssessment?.removed.length ?? 0;
      console.log(`[pipeline] dedup: ${removedCount} removed, ${Date.now() - t0}ms`);
      onProgress('dedup', 'complete', `${removedCount} duplicates found`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'dedup', error: msg });
      dedupAssessment = null;
      console.error(`[pipeline] dedup FAILED: ${msg} (${Date.now() - t0}ms)`);
      onProgress('dedup', 'complete', `failed: ${msg}`);
    }

    // ---- Stage: globalSimilarity ----
    // Compute prelimActiveMediaIds: images NOT trashed by blur (blurry),
    // severe overexposure, or hash duplicate. Then run global similarity
    // BEFORE the final reducer so its results feed into the single reduce pass.
    let globalSimilarityAssessment: GlobalSimilarityAssessment | null = null;
    onProgress('globalSimilarity', 'start');
    t0 = Date.now();
    try {
      const dedupRemovedSet = new Set(dedupAssessment?.removed ?? []);
      const prelimActiveMediaIds = contexts
        .filter((ctx) => {
          // Exclude blurry images
          if (ctx.blur?.blurStatus === 'blurry') return false;
          // Exclude severely overexposed images
          if (ctx.overexposure?.overexposureStatus === 'overexposed') return false;
          // Exclude hash duplicates
          if (dedupRemovedSet.has(ctx.mediaId)) return false;
          return true;
        })
        .map((ctx) => ctx.mediaId);

      console.log(`[pipeline] globalSimilarity: ${prelimActiveMediaIds.length} preliminary active images (from ${contexts.length} total)`);

      if (prelimActiveMediaIds.length >= 2) {
        const globalResult = await runGlobalSimilarity(tripId, prelimActiveMediaIds, {
          onProgress: (_stage, status, detail) => {
            onProgress('globalSimilarity', status, detail);
          },
          vlmStats: vlmCallStats,
        });

        // Convert GlobalSimilarityResult → GlobalSimilarityAssessment for the reducer
        const trashedByGlobalSimilarity: string[] = [];
        for (const cluster of globalResult.clusters) {
          for (const mediaId of cluster.trashedMediaIds) {
            trashedByGlobalSimilarity.push(mediaId);
          }
        }

        if (trashedByGlobalSimilarity.length > 0) {
          globalSimilarityAssessment = { trashed: trashedByGlobalSimilarity };
        }

        console.log(
          `[pipeline] globalSimilarity: ${globalResult.clusters.length} clusters, ` +
          `${trashedByGlobalSimilarity.length} trashed, ` +
          `${globalResult.localQualityResolved} local-quality, ${globalResult.vlmResolved} vlm, ` +
          `${globalResult.fallbackKeptAll} fallback-kept, ` +
          `${globalResult.vlmCallsMade} VLM calls, ${Date.now() - t0}ms`
        );
      } else {
        recordVLMSkippedStage(vlmCallStats, 'globalSimilarity');
        console.log(`[pipeline] globalSimilarity: skipped (fewer than 2 preliminary active images), ${Date.now() - t0}ms`);
      }
      onProgress('globalSimilarity', 'complete', `${globalSimilarityAssessment?.trashed.length ?? 0} trashed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'globalSimilarity', error: msg });
      console.error(`[pipeline] globalSimilarity FAILED: ${msg} (${Date.now() - t0}ms)`);
      onProgress('globalSimilarity', 'complete', `failed: ${msg}`);
    }

    // ---- Stage: reduce ----
    let decisions: ReturnType<typeof reduce> = [];
    onProgress('reduce', 'start');
    t0 = Date.now();
    try {
      decisions = reduce(contexts, dedupAssessment, globalSimilarityAssessment);
      // Sanity check: decisions should have unique mediaIds
      const uniqueIds = new Set(decisions.map(d => d.mediaId));
      if (uniqueIds.size !== decisions.length) {
        console.warn(`[pipeline] reduce produced ${decisions.length} decisions but only ${uniqueIds.size} unique mediaIds — deduplicating`);
        const seen = new Set<string>();
        decisions = decisions.filter(d => {
          if (seen.has(d.mediaId)) return false;
          seen.add(d.mediaId);
          return true;
        });
      }
      console.log(`[pipeline] reduce: ${decisions.length} decisions, ${Date.now() - t0}ms`);
      onProgress('reduce', 'complete', `${decisions.length} decisions`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'reduce', error: msg });
      console.error(`[pipeline] reduce FAILED: ${msg} (${Date.now() - t0}ms)`);
      onProgress('reduce', 'complete', `failed: ${msg}`);
    }

    // ---- Stage: write ----
    onProgress('write', 'start');
    t0 = Date.now();
    try {
      const writeResult = writeDecisions(tripId, decisions);
      if (writeResult.error) {
        stageErrors.push({ stage: 'write', error: writeResult.error });
        console.error(`[pipeline] write error: ${writeResult.error}`);
      }
      console.log(`[pipeline] write: ${writeResult.updatedCount} updated, ${writeResult.skippedCount} skipped, ${Date.now() - t0}ms`);
      onProgress('write', 'complete', `${writeResult.updatedCount} updated`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'write', error: msg });
      console.error(`[pipeline] write FAILED: ${msg} (${Date.now() - t0}ms)`);
      onProgress('write', 'complete', `failed: ${msg}`);
    }

    // ---- Stage: aiReview (per-photo quality screening) ----
    // First AI pass: each photo is judged independently against four hard
    // tests (sharpness / subject exposure / composition / video value).
    // Conservative fallback: any failed batch keeps all its photos.
    onProgress('aiReview', 'start');
    t0 = Date.now();
    let aiReviewTrashedCount = 0;
    try {
      const reviewResult = await runAIReview(tripId, {
        onProgress: (_stage, status, detail) => {
          onProgress('aiReview', status, detail);
        },
        vlmCallStats,
        tempCache,
      });
      aiReviewTrashedCount = reviewResult.totalTrashed;
      console.log(
        `[pipeline] aiReview: ${reviewResult.totalTrashed} trashed from ` +
        `${reviewResult.totalProcessed} images, ${reviewResult.vlmCallsMade} VLM calls, ` +
        `${reviewResult.vlmCallsFailed} batch failures, ${Date.now() - t0}ms`
      );
      onProgress('aiReview', 'complete', `${reviewResult.totalTrashed} trashed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'aiReview', error: msg });
      console.error(`[pipeline] aiReview FAILED: ${msg} (${Date.now() - t0}ms)`);
      onProgress('aiReview', 'complete', `failed: ${msg}`);
    }

    // ---- Stage: sceneDedup (cross-photo scene redundancy with smart batching) ----
    // Final AI pass: takes all surviving active photos, sorts them by
    // capture time, and asks the VLM to find scene-redundant clusters and
    // keep one per cluster. The batching uses DINOv2 cosine similarity
    // across batch boundaries to merge same-scene neighbours into one
    // batch — fixing the "burst pair split across two batches" failure
    // mode of the older aiFinalDedup. Sequential over batches (one at a
    // time) to stay under the VLM rate limit.
    //
    // The legacy runAIFinalDedup function is preserved for rollback but
    // no longer invoked.
    void runAIFinalDedup; // keep the import alive for rollback

    onProgress('sceneDedup', 'start');
    t0 = Date.now();
    let sceneDedupTrashedCount = 0;
    try {
      const sceneResult = await runSceneDedup(tripId, {
        onProgress: (_stage, status, detail) => {
          onProgress('sceneDedup', status, detail);
        },
        vlmCallStats,
        tempCache,
      });
      sceneDedupTrashedCount = sceneResult.totalTrashed;
      console.log(
        `[pipeline] sceneDedup: ${sceneResult.totalTrashed} trashed from ` +
        `${sceneResult.totalProcessed} images, ${sceneResult.vlmCallsMade} VLM calls, ` +
        `${sceneResult.vlmCallsFailed} batch failures, ${sceneResult.batchesProcessed} batches ` +
        `(merging=${sceneResult.embeddingsUsed ? 'on' : 'off'}), ${Date.now() - t0}ms`
      );
      onProgress('sceneDedup', 'complete', `${sceneResult.totalTrashed} trashed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'sceneDedup', error: msg });
      console.error(`[pipeline] sceneDedup FAILED: ${msg} (${Date.now() - t0}ms)`);
      onProgress('sceneDedup', 'complete', `failed: ${msg}`);
    }

    // ---- Stage: aiRefinement (optional) ----
    // Third post-reducer AI stage: per-photo refinement (which doubles
    // as a final keep/trash check). Needs a VLM provider; the gate
    // accepts any of dashscope / anthropic / bedrock that vlmClient supports.
    // Runs AFTER sceneDedup per design: writeDecisions → aiReview → sceneDedup → aiRefinement
    const aiRefinementEnabled = process.env.AI_REVIEW_ENABLED === 'true';
    const vlmConfiguredForRefinement =
      !!process.env.DASHSCOPE_API_KEY ||
      !!process.env.ANTHROPIC_API_KEY ||
      !!process.env.AWS_BEARER_TOKEN_BEDROCK ||
      !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
      !!(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
    let aiRefinementTrashedCount = 0;
    if (aiRefinementEnabled && vlmConfiguredForRefinement) {
      onProgress('aiRefinement', 'start');
      t0 = Date.now();
      try {
        const refinementResult = await runAiRefinement(tripId, { vlmCallStats, tempCache });
        aiRefinementTrashedCount = refinementResult.trashedCount;
        console.log(
          `[pipeline] aiRefinement: ${refinementResult.optimizedCount} optimized, ` +
          `${refinementResult.trashedCount} trashed, ${refinementResult.skippedCount} skipped, ` +
          `${refinementResult.errorCount} errors, ${Date.now() - t0}ms`
        );
        onProgress(
          'aiRefinement',
          'complete',
          `${refinementResult.optimizedCount} refined / ${refinementResult.trashedCount} trashed`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stageErrors.push({ stage: 'aiRefinement', error: msg });
        onProgress('aiRefinement', 'complete', `failed: ${msg}`);
      }
    } else {
      recordVLMSkippedStage(vlmCallStats, 'aiRefinement');
    }

    // ---- Compute stats from decisions (Constraint 6: primary trash reason) ----
    // Pre-reducer counts use the PRIMARY trash reason (first entry in trashedReasons).
    // Priority order: blur > overexposure > duplicate > global_similarity.
    // Each image is counted under its primary reason only — no double-counting.
    let blurryDeletedCount = 0;
    let overexposureDeletedCount = 0;
    let dedupDeletedCount = 0;
    let globalSimilarityTrashedCount = 0;
    for (const d of decisions) {
      if (d.finalStatus === 'trashed' && d.trashedReasons.length > 0) {
        const primaryReason = d.trashedReasons[0];
        switch (primaryReason) {
          case 'blur': blurryDeletedCount++; break;
          case 'overexposure': overexposureDeletedCount++; break;
          case 'duplicate': dedupDeletedCount++; break;
          case 'global_similarity': globalSimilarityTrashedCount++; break;
        }
      }
    }
    const classifiedCount = decisions.filter(
      d => d.finalCategory !== null
    ).length;
    const downloadFailedCount = contexts.filter(c => !c.downloadOk).length;
    const partialFailureCount = contexts.filter(
      c => c.processingErrors.length > 0 && c.downloadOk
    ).length;

    const categoryStats = { people: 0, animal: 0, landscape: 0, other: 0 };
    for (const d of decisions) {
      if (d.finalStatus === 'active') {
        const cat = d.finalCategory as keyof typeof categoryStats;
        if (cat in categoryStats) {
          categoryStats[cat]++;
        } else {
          categoryStats.other++;
        }
      }
    }

    // ---- Post-processing stages ----

    // analyze
    onProgress('analyze', 'start');
    t0 = Date.now();
    try {
      await analyzeTrip(tripId);
    } catch (err) {
      console.warn(`[pipeline] analyzeTrip failed: ${err}`);
    }
    const analyzedCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active' AND avg_brightness IS NOT NULL"
    ).get(tripId) as { cnt: number }).cnt;
    console.log(`[pipeline] analyze: ${analyzedCount} analyzed, ${Date.now() - t0}ms`);
    onProgress('analyze', 'complete', `${analyzedCount} analyzed`);

    // optimize
    onProgress('optimize', 'start');
    t0 = Date.now();
    let optimizedCount = 0;
    let failedCount = 0;
    try {
      const optimizeResults = await optimizeTrip(tripId);
      optimizedCount = optimizeResults.filter(r => r.optimizedPath !== null).length;
      failedCount += optimizeResults.filter(r => r.error).length;
    } catch (err) {
      console.warn(`[pipeline] optimizeTrip failed: ${err}`);
    }
    console.log(`[pipeline] optimize: ${optimizedCount} optimized, ${failedCount} failed, ${Date.now() - t0}ms`);
    onProgress('optimize', 'complete', `${optimizedCount} optimized`);

    // thumbnail
    onProgress('thumbnail', 'start');
    t0 = Date.now();
    try {
      await generateThumbnailsForTrip(tripId);
    } catch (err) {
      console.warn(`[pipeline] generateThumbnailsForTrip failed: ${err}`);
    }
    console.log(`[pipeline] thumbnail: ${Date.now() - t0}ms`);
    onProgress('thumbnail', 'complete');

    // video analysis + editing
    const videoRows = db.prepare(
      "SELECT * FROM media_items WHERE trip_id = ? AND media_type = 'video' AND status = 'active'"
    ).all(tripId) as MediaItemRow[];
    const totalVideos = videoRows.length;

    const unprocessedVideos = videoRows.filter(v => !v.compiled_path);
    const alreadyProcessedCount = totalVideos - unprocessedVideos.length;
    let compiledCount = alreadyProcessedCount;

    const updateCompiledStmt = db.prepare('UPDATE media_items SET compiled_path = ? WHERE id = ?');
    const updateErrorStmt = db.prepare(
      `UPDATE media_items
       SET processing_error = CASE
         WHEN processing_error IS NULL THEN ?
         ELSE processing_error || char(10) || ?
       END
       WHERE id = ?`
    );

    onProgress('videoAnalysis', 'start');
    const videoAnalysisStart = Date.now();
    console.log(`[pipeline] videoAnalysis started at ${new Date(videoAnalysisStart).toISOString()}`);
    const analysisResults = new Map<string, Awaited<ReturnType<typeof analyzeVideo>>>();
    for (const videoRow of unprocessedVideos) {
      // Skip merged videos — they should not be re-analyzed (Requirement 7.2)
      if (videoRow.media_source === 'merged') continue;
      try {
        const videoPath = await storageProvider.downloadToTemp(videoRow.file_path);
        const analysis = await analyzeVideo(videoPath, videoRow.id);
        analysisResults.set(videoRow.id, analysis);
        // Persist segments to DB so they're available for autoCompile and frontend
        saveSegments(videoRow.id, analysis.segments);
        console.log(`[pipeline] videoAnalysis OK for ${videoRow.id}: ${analysis.segments.length} segments, duration=${analysis.duration.toFixed(1)}s`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errorText = `[videoAnalysis] ${errorMsg}`;
        console.error(`[pipeline] videoAnalysis FAILED for ${videoRow.id}: ${errorMsg}`);
        updateErrorStmt.run(errorText, errorText, videoRow.id);
        failedCount++;
      }
    }
    const videoAnalysisEnd = Date.now();
    console.log(`[pipeline] videoAnalysis ended at ${new Date(videoAnalysisEnd).toISOString()}, duration=${((videoAnalysisEnd - videoAnalysisStart) / 1000).toFixed(1)}s`);
    onProgress('videoAnalysis', 'complete', `${analysisResults.size} analyzed`);

    // ---- Stage: autoCompile ----
    // Trigger auto-compilation for videos that have segments written to DB
    // Requirements: 1.1, 1.2, 1.3 — always auto-compile after video_segments are written
    onProgress('autoCompile', 'start');
    let autoCompileCount = 0;
    const compilationEngine = new CompilationEngine();
    for (const videoRow of unprocessedVideos) {
      if (!analysisResults.has(videoRow.id)) continue;
      // Skip merged videos — they should not be re-compiled (Requirement 7.2)
      if (videoRow.media_source === 'merged') continue;
      try {
        await compilationEngine.autoCompile(videoRow.id);
        autoCompileCount++;
      } catch (err) {
        // Auto-compilation failure must NOT affect pipeline result (Requirement 1.3)
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[pipeline] autoCompile failed for ${videoRow.id}: ${errorMsg}`);
      }
    }
    onProgress('autoCompile', 'complete', `${autoCompileCount} auto-compiled`);

    onProgress('videoEdit', 'start');
    const videoEditAuto = process.env.VIDEO_EDIT_AUTO === 'true';
    const videoEditStart = Date.now();
    if (!videoEditAuto) {
      console.log(`[pipeline] videoEdit skipped (VIDEO_EDIT_AUTO not enabled)`);
    } else {
      console.log(`[pipeline] videoEdit started at ${new Date(videoEditStart).toISOString()}`);
    for (const videoRow of unprocessedVideos) {
      // Skip merged videos — they should not be re-edited (Requirement 7.2)
      if (videoRow.media_source === 'merged') continue;
      const analysis = analysisResults.get(videoRow.id);
      if (!analysis) continue;

      try {
        console.log(`[pipeline] videoEdit processing ${videoRow.id}: ${analysis.segments.length} segments`);
        const videoPath = await storageProvider.downloadToTemp(videoRow.file_path);
        const editResult = await editVideo(videoPath, analysis, tripId, videoRow.id, {
          videoResolution: options?.videoResolution,
        });
        if (editResult.compiledPath) {
          updateCompiledStmt.run(editResult.compiledPath, videoRow.id);
          compiledCount++;
          console.log(`[pipeline] videoEdit OK for ${videoRow.id}: compiled_path=${editResult.compiledPath}`);

          // Regenerate thumbnail from compiled video
          try {
            const compiledLocalPath = await storageProvider.downloadToTemp(editResult.compiledPath);
            const thumbPath = await generateVideoThumbnail(compiledLocalPath, tripId, videoRow.id);
            db.prepare('UPDATE media_items SET thumbnail_path = ? WHERE id = ?').run(thumbPath, videoRow.id);
          } catch (thumbErr) {
            const thumbMsg = thumbErr instanceof Error ? thumbErr.message : String(thumbErr);
            console.warn(`[pipeline] thumbnail regeneration failed for ${videoRow.id}: ${thumbMsg}`);
          }
        } else if (editResult.error) {
          console.error(`[pipeline] videoEdit returned error for ${videoRow.id}: ${editResult.error}`);
          const errorText = `[videoEdit] ${editResult.error}`;
          updateErrorStmt.run(errorText, errorText, videoRow.id);
          failedCount++;
        } else {
          console.log(`[pipeline] videoEdit skipped for ${videoRow.id}: no compilation needed (short video, all segments good)`);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errorText = `[videoEdit] ${errorMsg}`;
        console.error(`[pipeline] videoEdit FAILED for ${videoRow.id}: ${errorMsg}`);
        updateErrorStmt.run(errorText, errorText, videoRow.id);
        failedCount++;
      }
    }
    } // end if (videoEditAuto)
    const videoEditEnd = Date.now();
    console.log(`[pipeline] videoEdit ended at ${new Date(videoEditEnd).toISOString()}, duration=${((videoEditEnd - videoEditStart) / 1000).toFixed(1)}s`);
    onProgress('videoEdit', 'complete', `${compiledCount} compiled`);

    // ---- Stage: videoEnhance ----
    // Run black frame detection, junk detection, and multi-version generation for each video
    const videoEnhanceAuto = process.env.VIDEO_ENHANCE_AUTO === 'true';
    onProgress('videoEnhance', 'start');
    t0 = Date.now();
    let versionsGenerated = 0;
    if (videoEnhanceAuto) {
      for (const videoRow of videoRows) {
        // Skip merged videos — they should not be re-enhanced (Requirement 7.2)
        if (videoRow.media_source === 'merged') continue;
        try {
          const videoPath = await storageProvider.downloadToTemp(videoRow.file_path);
          const mediaId = videoRow.id;

          // Get segments from the database
          const segmentRows = db.prepare(
            'SELECT * FROM video_segments WHERE media_id = ? ORDER BY start_time'
          ).all(mediaId) as any[];

          if (segmentRows.length === 0) continue;

          const segments: VideoSegment[] = segmentRows.map((s: any, idx: number) => ({
            index: idx,
            startTime: s.start_time,
            endTime: s.end_time,
            duration: s.end_time - s.start_time,
            overallScore: s.overall_score || 50,
            sharpnessScore: s.sharpness_score || 50,
            stabilityScore: s.stability_score || 50,
            exposureScore: s.exposure_score || 50,
            label: s.label || 'good',
          }));

          // Run black frame detection on each segment
          onProgress('blackFrameDetect', 'start');
          const blackFrameResults = new Map<number, BlackFrameResult>();
          for (const segment of segments) {
            try {
              const result = await detectBlackFrames(videoPath, segment.startTime, segment.endTime);
              blackFrameResults.set(segment.index, result);
            } catch {
              // Skip failed detection, continue with remaining segments
            }
          }
          onProgress('blackFrameDetect', 'complete', `${blackFrameResults.size}/${segments.length} segments checked`);

          // Run junk clip detection on each segment
          onProgress('junkDetect', 'start');
          const junkResults = new Map<number, JunkClipResult>();
          for (const segment of segments) {
            try {
              const result = await detectJunkClip(videoPath, segment.startTime, segment.endTime);
              junkResults.set(segment.index, result);
            } catch {
              // Skip failed detection, continue with remaining segments
            }
          }
          onProgress('junkDetect', 'complete', `${junkResults.size}/${segments.length} segments checked`);

          // Generate multiple versions with detection results
          onProgress('versionGenerate', 'start');
          const profiles = Object.values(DEFAULT_PROFILES);
          const versionResult = await generateVersions(
            videoPath,
            mediaId,
            tripId,
            segments,
            profiles,
            { blackFrameResults, junkResults, videoResolution: options?.videoResolution },
          );
          onProgress('versionGenerate', 'complete', `${versionResult.versions.length} versions created`);

          versionsGenerated += versionResult.versions.length;

          if (versionResult.errors.length > 0) {
            for (const err of versionResult.errors) {
              console.warn(`[pipeline] videoEnhance version error for ${mediaId}: ${err.profile}: ${err.error}`);
            }
          }
        } catch (err) {
          // Handle individual video failures without stopping the batch
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.warn(`[pipeline] videoEnhance failed for ${videoRow.id}: ${errorMsg}`);
          const errorText = `[videoEnhance] ${errorMsg}`;
          updateErrorStmt.run(errorText, errorText, videoRow.id);
        }
      }
      console.log(`[pipeline] videoEnhance: ${versionsGenerated} versions generated, ${Date.now() - t0}ms`);
    } else {
      console.log(`[pipeline] videoEnhance skipped by default`);
    }
    onProgress('videoEnhance', 'complete', `${versionsGenerated} versions generated`);

    // ---- Stage: aiAnalysis (optional) ----
    // Only runs if AI_AUTO_ANALYZE=true and AI provider is configured
    const aiAutoAnalyze = process.env.AI_AUTO_ANALYZE === 'true';
    if (aiAutoAnalyze && videoRows.length > 0) {
      onProgress('aiAnalysis', 'start');
      t0 = Date.now();
      let aiAnalyzedCount = 0;
      try {
        const { getAIProviderRegistry } = await import('../ai');
        const { ContentAnalyzer } = await import('../ai/contentAnalyzer');
        const { CostTracker } = await import('../ai/costTracker');
        const { BudgetController } = await import('../ai/budgetController');

        const registry = getAIProviderRegistry();
        if (registry.listProviders().length > 0) {
          const provider = registry.getDefault();
          const costTracker = new CostTracker();
          const budgetController = new BudgetController(costTracker);

          // Get trip owner for budget check
          const tripRow = db.prepare('SELECT user_id FROM trips WHERE id = ?').get(tripId) as { user_id: string } | undefined;
          const userId = tripRow?.user_id ?? 'system';

          // Check budget before proceeding
          const budgetCheck = budgetController.checkBudget(userId);
          if (budgetCheck.allowed) {
            const analyzer = new ContentAnalyzer(provider, costTracker, budgetController);
            for (const videoRow of videoRows) {
              try {
                await analyzer.analyzeContent(videoRow.id, userId, tripId);
                aiAnalyzedCount++;
              } catch (err) {
                // AI analysis failure doesn't stop the pipeline
                console.warn(`[pipeline] aiAnalysis failed for ${videoRow.id}: ${err}`);
              }
            }
          } else {
            console.log(`[pipeline] aiAnalysis skipped: budget exceeded for user ${userId}`);
          }
        }
      } catch (err) {
        console.warn(`[pipeline] aiAnalysis stage failed: ${err}`);
      }
      console.log(`[pipeline] aiAnalysis: ${aiAnalyzedCount} videos analyzed, ${Date.now() - t0}ms`);
      onProgress('aiAnalysis', 'complete', `${aiAnalyzedCount} AI-analyzed`);
    }

    // cover
    onProgress('cover', 'start');
    t0 = Date.now();
    let coverImageId: string | null = null;
    try {
      coverImageId = await selectCoverImage(tripId);
    } catch (err) {
      console.warn(`[pipeline] selectCoverImage failed: ${err}`);
    }
    console.log(`[pipeline] cover: ${coverImageId ?? 'none'}, ${Date.now() - t0}ms`);
    onProgress('cover', 'complete');

    // Count total images (including trashed)
    const totalImages = (db.prepare(
      "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image'"
    ).get(tripId) as { cnt: number }).cnt;

    const skippedCount = dedupAssessment?.skippedIndices.length ?? 0;

    // ---- Compute VLM status ----
    const vlmEnabled = process.env.AI_REVIEW_ENABLED !== 'false';
    const vlmAvailable = isVLMAvailable();
    const vlmStatus = deriveVLMStatus(vlmCallStats, vlmEnabled, vlmAvailable);
    vlmCallStats.diagnostic = buildVLMDiagnostic(vlmCallStats, vlmEnabled, vlmAvailable);

    // ---- Compute final active/trashed counts from DB (Constraint 4: after all stages) ----
    const activeCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active'"
    ).get(tripId) as { cnt: number }).cnt;
    const trashedCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'trashed'"
    ).get(tripId) as { cnt: number }).cnt;

    // ---- Completion summary log (Constraint 7) ----
    // This log MUST appear even if the pipeline completes with errors.
    console.log(
      `[pipeline] ===== SUMMARY trip=${tripId} =====\n` +
      `  blur=${blurryDeletedCount}, overexposure=${overexposureDeletedCount}, dedup=${dedupDeletedCount},\n` +
      `  globalSimilarity=${globalSimilarityTrashedCount}, aiReview=${aiReviewTrashedCount}, sceneDedup=${sceneDedupTrashedCount},\n` +
      `  vlmStatus=${vlmStatus}, vlmCalls=${vlmCallStats.totalCalls}, vlmFailed=${vlmCallStats.failedCalls}, vlmParseFailures=${vlmCallStats.parseFailures},\n` +
      `  finalActive=${activeCount}, finalTrashed=${trashedCount}, total=${totalImages}`
    );

    console.log(`[pipeline] ===== DONE trip=${tripId} total=${Date.now() - pipelineStart}ms blur=${blurryDeletedCount} dedup=${dedupDeletedCount} errors=${stageErrors.length} =====`);
    if (stageErrors.length > 0) {
      console.log(`[pipeline] stage errors: ${stageErrors.map(e => `${e.stage}: ${e.error.slice(0, 100)}`).join('; ')}`);
    }

    // Auto-trigger highlight evaluation + tier selection (fire-and-forget)
    // This runs 精选 → 精华 → slideshow generation in the background
    if (activeCount >= 2) {
      runHighlightEvaluation(tripId)
        .then((result) => {
          console.log(`[pipeline] Auto highlight evaluation completed: ${result.highlightCount} highlights selected`);
        })
        .catch((err) => {
          console.error(`[pipeline] Auto highlight evaluation failed (non-fatal): ${err}`);
        });
    }

    return {
      tripId,
      totalImages,
      totalVideos,
      blurryDeletedCount,
      overexposureDeletedCount,
      dedupDeletedCount,
      globalSimilarityTrashedCount,
      aiReviewTrashedCount,
      sceneDedupTrashedCount,
      aiRefinementTrashedCount,
      analyzedCount,
      optimizedCount,
      classifiedCount,
      categoryStats,
      compiledCount,
      failedCount,
      skippedCount,
      partialFailureCount,
      downloadFailedCount,
      coverImageId,
      vlmStatus,
      vlmCallStats,
    };
  } finally {
    tempCache.cleanup();
  }
}
