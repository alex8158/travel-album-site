import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AIProviderRegistry, InvocationContext } from './registry';
import { AIProvider, AIProviderMetadata, AIResponse } from './types';
import Database from 'better-sqlite3';

// Mock the database module
vi.mock('../../database', () => {
  let mockDb: Database.Database | null = null;

  return {
    getDb: () => {
      if (!mockDb) {
        mockDb = new Database(':memory:');
        mockDb.exec(`
          CREATE TABLE ai_invocations (
            id TEXT PRIMARY KEY,
            media_id TEXT,
            segment_id TEXT,
            provider TEXT,
            model_name TEXT,
            task_type TEXT,
            request_payload TEXT,
            response_payload TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            estimated_cost REAL,
            status TEXT,
            error_message TEXT,
            started_at TEXT,
            finished_at TEXT,
            created_at TEXT NOT NULL
          )
        `);
      }
      return mockDb;
    },
    __resetDb: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    }
  };
});

function createMockProvider(overrides?: Partial<AIProviderMetadata>): AIProvider {
  const metadata: AIProviderMetadata = {
    name: 'test-provider',
    model: 'test-model-v1',
    capabilities: ['text-generation', 'image-analysis'],
    costPerInputToken: 0.00001,
    costPerOutputToken: 0.00003,
    ...overrides,
  };

  return {
    metadata,
    generateText: vi.fn().mockResolvedValue({
      text: 'Generated text response',
      inputTokens: 100,
      outputTokens: 50,
      elapsedMs: 500,
    } as AIResponse),
    analyzeImage: vi.fn().mockResolvedValue({
      text: 'Image analysis response',
      inputTokens: 200,
      outputTokens: 80,
      elapsedMs: 1200,
    } as AIResponse),
    getHealth: vi.fn().mockResolvedValue({ available: true, latencyMs: 100 }),
  };
}

describe('AIProviderRegistry auto-logging', () => {
  let registry: AIProviderRegistry;
  let mockProvider: AIProvider;
  let db: Database.Database;

  beforeEach(async () => {
    const { getDb } = await import('../../database');
    db = getDb();
    registry = new AIProviderRegistry();
    mockProvider = createMockProvider();
    registry.register('test-provider', mockProvider);
  });

  afterEach(async () => {
    const { __resetDb } = await import('../../database') as any;
    __resetDb();
    vi.clearAllMocks();
  });

  describe('invokeText', () => {
    const context: InvocationContext = {
      mediaId: 'media-123',
      taskType: 'image_enhancement',
    };

    it('should create a pending ai_invocations record before calling provider', async () => {
      await registry.invokeText('test prompt', context);

      const rows = db.prepare('SELECT * FROM ai_invocations').all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].provider).toBe('test-provider');
      expect(rows[0].model_name).toBe('test-model-v1');
      expect(rows[0].task_type).toBe('image_enhancement');
      expect(rows[0].media_id).toBe('media-123');
    });

    it('should update record to completed on success', async () => {
      await registry.invokeText('test prompt', context);

      const row = db.prepare('SELECT * FROM ai_invocations').get() as any;
      expect(row.status).toBe('completed');
      expect(row.input_tokens).toBe(100);
      expect(row.output_tokens).toBe(50);
      expect(row.finished_at).toBeTruthy();
      expect(row.response_payload).toBe(JSON.stringify({ text: 'Generated text response' }));
    });

    it('should compute estimated_cost correctly', async () => {
      await registry.invokeText('test prompt', context);

      const row = db.prepare('SELECT * FROM ai_invocations').get() as any;
      // 100 * 0.00001 + 50 * 0.00003 = 0.001 + 0.0015 = 0.0025
      expect(row.estimated_cost).toBeCloseTo(0.0025, 6);
    });

    it('should update record to failed on error', async () => {
      (mockProvider.generateText as any).mockRejectedValue(new Error('Provider timeout'));

      await expect(registry.invokeText('test prompt', context)).rejects.toThrow('Provider timeout');

      const row = db.prepare('SELECT * FROM ai_invocations').get() as any;
      expect(row.status).toBe('failed');
      expect(row.error_message).toBe('Provider timeout');
      expect(row.finished_at).toBeTruthy();
    });

    it('should store segment_id when provided in context', async () => {
      const ctxWithSegment: InvocationContext = {
        mediaId: 'media-456',
        segmentId: 'segment-789',
        taskType: 'pair_review',
      };

      await registry.invokeText('test prompt', ctxWithSegment);

      const row = db.prepare('SELECT * FROM ai_invocations').get() as any;
      expect(row.segment_id).toBe('segment-789');
    });

    it('should store null for optional context fields when not provided', async () => {
      const minimalContext: InvocationContext = { taskType: 'color_cast_analysis' };

      await registry.invokeText('test prompt', minimalContext);

      const row = db.prepare('SELECT * FROM ai_invocations').get() as any;
      expect(row.media_id).toBeNull();
      expect(row.segment_id).toBeNull();
    });
  });

  describe('invokeImageAnalysis', () => {
    const images = [{ base64: 'abc123', mediaType: 'image/jpeg' }];
    const context: InvocationContext = {
      mediaId: 'media-img-1',
      taskType: 'color_cast_analysis',
    };

    it('should create a pending record and update to completed on success', async () => {
      await registry.invokeImageAnalysis(images, 'analyze this', context);

      const row = db.prepare('SELECT * FROM ai_invocations').get() as any;
      expect(row.status).toBe('completed');
      expect(row.provider).toBe('test-provider');
      expect(row.model_name).toBe('test-model-v1');
      expect(row.task_type).toBe('color_cast_analysis');
      expect(row.media_id).toBe('media-img-1');
      expect(row.input_tokens).toBe(200);
      expect(row.output_tokens).toBe(80);
      expect(row.response_payload).toBe(JSON.stringify({ text: 'Image analysis response' }));
    });

    it('should compute estimated_cost for image analysis', async () => {
      await registry.invokeImageAnalysis(images, 'analyze this', context);

      const row = db.prepare('SELECT * FROM ai_invocations').get() as any;
      // 200 * 0.00001 + 80 * 0.00003 = 0.002 + 0.0024 = 0.0044
      expect(row.estimated_cost).toBeCloseTo(0.0044, 6);
    });

    it('should update record to failed on error', async () => {
      (mockProvider.analyzeImage as any).mockRejectedValue(new Error('Rate limited'));

      await expect(
        registry.invokeImageAnalysis(images, 'analyze this', context)
      ).rejects.toThrow('Rate limited');

      const row = db.prepare('SELECT * FROM ai_invocations').get() as any;
      expect(row.status).toBe('failed');
      expect(row.error_message).toBe('Rate limited');
      expect(row.finished_at).toBeTruthy();
    });

    it('should use specified provider when providerName option is given', async () => {
      const secondProvider = createMockProvider({ name: 'second-provider', model: 'model-2' });
      registry.register('second-provider', secondProvider);

      await registry.invokeImageAnalysis(images, 'analyze', context, {
        providerName: 'second-provider',
      });

      const row = db.prepare('SELECT * FROM ai_invocations').get() as any;
      expect(row.provider).toBe('second-provider');
      expect(row.model_name).toBe('model-2');
    });
  });
});
