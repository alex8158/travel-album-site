/**
 * DegradationStrategy — AI 功能降级策略链
 *
 * 实现降级优先级：
 *   AI 完整功能 → AI 部分可用 → 纯质量评分策略 → 错误提示
 *
 * 每个降级层级都能产出可用的剪辑结果，只是智能程度递减。
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */

import { ContentAnalyzer } from './contentAnalyzer';
import { EditPlanner, fallbackSelection, hasAIAnalysis, calculateWeightedScore } from './editPlanner';
import { CostTracker } from './costTracker';
import { BudgetController } from './budgetController';
import { getDb } from '../../database';
import type { AIProvider, EditPlan, SegmentAIAnalysis } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Degradation level indicating which strategy was used */
export type DegradationLevel =
  | 'full_ai'           // AI 完整功能：内容分析 + AI 剪辑方案
  | 'partial_ai'        // AI 部分可用：部分片段有分析结果
  | 'quality_score'     // 纯质量评分策略：无 AI 分析，基于 overallScore
  | 'error';            // 错误：无法产出结果

/** Result from the degradation strategy chain */
export interface DegradationResult {
  level: DegradationLevel;
  editPlan: EditPlan | null;
  message: string;
  error?: string;
}

/** Options for running the degradation chain */
export interface DegradationOptions {
  mediaId: string;
  userId: string;
  tripId: string;
  targetDuration?: number;
}

// ---------------------------------------------------------------------------
// AI Availability Check
// ---------------------------------------------------------------------------

/** Registry getter function type — injected to avoid circular dependency */
type RegistryGetter = () => { listProviders(): string[]; getDefault(): AIProvider };

let _registryGetter: RegistryGetter | null = null;

/**
 * Set the registry getter function. Called by index.ts to inject the shared registry.
 * This avoids circular dependency while sharing the singleton registry.
 */
export function setRegistryGetter(getter: RegistryGetter): void {
  _registryGetter = getter;
}

/**
 * Check if AI provider is configured and available.
 * Returns the provider if available, null otherwise.
 *
 * Requirement 10.5: AI Provider 配置缺失时返回 null
 */
export function getAvailableProvider(): AIProvider | null {
  if (!_registryGetter) return null;
  try {
    const registry = _registryGetter();
    if (registry.listProviders().length === 0) {
      return null;
    }
    return registry.getDefault();
  } catch {
    return null;
  }
}

/**
 * Check if AI service is configured (for 503 response).
 * Requirement 10.5
 */
export function isAIServiceConfigured(): boolean {
  return getAvailableProvider() !== null;
}

// ---------------------------------------------------------------------------
// Degradation Strategy Chain
// ---------------------------------------------------------------------------

/**
 * Execute the degradation strategy chain.
 *
 * Priority:
 * 1. AI 完整功能 — all segments have AI analysis, use AI-generated edit plan
 * 2. AI 部分可用 — some segments have AI analysis, use weighted scoring
 * 3. 纯质量评分策略 — no AI analysis available, sort by overallScore
 * 4. 错误提示 — cannot produce any result
 *
 * Each level guarantees a usable edit result (except 'error').
 */
export async function executeDegradationChain(
  options: DegradationOptions,
): Promise<DegradationResult> {
  const { mediaId, userId, tripId, targetDuration = 60 } = options;

  // Load segments from database
  const segments = loadSegments(mediaId);
  if (segments.length === 0) {
    return {
      level: 'error',
      editPlan: null,
      message: '无法生成剪辑方案：未找到视频片段数据',
      error: 'No video segments found for media ' + mediaId,
    };
  }

  // Check AI provider availability
  const provider = getAvailableProvider();

  if (!provider) {
    // No AI provider — fall through to quality score strategy
    return executeQualityScoreStrategy(segments, mediaId, targetDuration);
  }

  // Check budget
  const costTracker = new CostTracker();
  const budgetController = new BudgetController(costTracker);
  const budgetCheck = budgetController.checkBudget(userId);

  if (!budgetCheck.allowed) {
    // Budget exceeded — use whatever AI analysis is already cached
    return executeCachedOrFallback(segments, mediaId, targetDuration);
  }

  // Try full AI strategy
  try {
    const planner = new EditPlanner(provider, costTracker, budgetController);
    const result = await planner.generateEditPlan(mediaId, userId, tripId, targetDuration);

    if (result.fallbackUsed) {
      // LLM output was invalid, but we still have a plan from fallback
      const aiAvailable = hasAIAnalysis(segments);
      return {
        level: aiAvailable ? 'partial_ai' : 'quality_score',
        editPlan: result.editPlan,
        message: aiAvailable
          ? 'AI 方案生成失败，使用加权评分策略（含 AI 分析结果）'
          : 'AI 方案生成失败，使用纯质量评分策略',
      };
    }

    // Full AI success
    const aiAvailable = hasAIAnalysis(segments);
    const allSegmentsAnalyzed = segments.every(s => s.sceneDescription !== '' || s.narrativeScore !== 50);

    return {
      level: allSegmentsAnalyzed ? 'full_ai' : 'partial_ai',
      editPlan: result.editPlan,
      message: allSegmentsAnalyzed
        ? 'AI 完整功能：基于内容分析的智能剪辑方案'
        : 'AI 部分可用：部分片段有 AI 分析结果',
    };
  } catch (err) {
    // AI call failed entirely — use cached analysis or pure quality scores
    console.warn(`[DegradationStrategy] AI plan generation failed: ${err}`);
    return executeCachedOrFallback(segments, mediaId, targetDuration);
  }
}

// ---------------------------------------------------------------------------
// Internal Strategy Implementations
// ---------------------------------------------------------------------------

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

/**
 * Use cached AI analysis if available, otherwise fall back to quality scores.
 */
function executeCachedOrFallback(
  segments: SegmentWithScores[],
  mediaId: string,
  targetDuration: number,
): DegradationResult {
  const aiAvailable = hasAIAnalysis(segments);

  const plan = fallbackSelection(segments, mediaId, targetDuration);

  if (aiAvailable) {
    return {
      level: 'partial_ai',
      editPlan: plan,
      message: 'AI 部分可用：使用已缓存的分析结果进行加权评分选择',
    };
  }

  return {
    level: 'quality_score',
    editPlan: plan,
    message: '纯质量评分策略：基于 overallScore 排序选择片段',
  };
}

/**
 * Pure quality score strategy — no AI involvement.
 */
function executeQualityScoreStrategy(
  segments: SegmentWithScores[],
  mediaId: string,
  targetDuration: number,
): DegradationResult {
  const plan = fallbackSelection(segments, mediaId, targetDuration);

  return {
    level: 'quality_score',
    editPlan: plan,
    message: '纯质量评分策略：AI 服务不可用，基于 overallScore 排序选择片段',
  };
}

/**
 * Load segments with their scores from the database.
 */
function loadSegments(mediaId: string): SegmentWithScores[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      vs.segment_index as "index",
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
