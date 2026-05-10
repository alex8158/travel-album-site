import { Router, Request, Response } from 'express';
import { AIEnhancementService } from '../services/aiEnhancementService';

const router = Router();
const tripEnhanceRouter = Router();
const enhancementService = new AIEnhancementService();

function getErrorMessage(code: string): string {
  switch (code) {
    case 'MEDIA_NOT_FOUND':
      return 'Media item does not exist';
    case 'INVALID_MEDIA_TYPE':
      return 'Media item is not an image';
    default:
      return 'Unknown error';
  }
}

// POST /api/media/:mediaId/enhance — Trigger AI enhancement for a single media item
router.post('/:mediaId/enhance', async (req: Request, res: Response) => {
  try {
    const mediaId = req.params.mediaId as string;
    const result = await enhancementService.enhanceMedia(mediaId);
    return res.status(200).json({ version: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message === 'MEDIA_NOT_FOUND' || message === 'INVALID_MEDIA_TYPE') {
      return res.status(400).json({
        error: { code: message, message: getErrorMessage(message) },
      });
    }

    if (message === 'ENHANCEMENT_IN_PROGRESS') {
      return res.status(409).json({
        error: { code: message, message: 'Enhancement is already in progress for this media item' },
      });
    }

    return res.status(500).json({
      error: { code: 'AI_PROVIDER_ERROR', message: 'Enhancement failed', details: message },
    });
  }
});

// POST /api/trips/:tripId/enhance — Batch enhance eligible media items in a trip
tripEnhanceRouter.post('/:tripId/enhance', async (req: Request, res: Response) => {
  try {
    const tripId = req.params.tripId as string;
    const { maxQualityScore, maxColorScore } = req.body || {};

    const filters = {
      ...(maxQualityScore !== undefined && { maxQualityScore }),
      ...(maxColorScore !== undefined && { maxColorScore }),
    };

    const summary = await enhancementService.enhanceBatch(tripId, Object.keys(filters).length > 0 ? filters : undefined);

    if (summary.totalProcessed === 0) {
      return res.status(200).json({ summary, message: 'No items need enhancement' });
    }

    return res.status(200).json({ summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({
      error: { code: 'BATCH_ENHANCEMENT_ERROR', message: 'Batch enhancement failed', details: message },
    });
  }
});

export default router;
export { tripEnhanceRouter };
