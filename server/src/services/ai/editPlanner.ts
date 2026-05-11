/**
 * EditPlanner — AI 剪辑方案规划器
 *
 * 基于内容分析结果和质量评分，使用 LLM 生成结构化剪辑方案。
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
 */

import { v4 as uuid } from 'uuid';
import { getDb } from '../../database';
import type { AIProvider, EditPlan, EditPlanSegment, PaceType, SegmentAIAnalysis, TransitionType } from './types';
import { CostTracker } from './costTracker';
import { BudgetController } from './budgetController';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditPlanResult {
  editPlan: EditPlan;
  tokensUsed: { input: number; output: number };
  estimatedCost: number;
  fallbackUsed: boolean;
}

interface SegmentWithScores {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  overallScore: number;
  narrativeScore: number;
  sceneDescription: string;
  emotionTags: string[];
}

// ---------------------------------------------------------------------------
// Validation & Fallback
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: TransitionType[] = ['cut', 'fade', 'crossfade', 'dissolve'];
const VALID_PACES: PaceType[] = ['fast', 'medium', 'slow'];

/**
 * Validate an EditPlan parsed from LLM output.
 * Returns null if invalid.
 */
export function validateEditPlan(
  plan: any,
  mediaId: string,
  validIndices: Set<number>,
): EditPlan | null {
  if (!plan || typeof plan !== 'object') return null;

  const segments = plan.segments;
  if (!Array.isArray(segments) || segments.length === 0) return null;

  const validatedSegments: EditPlanSegment[] = [];
  for (const seg of segments) {
    if (typeof seg.segmentIndex !== 'number') return null;
    if (!validIndices.has(seg.segmentIndex)) return null;
    if (!seg.reason || typeof seg.reason !== 'string') return null;

    const transition = VALID_TRANSITIONS.includes(seg.transitionTo)
      ? seg.transitionTo
      : undefined;

    validatedSegments.push({
      segmentIndex: seg.segmentIndex,
      reason: String(seg.reason).slice(0, 200),
      transitionTo: transition,
    });
  }

  if (validatedSegments.length === 0) return null;

  const pace: PaceType = VALID_PACES.includes(plan.pace) ? plan.pace : 'medium';
  const narrativeSummary = typeof plan.narrativeSummary === 'string'
    ? plan.narrativeSummary.slice(0, 500)
    : '';

  return {
    mediaId,
    segments: validatedSegments,
    pace,
    totalDuration: 0, // Will be calculated
    narrativeSummary,
  };
}

/**
 * Determine if AI analysis results are available for the given segments.
 * AI analysis is considered available if at least one segment has a non-default narrativeScore.
 * (Default narrativeScore is 50 when no AI analysis exists.)
 */
export function hasAIAnalysis(segments: SegmentWithScores[]): boolean {
  // If all segments have narrativeScore === 50 and empty sceneDescription,
  // it's likely that no AI analysis was performed (all defaults).
  return segments.some(s => s.narrativeScore !== 50 || s.sceneDescription !== '');
}

/**
 * Calculate weighted score for a segment.
 * When AI analysis is available: narrativeScore * 0.4 + overallScore * 0.6
 * When AI analysis is not available: pure overallScore
 *
 * Requirements: 9.5, 9.6
 */
export function calculateWeightedScore(
  segment: SegmentWithScores,
  aiAvailable: boolean,
): number {
  if (!aiAvailable) {
    return segment.overallScore;
  }
  return segment.narrativeScore * 0.4 + segment.overallScore * 0.6;
}

/**
 * Fallback strategy: select segments by weighted score in descending order,
 * respecting duration limit.
 *
 * When AI analysis is available: uses narrativeScore * 0.4 + overallScore * 0.6
 * When AI analysis is not available: falls back to pure overallScore sorting
 *
 * Requirements: 9.5, 9.6
 */
export function fallbackSelection(
  segments: SegmentWithScores[],
  mediaId: string,
  targetDuration: number,
): EditPlan {
  const aiAvailable = hasAIAnalysis(segments);

  const sorted = [...segments].sort((a, b) => {
    const scoreA = calculateWeightedScore(a, aiAvailable);
    const scoreB = calculateWeightedScore(b, aiAvailable);
    return scoreB - scoreA;
  });

  const selected: EditPlanSegment[] = [];
  let totalDuration = 0;

  for (const seg of sorted) {
    if (totalDuration >= targetDuration) break;
    const reason = aiAvailable
      ? `质量评分 ${seg.overallScore.toFixed(0)}, 叙事评分 ${seg.narrativeScore}`
      : `质量评分 ${seg.overallScore.toFixed(0)}`;
    selected.push({
      segmentIndex: seg.index,
      reason,
      transitionTo: 'cut',
    });
    totalDuration += seg.duration;
  }

  // Sort by startTime for chronological order
  selected.sort((a, b) => {
    const segA = segments.find(s => s.index === a.segmentIndex)!;
    const segB = segments.find(s => s.index === b.segmentIndex)!;
    return segA.startTime - segB.startTime;
  });

  const narrativeSummary = aiAvailable
    ? '基于质量和叙事评分自动选择的片段组合'
    : '基于质量评分自动选择的片段组合（AI 分析不可用）';

  return {
    mediaId,
    segments: selected,
    pace: 'medium',
    totalDuration,
    narrativeSummary,
  };
}

/**
 * Validate LLM output and fall back to score-based selection if invalid.
 */
export function validateAndFallback(
  llmOutput: string,
  mediaId: string,
  segments: SegmentWithScores[],
  targetDuration: number,
): { plan: EditPlan; fallbackUsed: boolean } {
  const validIndices = new Set(segments.map(s => s.index));

  try {
    const parsed = JSON.parse(llmOutput);
    const validated = validateEditPlan(parsed, mediaId, validIndices);

    if (validated) {
      // Calculate total duration
      let totalDuration = 0;
      for (const seg of validated.segments) {
        const source = segments.find(s => s.index === seg.segmentIndex);
        if (source) totalDuration += source.duration;
      }
      validated.totalDuration = totalDuration;

      return { plan: validated, fallbackUsed: false };
    }
  } catch {
    // JSON parse failed
  }

  // Fallback
  return { plan: fallbackSelection(segments, mediaId, targetDuration), fallbackUsed: true };
}

/**
 * Select segments with a duration limit.
 * Returns segments whose cumulative duration does not exceed targetDuration.
 */
export function selectWithDurationLimit(
  segments: SegmentWithScores[],
  selectedIndices: number[],
  targetDuration: number,
): number[] {
  const result: number[] = [];
  let cumDuration = 0;

  for (const idx of selectedIndices) {
    const seg = segments.find(s => s.index === idx);
    if (!seg) continue;
    if (cumDuration + seg.duration > targetDuration && result.length > 0) break;
    result.push(idx);
    cumDuration += seg.duration;
  }

  return result;
}

// ---------------------------------------------------------------------------
// EditPlanner
// ---------------------------------------------------------------------------

export class EditPlanner {
  private provider: AIProvider;
  private costTracker: CostTracker;
  private budgetController: BudgetController;

  constructor(provider: AIProvider, costTracker: CostTracker, budgetController: BudgetController) {
    this.provider = provider;
    this.costTracker = costTracker;
    this.budgetController = budgetController;
  }

  /**
   * Generate an AI-powered edit plan for a video.
   */
  async generateEditPlan(
    mediaId: string,
    userId: string,
    tripId: string,
    targetDuration?: number,
  ): Promise<EditPlanResult> {
    // Check budget
    const budgetCheck = this.budgetController.checkBudget(userId);
    if (!budgetCheck.allowed) {
      throw new Error('BUDGET_EXCEEDED: ' + budgetCheck.message);
    }

    // Load segment data with AI analysis
    const segments = this.loadSegmentsWithAnalysis(mediaId);
    if (segments.length === 0) {
      throw new Error('No segments found for media ' + mediaId);
    }

    const effectiveTargetDuration = targetDuration ?? 60; // Default 60s

    // Build prompt and call LLM
    const prompt = this.buildPrompt(segments, effectiveTargetDuration);

    let fallbackUsed = false;
    let editPlan: EditPlan;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const response = await this.provider.generateText(prompt, { maxTokens: 2048 });
      inputTokens = response.inputTokens;
      outputTokens = response.outputTokens;

      const result = validateAndFallback(response.text, mediaId, segments, effectiveTargetDuration);
      editPlan = result.plan;
      fallbackUsed = result.fallbackUsed;
    } catch (err) {
      // LLM call failed entirely — use fallback
      console.warn(`[EditPlanner] LLM call failed, using fallback: ${err}`);
      editPlan = fallbackSelection(segments, mediaId, effectiveTargetDuration);
      fallbackUsed = true;
    }

    // Apply duration limit
    const limitedIndices = selectWithDurationLimit(
      segments,
      editPlan.segments.map(s => s.segmentIndex),
      effectiveTargetDuration,
    );
    editPlan.segments = editPlan.segments.filter(s => limitedIndices.includes(s.segmentIndex));

    // Recalculate total duration
    editPlan.totalDuration = editPlan.segments.reduce((sum, seg) => {
      const source = segments.find(s => s.index === seg.segmentIndex);
      return sum + (source?.duration ?? 0);
    }, 0);

    // Record cost
    let estimatedCost = 0;
    if (inputTokens > 0 || outputTokens > 0) {
      const record = this.costTracker.recordUsage({
        userId,
        tripId,
        mediaId,
        provider: this.provider.metadata.name,
        model: this.provider.metadata.model,
        callType: 'edit_planning',
        inputTokens,
        outputTokens,
      });
      estimatedCost = record.estimatedCost;
    }

    // Save to database
    this.saveEditPlan(mediaId, editPlan, fallbackUsed);

    return {
      editPlan,
      tokensUsed: { input: inputTokens, output: outputTokens },
      estimatedCost,
      fallbackUsed,
    };
  }

  /**
   * Get the most recent edit plan from database.
   */
  getEditPlan(mediaId: string): EditPlan | null {
    const db = getDb();
    const row = db.prepare(
      `SELECT plan_json FROM ai_edit_plans WHERE media_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(mediaId) as { plan_json: string } | undefined;

    if (!row) return null;

    try {
      return JSON.parse(row.plan_json) as EditPlan;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private loadSegmentsWithAnalysis(mediaId: string): SegmentWithScores[] {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        vs.segment_index as index,
        vs.start_time as startTime,
        vs.end_time as endTime,
        vs.duration,
        COALESCE(vs.overall_score, 50) as overallScore,
        COALESCE(saa.narrative_score, 50) as narrativeScore,
        COALESCE(saa.scene_description, '') as sceneDescription,
        COALESCE(saa.emotion_tags, '[]') as emotionTags
      FROM video_segments vs
      LEFT JOIN segment_ai_analysis saa ON vs.media_id = saa.media_id AND vs.segment_index = saa.segment_index
      WHERE vs.media_id = ?
      ORDER BY vs.segment_index
    `).all(mediaId) as Array<{
      index: number;
      startTime: number;
      endTime: number;
      duration: number;
      overallScore: number;
      narrativeScore: number;
      sceneDescription: string;
      emotionTags: string;
    }>;

    return rows.map(row => ({
      ...row,
      emotionTags: JSON.parse(row.emotionTags),
    }));
  }

  private buildPrompt(segments: SegmentWithScores[], targetDuration: number): string {
    const segmentList = segments.map(s =>
      `片段${s.index}: ${s.startTime.toFixed(1)}-${s.endTime.toFixed(1)}s (${s.duration.toFixed(1)}s), 质量${s.overallScore}/100, 叙事${s.narrativeScore}/100, "${s.sceneDescription}", 情感[${s.emotionTags.join(',')}]`
    ).join('\n');

    return `你是一个专业视频剪辑师。请基于以下视频片段信息，生成一个${targetDuration}秒的剪辑方案。

要求：
1. 选择片段组成有叙事逻辑的视频（开头-发展-高潮-结尾）
2. 优先选择叙事评分和质量评分都高的片段
3. 总时长不超过${targetDuration}秒
4. 为每个片段标注选择理由和到下一片段的过渡方式

片段列表：
${segmentList}

请以JSON格式返回：
{
  "segments": [{"segmentIndex": 0, "reason": "开场...", "transitionTo": "fade"}],
  "pace": "medium",
  "narrativeSummary": "整体叙事概要..."
}

过渡方式可选：cut, fade, crossfade, dissolve
节奏可选：fast, medium, slow`;
  }

  private saveEditPlan(mediaId: string, plan: EditPlan, fallbackUsed: boolean): void {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO ai_edit_plans (id, media_id, plan_json, pace, total_duration, segment_count, provider, model, fallback_used, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuid(),
      mediaId,
      JSON.stringify(plan),
      plan.pace,
      plan.totalDuration,
      plan.segments.length,
      this.provider.metadata.name,
      this.provider.metadata.model,
      fallbackUsed ? 1 : 0,
      now,
    );
  }
}
