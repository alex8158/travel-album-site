/**
 * Tests for the AI degradation strategy chain.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDb } from '../../database';

// Mock the EditPlanner
const mockGenerateEditPlan = vi.fn();
vi.mock('./editPlanner', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    EditPlanner: vi.fn().mockImplementation(() => ({
      generateEditPlan: mockGenerateEditPlan,
    })),
  };
});

import {
  getAvailableProvider,
  isAIServiceConfigured,
  executeDegradationChain,
  setRegistryGetter,
} from './degradationStrategy';
import { hasAIAnalysis, calculateWeightedScore, fallbackSelection } from './editPlanner';

// Helper to create mock registry
function createMockRegistry(providers: string[], defaultProvider?: any) {
  return () => ({
    listProviders: () => providers,
    getDefault: () => defaultProvider ?? { metadata: { name: 'bedrock', model: 'claude-3' } },
  });
}
describe('DegradationStrategy', () => {
  beforeEach(() => {
    const db = getDb();
    db.pragma('foreign_keys = OFF');
    db.exec('DELETE FROM segment_ai_analysis');
    db.exec('DELETE FROM ai_usage_records');
    db.exec('DELETE FROM ai_budget_configs');
    db.exec('DELETE FROM video_segments');
    db.exec('DELETE FROM media_items');
    db.exec('DELETE FROM trips');
    db.exec('DELETE FROM users');
    db.pragma('foreign_keys = ON');

    // Reset the registry getter
    setRegistryGetter(createMockRegistry([]));
    vi.clearAllMocks();
  });

  describe('isAIServiceConfigured', () => {
    it('returns true when providers are registered', () => {
      setRegistryGetter(createMockRegistry(['bedrock']));
      expect(isAIServiceConfigured()).toBe(true);
    });

    it('returns false when no providers are registered', () => {
      setRegistryGetter(createMockRegistry([]));
      expect(isAIServiceConfigured()).toBe(false);
    });

    it('returns false when registry throws', () => {
      setRegistryGetter(() => { throw new Error('No registry'); });
      expect(isAIServiceConfigured()).toBe(false);
    });
  });

  describe('getAvailableProvider', () => {
    it('returns provider when available', () => {
      const mockProvider = { metadata: { name: 'bedrock', model: 'claude-3' } };
      setRegistryGetter(createMockRegistry(['bedrock'], mockProvider));
      expect(getAvailableProvider()).toBe(mockProvider);
    });

    it('returns null when no providers', () => {
      setRegistryGetter(createMockRegistry([]));
      expect(getAvailableProvider()).toBeNull();
    });
  });

  describe('executeDegradationChain', () => {
    function setupTestData() {
      const db = getDb();
      const now = new Date().toISOString();

      // Create user first (trips.user_id references users.id)
      db.prepare(
        `INSERT OR IGNORE INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('user-1', 'testuser', 'hash', 'regular', 'active', now, now);

      db.prepare(
        `INSERT INTO trips (id, title, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?)`
      ).run('trip-1', 'Test Trip', now, now, 'user-1');

      db.prepare(
        `INSERT INTO media_items (id, trip_id, file_path, media_type, mime_type, original_filename, file_size, status, created_at)
         VALUES (?, ?, ?, 'video', 'video/mp4', ?, 1024, 'active', ?)`
      ).run('media-1', 'trip-1', 'trip-1/originals/video.mp4', 'video.mp4', now);

      // Create video segments
      for (let i = 0; i < 4; i++) {
        db.prepare(
          `INSERT INTO video_segments (id, media_id, segment_index, start_time, end_time, duration, overall_score, label, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'good', ?)`
        ).run(`seg-${i}`, 'media-1', i, i * 10, (i + 1) * 10, 10, 80 - i * 10, now);
      }
    }

    it('returns error level when no segments exist', async () => {
      setRegistryGetter(createMockRegistry(['bedrock']));

      const result = await executeDegradationChain({
        mediaId: 'nonexistent',
        userId: 'user-1',
        tripId: 'trip-1',
      });

      expect(result.level).toBe('error');
      expect(result.editPlan).toBeNull();
    });

    it('returns quality_score level when AI is not configured', async () => {
      setupTestData();
      setRegistryGetter(createMockRegistry([]));

      const result = await executeDegradationChain({
        mediaId: 'media-1',
        userId: 'user-1',
        tripId: 'trip-1',
        targetDuration: 30,
      });

      expect(result.level).toBe('quality_score');
      expect(result.editPlan).not.toBeNull();
      expect(result.editPlan!.segments.length).toBeGreaterThan(0);
      expect(result.message).toContain('AI 服务不可用');
    });

    it('returns quality_score level when no AI analysis exists and AI call fails', async () => {
      setupTestData();
      const mockProvider = { metadata: { name: 'bedrock', model: 'claude-3' } };
      setRegistryGetter(createMockRegistry(['bedrock'], mockProvider));
      mockGenerateEditPlan.mockRejectedValue(new Error('AI call failed'));

      const result = await executeDegradationChain({
        mediaId: 'media-1',
        userId: 'user-1',
        tripId: 'trip-1',
        targetDuration: 30,
      });

      expect(result.level).toBe('quality_score');
      expect(result.editPlan).not.toBeNull();
    });

    it('returns partial_ai level when AI analysis exists but AI call fails', async () => {
      setupTestData();

      // Add AI analysis for some segments
      const db = getDb();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO segment_ai_analysis (id, media_id, segment_index, scene_description, emotion_tags, narrative_score, provider, model, analyzed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('ai-1', 'media-1', 0, '美丽的海滩日落', '["壮观","宁静"]', 85, 'bedrock', 'claude-3', now, now);

      const mockProvider = { metadata: { name: 'bedrock', model: 'claude-3' } };
      setRegistryGetter(createMockRegistry(['bedrock'], mockProvider));
      mockGenerateEditPlan.mockRejectedValue(new Error('AI call failed'));

      const result = await executeDegradationChain({
        mediaId: 'media-1',
        userId: 'user-1',
        tripId: 'trip-1',
        targetDuration: 30,
      });

      expect(result.level).toBe('partial_ai');
      expect(result.editPlan).not.toBeNull();
    });

    it('returns full_ai level when AI plan generation succeeds with full analysis', async () => {
      setupTestData();

      // Add AI analysis for all segments
      const db = getDb();
      const now = new Date().toISOString();
      for (let i = 0; i < 4; i++) {
        db.prepare(
          `INSERT INTO segment_ai_analysis (id, media_id, segment_index, scene_description, emotion_tags, narrative_score, provider, model, analyzed_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(`ai-${i}`, 'media-1', i, `场景描述${i}`, '["壮观"]', 70 + i * 5, 'bedrock', 'claude-3', now, now);
      }

      const mockProvider = { metadata: { name: 'bedrock', model: 'claude-3' } };
      setRegistryGetter(createMockRegistry(['bedrock'], mockProvider));
      mockGenerateEditPlan.mockResolvedValue({
        editPlan: {
          mediaId: 'media-1',
          segments: [{ segmentIndex: 0, reason: 'test' }],
          pace: 'medium',
          totalDuration: 10,
          narrativeSummary: 'AI generated plan',
        },
        tokensUsed: { input: 100, output: 50 },
        estimatedCost: 0.001,
        fallbackUsed: false,
      });

      const result = await executeDegradationChain({
        mediaId: 'media-1',
        userId: 'user-1',
        tripId: 'trip-1',
        targetDuration: 30,
      });

      expect(result.level).toBe('full_ai');
      expect(result.editPlan).not.toBeNull();
      expect(result.message).toContain('AI 完整功能');
    });

    it('each degradation level produces a usable edit plan (except error)', async () => {
      setupTestData();
      setRegistryGetter(createMockRegistry([]));

      const result = await executeDegradationChain({
        mediaId: 'media-1',
        userId: 'user-1',
        tripId: 'trip-1',
        targetDuration: 30,
      });

      // quality_score level should still produce a valid plan
      expect(result.editPlan).not.toBeNull();
      expect(result.editPlan!.segments.length).toBeGreaterThan(0);
      expect(result.editPlan!.mediaId).toBe('media-1');
      expect(result.editPlan!.totalDuration).toBeGreaterThan(0);
    });
  });
});

describe('EditPlanner - hasAIAnalysis', () => {
  it('returns false when all segments have default values', () => {
    const segments = [
      { index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80, narrativeScore: 50, sceneDescription: '', emotionTags: [] },
      { index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 70, narrativeScore: 50, sceneDescription: '', emotionTags: [] },
    ];
    expect(hasAIAnalysis(segments)).toBe(false);
  });

  it('returns true when at least one segment has non-default narrativeScore', () => {
    const segments = [
      { index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80, narrativeScore: 85, sceneDescription: '', emotionTags: [] },
      { index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 70, narrativeScore: 50, sceneDescription: '', emotionTags: [] },
    ];
    expect(hasAIAnalysis(segments)).toBe(true);
  });

  it('returns true when at least one segment has non-empty sceneDescription', () => {
    const segments = [
      { index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80, narrativeScore: 50, sceneDescription: '海滩日落', emotionTags: [] },
      { index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 70, narrativeScore: 50, sceneDescription: '', emotionTags: [] },
    ];
    expect(hasAIAnalysis(segments)).toBe(true);
  });
});

describe('EditPlanner - calculateWeightedScore', () => {
  const segment = { index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 80, narrativeScore: 60, sceneDescription: '', emotionTags: [] as string[] };

  it('uses weighted formula when AI is available', () => {
    const score = calculateWeightedScore(segment, true);
    expect(score).toBeCloseTo(60 * 0.4 + 80 * 0.6); // 24 + 48 = 72
  });

  it('uses pure overallScore when AI is not available', () => {
    const score = calculateWeightedScore(segment, false);
    expect(score).toBe(80);
  });
});

describe('EditPlanner - fallbackSelection with AI availability', () => {
  it('sorts by pure overallScore when no AI analysis is available', () => {
    const segments = [
      { index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 60, narrativeScore: 50, sceneDescription: '', emotionTags: [] },
      { index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 90, narrativeScore: 50, sceneDescription: '', emotionTags: [] },
      { index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 70, narrativeScore: 50, sceneDescription: '', emotionTags: [] },
    ];

    const plan = fallbackSelection(segments, 'media-1', 20);

    // With no AI analysis (all narrativeScore=50, empty descriptions),
    // should sort by overallScore: seg1(90) > seg2(70) > seg0(60)
    // Top 2 selected: seg1, seg2 — then sorted chronologically
    expect(plan.segments.length).toBe(2);
    expect(plan.narrativeSummary).toContain('AI 分析不可用');
  });

  it('sorts by weighted score when AI analysis is available', () => {
    const segments = [
      { index: 0, startTime: 0, endTime: 10, duration: 10, overallScore: 60, narrativeScore: 95, sceneDescription: '壮观的山景', emotionTags: ['壮观'] },
      { index: 1, startTime: 10, endTime: 20, duration: 10, overallScore: 90, narrativeScore: 30, sceneDescription: '普通街道', emotionTags: ['宁静'] },
      { index: 2, startTime: 20, endTime: 30, duration: 10, overallScore: 70, narrativeScore: 80, sceneDescription: '日落海滩', emotionTags: ['浪漫'] },
    ];

    const plan = fallbackSelection(segments, 'media-1', 20);

    // With AI analysis available:
    // seg0: 95*0.4 + 60*0.6 = 38 + 36 = 74
    // seg1: 30*0.4 + 90*0.6 = 12 + 54 = 66
    // seg2: 80*0.4 + 70*0.6 = 32 + 42 = 74
    // Top 2: seg0(74), seg2(74) — then sorted chronologically
    expect(plan.segments.length).toBe(2);
    expect(plan.narrativeSummary).not.toContain('AI 分析不可用');

    // Verify the selected segments are seg0 and seg2 (highest weighted scores)
    const selectedIndices = plan.segments.map(s => s.segmentIndex);
    expect(selectedIndices).toContain(0);
    expect(selectedIndices).toContain(2);
  });
});
