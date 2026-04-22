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
    await runFfmpeg(localPath, thumbLocal, ['-ss', String(thumbTime), '-frames:v', '1', '-q:v', '2']);
    const thumbnailKey = `${tripId}/thumbnails/${mediaId}.jpg`;
    await storage.save(thumbnailKey, await fs.promises.readFile(thumbLocal));

    // 4. Generate Preview Proxy (max 1080p, CRF 23)
    const previewLocal = path.join(tmpDir, `${mediaId}_preview.mp4`);
    tmpFiles.push(previewLocal);
    await runFfmpeg(localPath, previewLocal, [
      '-vf', "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease",
      '-c:v', 'libx264', '-crf', '23', '-preset', 'medium',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
    ]);
    const previewKey = `${tripId}/proxies/${mediaId}_preview.mp4`;
    await storage.save(previewKey, fs.createReadStream(previewLocal));

    // 5. Generate Edit Proxy (720p CBR 4Mbps, keyint=30)
    const editLocal = path.join(tmpDir, `${mediaId}_edit.mp4`);
    tmpFiles.push(editLocal);
    await runFfmpeg(localPath, editLocal, [
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease',
      '-c:v', 'libx264', '-b:v', '4M', '-maxrate', '4M', '-bufsize', '8M',
      '-g', '30', '-preset', 'medium',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
    ]);
    const editKey = `${tripId}/proxies/${mediaId}_edit.mp4`;
    await storage.save(editKey, fs.createReadStream(editLocal));

    // 6. Update media_items to ready
    db.prepare(
      `UPDATE media_items SET processing_status = 'ready', thumbnail_path = ?, preview_proxy_path = ?, edit_proxy_path = ?,
       video_duration = COALESCE(video_duration, ?), video_width = COALESCE(video_width, ?), video_height = COALESCE(video_height, ?),
       video_codec = COALESCE(video_codec, ?), video_bitrate = COALESCE(video_bitrate, ?) WHERE id = ?`
    ).run(thumbnailKey, previewKey, editKey, meta.duration, meta.width, meta.height, meta.codec, meta.bitrate, mediaId);

    // 7. Auto-trigger video analysis + editing (fire-and-forget, non-blocking)
    processVideoAfterProxy(localPath, mediaId, tripId).catch(err => {
      console.error(`[proxyGenerator] Auto video processing failed for ${mediaId}:`, err);
    });
  } catch (err: any) {
    // 7. On failure: mark proxy_failed
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

    // Analyze video (scene detection, quality scoring, segment creation)
    const analysis = await analyzeVideo(videoPath, mediaId);

    // Persist segments to DB for ClipEditor
    saveSegments(mediaId, analysis.segments);

    // Edit video (smart selection, compilation)
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
