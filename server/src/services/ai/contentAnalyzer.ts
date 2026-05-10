/**
 * ContentAnalyzer — AI 视频内容分析器
 *
 * 使用多模态 AI 分析视频片段的视觉内容，生成场景描述、情感标签和叙事价值评分。
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8
 */

import { getDb } from '../../database';
import { v4 as uuid } from 'uuid';
import type { AIProvider, AIResponse, EmotionTag, SegmentAIAnalysis } from './types';
import { EMOTION_TAGS } from './types';
import { CostTracker } from './costTracker';
import { BudgetController } from './budgetController';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContentAnalyzerOptions {
  batchSize?: number;          // 每批最大片段数（默认 5）
  forceReanalyze?: boolean;    // 是否强制重新分析（忽略缓存）
}

export interface ContentAnalysisResult {
  mediaId: string;
  segments: SegmentAIAnalysis[];
  totalTokensUsed: { input: number; output: number };
  estimatedCost: number;
}

interface VideoSegmentRow {
  segment_index: number;
  start_time: number;
  end_time: number;
  duration: number;
  overall_score: number;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse AI response text into a SegmentAIAnalysis object.
 * Enforces constraints: description ≤ 100 chars, 1-3 valid emotion tags, score 0-100.
 */
export function parseSegmentAnalysis(text: string, segmentIndex: number): SegmentAIAnalysis {
  try {
    const parsed = JSON.parse(text);

    // Scene description: truncate to 100 chars
    let sceneDescription = String(parsed.sceneDescription || parsed.scene_description || '');
    if (sceneDescription.length > 100) {
      sceneDescription = sceneDescription.slice(0, 100);
    }

    // Emotion tags: filter to valid tags, keep 1-3
    let emotionTags: EmotionTag[] = [];
    const rawTags = parsed.emotionTags || parsed.emotion_tags || [];
    if (Array.isArray(rawTags)) {
      emotionTags = rawTags
        .filter((tag: string) => EMOTION_TAGS.includes(tag as EmotionTag))
        .slice(0, 3) as EmotionTag[];
    }
    // Ensure at least 1 tag
    if (emotionTags.length === 0) {
      emotionTags = ['宁静'];
    }

    // Narrative score: clamp to 0-100 integer
    let narrativeScore = parseInt(String(parsed.narrativeScore || parsed.narrative_score || '50'), 10);
    if (isNaN(narrativeScore)) narrativeScore = 50;
    narrativeScore = Math.max(0, Math.min(100, Math.round(narrativeScore)));

    return { segmentIndex, sceneDescription, emotionTags, narrativeScore };
  } catch {
    // If parsing fails entirely, return defaults
    return getDefaultAnalysis(segmentIndex);
  }
}

/**
 * Parse a batch response containing multiple segment analyses.
 */
export function parseBatchAnalysis(text: string, segmentIndices: number[]): SegmentAIAnalysis[] {
  try {
    const parsed = JSON.parse(text);
    const segments = Array.isArray(parsed) ? parsed : (parsed.segments || []);

    return segmentIndices.map((index, i) => {
      if (segments[i]) {
        return parseSegmentAnalysis(JSON.stringify(segments[i]), index);
      }
      return getDefaultAnalysis(index);
    });
  } catch {
    // If batch parsing fails, return defaults for all
    return segmentIndices.map(index => getDefaultAnalysis(index));
  }
}

function getDefaultAnalysis(segmentIndex: number): SegmentAIAnalysis {
  return {
    segmentIndex,
    sceneDescription: '',
    emotionTags: ['宁静'],
    narrativeScore: 50,
  };
}

// ---------------------------------------------------------------------------
// ContentAnalyzer
// ---------------------------------------------------------------------------

export class ContentAnalyzer {
  private provider: AIProvider;
  private costTracker: CostTracker;
  private budgetController: BudgetController;

  constructor(provider: AIProvider, costTracker: CostTracker, budgetController: BudgetController) {
    this.provider = provider;
    this.costTracker = costTracker;
    this.budgetController = budgetController;
  }

  /**
   * Analyze all segments of a video using AI.
   */
  async analyzeContent(
    mediaId: string,
    userId: string,
    tripId: string,
    options?: ContentAnalyzerOptions,
  ): Promise<ContentAnalysisResult> {
    const batchSize = options?.batchSize ?? 5;
    const forceReanalyze = options?.forceReanalyze ?? false;

    // Check budget before proceeding
    const budgetCheck = this.budgetController.checkBudget(userId);
    if (!budgetCheck.allowed) {
      throw new Error('BUDGET_EXCEEDED: ' + budgetCheck.message);
    }

    // Check cache unless forced
    if (!forceReanalyze) {
      const cached = this.getCachedAnalysis(mediaId);
      if (cached && cached.length > 0) {
        return {
          mediaId,
          segments: cached,
          totalTokensUsed: { input: 0, output: 0 },
          estimatedCost: 0,
        };
      }
    }

    // Get video segments from database
    const db = getDb();
    const segments = db.prepare(
      `SELECT segment_index, start_time, end_time, duration, overall_score
       FROM video_segments WHERE media_id = ? ORDER BY segment_index`
    ).all(mediaId) as VideoSegmentRow[];

    if (segments.length === 0) {
      return { mediaId, segments: [], totalTokensUsed: { input: 0, output: 0 }, estimatedCost: 0 };
    }

    // Process in batches
    const results: SegmentAIAnalysis[] = [];
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;

    for (let i = 0; i < segments.length; i += batchSize) {
      const batch = segments.slice(i, i + batchSize);
      const indices = batch.map(s => s.segment_index);

      try {
        const prompt = this.buildBatchPrompt(batch);
        const response = await this.provider.generateText(prompt, { maxTokens: 2048 });

        const batchResults = parseBatchAnalysis(response.text, indices);
        results.push(...batchResults);

        totalInput += response.inputTokens;
        totalOutput += response.outputTokens;

        // Record usage
        const record = this.costTracker.recordUsage({
          userId,
          tripId,
          mediaId,
          provider: this.provider.metadata.name,
          model: this.provider.metadata.model,
          callType: 'content_analysis',
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
        });
        totalCost += record.estimatedCost;
      } catch (err) {
        // On batch failure, use defaults for all segments in this batch
        console.warn(`[ContentAnalyzer] Batch analysis failed for segments ${indices.join(',')}: ${err}`);
        for (const index of indices) {
          results.push(getDefaultAnalysis(index));
        }
      }
    }

    // Persist results to database
    this.saveAnalysisResults(mediaId, results);

    return {
      mediaId,
      segments: results,
      totalTokensUsed: { input: totalInput, output: totalOutput },
      estimatedCost: totalCost,
    };
  }

  /**
   * Check if cached analysis exists for a media item.
   */
  hasCachedAnalysis(mediaId: string): boolean {
    const db = getDb();
    const row = db.prepare(
      `SELECT COUNT(*) as count FROM segment_ai_analysis WHERE media_id = ?`
    ).get(mediaId) as { count: number };
    return row.count > 0;
  }

  /**
   * Get cached analysis results from database.
   */
  getCachedAnalysis(mediaId: string): SegmentAIAnalysis[] | null {
    const db = getDb();
    const rows = db.prepare(
      `SELECT segment_index, scene_description, emotion_tags, narrative_score
       FROM segment_ai_analysis WHERE media_id = ? ORDER BY segment_index`
    ).all(mediaId) as Array<{
      segment_index: number;
      scene_description: string;
      emotion_tags: string;
      narrative_score: number;
    }>;

    if (rows.length === 0) return null;

    return rows.map(row => ({
      segmentIndex: row.segment_index,
      sceneDescription: row.scene_description || '',
      emotionTags: JSON.parse(row.emotion_tags || '["宁静"]') as EmotionTag[],
      narrativeScore: row.narrative_score ?? 50,
    }));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildBatchPrompt(segments: VideoSegmentRow[]): string {
    const segmentDescriptions = segments.map(s =>
      `片段 ${s.segment_index}: 时间 ${s.start_time.toFixed(1)}s-${s.end_time.toFixed(1)}s, 时长 ${s.duration.toFixed(1)}s, 质量评分 ${(s.overall_score ?? 0).toFixed(0)}/100`
    ).join('\n');

    return `你是一个视频内容分析专家。请分析以下视频片段，为每个片段生成：
1. sceneDescription: 场景描述（不超过100字，描述画面内容）
2. emotionTags: 情感标签（1-3个，从以下选择：欢乐、宁静、壮观、温馨、紧张、浪漫、神秘、活力、忧伤、震撼）
3. narrativeScore: 叙事价值评分（0-100整数，表示该片段在整体叙事中的重要性）

视频片段信息：
${segmentDescriptions}

请以JSON数组格式返回，每个元素包含 sceneDescription, emotionTags, narrativeScore 三个字段。
示例：[{"sceneDescription":"日落时分的海滩","emotionTags":["宁静","壮观"],"narrativeScore":85}]`;
  }

  private saveAnalysisResults(mediaId: string, results: SegmentAIAnalysis[]): void {
    const db = getDb();
    const now = new Date().toISOString();

    const insert = db.prepare(`
      INSERT OR REPLACE INTO segment_ai_analysis
        (id, media_id, segment_index, scene_description, emotion_tags, narrative_score, provider, model, analyzed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction(() => {
      for (const result of results) {
        // Check if exists to preserve id
        const existing = db.prepare(
          `SELECT id FROM segment_ai_analysis WHERE media_id = ? AND segment_index = ?`
        ).get(mediaId, result.segmentIndex) as { id: string } | undefined;

        insert.run(
          existing?.id ?? uuid(),
          mediaId,
          result.segmentIndex,
          result.sceneDescription,
          JSON.stringify(result.emotionTags),
          result.narrativeScore,
          this.provider.metadata.name,
          this.provider.metadata.model,
          now,
          now,
        );
      }
    });

    transaction();
  }
}
