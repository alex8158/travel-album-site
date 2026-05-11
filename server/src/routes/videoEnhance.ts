import { Router, Request, Response } from 'express';
import { getDb } from '../database';
import { generateVersions, isGenerating, DEFAULT_PROFILES, VersionProfile } from '../services/multiVersionGenerator';
import { detectBlackFrames, BlackFrameResult } from '../services/blackFrameDetector';
import { detectJunkClip, JunkClipResult } from '../services/junkClipDetector';
import { VideoSegment } from '../services/videoAnalyzer';

const router = Router();
const tripVideoEnhanceRouter = Router();

/**
 * POST /api/media/:mediaId/versions
 *
 * Generate multiple versions of a video.
 * Body: { profiles?: string[], customProfiles?: VersionProfile[] }
 *
 * Responses:
 * - 200: { result: MultiVersionResult }
 * - 400: Invalid request (not a video, invalid profiles)
 * - 404: Media not found
 * - 409: Generation already in progress for this media
 */
router.post('/:mediaId/versions', async (req: Request, res: Response) => {
  try {
    const mediaId = req.params.mediaId as string;
    const db = getDb();

    // 1. Validate media exists
    const media = db.prepare('SELECT * FROM media_items WHERE id = ?').get(mediaId) as any;
    if (!media) {
      return res.status(404).json({ error: { code: 'MEDIA_NOT_FOUND', message: 'Media item not found' } });
    }

    // 2. Validate it's a video
    if (!media.mime_type?.startsWith('video/')) {
      return res.status(400).json({ error: { code: 'INVALID_MEDIA_TYPE', message: 'Media item is not a video' } });
    }

    // 3. Check concurrency lock
    if (isGenerating(mediaId)) {
      return res.status(409).json({ error: { code: 'GENERATION_IN_PROGRESS', message: 'Version generation already in progress for this media' } });
    }

    // 4. Parse profiles from body
    const { profiles: profileNames, customProfiles } = req.body || {};
    let profiles: VersionProfile[] = [];

    if (customProfiles && Array.isArray(customProfiles)) {
      profiles = customProfiles;
    } else if (profileNames && Array.isArray(profileNames)) {
      profiles = profileNames
        .filter((name: string) => DEFAULT_PROFILES[name])
        .map((name: string) => DEFAULT_PROFILES[name]);
    } else {
      // Default: generate all three profiles
      profiles = Object.values(DEFAULT_PROFILES);
    }

    if (profiles.length === 0) {
      return res.status(400).json({ error: { code: 'INVALID_PROFILES', message: 'No valid profiles specified' } });
    }

    // 5. Get video segments from analysis
    const segments = db.prepare(
      'SELECT * FROM video_segments WHERE media_id = ? ORDER BY start_time'
    ).all(mediaId) as any[];

    const videoSegments: VideoSegment[] = segments.map((s: any, idx: number) => ({
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

    // 6. Get the video file path
    const videoPath = media.file_path;

    // 7. Call generateVersions
    const result = await generateVersions(
      videoPath,
      mediaId,
      media.trip_id,
      videoSegments,
      profiles,
    );

    res.json({ result });
  } catch (err: any) {
    if (err.message?.includes('GENERATION_IN_PROGRESS')) {
      return res.status(409).json({ error: { code: 'GENERATION_IN_PROGRESS', message: err.message } });
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message || 'Unknown error' } });
  }
});

/**
 * POST /api/trips/:tripId/video-enhance
 *
 * Run the full video enhancement pipeline on all videos in a trip:
 * black frame detection → junk clip detection → multi-version generation.
 *
 * Responses:
 * - 200: { summary: { totalVideos, processed, versionsGenerated, errors } }
 * - 404: Trip not found
 */
tripVideoEnhanceRouter.post('/:tripId/video-enhance', async (req: Request, res: Response) => {
  try {
    const tripId = req.params.tripId as string;
    const db = getDb();

    // 1. Validate trip exists
    const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as any;
    if (!trip) {
      return res.status(404).json({ error: { code: 'TRIP_NOT_FOUND', message: 'Trip not found' } });
    }

    // 2. Query all video media_items in the trip
    const videoItems = db.prepare(
      "SELECT * FROM media_items WHERE trip_id = ? AND mime_type LIKE 'video/%'"
    ).all(tripId) as any[];

    const totalVideos = videoItems.length;
    let processed = 0;
    let versionsGenerated = 0;
    const errors: Array<{ mediaId: string; error: string }> = [];

    // 3. Process each video through the full pipeline
    for (const media of videoItems) {
      try {
        const mediaId = media.id;
        const videoPath = media.file_path;

        // 3a. Get video segments
        const segmentRows = db.prepare(
          'SELECT * FROM video_segments WHERE media_id = ? ORDER BY start_time'
        ).all(mediaId) as any[];

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

        // 3b. Run black frame detection on each segment
        const blackFrameResults = new Map<number, BlackFrameResult>();
        for (const segment of segments) {
          try {
            const result = await detectBlackFrames(videoPath, segment.startTime, segment.endTime);
            blackFrameResults.set(segment.index, result);
          } catch {
            // Skip failed detection, continue with remaining segments
          }
        }

        // 3c. Run junk clip detection on each segment
        const junkResults = new Map<number, JunkClipResult>();
        for (const segment of segments) {
          try {
            const result = await detectJunkClip(videoPath, segment.startTime, segment.endTime);
            junkResults.set(segment.index, result);
          } catch {
            // Skip failed detection, continue with remaining segments
          }
        }

        // 3d. Generate versions with detection results
        const profiles = Object.values(DEFAULT_PROFILES);
        const result = await generateVersions(
          videoPath,
          mediaId,
          tripId,
          segments,
          profiles,
          { blackFrameResults, junkResults },
        );

        // 3e. Collect results
        versionsGenerated += result.versions.length;
        processed++;

        if (result.errors.length > 0) {
          for (const err of result.errors) {
            errors.push({ mediaId, error: `${err.profile}: ${err.error}` });
          }
        }
      } catch (err: any) {
        // 4. If an individual video fails, continue processing remaining videos
        errors.push({ mediaId: media.id, error: err.message || 'Unknown error' });
      }
    }

    // 5. Return batch summary
    res.json({
      summary: {
        totalVideos,
        processed,
        versionsGenerated,
        errors,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message || 'Unknown error' } });
  }
});

export { tripVideoEnhanceRouter };
export default router;
