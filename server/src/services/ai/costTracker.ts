/**
 * CostTracker — AI 调用成本追踪器
 *
 * 记录每次 AI 调用的 token 用量和费用，提供按用户/旅行/时间范围的费用统计。
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */

import { v4 as uuid } from 'uuid';
import { getDb } from '../../database';
import type { AICallType, AIUsageRecord, ModelPricing, UsageStats } from './types';

// ---------------------------------------------------------------------------
// Pricing Configuration
// ---------------------------------------------------------------------------

/** Default model pricing (per million tokens, USD) */
const DEFAULT_PRICING: ModelPricing[] = [
  { provider: 'bedrock', model: 'anthropic.claude-3-haiku-20240307-v1:0', inputPricePerMToken: 0.25, outputPricePerMToken: 1.25 },
  { provider: 'bedrock', model: 'anthropic.claude-3-sonnet-20240229-v1:0', inputPricePerMToken: 3.0, outputPricePerMToken: 15.0 },
  { provider: 'bedrock', model: 'anthropic.claude-3-5-sonnet-20241022-v2:0', inputPricePerMToken: 3.0, outputPricePerMToken: 15.0 },
  { provider: 'openai', model: 'gpt-4o-mini', inputPricePerMToken: 0.15, outputPricePerMToken: 0.60 },
  { provider: 'openai', model: 'gpt-4o', inputPricePerMToken: 2.50, outputPricePerMToken: 10.0 },
];

// ---------------------------------------------------------------------------
// CostTracker Implementation
// ---------------------------------------------------------------------------

export class CostTracker {
  private pricing: ModelPricing[];

  constructor() {
    this.pricing = DEFAULT_PRICING;
  }

  /**
   * Calculate cost for a given number of tokens.
   * Returns cost in USD.
   */
  calculateCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
    const pricing = this.pricing.find(p => p.provider === provider && p.model === model);

    // Fallback: use generic pricing if model not found
    const inputPrice = pricing?.inputPricePerMToken ?? 1.0;
    const outputPrice = pricing?.outputPricePerMToken ?? 3.0;

    return (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
  }

  /**
   * Record an AI usage event to the database.
   */
  recordUsage(record: Omit<AIUsageRecord, 'id' | 'estimatedCost' | 'createdAt'>): AIUsageRecord {
    const id = uuid();
    const createdAt = new Date().toISOString();
    const estimatedCost = this.calculateCost(
      record.provider,
      record.model,
      record.inputTokens,
      record.outputTokens,
    );

    const db = getDb();
    db.prepare(`
      INSERT INTO ai_usage_records (id, user_id, trip_id, media_id, provider, model, call_type, input_tokens, output_tokens, estimated_cost, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      record.userId,
      record.tripId,
      record.mediaId ?? null,
      record.provider,
      record.model,
      record.callType,
      record.inputTokens,
      record.outputTokens,
      estimatedCost,
      createdAt,
    );

    return { ...record, id, estimatedCost, createdAt };
  }

  /**
   * Get usage statistics for a user within an optional date range.
   */
  getUserStats(userId: string, startDate?: string, endDate?: string): UsageStats {
    const db = getDb();
    let query = `SELECT call_type, input_tokens, output_tokens, estimated_cost FROM ai_usage_records WHERE user_id = ?`;
    const params: any[] = [userId];

    if (startDate) {
      query += ` AND created_at >= ?`;
      params.push(startDate);
    }
    if (endDate) {
      query += ` AND created_at <= ?`;
      params.push(endDate);
    }

    const rows = db.prepare(query).all(...params) as Array<{
      call_type: string;
      input_tokens: number;
      output_tokens: number;
      estimated_cost: number;
    }>;

    return this.aggregateStats(rows);
  }

  /**
   * Get usage statistics for a trip.
   */
  getTripStats(tripId: string): UsageStats {
    const db = getDb();
    const rows = db.prepare(
      `SELECT call_type, input_tokens, output_tokens, estimated_cost FROM ai_usage_records WHERE trip_id = ?`
    ).all(tripId) as Array<{
      call_type: string;
      input_tokens: number;
      output_tokens: number;
      estimated_cost: number;
    }>;

    return this.aggregateStats(rows);
  }

  /**
   * Get the pricing configuration.
   */
  getPricing(): ModelPricing[] {
    return [...this.pricing];
  }

  /**
   * Estimate token count for a string when provider doesn't return usage info.
   * Uses a heuristic: Chinese text ~2 chars/token, English ~4 chars/token.
   * Returns a value between len/6 and len/2.
   */
  estimateTokens(text: string): number {
    if (!text || text.length === 0) return 0;

    // Count CJK characters
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}]/gu) || []).length;
    const nonCjkLength = text.length - cjkCount;

    // CJK: ~1.5 chars per token; non-CJK: ~4 chars per token
    const estimated = Math.ceil(cjkCount / 1.5 + nonCjkLength / 4);

    // Clamp to [len/6, len/2] range
    const min = Math.ceil(text.length / 6);
    const max = Math.ceil(text.length / 2);
    return Math.max(min, Math.min(max, estimated));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private aggregateStats(rows: Array<{ call_type: string; input_tokens: number; output_tokens: number; estimated_cost: number }>): UsageStats {
    const byType: Record<AICallType, { cost: number; count: number }> = {
      content_analysis: { cost: 0, count: 0 },
      edit_planning: { cost: 0, count: 0 },
      text_generation: { cost: 0, count: 0 },
    };

    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const row of rows) {
      totalCost += row.estimated_cost;
      totalInputTokens += row.input_tokens;
      totalOutputTokens += row.output_tokens;

      const callType = row.call_type as AICallType;
      if (byType[callType]) {
        byType[callType].cost += row.estimated_cost;
        byType[callType].count += 1;
      }
    }

    return {
      totalCost,
      totalInputTokens,
      totalOutputTokens,
      callCount: rows.length,
      byType,
    };
  }
}
