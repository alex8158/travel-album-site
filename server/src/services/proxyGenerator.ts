import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';
import { analyzeVideo } from './videoAnalyzer';
import { editVideo } from './videoEditor';
import { generateVideoThumbnail } from './thumbnailGenerator';
import { saveSegments } from '../helpers/videoSegmentStore';

interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  codec: string;
  bitrate: number;
}

function probeMetadata(videoPath: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, data) => {
      if (err) return reject(err);
      const videoStream = data.streams.find(s => s.codec_type === 'video');
      resolve({
        duration: data.format.duration || 0,
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        codec: videoStream?.codec_name || 'unknown',
        bitrate: data.format.bit_rate ? Math.round(Number(data.format.bit_rate)) : 0,
      });
    });
  });
}

function runFfmpeg(inputPath: string, outputPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath);
    cmd.outputOptions(args).output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
}

export async function generateProxies(mediaId: string, tripId: string, storageKey: string): Promise<void> {
  const db = getDb();
  const storage = getStorageProvider();
  let localPath: string | undefined;
  const tmpFiles: string[] = [];

  try {
    // 1. Download original to local temp
    console.log(`[proxyGenerator] Starting for ${mediaId}, storageKey=${storageKey}`);
    localPath = await storage.downloadToTemp(storageKey);
    console.log(`[proxyGenerator] Downloaded to ${localPath}`);

    // 2. Extract metadata via ffprobe
    let meta: VideoMetadata;
    try {
      meta = await probeMetadata(localPath);
      db.prepare(
        `UPDATE media_items SET video_duration = ?, video_width = ?, video_height = ?, video_codec = ?, video_bitrate = ? WHERE id = ?`
      ).run(meta.duration, meta.width, meta.height, meta.codec, meta.bitrate, mediaId);
    } catch (probeErr) {
      console.error(`[proxyGenerator] ffprobe failed for ${mediaId}:`, probeErr);
      meta = { duration: 10, width: 1920, height: 1080, codec: 'unknown', bitrate: 0 };
    }

    const tmpDir = os.tmpdir();

    // 3. Extract thumbnail at 10% of duration
    const thumbTime = Math.max(0, meta.duration * 0.1);
    const thumbLocal = path.join(tmpDir, `${mediaId}_thumb.jpg`);
    tmpFiles.push(thumbLocal);
    try {
      await runFfmpeg(localPath, thumbLocal, ['-ss', String(thumbTime), '-frames:v', '1', '-q:v', '2']);
      const thumbnailKey = `${tripId}/thumbnails/${mediaId}.jpg`;
      await storage.save(thumbnailKey, await fs.promises.readFile(thumbLocal));
      db.prepare('UPDATE media_items SET thumbnail_path = ? WHERE id = ?').run(thumbnailKey, mediaId);
      console.log(`[proxyGenerator] Thumbnail generated for ${mediaId}`);
    } catch (thumbErr) {
      console.warn(`[proxyGenerator] Thumbnail failed for ${mediaId}:`, thumbErr);
    }

    // 4. Generate Preview Proxy (max 720p, CRF 28 — lighter than before to avoid OOM)
    const previewLocal = path.join(tmpDir, `${mediaId}_preview.mp4`);
    tmpFiles.push(previewLocal);
    try {
      await runFfmpeg(localPath, previewLocal, [
        '-vf', "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease",
        '-c:v', 'libx264', '-crf', '28', '-preset', 'fast',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart',
        '-threads', '1',
      ]);
      const previewKey = `${tripId}/proxies/${mediaId}_preview.mp4`;
      await storage.save(previewKey, fs.createReadStream(previewLocal));
      console.log(`[proxyGenerator] Preview proxy generated for ${mediaId}`);

      // Update DB with preview proxy and mark as ready
      db.prepare(
        `UPDATE media_items SET processing_status = 'ready', preview_proxy_path = ?,
         video_duration = COALESCE(video_duration, ?), video_width = COALESCE(video_width, ?), video_height = COALESCE(video_height, ?),
         video_codec = COALESCE(video_codec, ?), video_bitrate = COALESCE(video_bitrate, ?) WHERE id = ?`
      ).run(previewKey, meta.duration, meta.width, meta.height, meta.codec, meta.bitrate, mediaId);
    } catch (previewErr) {
      console.error(`[proxyGenerator] Preview proxy failed for ${mediaId}:`, previewErr);
      // Still mark as ready so user can see original
      db.prepare(
        `UPDATE media_items SET processing_status = 'ready',
         video_duration = COALESCE(video_duration, ?), video_width = COALESCE(video_width, ?), video_height = COALESCE(video_height, ?),
         video_codec = COALESCE(video_codec, ?), video_bitrate = COALESCE(video_bitrate, ?) WHERE id = ?`
      ).run(meta.duration, meta.width, meta.height, meta.codec, meta.bitrate, mediaId);
    }

    console.log(`[proxyGenerator] Proxy generation complete for ${mediaId}, skipping heavy video analysis for stability`);

    // Skip analyzeVideo + editVideo entirely for now.
    // The preview proxy serves as the viewable version.
    // Users can trigger manual compilation later via the UI if needed.

  } catch (err: any) {
    console.error(`[proxyGenerator] Failed for ${mediaId}:`, err);
    db.prepare(
      `UPDATE media_items SET processing_status = 'proxy_failed', processing_error = ? WHERE id = ?`
    ).run(String(err?.message || err), mediaId);
  } finally {
    // Cleanup temp files
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

/**
 * After proxy generation succeeds, automatically run video analysis + editing.
 * This produces segments (for ClipEditor) and a compiled video (smart edit).
 * Runs in the background — failures are logged but don't affect proxy status.
 */
async function processVideoAfterProxy(videoPath: string, mediaId: string, tripId: string): Promise<void> {
  const db = getDb();

  try {
    console.log(`[proxyGenerator] Starting auto video processing for ${mediaId}`);
    const startTime = Date.now();

    // Analyze video (scene detection, quality scoring, segment creation)
    console.log(`[proxyGenerator] Starting video analysis for ${mediaId}...`);
    const analysis = await analyzeVideo(videoPath, mediaId);
    console.log(`[proxyGenerator] Video analysis completed for ${mediaId}: ${analysis.segments.length} segments in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    // Persist segments to DB for ClipEditor
    saveSegments(mediaId, analysis.segments);

    // Edit video (smart selection, compilation with audio-only smoothing)
    const editResult = await editVideo(videoPath, analysis, tripId, mediaId);

    if (editResult.compiledPath) {
      db.prepare('UPDATE media_items SET compiled_path = ? WHERE id = ?').run(editResult.compiledPath, mediaId);
      console.log(`[proxyGenerator] Auto video processing completed for ${mediaId}: compiled=${editResult.compiledPath}`);
    } else if (editResult.error) {
      console.warn(`[proxyGenerator] Auto video editing returned error for ${mediaId}: ${editResult.error}`);
      db.prepare(
        `UPDATE media_items SET processing_error = CASE
           WHEN processing_error IS NULL THEN ?
           ELSE processing_error || char(10) || ?
         END WHERE id = ?`
      ).run(`[autoEdit] ${editResult.error}`, `[autoEdit] ${editResult.error}`, mediaId);
    } else {
      console.log(`[proxyGenerator] Auto video processing for ${mediaId}: no compilation needed (short video, all segments good)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[proxyGenerator] Auto video processing error for ${mediaId}: ${msg}`);
    // Non-fatal: proxy generation already succeeded, just log the error
    db.prepare(
      `UPDATE media_items SET processing_error = CASE
         WHEN processing_error IS NULL THEN ?
         ELSE processing_error || char(10) || ?
       END WHERE id = ?`
    ).run(`[autoProcess] ${msg}`, `[autoProcess] ${msg}`, mediaId);
  }
}
