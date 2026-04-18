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
import { assessBlur } from '../blurDetector';
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
  for (const ctx of contexts) {
    if (!ctx.downloadOk || !ctx.localPath) continue;

    try {
      // Try Python result first (from shared analyzeImages call)
      const pyResult = pythonResults.get(ctx.mediaId);
      if (
        pyResult &&
        !pyResult.blurError &&
        pyResult.blurScore != null &&
        pyResult.blurStatus &&
        pyResult.blurStatus !== 'unknown'
      ) {
        ctx.blur = {
          sharpnessScore: pyResult.blurScore,
          blurStatus: pyResult.blurStatus as 'clear' | 'suspect' | 'blurry',
          source: 'python',
        };
        continue;
      }

      // Python blur failed or unavailable — try Node.js Laplacian
      const blurError = pyResult?.blurError;
      if (blurError) {
        ctx.processingErrors.push(`[python-blur] ${blurError}`);
      }

      ctx.blur = await assessBlur(ctx.localPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.processingErrors.push(`[blur] ${msg}`);
      ctx.blur = {
        blurStatus: 'suspect',
        sharpnessScore: null,
        source: 'node',
        error: msg,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// runDedupStage
// ---------------------------------------------------------------------------

async function runDedupStage(
  contexts: ImageProcessContext[],
  tempCache: TempPathCache,
): Promise<DedupAssessment | null> {
  // Build ImageRow-compatible objects from contexts
  const rows: ImageRow[] = contexts.map(ctx => ({
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
  for (let i = 0; i < contexts.length; i++) {
    const dbRow = db.prepare(
      'SELECT width, height, file_size, original_filename, created_at FROM media_items WHERE id = ?'
    ).get(contexts[i].mediaId) as { width: number | null; height: number | null; file_size: number; original_filename: string; created_at: string } | undefined;
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
    // ---- Stage: collectInputs ----
    onProgress('collectInputs', 'start');
    try {
      contexts = await collectInputs(tripId, tempCache);
      onProgress('collectInputs', 'complete', `${contexts.length} images collected`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'collectInputs', error: msg });
      onProgress('collectInputs', 'complete', `failed: ${msg}`);
    }

    // ---- Stage: classify ----
    onProgress('classify', 'start');
    try {
      await runClassifyStage(contexts, pythonResults);
      const classifiedCount = contexts.filter(c => c.classification !== null).length;
      onProgress('classify', 'complete', `${classifiedCount} classified`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'classify', error: msg });
      onProgress('classify', 'complete', `failed: ${msg}`);
    }

    // ---- Stage: blur ----
    onProgress('blur', 'start');
    try {
      await runBlurStage(contexts, pythonResults);
      const blurCount = contexts.filter(c => c.blur !== null).length;
      onProgress('blur', 'complete', `${blurCount} blur-assessed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'blur', error: msg });
      onProgress('blur', 'complete', `failed: ${msg}`);
    }

    // ---- Stage: dedup ----
    onProgress('dedup', 'start');
    try {
      dedupAssessment = await runDedupStage(contexts, tempCache);
      const removedCount = dedupAssessment?.removed.length ?? 0;
      onProgress('dedup', 'complete', `${removedCount} duplicates found`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'dedup', error: msg });
      dedupAssessment = null;
      onProgress('dedup', 'complete', `failed: ${msg}`);
    }

    // ---- Stage: reduce ----
    let decisions: ReturnType<typeof reduce> = [];
    onProgress('reduce', 'start');
    try {
      decisions = reduce(contexts, dedupAssessment);
      onProgress('reduce', 'complete', `${decisions.length} decisions`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'reduce', error: msg });
      console.error(`[pipeline] reduce failed: ${msg}`);
      onProgress('reduce', 'complete', `failed: ${msg}`);
    }

    // ---- Stage: write ----
    onProgress('write', 'start');
    try {
      const writeResult = writeDecisions(tripId, decisions);
      if (writeResult.error) {
        stageErrors.push({ stage: 'write', error: writeResult.error });
      }
      onProgress('write', 'complete', `${writeResult.updatedCount} updated`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push({ stage: 'write', error: msg });
      console.error(`[pipeline] write failed: ${msg}`);
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
    try {
      await analyzeTrip(tripId);
    } catch (err) {
      console.warn(`[pipeline] analyzeTrip failed: ${err}`);
    }
    const analyzedCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active' AND avg_brightness IS NOT NULL"
    ).get(tripId) as { cnt: number }).cnt;
    onProgress('analyze', 'complete', `${analyzedCount} analyzed`);

    // optimize
    onProgress('optimize', 'start');
    let optimizedCount = 0;
    let failedCount = 0;
    try {
      const optimizeResults = await optimizeTrip(tripId);
      optimizedCount = optimizeResults.filter(r => r.optimizedPath !== null).length;
      failedCount += optimizeResults.filter(r => r.error).length;
    } catch (err) {
      console.warn(`[pipeline] optimizeTrip failed: ${err}`);
    }
    onProgress('optimize', 'complete', `${optimizedCount} optimized`);

    // thumbnail
    onProgress('thumbnail', 'start');
    try {
      await generateThumbnailsForTrip(tripId);
    } catch (err) {
      console.warn(`[pipeline] generateThumbnailsForTrip failed: ${err}`);
    }
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
    let coverImageId: string | null = null;
    try {
      coverImageId = await selectCoverImage(tripId);
    } catch (err) {
      console.warn(`[pipeline] selectCoverImage failed: ${err}`);
    }
    onProgress('cover', 'complete');

    // Count total images (including trashed)
    const totalImages = (db.prepare(
      "SELECT COUNT(*) as cnt FROM media_items WHERE trip_id = ? AND media_type = 'image'"
    ).get(tripId) as { cnt: number }).cnt;

    const skippedCount = dedupAssessment?.skippedIndices.length ?? 0;

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
