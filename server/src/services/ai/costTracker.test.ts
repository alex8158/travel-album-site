/**
 * Unit tests for CostTracker and BudgetController.
 * No real AI model calls — tests pure logic only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Create in-memory database
let db: Database.Database;

vi.mock('../../database', () => ({
  getDb: () => db,
}));

import { CostTracker } from './costTracker';
import { BudgetController } from './budgetController';

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, password_hash TEXT, role TEXT DEFAULT 'regular', status TEXT DEFAULT 'active', created_at TEXT, updated_at TEXT);
    CREATE TABLE trips (id TEXT PRIMARY KEY, title TEXT, user_id TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE ai_usage_records (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, trip_id TEXT NOT NULL, media_id TEXT,
      provider TEXT NOT NULL, model TEXT NOT NULL, call_type TEXT NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      estimated_cost REAL NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX idx_ai_usage_user ON ai_usage_records(user_id);
    CREATE TABLE ai_budget_configs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, monthly_limit REAL NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);

  db.prepare("INSERT INTO users VALUES ('user-1', 'testuser', 'hash', 'regular', 'active', '2024-01-01', '2024-01-01')").run();
  db.prepare("INSERT INTO trips VALUES ('trip-1', 'Test Trip', 'user-1', '2024-01-01', '2024-01-01')").run();
});

afterEach(() => {
  db.close();
});

describe('CostTracker', () => {
  it('calculateCost returns correct value for known model', () => {
    const tracker = new CostTracker();
    // bedrock haiku: input $0.25/M, output $1.25/M
    const cost = tracker.calculateCost('bedrock', 'anthropic.claude-3-haiku-20240307-v1:0', 1000, 500);
    // (1000 * 0.25 + 500 * 1.25) / 1_000_000 = 875 / 1_000_000 = 0.000875
    expect(cost).toBeCloseTo(0.000875, 6);
  });

  it('calculateCost uses fallback pricing for unknown model', () => {
    const tracker = new CostTracker();
    const cost = tracker.calculateCost('unknown', 'unknown-model', 1000, 500);
    // Fallback: input $1.0/M, output $3.0/M
    // (1000 * 1.0 + 500 * 3.0) / 1_000_000 = 2500 / 1_000_000 = 0.0025
    expect(cost).toBeCloseTo(0.0025, 6);
  });

  it('recordUsage inserts a record and returns it with id and cost', () => {
    const tracker = new CostTracker();
    const record = tracker.recordUsage({
      userId: 'user-1',
      tripId: 'trip-1',
      mediaId: 'media-1',
      provider: 'bedrock',
      model: 'anthropic.claude-3-haiku-20240307-v1:0',
      callType: 'content_analysis',
      inputTokens: 2000,
      outputTokens: 1000,
    });

    expect(record.id).toBeTruthy();
    expect(record.estimatedCost).toBeGreaterThan(0);
    expect(record.createdAt).toBeTruthy();

    // Verify it's in the database
    const row = db.prepare('SELECT * FROM ai_usage_records WHERE id = ?').get(record.id) as any;
    expect(row).toBeTruthy();
    expect(row.user_id).toBe('user-1');
    expect(row.call_type).toBe('content_analysis');
  });

  it('getUserStats aggregates correctly', () => {
    const tracker = new CostTracker();

    tracker.recordUsage({ userId: 'user-1', tripId: 'trip-1', provider: 'bedrock', model: 'anthropic.claude-3-haiku-20240307-v1:0', callType: 'content_analysis', inputTokens: 1000, outputTokens: 500 });
    tracker.recordUsage({ userId: 'user-1', tripId: 'trip-1', provider: 'bedrock', model: 'anthropic.claude-3-haiku-20240307-v1:0', callType: 'edit_planning', inputTokens: 2000, outputTokens: 1000 });

    const stats = tracker.getUserStats('user-1');
    expect(stats.callCount).toBe(2);
    expect(stats.totalInputTokens).toBe(3000);
    expect(stats.totalOutputTokens).toBe(1500);
    expect(stats.totalCost).toBeGreaterThan(0);
    expect(stats.byType.content_analysis.count).toBe(1);
    expect(stats.byType.edit_planning.count).toBe(1);
    expect(stats.byType.text_generation.count).toBe(0);
  });

  it('estimateTokens returns value in valid range', () => {
    const tracker = new CostTracker();

    const text = '这是一段中英文混合的测试文本 with some English words mixed in';
    const estimate = tracker.estimateTokens(text);

    expect(estimate).toBeGreaterThanOrEqual(Math.ceil(text.length / 6));
    expect(estimate).toBeLessThanOrEqual(Math.ceil(text.length / 2));
  });

  it('estimateTokens returns 0 for empty string', () => {
    const tracker = new CostTracker();
    expect(tracker.estimateTokens('')).toBe(0);
  });
});

describe('BudgetController', () => {
  it('checkBudget returns allowed=true when no usage', () => {
    const tracker = new CostTracker();
    const controller = new BudgetController(tracker);

    const result = controller.checkBudget('user-1');
    expect(result.allowed).toBe(true);
    expect(result.warningLevel).toBe('none');
    expect(result.currentUsage).toBe(0);
    expect(result.limit).toBe(5.0); // default
  });

  it('checkBudget returns exceeded when over limit', () => {
    const tracker = new CostTracker();
    const controller = new BudgetController(tracker);

    // Set a very low budget
    controller.setUserBudget('user-1', 0.001);

    // Record usage that exceeds it
    tracker.recordUsage({ userId: 'user-1', tripId: 'trip-1', provider: 'bedrock', model: 'anthropic.claude-3-haiku-20240307-v1:0', callType: 'content_analysis', inputTokens: 100000, outputTokens: 50000 });

    const result = controller.checkBudget('user-1');
    expect(result.allowed).toBe(false);
    expect(result.warningLevel).toBe('exceeded');
  });

  it('setUserBudget creates and updates budget config', () => {
    const tracker = new CostTracker();
    const controller = new BudgetController(tracker);

    controller.setUserBudget('user-1', 10.0);
    let config = controller.getBudgetConfig('user-1');
    expect(config.customLimit).toBe(10.0);

    controller.setUserBudget('user-1', 20.0);
    config = controller.getBudgetConfig('user-1');
    expect(config.customLimit).toBe(20.0);
  });

  it('resetUserBudget removes custom config', () => {
    const tracker = new CostTracker();
    const controller = new BudgetController(tracker);

    controller.setUserBudget('user-1', 10.0);
    controller.resetUserBudget('user-1');

    const config = controller.getBudgetConfig('user-1');
    expect(config.customLimit).toBeUndefined();
    expect(config.monthlyLimit).toBe(5.0); // back to global default
  });

  it('getGlobalDefault returns env value when set', () => {
    const tracker = new CostTracker();
    const controller = new BudgetController(tracker);

    const original = process.env.AI_MONTHLY_BUDGET_LIMIT;
    process.env.AI_MONTHLY_BUDGET_LIMIT = '15.5';

    expect(controller.getGlobalDefault()).toBe(15.5);

    if (original !== undefined) {
      process.env.AI_MONTHLY_BUDGET_LIMIT = original;
    } else {
      delete process.env.AI_MONTHLY_BUDGET_LIMIT;
    }
  });
});
