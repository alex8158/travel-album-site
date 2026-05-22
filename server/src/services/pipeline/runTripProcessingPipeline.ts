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
import { reduce } from './resultReducer';
import { writeDecisions } from './resultWriter';
import { CompilationEngine } from '../compilationEngine';
import type {
  ImageProcessContext,
  ClassificationAssessment,
  BlurAssessment,
  DedupAssessment,
  PipelineOptions,
  PipelineResult,
  PipelineProgressCallback,
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

  const contexts: ImageProcessContext[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const ctx: ImageProcessContext = {
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
    };

    try {
      const localPath = await tempCache.get(row.file_path);
      ctx.localPath = localPath;
      ctx.downloadOk = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.downloadOk = false;
      ctx.downloadError = msg;
      ctx.processingErrors.push(`[download] ${msg}`);
    }

    contexts.push(ctx);
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
  for (const ctx of contexts) {
    if (!ctx.downloadOk || !ctx.localPath) continue;

    try {
      // Use full dual-condition detection (Laplacian + MUSIQ) via assessBlur
      const assessment = await assessBlur(ctx.localPath);
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
  }

  const blurry = contexts.filter(c => c.blur?.blurStatus === 'blurry').length;
  const suspect = contexts.filter(c => c.blur?.blurStatus === 'suspect').length;
  const clear = contexts.filter(c => c.blur?.blurStatus === 'clear').length;
  console.log(`[blur] dual-condition: ${blurry} blurry, ${suspect} suspect, ${clear} clear`);
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

  try {
    const pipelineStart = Date.now();

    // ---- Stage: collectInputs ----
    console.log(`[pipeline] ===== START trip=${tripId} =====`);
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

    // ---- Stage: reduce ----
    let decisions: ReturnType<typeof reduce> = [];
    onProgress('reduce', 'start');
    t0 = Date.now();
    try {
      decisions = reduce(contexts, dedupAssessment);
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

    // ---- Stage: aiScreening (optional) ----
    // Runs AFTER write so that dedup trashed images are already committed to DB
    // Only runs when AI_REVIEW_ENABLED=true and DASHSCOPE_API_KEY is configured
    const aiReviewEnabled = process.env.AI_REVIEW_ENABLED === 'true';
    const dashScopeConfigured = !!process.env.DASHSCOPE_API_KEY;
    if (aiReviewEnabled && dashScopeConfigured) {
      onProgress('aiScreening', 'start');
      t0 = Date.now();
      try {
        const screeningResult = await runAiScreening(tripId);
        console.log(`[pipeline] aiScreening: ${screeningResult.totalRemoved} removed from ${screeningResult.totalProcessed} images, ${Date.now() - t0}ms`);
        onProgress('aiScreening', 'complete', `${screeningResult.totalRemoved} removed`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stageErrors.push({ stage: 'aiScreening', error: msg });
        console.error(`[pipeline] aiScreening FAILED: ${msg} (${Date.now() - t0}ms)`);
        onProgress('aiScreening', 'complete', `failed: ${msg}`);
      }
    }

    // ---- Compute stats from decisions ----
    const blurryDeletedCount = decisions.filter(
      d => d.finalStatus === 'trashed' && d.trashedReasons.includes('blur')
    ).length;
    const dedupDeletedCount = decisions.filter(
      d => d.finalStatus === 'trashed' && d.trashedReasons.includes('duplicate')
    ).length;
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

    // ---- Stage: aiRefinement (optional) ----
    const aiRefinementEnabled = process.env.AI_REVIEW_ENABLED === 'true';
    const dashScopeConfiguredForRefinement = !!process.env.DASHSCOPE_API_KEY;
    if (aiRefinementEnabled && dashScopeConfiguredForRefinement) {
      onProgress('aiRefinement', 'start');
      t0 = Date.now();
      try {
        const refinementResult = await runAiRefinement(tripId);
        console.log(`[pipeline] aiRefinement: ${refinementResult.optimizedCount} optimized, ${Date.now() - t0}ms`);
        onProgress('aiRefinement', 'complete', `${refinementResult.optimizedCount} refined`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stageErrors.push({ stage: 'aiRefinement', error: msg });
        onProgress('aiRefinement', 'complete', `failed: ${msg}`);
      }
    }

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

    console.log(`[pipeline] ===== DONE trip=${tripId} total=${Date.now() - pipelineStart}ms blur=${blurryDeletedCount} dedup=${dedupDeletedCount} errors=${stageErrors.length} =====`);
    if (stageErrors.length > 0) {
      console.log(`[pipeline] stage errors: ${stageErrors.map(e => `${e.stage}: ${e.error.slice(0, 100)}`).join('; ')}`);
    }

    return {
      tripId,
      totalImages,
      totalVideos,
      blurryDeletedCount,
      dedupDeletedCount,
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
    };
  } finally {
    tempCache.cleanup();
  }
}
