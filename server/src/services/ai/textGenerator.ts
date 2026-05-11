/**
 * TextGenerator — AI 文本生成器
 *
 * 生成视频标题、片段字幕和旁白文案。
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */

import { v4 as uuid } from 'uuid';
import { getDb } from '../../database';
import type {
  AIProvider,
  GeneratedNarration,
  GeneratedSubtitles,
  GeneratedTitles,
  TextStyle,
  TextType,
} from './types';
import { CostTracker } from './costTracker';
import { BudgetController } from './budgetController';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TextGenerationRequest {
  mediaId: string;
  userId: string;
  tripId: string;
  type: TextType;
  style?: TextStyle;
}

export interface TextGenerationResult {
  type: TextType;
  titles?: GeneratedTitles;
  subtitles?: GeneratedSubtitles;
  narration?: GeneratedNarration;
  tokensUsed: { input: number; output: number };
  estimatedCost: number;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Truncate a title to max 30 characters.
 */
export function truncateTitle(title: string): string {
  if (title.length <= 30) return title;
  return title.slice(0, 30);
}

/**
 * Truncate a subtitle to max 20 characters.
 */
export function truncateSubtitle(subtitle: string): string {
  if (subtitle.length <= 20) return subtitle;
  return subtitle.slice(0, 20);
}

/**
 * Estimate narration duration in seconds.
 * Chinese: ~4 characters per second
 * English: ~150 words per minute (~2.5 words per second)
 */
export function estimateNarrationDuration(text: string): number {
  if (!text) return 0;

  // Count CJK characters
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}]/gu) || []).length;
  // Count English words (non-CJK text split by spaces)
  const nonCjk = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}]/gu, '');
  const englishWords = nonCjk.split(/\s+/).filter(w => w.length > 0).length;

  const cjkDuration = cjkChars / 4;
  const englishDuration = englishWords / 2.5;

  return cjkDuration + englishDuration;
}

// ---------------------------------------------------------------------------
// Style descriptions for prompts
// ---------------------------------------------------------------------------

const STYLE_DESCRIPTIONS: Record<TextStyle, string> = {
  travel_diary: '旅行日记风格：亲切、个人化、带有感悟',
  documentary: '纪录片风格：客观、深沉、有画面感',
  social_media: '社交媒体风格：简短、有趣、吸引眼球',
  cinematic: '电影风格：诗意、有节奏感、富有画面感',
};

// ---------------------------------------------------------------------------
// TextGenerator
// ---------------------------------------------------------------------------

export class TextGenerator {
  private provider: AIProvider;
  private costTracker: CostTracker;
  private budgetController: BudgetController;

  constructor(provider: AIProvider, costTracker: CostTracker, budgetController: BudgetController) {
    this.provider = provider;
    this.costTracker = costTracker;
    this.budgetController = budgetController;
  }

  /**
   * Generate text content (title, subtitle, or narration) for a video.
   */
  async generateText(request: TextGenerationRequest): Promise<TextGenerationResult> {
    // Check budget
    const budgetCheck = this.budgetController.checkBudget(request.userId);
    if (!budgetCheck.allowed) {
      throw new Error('BUDGET_EXCEEDED: ' + budgetCheck.message);
    }

    try {
      switch (request.type) {
        case 'title':
          return await this.generateTitles(request);
        case 'subtitle':
          return await this.generateSubtitles(request);
        case 'narration':
          return await this.generateNarration(request);
        default:
          throw new Error(`Unknown text type: ${request.type}`);
      }
    } catch (err) {
      // Requirement 4.7: failure returns empty result, doesn't affect video editing
      if ((err as Error).message?.startsWith('BUDGET_EXCEEDED')) throw err;

      console.error(`[TextGenerator] Failed to generate ${request.type}: ${err}`);
      return {
        type: request.type,
        tokensUsed: { input: 0, output: 0 },
        estimatedCost: 0,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Private generation methods
  // ---------------------------------------------------------------------------

  private async generateTitles(request: TextGenerationRequest): Promise<TextGenerationResult> {
    const context = this.loadAnalysisContext(request.mediaId);
    const styleDesc = request.style ? STYLE_DESCRIPTIONS[request.style] : '';

    const prompt = `基于以下视频片段内容，生成3个候选视频标题。每个标题不超过30个字符，简洁有吸引力。${styleDesc ? `\n风格要求：${styleDesc}` : ''}

片段内容：
${context}

请以JSON格式返回：{"titles": ["标题1", "标题2", "标题3"]}`;

    const response = await this.provider.generateText(prompt, { maxTokens: 512 });

    let titles: string[] = [];
    try {
      const parsed = JSON.parse(response.text);
      titles = (parsed.titles || []).map((t: string) => truncateTitle(String(t))).slice(0, 3);
    } catch {
      titles = [];
    }

    // Ensure we have 3 titles
    while (titles.length < 3) {
      titles.push('');
    }

    const result: GeneratedTitles = { titles };

    // Record cost and save
    const record = this.costTracker.recordUsage({
      userId: request.userId,
      tripId: request.tripId,
      mediaId: request.mediaId,
      provider: this.provider.metadata.name,
      model: this.provider.metadata.model,
      callType: 'text_generation',
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    });

    this.saveGeneratedText(request.mediaId, 'title', request.style, result);

    return {
      type: 'title',
      titles: result,
      tokensUsed: { input: response.inputTokens, output: response.outputTokens },
      estimatedCost: record.estimatedCost,
    };
  }

  private async generateSubtitles(request: TextGenerationRequest): Promise<TextGenerationResult> {
    const context = this.loadSelectedSegmentsContext(request.mediaId);
    const styleDesc = request.style ? STYLE_DESCRIPTIONS[request.style] : '';

    const prompt = `基于以下选中的视频片段内容，为每个片段生成一句字幕。每句字幕不超过20个字符。${styleDesc ? `\n风格要求：${styleDesc}` : ''}

选中片段内容：
${context}

请以JSON格式返回：{"subtitles": [{"segmentIndex": 0, "text": "字幕内容"}]}`;

    const response = await this.provider.generateText(prompt, { maxTokens: 1024 });

    let subtitles: Array<{ segmentIndex: number; text: string }> = [];
    try {
      const parsed = JSON.parse(response.text);
      subtitles = (parsed.subtitles || []).map((s: any) => ({
        segmentIndex: Number(s.segmentIndex),
        text: truncateSubtitle(String(s.text || '')),
      }));
    } catch {
      subtitles = [];
    }

    const result: GeneratedSubtitles = { subtitles };

    const record = this.costTracker.recordUsage({
      userId: request.userId,
      tripId: request.tripId,
      mediaId: request.mediaId,
      provider: this.provider.metadata.name,
      model: this.provider.metadata.model,
      callType: 'text_generation',
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    });

    this.saveGeneratedText(request.mediaId, 'subtitle', request.style, result);

    return {
      type: 'subtitle',
      subtitles: result,
      tokensUsed: { input: response.inputTokens, output: response.outputTokens },
      estimatedCost: record.estimatedCost,
    };
  }

  private async generateNarration(request: TextGenerationRequest): Promise<TextGenerationResult> {
    const context = this.loadAnalysisContext(request.mediaId);
    const editPlanContext = this.loadEditPlanContext(request.mediaId);
    const styleDesc = request.style ? STYLE_DESCRIPTIONS[request.style] : '';

    // Get video total duration for length constraint
    const db = getDb();
    const durationRow = db.prepare(
      `SELECT SUM(duration) as total FROM video_segments WHERE media_id = ?`
    ).get(request.mediaId) as { total: number } | undefined;
    const videoDuration = durationRow?.total ?? 60;

    // Estimate max characters: Chinese ~4 chars/sec
    const maxChars = Math.floor(videoDuration * 4);

    const prompt = `基于以下视频片段内容和剪辑方案，生成连贯的旁白文案。旁白总长度不超过${maxChars}个字符（约${videoDuration}秒朗读时长）。${styleDesc ? `\n风格要求：${styleDesc}` : ''}

片段内容：
${context}

${editPlanContext ? `剪辑方案：\n${editPlanContext}\n` : ''}
请以JSON格式返回：{"narration": "旁白文案内容..."}`;

    const response = await this.provider.generateText(prompt, { maxTokens: 2048 });

    let narration = '';
    try {
      const parsed = JSON.parse(response.text);
      narration = String(parsed.narration || '');
      // Truncate if too long
      if (narration.length > maxChars) {
        narration = narration.slice(0, maxChars);
      }
    } catch {
      narration = '';
    }

    const estimatedDurationSeconds = estimateNarrationDuration(narration);
    const result: GeneratedNarration = { narration, estimatedDurationSeconds };

    const record = this.costTracker.recordUsage({
      userId: request.userId,
      tripId: request.tripId,
      mediaId: request.mediaId,
      provider: this.provider.metadata.name,
      model: this.provider.metadata.model,
      callType: 'text_generation',
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    });

    this.saveGeneratedText(request.mediaId, 'narration', request.style, result);

    return {
      type: 'narration',
      narration: result,
      tokensUsed: { input: response.inputTokens, output: response.outputTokens },
      estimatedCost: record.estimatedCost,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private loadAnalysisContext(mediaId: string): string {
    const db = getDb();
    const rows = db.prepare(`
      SELECT segment_index, scene_description, emotion_tags
      FROM segment_ai_analysis
      WHERE media_id = ?
      ORDER BY segment_index
    `).all(mediaId) as Array<{
      segment_index: number;
      scene_description: string;
      emotion_tags: string;
    }>;

    if (rows.length === 0) {
      // Fallback: use segment basic info
      const segments = db.prepare(
        `SELECT segment_index, start_time, end_time, duration FROM video_segments WHERE media_id = ? ORDER BY segment_index`
      ).all(mediaId) as Array<{ segment_index: number; start_time: number; end_time: number; duration: number }>;

      return segments.map(s =>
        `片段${s.segment_index}: ${s.start_time.toFixed(1)}-${s.end_time.toFixed(1)}s`
      ).join('\n');
    }

    return rows.map(row => {
      const tags = JSON.parse(row.emotion_tags || '[]');
      return `片段${row.segment_index}: ${row.scene_description} [${tags.join(',')}]`;
    }).join('\n');
  }

  /**
   * Load context for selected segments only (from EditPlan).
   * Falls back to all segments if no EditPlan exists.
   */
  private loadSelectedSegmentsContext(mediaId: string): string {
    const db = getDb();

    // Try to get selected segment indices from the latest EditPlan
    const planRow = db.prepare(
      `SELECT plan_json FROM ai_edit_plans WHERE media_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(mediaId) as { plan_json: string } | undefined;

    let selectedIndices: number[] | null = null;
    if (planRow) {
      try {
        const plan = JSON.parse(planRow.plan_json);
        if (Array.isArray(plan.segments)) {
          selectedIndices = plan.segments.map((s: any) => s.segmentIndex);
        }
      } catch {
        // ignore parse errors
      }
    }

    const rows = db.prepare(`
      SELECT segment_index, scene_description, emotion_tags
      FROM segment_ai_analysis
      WHERE media_id = ?
      ORDER BY segment_index
    `).all(mediaId) as Array<{
      segment_index: number;
      scene_description: string;
      emotion_tags: string;
    }>;

    if (rows.length === 0) {
      // Fallback: use segment basic info
      const segments = db.prepare(
        `SELECT segment_index, start_time, end_time, duration FROM video_segments WHERE media_id = ? ORDER BY segment_index`
      ).all(mediaId) as Array<{ segment_index: number; start_time: number; end_time: number; duration: number }>;

      const filtered = selectedIndices
        ? segments.filter(s => selectedIndices!.includes(s.segment_index))
        : segments;

      return filtered.map(s =>
        `片段${s.segment_index}: ${s.start_time.toFixed(1)}-${s.end_time.toFixed(1)}s`
      ).join('\n');
    }

    const filtered = selectedIndices
      ? rows.filter(r => selectedIndices!.includes(r.segment_index))
      : rows;

    return filtered.map(row => {
      const tags = JSON.parse(row.emotion_tags || '[]');
      return `片段${row.segment_index}: ${row.scene_description} [${tags.join(',')}]`;
    }).join('\n');
  }

  /**
   * Load EditPlan context for narration generation.
   */
  private loadEditPlanContext(mediaId: string): string | null {
    const db = getDb();
    const row = db.prepare(
      `SELECT plan_json FROM ai_edit_plans WHERE media_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(mediaId) as { plan_json: string } | undefined;

    if (!row) return null;

    try {
      const plan = JSON.parse(row.plan_json);
      const parts: string[] = [];

      if (plan.narrativeSummary) {
        parts.push(`叙事概要：${plan.narrativeSummary}`);
      }
      if (plan.pace) {
        parts.push(`节奏：${plan.pace}`);
      }
      if (Array.isArray(plan.segments)) {
        const segmentDescs = plan.segments.map((s: any) =>
          `片段${s.segmentIndex}: ${s.reason || ''}${s.transitionTo ? ` → ${s.transitionTo}` : ''}`
        );
        parts.push(`片段顺序：\n${segmentDescs.join('\n')}`);
      }

      return parts.join('\n');
    } catch {
      return null;
    }
  }

  private saveGeneratedText(mediaId: string, textType: TextType, style: TextStyle | undefined, content: any): void {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO ai_generated_texts (id, media_id, text_type, style, content_json, provider, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuid(),
      mediaId,
      textType,
      style ?? null,
      JSON.stringify(content),
      this.provider.metadata.name,
      this.provider.metadata.model,
      now,
    );
  }
}
