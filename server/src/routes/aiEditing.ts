/**
 * AI Editing API Routes
 *
 * Provides endpoints for AI content analysis, edit plan generation,
 * text generation, usage statistics, and budget management.
 *
 * Requirements: 8.1-8.10, 6.2, 6.6, 6.7
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../database';
import { getAIProviderRegistry } from '../services/ai';
import { ContentAnalyzer } from '../services/ai/contentAnalyzer';
import { EditPlanner } from '../services/ai/editPlanner';
import { TextGenerator } from '../services/ai/textGenerator';
import { CostTracker } from '../services/ai/costTracker';
import { BudgetController } from '../services/ai/budgetController';
import type { TextStyle, TextType } from '../services/ai/types';

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Shared instances (lazy init)
// ---------------------------------------------------------------------------

let costTracker: CostTracker | null = null;
let budgetController: BudgetController | null = null;

function getCostTracker(): CostTracker {
  if (!costTracker) costTracker = new CostTracker();
  return costTracker;
}

function getBudgetController(): BudgetController {
  if (!budgetController) budgetController = new BudgetController(getCostTracker());
  return budgetController;
}

function isAIConfigured(): boolean {
  try {
    const registry = getAIProviderRegistry();
    return registry.listProviders().length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Middleware: check AI availability
// ---------------------------------------------------------------------------

function requireAI(req: Request, res: Response, next: Function): void {
  if (!isAIConfigured()) {
    res.status(503).json({ error: 'AI service not configured. Please set AI provider credentials.' });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Helper: validate media exists and belongs to user
// ---------------------------------------------------------------------------

function getMediaOrFail(mediaId: string, res: Response): any | null {
  const db = getDb();
  const media = db.prepare(`SELECT id, trip_id FROM media_items WHERE id = ?`).get(mediaId);
  if (!media) {
    res.status(404).json({ error: 'Media not found' });
    return null;
  }
  return media;
}

// ---------------------------------------------------------------------------
// POST /api/media/:id/ai-analyze — Trigger AI content analysis
// ---------------------------------------------------------------------------

router.post('/api/media/:id/ai-analyze', requireAI, async (req: Request, res: Response) => {
  try {
    const media = getMediaOrFail(req.params.id as string, res);
    if (!media) return;

    const userId = (req as any).user?.id;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const registry = getAIProviderRegistry();
    const provider = registry.getDefault();
    const analyzer = new ContentAnalyzer(provider, getCostTracker(), getBudgetController());

    const result = await analyzer.analyzeContent(
      media.id,
      userId,
      media.trip_id,
      { forceReanalyze: req.body?.forceReanalyze ?? false },
    );

    res.json({
      mediaId: result.mediaId,
      segmentCount: result.segments.length,
      tokensUsed: result.totalTokensUsed,
      estimatedCost: result.estimatedCost,
    });
  } catch (err: any) {
    if (err.message?.startsWith('BUDGET_EXCEEDED')) {
      res.status(402).json({ error: err.message });
      return;
    }
    console.error('[aiEditing] analyze error:', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/media/:id/ai-analysis — Get AI analysis results
// ---------------------------------------------------------------------------

router.get('/api/media/:id/ai-analysis', async (req: Request, res: Response) => {
  try {
    const media = getMediaOrFail(req.params.id as string, res);
    if (!media) return;

    const db = getDb();
    const rows = db.prepare(`
      SELECT segment_index, scene_description, emotion_tags, narrative_score, provider, model, analyzed_at
      FROM segment_ai_analysis WHERE media_id = ? ORDER BY segment_index
    `).all(media.id) as any[];

    res.json({
      mediaId: media.id,
      segments: rows.map(r => ({
        segmentIndex: r.segment_index,
        sceneDescription: r.scene_description,
        emotionTags: JSON.parse(r.emotion_tags || '[]'),
        narrativeScore: r.narrative_score,
        provider: r.provider,
        model: r.model,
        analyzedAt: r.analyzed_at,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/media/:id/ai-edit-plan — Generate edit plan
// ---------------------------------------------------------------------------

router.post('/api/media/:id/ai-edit-plan', requireAI, async (req: Request, res: Response) => {
  try {
    const media = getMediaOrFail(req.params.id as string, res);
    if (!media) return;

    const userId = (req as any).user?.id;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const registry = getAIProviderRegistry();
    const provider = registry.getDefault();
    const planner = new EditPlanner(provider, getCostTracker(), getBudgetController());

    const result = await planner.generateEditPlan(
      media.id,
      userId,
      media.trip_id,
      req.body?.targetDuration,
    );

    res.json({
      editPlan: result.editPlan,
      tokensUsed: result.tokensUsed,
      estimatedCost: result.estimatedCost,
      fallbackUsed: result.fallbackUsed,
    });
  } catch (err: any) {
    if (err.message?.startsWith('BUDGET_EXCEEDED')) {
      res.status(402).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/media/:id/ai-edit-plan — Get latest edit plan
// ---------------------------------------------------------------------------

router.get('/api/media/:id/ai-edit-plan', async (req: Request, res: Response) => {
  try {
    const media = getMediaOrFail(req.params.id as string, res);
    if (!media) return;

    const db = getDb();
    const row = db.prepare(
      `SELECT plan_json, pace, total_duration, segment_count, fallback_used, created_at
       FROM ai_edit_plans WHERE media_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(media.id) as any;

    if (!row) {
      res.json({ editPlan: null });
      return;
    }

    res.json({
      editPlan: JSON.parse(row.plan_json),
      pace: row.pace,
      totalDuration: row.total_duration,
      segmentCount: row.segment_count,
      fallbackUsed: !!row.fallback_used,
      createdAt: row.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/media/:id/ai-text — Generate text (title/subtitle/narration)
// ---------------------------------------------------------------------------

router.post('/api/media/:id/ai-text', requireAI, async (req: Request, res: Response) => {
  try {
    const media = getMediaOrFail(req.params.id as string, res);
    if (!media) return;

    const userId = (req as any).user?.id;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const { type, style } = req.body || {};
    if (!type || !['title', 'subtitle', 'narration'].includes(type)) {
      res.status(400).json({ error: 'Invalid type. Must be title, subtitle, or narration.' });
      return;
    }

    const registry = getAIProviderRegistry();
    const provider = registry.getDefault();
    const generator = new TextGenerator(provider, getCostTracker(), getBudgetController());

    const result = await generator.generateText({
      mediaId: media.id,
      userId,
      tripId: media.trip_id,
      type: type as TextType,
      style: style as TextStyle | undefined,
    });

    res.json(result);
  } catch (err: any) {
    if (err.message?.startsWith('BUDGET_EXCEEDED')) {
      res.status(402).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/media/:id/ai-text — Get generated texts
// ---------------------------------------------------------------------------

router.get('/api/media/:id/ai-text', async (req: Request, res: Response) => {
  try {
    const media = getMediaOrFail(req.params.id as string, res);
    if (!media) return;

    const db = getDb();
    const rows = db.prepare(`
      SELECT text_type, style, content_json, created_at
      FROM ai_generated_texts WHERE media_id = ? ORDER BY created_at DESC
    `).all(media.id) as any[];

    res.json({
      mediaId: media.id,
      texts: rows.map(r => ({
        type: r.text_type,
        style: r.style,
        content: JSON.parse(r.content_json),
        createdAt: r.created_at,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai/usage — Current user's AI usage statistics
// ---------------------------------------------------------------------------

router.get('/api/ai/usage', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const stats = getCostTracker().getUserStats(userId);
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai/budget — Current user's budget status
// ---------------------------------------------------------------------------

router.get('/api/ai/budget', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const result = getBudgetController().checkBudget(userId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// ---------------------------------------------------------------------------
// Admin endpoints
// ---------------------------------------------------------------------------

// GET /api/admin/ai/usage — All users' AI usage (admin only)
router.get('/api/admin/ai/usage', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || user.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const allStatus = getBudgetController().getAllUsersBudgetStatus();
    res.json({ users: allStatus });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// PUT /api/admin/ai/budget/:userId — Set user budget (admin only)
router.put('/api/admin/ai/budget/:userId', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || user.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const { monthlyLimit } = req.body || {};
    if (typeof monthlyLimit !== 'number' || monthlyLimit <= 0) {
      res.status(400).json({ error: 'monthlyLimit must be a positive number' });
      return;
    }

    getBudgetController().setUserBudget(req.params.userId as string, monthlyLimit);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// POST /api/admin/ai/budget/:userId/reset — Reset user budget (admin only)
router.post('/api/admin/ai/budget/:userId/reset', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || user.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    getBudgetController().resetUserBudget(req.params.userId as string);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

export default router;
