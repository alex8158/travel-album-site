/**
 * AI Editing API Routes
 *
 * Provides endpoints for AI content analysis, edit plan generation,
 * text generation, usage statistics, and budget management.
 *
 * Requirements: 8.1-8.10, 6.2, 6.6, 6.7, 10.5
 */

import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import { authMiddleware, requireAuth, requireAdmin } from '../middleware/auth';
import { getAIProviderRegistry } from '../services/ai';
import { ContentAnalyzer } from '../services/ai/contentAnalyzer';
import { EditPlanner } from '../services/ai/editPlanner';
import { TextGenerator } from '../services/ai/textGenerator';
import { CostTracker } from '../services/ai/costTracker';
import { BudgetController } from '../services/ai/budgetController';
import { executeDegradationChain } from '../services/ai/degradationStrategy';
import type { TextStyle, TextType } from '../services/ai/types';

const router = Router();

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

/**
 * Check if AI provider is configured and available.
 * Returns false if no providers are registered (e.g., missing API keys).
 * Requirement 10.5: AI Provider 配置缺失时返回 HTTP 503
 */
function isAIConfigured(): boolean {
  try {
    // Ensure registry is initialized (this also sets up the degradation strategy getter)
    const registry = getAIProviderRegistry();
    return registry.listProviders().length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Middleware: check AI availability (returns 503 if not configured)
// ---------------------------------------------------------------------------

function requireAI(_req: Request, res: Response, next: NextFunction): void {
  if (!isAIConfigured()) {
    res.status(503).json({
      error: {
        code: 'AI_NOT_CONFIGURED',
        message: 'AI service not configured. Please set AI provider credentials.',
      },
    });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Helper: validate media exists and belongs to user
// ---------------------------------------------------------------------------

function getMediaOrFail(mediaId: string, res: Response): { id: string; trip_id: string } | null {
  const db = getDb();
  const media = db.prepare(`SELECT id, trip_id FROM media_items WHERE id = ?`).get(mediaId) as
    | { id: string; trip_id: string }
    | undefined;
  if (!media) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Media not found' } });
    return null;
  }
  return media;
}

/**
 * Create a processing_job record and return the jobId.
 */
function createProcessingJob(tripId: string, mediaId: string, jobType: string): string {
  const db = getDb();
  const jobId = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO processing_jobs (id, trip_id, status, created_at)
     VALUES (?, ?, 'queued', ?)`
  ).run(jobId, tripId, now);

  return jobId;
}

// ===========================================================================
// User-facing AI endpoints (require authentication)
// ===========================================================================

// ---------------------------------------------------------------------------
// POST /api/media/:id/ai-analyze — Trigger AI content analysis
// Requirement 8.1: 触发 AI 内容分析流程并返回 jobId
// ---------------------------------------------------------------------------

router.post(
  '/api/media/:id/ai-analyze',
  authMiddleware,
  requireAuth,
  requireAI,
  async (req: Request, res: Response) => {
    try {
      const media = getMediaOrFail(req.params.id as string, res);
      if (!media) return;

      const userId = req.user!.userId;

      // Create processing job
      const jobId = createProcessingJob(media.trip_id, media.id, 'ai_analyze');

      // Run analysis asynchronously (fire-and-forget with job tracking)
      const registry = getAIProviderRegistry();
      const provider = registry.getDefault();
      const analyzer = new ContentAnalyzer(provider, getCostTracker(), getBudgetController());

      // Start async analysis
      analyzer
        .analyzeContent(media.id, userId, media.trip_id, {
          forceReanalyze: req.body?.forceReanalyze ?? false,
        })
        .then((result) => {
          const db = getDb();
          db.prepare(
            `UPDATE processing_jobs SET status = 'completed', result_json = ?, finished_at = ? WHERE id = ?`
          ).run(
            JSON.stringify({
              mediaId: result.mediaId,
              segmentCount: result.segments.length,
              tokensUsed: result.totalTokensUsed,
              estimatedCost: result.estimatedCost,
            }),
            new Date().toISOString(),
            jobId
          );
        })
        .catch((err) => {
          const db = getDb();
          db.prepare(
            `UPDATE processing_jobs SET status = 'failed', error_message = ?, finished_at = ? WHERE id = ?`
          ).run(err instanceof Error ? err.message : String(err), new Date().toISOString(), jobId);
        });

      res.json({ jobId });
    } catch (err: any) {
      if (err.message?.startsWith('BUDGET_EXCEEDED')) {
        res.status(402).json({ error: { code: 'BUDGET_EXCEEDED', message: err.message } });
        return;
      }
      console.error('[aiEditing] analyze error:', err);
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal error' } });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/media/:id/ai-analysis — Get AI analysis results
// Requirement 8.2: 返回该视频所有片段的 AI 分析结果
// ---------------------------------------------------------------------------

router.get(
  '/api/media/:id/ai-analysis',
  authMiddleware,
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const media = getMediaOrFail(req.params.id as string, res);
      if (!media) return;

      const db = getDb();
      const rows = db
        .prepare(
          `SELECT segment_index, scene_description, emotion_tags, narrative_score, provider, model, analyzed_at
         FROM segment_ai_analysis WHERE media_id = ? ORDER BY segment_index`
        )
        .all(media.id) as any[];

      res.json({
        mediaId: media.id,
        segments: rows.map((r) => ({
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
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal error' } });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/media/:id/ai-edit-plan — Generate edit plan (with degradation)
// Requirement 8.3: 触发剪辑方案生成并返回 jobId
// Requirements 10.1-10.5: 降级策略链
// ---------------------------------------------------------------------------

router.post(
  '/api/media/:id/ai-edit-plan',
  authMiddleware,
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const media = getMediaOrFail(req.params.id as string, res);
      if (!media) return;

      const userId = req.user!.userId;

      // If AI is not configured, use degradation chain (returns quality-score plan)
      if (!isAIConfigured()) {
        // Execute degradation chain which will fall back to quality scores
        const degradationResult = await executeDegradationChain({
          mediaId: media.id,
          userId,
          tripId: media.trip_id,
          targetDuration: req.body?.targetDuration,
        });

        if (degradationResult.level === 'error') {
          res.status(400).json({
            error: { code: 'NO_SEGMENTS', message: degradationResult.message },
          });
          return;
        }

        // Return the degraded result directly (no job needed for non-AI plans)
        res.json({
          jobId: null,
          degradationLevel: degradationResult.level,
          editPlan: degradationResult.editPlan,
          message: degradationResult.message,
        });
        return;
      }

      // Create processing job
      const jobId = createProcessingJob(media.trip_id, media.id, 'ai_edit_plan');

      const registry = getAIProviderRegistry();
      const provider = registry.getDefault();
      const planner = new EditPlanner(provider, getCostTracker(), getBudgetController());

      // Start async edit plan generation
      planner
        .generateEditPlan(media.id, userId, media.trip_id, req.body?.targetDuration)
        .then((result) => {
          const db = getDb();
          db.prepare(
            `UPDATE processing_jobs SET status = 'completed', result_json = ?, finished_at = ? WHERE id = ?`
          ).run(
            JSON.stringify({
              editPlan: result.editPlan,
              tokensUsed: result.tokensUsed,
              estimatedCost: result.estimatedCost,
              fallbackUsed: result.fallbackUsed,
            }),
            new Date().toISOString(),
            jobId
          );
        })
        .catch((err) => {
          const db = getDb();
          db.prepare(
            `UPDATE processing_jobs SET status = 'failed', error_message = ?, finished_at = ? WHERE id = ?`
          ).run(err instanceof Error ? err.message : String(err), new Date().toISOString(), jobId);
        });

      res.json({ jobId });
    } catch (err: any) {
      if (err.message?.startsWith('BUDGET_EXCEEDED')) {
        // Budget exceeded — try degradation chain for a fallback plan
        try {
          const media = getMediaOrFail(req.params.id as string, res);
          if (!media) return;
          const degradationResult = await executeDegradationChain({
            mediaId: media.id,
            userId: req.user!.userId,
            tripId: media.trip_id,
            targetDuration: req.body?.targetDuration,
          });
          res.status(402).json({
            error: { code: 'BUDGET_EXCEEDED', message: err.message },
            degradationLevel: degradationResult.level,
            editPlan: degradationResult.editPlan,
            degradationMessage: degradationResult.message,
          });
        } catch {
          res.status(402).json({ error: { code: 'BUDGET_EXCEEDED', message: err.message } });
        }
        return;
      }
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal error' } });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/media/:id/ai-edit-plan — Get latest edit plan
// Requirement 8.4: 返回最新的 EditPlan
// ---------------------------------------------------------------------------

router.get(
  '/api/media/:id/ai-edit-plan',
  authMiddleware,
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const media = getMediaOrFail(req.params.id as string, res);
      if (!media) return;

      const db = getDb();
      const row = db
        .prepare(
          `SELECT plan_json, pace, total_duration, segment_count, fallback_used, created_at
         FROM ai_edit_plans WHERE media_id = ? ORDER BY created_at DESC LIMIT 1`
        )
        .get(media.id) as any;

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
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal error' } });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/media/:id/ai-text — Generate text (title/subtitle/narration)
// Requirement 8.5: 触发文本生成并返回 jobId
// ---------------------------------------------------------------------------

router.post(
  '/api/media/:id/ai-text',
  authMiddleware,
  requireAuth,
  requireAI,
  async (req: Request, res: Response) => {
    try {
      const media = getMediaOrFail(req.params.id as string, res);
      if (!media) return;

      const userId = req.user!.userId;

      const { type, style } = req.body || {};
      if (!type || !['title', 'subtitle', 'narration'].includes(type)) {
        res.status(400).json({
          error: { code: 'INVALID_PARAMS', message: 'Invalid type. Must be title, subtitle, or narration.' },
        });
        return;
      }

      // Create processing job
      const jobId = createProcessingJob(media.trip_id, media.id, 'ai_text');

      const registry = getAIProviderRegistry();
      const provider = registry.getDefault();
      const generator = new TextGenerator(provider, getCostTracker(), getBudgetController());

      // Start async text generation
      generator
        .generateText({
          mediaId: media.id,
          userId,
          tripId: media.trip_id,
          type: type as TextType,
          style: style as TextStyle | undefined,
        })
        .then((result) => {
          const db = getDb();
          db.prepare(
            `UPDATE processing_jobs SET status = 'completed', result_json = ?, finished_at = ? WHERE id = ?`
          ).run(JSON.stringify(result), new Date().toISOString(), jobId);
        })
        .catch((err) => {
          const db = getDb();
          db.prepare(
            `UPDATE processing_jobs SET status = 'failed', error_message = ?, finished_at = ? WHERE id = ?`
          ).run(err instanceof Error ? err.message : String(err), new Date().toISOString(), jobId);
        });

      res.json({ jobId });
    } catch (err: any) {
      if (err.message?.startsWith('BUDGET_EXCEEDED')) {
        res.status(402).json({ error: { code: 'BUDGET_EXCEEDED', message: err.message } });
        return;
      }
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal error' } });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/media/:id/ai-text — Get generated texts
// Requirement 8.6: 返回已生成的文本内容
// ---------------------------------------------------------------------------

router.get(
  '/api/media/:id/ai-text',
  authMiddleware,
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const media = getMediaOrFail(req.params.id as string, res);
      if (!media) return;

      const db = getDb();
      const rows = db
        .prepare(
          `SELECT text_type, style, content_json, created_at
         FROM ai_generated_texts WHERE media_id = ? ORDER BY created_at DESC`
        )
        .all(media.id) as any[];

      res.json({
        mediaId: media.id,
        texts: rows.map((r) => ({
          type: r.text_type,
          style: r.style,
          content: JSON.parse(r.content_json),
          createdAt: r.created_at,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal error' } });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/ai/usage — Current user's AI usage statistics
// Requirement 8.7: 返回当前用户的 AI 使用统计
// ---------------------------------------------------------------------------

router.get('/api/ai/usage', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const stats = getCostTracker().getUserStats(userId);
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal error' } });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai/budget — Current user's budget status
// Requirement 8.8: 返回当前用户的预算使用情况
// ---------------------------------------------------------------------------

router.get('/api/ai/budget', authMiddleware, requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const result = getBudgetController().checkBudget(userId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal error' } });
  }
});

// ===========================================================================
// Admin AI endpoints (require admin role)
// Requirements: 6.2, 6.6, 6.7
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/admin/ai/usage — All users' AI usage (admin only)
// Requirement 6.6: 管理员查看所有用户的预算使用情况
// ---------------------------------------------------------------------------

router.get(
  '/api/admin/ai/usage',
  authMiddleware,
  requireAdmin,
  async (_req: Request, res: Response) => {
    try {
      const allStatus = getBudgetController().getAllUsersBudgetStatus();
      res.json({ users: allStatus });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal error' } });
    }
  }
);

// ---------------------------------------------------------------------------
// PUT /api/admin/ai/budget/:userId — Set user budget (admin only)
// Requirement 6.2: 为单个用户设置自定义预算限制
// ---------------------------------------------------------------------------

router.put(
  '/api/admin/ai/budget/:userId',
  authMiddleware,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { monthlyLimit } = req.body || {};
      if (typeof monthlyLimit !== 'number' || monthlyLimit <= 0) {
        res.status(400).json({
          error: { code: 'INVALID_PARAMS', message: 'monthlyLimit must be a positive number' },
        });
        return;
      }

      getBudgetController().setUserBudget(req.params.userId as string, monthlyLimit);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal error' } });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/admin/ai/budget/:userId/reset — Reset user budget (admin only)
// Requirement 6.7: 管理员重置用户的已用预算
// ---------------------------------------------------------------------------

router.post(
  '/api/admin/ai/budget/:userId/reset',
  authMiddleware,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      getBudgetController().resetUserBudget(req.params.userId as string);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal error' } });
    }
  }
);

export default router;
