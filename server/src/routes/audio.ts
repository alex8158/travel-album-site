import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authMiddleware, requireAuth } from '../middleware/auth';
import {
  saveAudioTrack,
  downloadAudioFromUrl,
  listUserTracks,
  getTrackById,
  deleteAudioTrack,
  generateWaveformData,
} from '../services/audioService';
import { mixAudioToVideo } from '../services/audioMixer';
import { getVideoDuration } from '../services/videoAnalyzer';
import { getStorageProvider } from '../storage/factory';
import { getDb } from '../database';
import { getTempDir } from '../helpers/tempDir';
import type { MediaItemRow } from '../helpers/mediaItemRow';

const router = Router();

// Configure multer with memory storage and 50MB file size limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 52_428_800, // 50MB
  },
});

/** Map audio format extensions to MIME types for Content-Type header */
const FORMAT_TO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

// POST /api/audio/upload — Upload an audio file (requires auth)
router.post('/upload', authMiddleware, requireAuth, (req: Request, res: Response, next) => {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File size exceeds 50MB limit' });
      }
      return res.status(400).json({ error: err.message });
    }
    if (err) {
      return next(err);
    }
    next();
  });
}, async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const userId = req.user!.userId;
    const file = req.file;

    const track = await saveAudioTrack(userId, file.buffer, file.originalname);
    return res.status(201).json({ track });
  } catch (err: any) {
    const message = err?.message || 'Upload failed';

    // Map known validation errors to appropriate status codes
    if (message.includes('File size exceeds 50MB limit')) {
      return res.status(413).json({ error: message });
    }
    if (
      message.includes('Invalid audio format') ||
      message.includes('File is not a valid audio file') ||
      message.includes('File is empty') ||
      message.includes('Invalid audio file')
    ) {
      return res.status(400).json({ error: message });
    }

    console.error('[Audio Upload] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/audio/download — Download audio from a URL (requires auth)
router.post('/download', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    const track = await downloadAudioFromUrl(userId, url);
    return res.status(201).json({ track });
  } catch (err: any) {
    const message = err?.message || 'Download failed';

    if (message.includes('File size exceeds 50MB limit')) {
      return res.status(413).json({ error: message });
    }
    if (
      message.includes('Download failed') ||
      message.includes('not a supported audio format') ||
      message.includes('Invalid audio format')
    ) {
      return res.status(400).json({ error: message });
    }

    console.error('[Audio Download] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/audio — List current user's audio tracks (requires auth)
router.get('/', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const tracks = await listUserTracks(userId);
    return res.json({ tracks });
  } catch (err: any) {
    console.error('[Audio List] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/audio/:id/stream — Stream audio file for preview playback (requires auth)
router.get('/:id/stream', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const trackId = req.params.id as string;

    const track = await getTrackById(trackId);
    if (!track) {
      return res.status(404).json({ error: 'Audio track not found' });
    }

    // Verify ownership
    if (track.userId !== userId) {
      return res.status(404).json({ error: 'Audio track not found' });
    }

    // Read the file from storage and send it
    const storageProvider = getStorageProvider();
    const buffer = await storageProvider.read(track.filePath);

    const contentType = FORMAT_TO_MIME[track.format] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Accept-Ranges', 'bytes');
    return res.send(buffer);
  } catch (err: any) {
    console.error('[Audio Stream] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/audio/:id — Delete an audio track (requires auth)
router.delete('/:id', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const trackId = req.params.id as string;

    await deleteAudioTrack(trackId, userId);
    return res.status(204).send();
  } catch (err: any) {
    const message = err?.message || 'Delete failed';

    if (message.includes('Audio track not found')) {
      return res.status(404).json({ error: 'Audio track not found' });
    }

    console.error('[Audio Delete] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/audio/:id/waveform — Generate/return waveform data (requires auth)
router.post('/:id/waveform', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  try {
    const trackId = req.params.id as string;

    const waveform = await generateWaveformData(trackId);
    return res.json({ waveform });
  } catch (err: any) {
    const message = err?.message || 'Waveform generation failed';

    if (message.includes('Audio track not found')) {
      return res.status(404).json({ error: 'Audio track not found' });
    }

    console.error('[Audio Waveform] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

// ---------------------------------------------------------------------------
// Apply Audio to Video — mounted on /api (not /api/audio)
// ---------------------------------------------------------------------------

/**
 * POST /api/media/:id/apply-audio
 *
 * Downloads audio and video to temp files, mixes them using audioMixer,
 * uploads the result, and updates the media_items record.
 *
 * Body: { audioTrackId: string, trimStart?: number, trimEnd?: number }
 * Response: { compiledPath: string }
 */
export const applyAudioRouter = Router();

applyAudioRouter.post('/media/:id/apply-audio', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  const mediaId = req.params.id;
  const userId = req.user!.userId;
  const { audioTrackId, trimStart, trimEnd } = req.body;

  if (!audioTrackId) {
    return res.status(400).json({ error: 'audioTrackId is required' });
  }

  const db = getDb();
  const storageProvider = getStorageProvider();
  const tempFiles: string[] = [];

  try {
    // 1. Get the media item and verify ownership
    const mediaRow = db.prepare(
      'SELECT id, trip_id, compiled_path, user_id, media_type FROM media_items WHERE id = ?'
    ).get(mediaId) as Pick<MediaItemRow, 'id' | 'trip_id' | 'compiled_path' | 'user_id' | 'media_type'> | undefined;

    if (!mediaRow) {
      return res.status(404).json({ error: 'Media item not found' });
    }

    if (mediaRow.user_id !== userId) {
      return res.status(403).json({ error: '无权操作此资源' });
    }

    if (!mediaRow.compiled_path) {
      return res.status(400).json({ error: 'Media item has no compiled video' });
    }

    // 2. Get the audio track
    const audioTrack = await getTrackById(audioTrackId);
    if (!audioTrack) {
      return res.status(404).json({ error: 'Audio track not found' });
    }

    // 3. Download audio file to temp
    const audioLocalPath = await storageProvider.downloadToTemp(audioTrack.filePath);
    tempFiles.push(audioLocalPath);

    // 4. Download compiled video to temp
    const videoLocalPath = await storageProvider.downloadToTemp(mediaRow.compiled_path);
    tempFiles.push(videoLocalPath);

    // 5. Get video duration using ffprobe
    const videoDuration = await getVideoDuration(videoLocalPath);

    // 6. Prepare output path
    const tempDir = getTempDir();
    const outputTempPath = path.join(tempDir, `mixed-${mediaId}-${Date.now()}.mp4`);
    tempFiles.push(outputTempPath);

    // 7. Call mixAudioToVideo
    await mixAudioToVideo({
      audioTrackPath: audioLocalPath,
      videoPath: videoLocalPath,
      outputPath: outputTempPath,
      videoDuration,
      trimStart: trimStart != null ? Number(trimStart) : undefined,
      trimEnd: trimEnd != null ? Number(trimEnd) : undefined,
    });

    // 8. Upload the mixed output to StorageProvider
    const mixedRelativePath = `${mediaRow.trip_id}/compiled/${mediaId}_with_audio.mp4`;
    const mixedBuffer = fs.readFileSync(outputTempPath);
    await storageProvider.save(mixedRelativePath, mixedBuffer);

    // 9. Update media_items record
    db.prepare(
      'UPDATE media_items SET audio_track_id = ?, audio_trim_start = ?, audio_trim_end = ?, compiled_path = ? WHERE id = ?'
    ).run(
      audioTrackId,
      trimStart != null ? Number(trimStart) : null,
      trimEnd != null ? Number(trimEnd) : null,
      mixedRelativePath,
      mediaId
    );

    // 10. Return compiledPath
    return res.json({ compiledPath: mixedRelativePath });
  } catch (err: any) {
    console.error('[ApplyAudio] Error:', err);
    return res.status(500).json({ error: 'Audio mixing failed' });
  } finally {
    // 11. Clean up temp files
    for (const tempFile of tempFiles) {
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Remove Applied Audio
// ---------------------------------------------------------------------------

/**
 * DELETE /api/media/:id/applied-audio
 *
 * Removes background music from a media item by clearing the audio_track_id
 * and trim fields. Returns the compiled path.
 *
 * Response: { compiledPath: string }
 */
applyAudioRouter.delete('/media/:id/applied-audio', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  const mediaId = req.params.id;
  const userId = req.user!.userId;

  const db = getDb();

  try {
    // 1. Get the media item and verify ownership
    const mediaRow = db.prepare(
      'SELECT id, trip_id, compiled_path, user_id FROM media_items WHERE id = ?'
    ).get(mediaId) as Pick<MediaItemRow, 'id' | 'trip_id' | 'compiled_path' | 'user_id'> | undefined;

    if (!mediaRow) {
      return res.status(404).json({ error: 'Media item not found' });
    }

    if (mediaRow.user_id !== userId) {
      return res.status(403).json({ error: '无权操作此资源' });
    }

    // 2. Clear audio_track_id, audio_trim_start, audio_trim_end
    db.prepare(
      'UPDATE media_items SET audio_track_id = NULL, audio_trim_start = NULL, audio_trim_end = NULL WHERE id = ?'
    ).run(mediaId);

    // 3. Return the compiled path
    return res.json({ compiledPath: mediaRow.compiled_path || '' });
  } catch (err: any) {
    console.error('[RemoveAudio] Error:', err);
    return res.status(500).json({ error: 'Failed to remove applied audio' });
  }
});
