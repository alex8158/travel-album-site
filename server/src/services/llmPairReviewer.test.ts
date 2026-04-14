import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { extractJSON } from './bedrockClient';
import { applyStrictThreshold, CLIP_STRICT_THRESHOLD } from './dedupThresholds';
import type {
  LLMProviderType,
  ProviderConfig,
  PairReviewRequest,
  PairReviewResult,
} from './llmPairReviewer';

// ============================================================================
// Mocks
// ============================================================================

// Mock bedrockClient — prevent real AWS/OpenAI client creation
vi.mock('./bedrockClient', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    createBedrockClient: vi.fn(() => ({
      invokeModel: vi.fn(async () => '{"is_duplicate": true, "confidence": 0.9}'),
    })),
    resizeForAnalysis: vi.fn(async () => 'dummyBase64'),
  };
});

// Mock openai module to prevent real API calls
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation((opts: any) => {
      // Store the options so tests can inspect them
      const instance = {
        _opts: opts,
        chat: {
          completions: {
            create: vi.fn(async () => ({
              choices: [{ message: { content: '{"is_duplicate": true, "confidence": 0.9}' } }],
            })),
          },
        },
      };
      return instance;
    }),
  };
});

// ============================================================================
// Helpers
// ============================================================================

/** Save and restore env vars around tests */
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'OPENAI_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'DASHSCOPE_API_KEY',
  'DASHSCOPE_BASE_URL',
  'DASHSCOPE_MODEL',
  'OPENAI_MODEL',
  'LLM_DEDUP_PROVIDER',
  'S3_REGION',
  'AWS_REGION',
  'BEDROCK_MODEL_ID',
];

function saveEnv() {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
}

function clearProviderEnv() {
  delete process.env.OPENAI_API_KEY;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.LLM_DEDUP_PROVIDER;
}

/** Create a mock ProviderConfig that succeeds with given response */
function mockProvider(
  type: LLMProviderType,
  response: { is_duplicate: boolean; confidence: number },
): ProviderConfig {
  return {
    type,
    client: {
      invokeModel: vi.fn(async () => JSON.stringify(response)),
    },
  };
}

/** Create a mock ProviderConfig that always fails */
function failingProvider(type: LLMProviderType): ProviderConfig {
  return {
    type,
    client: {
      invokeModel: vi.fn(async () => {
        throw new Error(`${type} provider failed`);
      }),
    },
  };
}

/** Create a dummy PairReviewRequest */
function makePair(
  idA: string,
  idB: string,
  similarity: number,
): PairReviewRequest {
  return {
    imageA: { id: idA, filePath: `/fake/${idA}.jpg` },
    imageB: { id: idB, filePath: `/fake/${idB}.jpg` },
    clipSimilarity: similarity,
  };
}

// ============================================================================
// Property Tests
// ============================================================================

describe('Property Tests — llmPairReviewer', () => {
  beforeEach(() => {
    saveEnv();
    clearProviderEnv();
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Feature: hybrid-dedup, Property 10: Provider 自动检测正确性
  // --------------------------------------------------------------------------
  describe('Property 10: Provider 自动检测正确性', () => {
    /**
     * Feature: hybrid-dedup, Property 10: Provider 自动检测正确性
     *
     * Generate random env var combinations (OPENAI_API_KEY present/absent ×
     * AWS credentials present/absent × DASHSCOPE_API_KEY present/absent).
     * Verify detectConfiguredProviders() returns correct providers.
     *
     * Validates: Requirements 6.1, 6.2
     */
    it('should detect exactly the providers whose env vars are set', async () => {
      const { detectConfiguredProviders } = await import('./llmPairReviewer');

      fc.assert(
        fc.property(
          fc.boolean(), // hasOpenAI
          fc.boolean(), // hasAWS
          fc.boolean(), // hasDashScope
          (hasOpenAI, hasAWS, hasDashScope) => {
            clearProviderEnv();

            if (hasOpenAI) process.env.OPENAI_API_KEY = 'sk-test-key';
            if (hasAWS) {
              process.env.AWS_ACCESS_KEY_ID = 'AKIATEST';
              process.env.AWS_SECRET_ACCESS_KEY = 'secret-test';
            }
            if (hasDashScope) process.env.DASHSCOPE_API_KEY = 'ds-test-key';

            const providers = detectConfiguredProviders();
            const types = providers.map((p) => p.type);

            // (a) OpenAI present iff OPENAI_API_KEY set
            expect(types.includes('openai')).toBe(hasOpenAI);
            // (b) Bedrock present iff both AWS keys set
            expect(types.includes('bedrock')).toBe(hasAWS);
            // (c) DashScope present iff DASHSCOPE_API_KEY set
            expect(types.includes('dashscope')).toBe(hasDashScope);
            // (d) No extra providers
            expect(types.length).toBe(
              (hasOpenAI ? 1 : 0) + (hasAWS ? 1 : 0) + (hasDashScope ? 1 : 0),
            );
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Feature: hybrid-dedup, Property 11: Provider 链排序正确性
  // --------------------------------------------------------------------------
  describe('Property 11: Provider 链排序正确性', () => {
    /**
     * Feature: hybrid-dedup, Property 11: Provider 链排序正确性
     *
     * Generate random configured provider lists and preferred provider.
     * Verify preferred provider is at chain front when configured.
     *
     * Validates: Requirements 6.3, 6.4
     */
    it('preferred provider should be at chain front when configured', async () => {
      const { detectConfiguredProviders } = await import('./llmPairReviewer');

      const providerTypeArb = fc.constantFrom<LLMProviderType>('openai', 'bedrock', 'dashscope');

      fc.assert(
        fc.property(
          // Which providers are configured (at least one)
          fc.boolean(),
          fc.boolean(),
          fc.boolean(),
          // Preferred provider
          providerTypeArb,
          (hasOpenAI, hasAWS, hasDashScope, preferred) => {
            clearProviderEnv();

            if (hasOpenAI) process.env.OPENAI_API_KEY = 'sk-test-key';
            if (hasAWS) {
              process.env.AWS_ACCESS_KEY_ID = 'AKIATEST';
              process.env.AWS_SECRET_ACCESS_KEY = 'secret-test';
            }
            if (hasDashScope) process.env.DASHSCOPE_API_KEY = 'ds-test-key';

            const providers = detectConfiguredProviders(preferred);
            const types = providers.map((p) => p.type);

            // Check if preferred is in the configured set
            const isPreferredConfigured =
              (preferred === 'openai' && hasOpenAI) ||
              (preferred === 'bedrock' && hasAWS) ||
              (preferred === 'dashscope' && hasDashScope);

            if (isPreferredConfigured && types.length > 0) {
              // Preferred should be first
              expect(types[0]).toBe(preferred);
            }

            // All configured providers should still be present
            if (hasOpenAI) expect(types).toContain('openai');
            if (hasAWS) expect(types).toContain('bedrock');
            if (hasDashScope) expect(types).toContain('dashscope');
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Feature: hybrid-dedup, Property 4: LLM 响应映射正确性
  // --------------------------------------------------------------------------
  describe('Property 4: LLM 响应映射正确性', () => {
    /**
     * Feature: hybrid-dedup, Property 4: LLM 响应映射正确性
     *
     * Generate random {is_duplicate: boolean, confidence: number} objects.
     * Verify mapping is correct: is_duplicate=true → isDuplicate=true,
     * is_duplicate=false → isDuplicate=false.
     *
     * Validates: Requirements 3.3, 3.4
     */
    it('LLM response mapping should preserve is_duplicate semantics', async () => {
      const { reviewPairs } = await import('./llmPairReviewer');

      await fc.assert(
        fc.asyncProperty(
          fc.boolean(),
          fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
          async (isDuplicate, confidence) => {
            const provider: ProviderConfig = {
              type: 'openai',
              client: {
                invokeModel: vi.fn(async () =>
                  JSON.stringify({ is_duplicate: isDuplicate, confidence }),
                ),
              },
            };

            const pair = makePair('a', 'b', 0.92);
            const results = await reviewPairs([pair], [provider]);

            expect(results).toHaveLength(1);
            expect(results[0].isDuplicate).toBe(isDuplicate);
            // Confidence should be clamped to [0, 1]
            expect(results[0].confidence).toBeGreaterThanOrEqual(0);
            expect(results[0].confidence).toBeLessThanOrEqual(1);
            expect(results[0].fellBackToThreshold).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Feature: hybrid-dedup, Property 5: LLM 响应 JSON 解析往返
  // --------------------------------------------------------------------------
  describe('Property 5: LLM 响应 JSON 解析往返', () => {
    /**
     * Feature: hybrid-dedup, Property 5: LLM 响应 JSON 解析往返
     *
     * Generate random valid {is_duplicate, confidence} JSON objects,
     * verify serialize then parse equals original.
     *
     * Validates: Requirements 3.2
     */
    it('JSON serialize → parse roundtrip should preserve values', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
          (isDuplicate, confidence) => {
            const original = { is_duplicate: isDuplicate, confidence };
            const serialized = JSON.stringify(original);
            const parsed = extractJSON<{ is_duplicate: boolean; confidence: number }>(serialized);

            expect(parsed.is_duplicate).toBe(original.is_duplicate);
            expect(parsed.confidence).toBe(original.confidence);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Feature: hybrid-dedup, Property 12: 级联回退正确性
  // --------------------------------------------------------------------------
  describe('Property 12: 级联回退正确性', () => {
    /**
     * Feature: hybrid-dedup, Property 12: 级联回退正确性
     *
     * Generate random provider chains and random failure patterns.
     * Verify cascade behavior: when provider k fails, try k+1;
     * when a provider succeeds, use its result and stop.
     *
     * Validates: Requirements 3.5, 6.6
     */
    it('should cascade through providers and use first successful result', async () => {
      const { reviewPairs } = await import('./llmPairReviewer');

      const providerTypeArb = fc.constantFrom<LLMProviderType>('openai', 'bedrock', 'dashscope');

      await fc.assert(
        fc.asyncProperty(
          // Chain of 1-3 providers, each with a success/fail flag
          fc.array(
            fc.tuple(providerTypeArb, fc.boolean()),
            { minLength: 1, maxLength: 3 },
          ),
          fc.boolean(), // expected isDuplicate result from successful provider
          async (providerSpecs, expectedDup) => {
            const chain: ProviderConfig[] = providerSpecs.map(([type, succeeds]) => {
              if (succeeds) {
                return mockProvider(type, { is_duplicate: expectedDup, confidence: 0.85 });
              } else {
                return failingProvider(type);
              }
            });

            const pair = makePair('x', 'y', 0.92);
            const results = await reviewPairs([pair], chain);

            expect(results).toHaveLength(1);
            const result = results[0];

            // Find the first successful provider index
            const firstSuccessIdx = providerSpecs.findIndex(([, succeeds]) => succeeds);

            if (firstSuccessIdx >= 0) {
              // Should use the first successful provider's result
              expect(result.isDuplicate).toBe(expectedDup);
              expect(result.usedProvider).toBe(providerSpecs[firstSuccessIdx][0]);
              expect(result.fellBackToThreshold).toBe(false);
            } else {
              // All failed → fallback to strict threshold
              expect(result.fellBackToThreshold).toBe(true);
              const expectedIsDup = applyStrictThreshold(pair.clipSimilarity);
              expect(result.isDuplicate).toBe(expectedIsDup);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Feature: hybrid-dedup, Property 13: 全 Provider 失败降级正确性
  // --------------------------------------------------------------------------
  describe('Property 13: 全 Provider 失败降级正确性', () => {
    /**
     * Feature: hybrid-dedup, Property 13: 全 Provider 失败降级正确性
     *
     * Generate random gray zone pairs and all-fail provider chains.
     * Verify fallback to Strict Threshold (0.955).
     *
     * Validates: Requirements 3.6, 6.8
     */
    it('should fallback to strict threshold when all providers fail', async () => {
      const { reviewPairs } = await import('./llmPairReviewer');

      await fc.assert(
        fc.asyncProperty(
          // Random similarity in gray zone range [0.85, 1.0]
          fc.double({ min: 0.85, max: 1.0, noNaN: true, noDefaultInfinity: true }),
          // 1-3 failing providers
          fc.integer({ min: 1, max: 3 }),
          async (similarity, numProviders) => {
            const providerTypes: LLMProviderType[] = ['openai', 'bedrock', 'dashscope'];
            const chain: ProviderConfig[] = [];
            for (let i = 0; i < numProviders; i++) {
              chain.push(failingProvider(providerTypes[i % 3]));
            }

            const pair = makePair('a', 'b', similarity);
            const results = await reviewPairs([pair], chain);

            expect(results).toHaveLength(1);
            const result = results[0];

            // Should have fallen back to strict threshold
            expect(result.fellBackToThreshold).toBe(true);
            expect(result.usedProvider).toBeUndefined();

            // Verify strict threshold logic
            const expectedIsDup = similarity >= CLIP_STRICT_THRESHOLD;
            expect(result.isDuplicate).toBe(expectedIsDup);

            // Confidence should be 0.955 when confirmed, 0 when not
            if (expectedIsDup) {
              expect(result.confidence).toBe(0.955);
            } else {
              expect(result.confidence).toBe(0);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});


// ============================================================================
// Unit Tests
// ============================================================================

describe('Unit Tests — llmPairReviewer', () => {
  beforeEach(() => {
    saveEnv();
    clearProviderEnv();
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // DashScope client creation (verify uses OpenAI SDK + custom base URL)
  // --------------------------------------------------------------------------
  describe('DashScope client creation', () => {
    it('should create DashScope client using OpenAI SDK with custom base URL', async () => {
      const OpenAI = (await import('openai')).default;

      process.env.DASHSCOPE_API_KEY = 'ds-test-key-123';
      process.env.DASHSCOPE_BASE_URL = 'https://custom.dashscope.example.com/v1';

      // Re-import to get fresh module with new env
      const { detectConfiguredProviders } = await import('./llmPairReviewer');
      const providers = detectConfiguredProviders();

      // DashScope should be detected
      const dsProvider = providers.find((p) => p.type === 'dashscope');
      expect(dsProvider).toBeDefined();

      // Verify OpenAI constructor was called with custom base URL
      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'ds-test-key-123',
          baseURL: 'https://custom.dashscope.example.com/v1',
        }),
      );
    });

    it('should use default DashScope base URL when DASHSCOPE_BASE_URL not set', async () => {
      const OpenAI = (await import('openai')).default;

      process.env.DASHSCOPE_API_KEY = 'ds-test-key-456';
      delete process.env.DASHSCOPE_BASE_URL;

      const { detectConfiguredProviders } = await import('./llmPairReviewer');
      const providers = detectConfiguredProviders();

      const dsProvider = providers.find((p) => p.type === 'dashscope');
      expect(dsProvider).toBeDefined();

      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'ds-test-key-456',
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // LLM returns invalid JSON error handling
  // --------------------------------------------------------------------------
  describe('LLM returns invalid JSON error handling', () => {
    it('should cascade to next provider when LLM returns invalid JSON', async () => {
      const { reviewPairs } = await import('./llmPairReviewer');

      const invalidJsonProvider: ProviderConfig = {
        type: 'openai',
        client: {
          invokeModel: vi.fn(async () => 'this is not valid json at all'),
        },
      };

      const validProvider = mockProvider('bedrock', {
        is_duplicate: true,
        confidence: 0.88,
      });

      const pair = makePair('a', 'b', 0.92);
      const results = await reviewPairs([pair], [invalidJsonProvider, validProvider]);

      expect(results).toHaveLength(1);
      expect(results[0].isDuplicate).toBe(true);
      expect(results[0].usedProvider).toBe('bedrock');
      expect(results[0].fellBackToThreshold).toBe(false);
    });

    it('should fallback to strict threshold when all providers return invalid JSON', async () => {
      const { reviewPairs } = await import('./llmPairReviewer');

      const invalidProvider1: ProviderConfig = {
        type: 'openai',
        client: {
          invokeModel: vi.fn(async () => 'not json'),
        },
      };
      const invalidProvider2: ProviderConfig = {
        type: 'bedrock',
        client: {
          invokeModel: vi.fn(async () => '<<<invalid>>>'),
        },
      };

      const pair = makePair('a', 'b', 0.96);
      const results = await reviewPairs([pair], [invalidProvider1, invalidProvider2]);

      expect(results).toHaveLength(1);
      expect(results[0].fellBackToThreshold).toBe(true);
      expect(results[0].isDuplicate).toBe(true); // 0.96 >= 0.955
    });
  });

  // --------------------------------------------------------------------------
  // LLM_DEDUP_PROVIDER various values parsing
  // --------------------------------------------------------------------------
  describe('LLM_DEDUP_PROVIDER parsing', () => {
    it('should put openai first when LLM_DEDUP_PROVIDER=openai', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.AWS_ACCESS_KEY_ID = 'AKIA';
      process.env.AWS_SECRET_ACCESS_KEY = 'secret';
      process.env.DASHSCOPE_API_KEY = 'ds-key';
      process.env.LLM_DEDUP_PROVIDER = 'openai';

      const { detectConfiguredProviders } = await import('./llmPairReviewer');
      const providers = detectConfiguredProviders();
      const types = providers.map((p) => p.type);

      expect(types[0]).toBe('openai');
      expect(types).toContain('bedrock');
      expect(types).toContain('dashscope');
    });

    it('should put bedrock first when LLM_DEDUP_PROVIDER=bedrock', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.AWS_ACCESS_KEY_ID = 'AKIA';
      process.env.AWS_SECRET_ACCESS_KEY = 'secret';
      process.env.DASHSCOPE_API_KEY = 'ds-key';
      process.env.LLM_DEDUP_PROVIDER = 'bedrock';

      const { detectConfiguredProviders } = await import('./llmPairReviewer');
      const providers = detectConfiguredProviders();
      const types = providers.map((p) => p.type);

      expect(types[0]).toBe('bedrock');
      expect(types).toContain('openai');
      expect(types).toContain('dashscope');
    });

    it('should put dashscope first when LLM_DEDUP_PROVIDER=dashscope', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.AWS_ACCESS_KEY_ID = 'AKIA';
      process.env.AWS_SECRET_ACCESS_KEY = 'secret';
      process.env.DASHSCOPE_API_KEY = 'ds-key';
      process.env.LLM_DEDUP_PROVIDER = 'dashscope';

      const { detectConfiguredProviders } = await import('./llmPairReviewer');
      const providers = detectConfiguredProviders();
      const types = providers.map((p) => p.type);

      expect(types[0]).toBe('dashscope');
      expect(types).toContain('openai');
      expect(types).toContain('bedrock');
    });

    it('should use default order when LLM_DEDUP_PROVIDER is empty', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.AWS_ACCESS_KEY_ID = 'AKIA';
      process.env.AWS_SECRET_ACCESS_KEY = 'secret';
      process.env.DASHSCOPE_API_KEY = 'ds-key';
      process.env.LLM_DEDUP_PROVIDER = '';

      const { detectConfiguredProviders } = await import('./llmPairReviewer');
      const providers = detectConfiguredProviders();
      const types = providers.map((p) => p.type);

      // Default order: OpenAI → Bedrock → DashScope
      expect(types).toEqual(['openai', 'bedrock', 'dashscope']);
    });

    it('should log warning and ignore invalid LLM_DEDUP_PROVIDER value', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.LLM_DEDUP_PROVIDER = 'invalid-provider';

      const { detectConfiguredProviders } = await import('./llmPairReviewer');
      const providers = detectConfiguredProviders();

      // Should still detect openai
      expect(providers.map((p) => p.type)).toContain('openai');

      // Should have logged a warning about invalid value
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid LLM_DEDUP_PROVIDER value 'invalid-provider'"),
      );

      warnSpy.mockRestore();
    });
  });

  // --------------------------------------------------------------------------
  // Preferred provider env vars not configured warning log
  // --------------------------------------------------------------------------
  describe('Preferred provider not configured warning', () => {
    it('should log warning when preferred provider env vars are not configured', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Only OpenAI configured, but prefer bedrock
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.LLM_DEDUP_PROVIDER = 'bedrock';

      const { detectConfiguredProviders } = await import('./llmPairReviewer');
      const providers = detectConfiguredProviders();

      // Should still have openai
      expect(providers.map((p) => p.type)).toContain('openai');
      expect(providers.map((p) => p.type)).not.toContain('bedrock');

      // Should have logged warning about bedrock not being configured
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Preferred provider 'bedrock' is not configured"),
      );

      warnSpy.mockRestore();
    });

    it('should log warning when preferred dashscope is not configured', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      process.env.AWS_ACCESS_KEY_ID = 'AKIA';
      process.env.AWS_SECRET_ACCESS_KEY = 'secret';
      process.env.LLM_DEDUP_PROVIDER = 'dashscope';

      const { detectConfiguredProviders } = await import('./llmPairReviewer');
      const providers = detectConfiguredProviders();

      expect(providers.map((p) => p.type)).toContain('bedrock');
      expect(providers.map((p) => p.type)).not.toContain('dashscope');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Preferred provider 'dashscope' is not configured"),
      );

      warnSpy.mockRestore();
    });
  });
});
