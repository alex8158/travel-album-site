import fs from 'fs';
import { getDb } from '../../database';
import { getStorageProvider } from '../../storage/factory';
import { TempPathCache } from '../../helpers/tempPathCache';
import {
  isPythonAvailable,
  analyzeImages,
  PythonAnalyzeResult,
} from '../pythonAnalyzer';
import { assessClassification } from '../imageClassifier';
import { computeSharpness, classifyBlur } from '../blurDetector';
import { PROCESS_THRESHOLDS } from '../dedupThresholds';
import { batchMLQuality, isMLServiceAvailable } from '../mlQualityService';
import { assessDedup, ImageRow } from '../hybridDedupEngine';
import { analyzeTrip } from '../imageAnalyzer';
import { optimizeTrip } from '../imageOptimizer';
import { generateThumbnailsForTrip } from '../thumbnailGenerator';
import { selectCoverImage } from '../coverSelector';
import { analyzeVideo } from '../videoAnalyzer';
import { editVideo } from '../videoEditor';
import { reduce } from './resultReducer';
import { writeDecisions } from './resultWriter';
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
  // ---- Pass 1: Apply Python dual-Laplacian results ----
  for (const ctx of contexts) {
    if (!ctx.downloadOk || !ctx.localPath) continue;

    const pyResult = pythonResults.get(ctx.mediaId);
    if (pyResult && !pyResult.blurError && pyResult.blurScore != null
        && pyResult.blurStatus && pyResult.blurStatus !== 'unknown') {
      ctx.blur = {
        sharpnessScore: pyResult.blurScore,
        blurStatus: pyResult.blurStatus as 'clear' | 'suspect' | 'blurry',
        source: 'python',
      };
    } else {
      // No Python result — use Node.js Laplacian
      try {
        const sharpness = await computeSharpness(ctx.localPath);
        const status = classifyBlur(sharpness, PROCESS_THRESHOLDS.blurThreshold, PROCESS_THRESHOLDS.clearThreshold);
        ctx.blur = { sharpnessScore: sharpness, blurStatus: status, source: 'node' };
      } catch {
        ctx.blur = { blurStatus: 'suspect', sharpnessScore: null, source: 'node' };
      }
    }
  }

  const blurryAfterLap = contexts.filter(c => c.blur?.blurStatus === 'blurry').length;
  const suspectAfterLap = contexts.filter(c => c.blur?.blurStatus === 'suspect').length;
  console.log(`[blur] Laplacian pass: ${blurryAfterLap} blurry, ${suspectAfterLap} suspect`);

  // ---- Pass 2: MUSIQ for suspect images with low-ish Laplacian (< clearThreshold) ----
  // Only check suspects that actually need MUSIQ — high-score suspects are fine
  const suspectContexts = contexts.filter(
    c => c.downloadOk && c.localPath && c.blur?.blurStatus === 'suspect'
  );

  if (suspectContexts.length > 0) {
    const mlAvailable = await isMLServiceAvailable();
    if (mlAvailable) {
      const CHUNK = 15;
      console.log(`[blur] MUSIQ pass: ${suspectContexts.length} suspects (chunks of ${CHUNK})...`);
      let totalScored = 0;
      let upgraded = 0;

      for (let start = 0; start < suspectContexts.length; start += CHUNK) {
        const chunk = suspectContexts.slice(start, start + CHUNK);
        const paths = chunk.map(c => c.localPath!);
        try {
          const results = await batchMLQuality(paths);
          for (let i = 0; i < chunk.length; i++) {
            const musiqScore = results[i]?.musiq_score ?? null;
            if (musiqScore != null) {
              totalScored++;
              chunk[i].blur!.musiqScore = musiqScore;
              // MUSIQ < 20 → upgrade suspect to blurry
              if (musiqScore < 20) {
                chunk[i].blur!.blurStatus = 'blurry';
                upgraded++;
              }
              console.log(`[blur] ${chunk[i].mediaId} musiq=${musiqScore.toFixed(1)} → ${chunk[i].blur!.blurStatus}`);
            }
          }
          console.log(`[blur] MUSIQ chunk ${start}-${start + chunk.length}: ${chunk.length} processed`);
        } catch (err) {
          console.warn(`[blur] MUSIQ chunk ${start}-${start + chunk.length} failed: ${err}`);
        }
      }
      console.log(`[blur] MUSIQ: ${totalScored} scored, ${upgraded} upgraded to blurry`);
    } else {
      console.log(`[blur] MUSIQ unavailable, keeping Laplacian results`);
    }
  }

  const blurryFinal = contexts.filter(c => c.blur?.blurStatus === 'blurry').length;
  const suspectFinal = contexts.filter(c => c.blur?.blurStatus === 'suspect').length;
  const clearFinal = contexts.filter(c => c.blur?.blurStatus === 'clear').length;
  console.log(`[blur] final: ${blurryFinal} blurry, ${suspectFinal} suspect, ${clearFinal} clear`);
}

// ---------------------------------------------------------------------------
// runDedupStage
// ---------------------------------------------------------------------------

async function runDedupStage(
  contexts: ImageProcessContext[],
  tempCache: TempPathCache,
): Promise<DedupAssessment | null> {
  // Filter out blurry images — they're already trashed, no need to dedup them
  const nonBlurryContexts = contexts.filter(
    ctx => ctx.blur?.blurStatus !== 'blurry'
  );

  console.log(`[dedup] ${contexts.length} total, ${contexts.length - nonBlurryContexts.length} blurry excluded, ${nonBlurryContexts.length} entering dedup`);

  if (nonBlurryContexts.length < 2) {
    return {
      confirmedPairs: [],
      groups: [],
      kept: nonBlurryContexts.map(c => c.mediaId),
      removed: [],
      skippedIndices: [],
      skippedReasons: {},
      capabilitiesUsed: { hash: false, clip: false, dinov2: false, llm: false },
      evidenceByPair: [],
    };
  }

  // Build ImageRow-compatible objects from non-blurry contexts
  const rows: ImageRow[] = nonBlurryContexts.map(ctx => ({
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

  // Enrich rows with DB data for quality selection (resolution, file_size)
  const db = getDb();
  for (let i = 0; i < nonBlurryContexts.length; i++) {
    const dbRow = db.prepare(
      'SELECT width, height, file_size, original_filename, created_at FROM media_items WHERE id = ?'
    ).get(nonBlurryContexts[i].mediaId) as { width: number | null; height: number | null; file_size: number; original_filename: string; created_at: string } | undefined;
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
      const blurCount = contexts.filter(c => c.blur !== null).length;
      const blurryCount = contexts.filter(c => c.blur?.blurStatus === 'blurry').length;
      console.log(`[pipeline] blur: ${blurCount} assessed, ${blurryCount} blurry, ${Date.now() - t0}ms`);
      onProgress('blur', 'complete', `${blurCount} blur-assessed`);
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
      console.log(`[pipeline] write: ${writeResult.updatedCount} updated, ${Date.now() - t0}ms`);
      onProgress('write', 'complete', `${writeResult.updatedCount} updated`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'write', error: msg });
      console.error(`[pipeline] write FAILED: ${msg} (${Date.now() - t0}ms)`);
      onProgress('write', 'complete', `failed: ${msg}`);
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

    const unprocessedVideos = videoRows.filter(v => !v.compiled_path && !v.thumbnail_path);
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
    const analysisResults = new Map<string, Awaited<ReturnType<typeof analyzeVideo>>>();
    for (const videoRow of unprocessedVideos) {
      try {
        const videoPath = await storageProvider.downloadToTemp(videoRow.file_path);
        const analysis = await analyzeVideo(videoPath, videoRow.id);
        analysisResults.set(videoRow.id, analysis);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errorText = `[videoAnalysis] ${errorMsg}`;
        updateErrorStmt.run(errorText, errorText, videoRow.id);
        failedCount++;
      }
    }
    onProgress('videoAnalysis', 'complete', `${analysisResults.size} analyzed`);

    onProgress('videoEdit', 'start');
    for (const videoRow of unprocessedVideos) {
      const analysis = analysisResults.get(videoRow.id);
      if (!analysis) continue;

      try {
        const videoPath = await storageProvider.downloadToTemp(videoRow.file_path);
        const editResult = await editVideo(videoPath, analysis, tripId, videoRow.id, {
          videoResolution: options?.videoResolution,
        });
        if (editResult.compiledPath) {
          updateCompiledStmt.run(editResult.compiledPath, videoRow.id);
          compiledCount++;
        } else if (editResult.error) {
          const errorText = `[videoEdit] ${editResult.error}`;
          updateErrorStmt.run(errorText, errorText, videoRow.id);
          failedCount++;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errorText = `[videoEdit] ${errorMsg}`;
        updateErrorStmt.run(errorText, errorText, videoRow.id);
        failedCount++;
      }
    }
    onProgress('videoEdit', 'complete', `${compiledCount} compiled`);

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
