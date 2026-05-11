/**
 * BudgetController — AI 调用预算控制器
 *
 * 支持全局默认预算和用户自定义预算，在 AI 调用前检查预算余额。
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8
 */

import { v4 as uuid } from 'uuid';
import { getDb } from '../../database';
import { CostTracker } from './costTracker';
import type { BudgetCheckResult, BudgetConfig } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default monthly budget limit per user (USD) */
const DEFAULT_MONTHLY_LIMIT = 5.0;

/** Warning threshold: warn when usage reaches this fraction of limit */
const WARNING_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------
// BudgetController Implementation
// ---------------------------------------------------------------------------

export class BudgetController {
  private costTracker: CostTracker;

  constructor(costTracker: CostTracker) {
    this.costTracker = costTracker;
  }

  /**
   * Check if a user has remaining budget for AI calls.
   */
  checkBudget(userId: string): BudgetCheckResult {
    const config = this.getBudgetConfig(userId);
    const limit = config.customLimit ?? config.monthlyLimit;

    // Get current month's usage
    const startOfMonth = this.getStartOfMonth();
    const stats = this.costTracker.getUserStats(userId, startOfMonth);
    const currentUsage = stats.totalCost;

    const remainingBudget = Math.max(0, limit - currentUsage);

    if (currentUsage >= limit) {
      return {
        allowed: false,
        currentUsage,
        limit,
        remainingBudget: 0,
        warningLevel: 'exceeded',
        message: `AI budget exceeded. Used $${currentUsage.toFixed(4)} of $${limit.toFixed(2)} monthly limit.`,
      };
    }

    if (currentUsage >= limit * WARNING_THRESHOLD) {
      return {
        allowed: true,
        currentUsage,
        limit,
        remainingBudget,
        warningLevel: 'approaching',
        message: `AI budget warning: ${Math.round((currentUsage / limit) * 100)}% used ($${currentUsage.toFixed(4)} of $${limit.toFixed(2)}).`,
      };
    }

    return {
      allowed: true,
      currentUsage,
      limit,
      remainingBudget,
      warningLevel: 'none',
    };
  }

  /**
   * Get budget configuration for a user.
   * Falls back to global default if no custom config exists.
   */
  getBudgetConfig(userId: string): BudgetConfig {
    const db = getDb();
    const row = db.prepare(
      `SELECT user_id, monthly_limit FROM ai_budget_configs WHERE user_id = ?`
    ).get(userId) as { user_id: string; monthly_limit: number } | undefined;

    if (row) {
      return {
        userId: row.user_id,
        monthlyLimit: this.getGlobalDefault(),
        customLimit: row.monthly_limit,
      };
    }

    return {
      userId,
      monthlyLimit: this.getGlobalDefault(),
    };
  }

  /**
   * Set a custom monthly budget limit for a user.
   */
  setUserBudget(userId: string, monthlyLimit: number): void {
    const db = getDb();
    const now = new Date().toISOString();

    const existing = db.prepare(
      `SELECT id FROM ai_budget_configs WHERE user_id = ?`
    ).get(userId) as { id: string } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE ai_budget_configs SET monthly_limit = ?, updated_at = ? WHERE user_id = ?`
      ).run(monthlyLimit, now, userId);
    } else {
      db.prepare(
        `INSERT INTO ai_budget_configs (id, user_id, monthly_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      ).run(uuid(), userId, monthlyLimit, now, now);
    }
  }

  /**
   * Reset a user's budget by removing their custom config and deleting
   * current month's usage records. This effectively resets them to the
   * global default and sets their current usage back to 0.
   */
  resetUserBudget(userId: string): void {
    const db = getDb();
    const startOfMonth = this.getStartOfMonth();
    db.prepare(
      `DELETE FROM ai_usage_records WHERE user_id = ? AND created_at >= ?`
    ).run(userId, startOfMonth);
    db.prepare(
      `DELETE FROM ai_budget_configs WHERE user_id = ?`
    ).run(userId);
  }

  /**
   * Get the global default monthly budget limit from environment variable.
   */
  getGlobalDefault(): number {
    const envValue = process.env.AI_MONTHLY_BUDGET_LIMIT;
    if (envValue) {
      const parsed = parseFloat(envValue);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return DEFAULT_MONTHLY_LIMIT;
  }

  /**
   * Get all users' budget status (for admin view).
   */
  getAllUsersBudgetStatus(): Array<BudgetConfig & { currentUsage: number }> {
    const db = getDb();
    const startOfMonth = this.getStartOfMonth();

    // Get all users who have either a custom budget or any AI usage
    const users = db.prepare(`
      SELECT DISTINCT user_id FROM (
        SELECT user_id FROM ai_budget_configs
        UNION
        SELECT user_id FROM ai_usage_records WHERE created_at >= ?
      )
    `).all(startOfMonth) as Array<{ user_id: string }>;

    return users.map(({ user_id }) => {
      const config = this.getBudgetConfig(user_id);
      const stats = this.costTracker.getUserStats(user_id, startOfMonth);
      return {
        ...config,
        currentUsage: stats.totalCost,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getStartOfMonth(): string {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  }
}
