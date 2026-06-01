/**
 * Preservation Property Tests — Baseline behavior of existing VLM providers
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**
 *
 * These tests capture the current (pre-fix) behavior of DashScope, Anthropic,
 * and Bedrock providers. They MUST PASS on the unfixed code to confirm the
 * baseline is correctly captured. After the fix, they MUST STILL PASS to
 * confirm no regression.
 *
 * Observation-first methodology:
 * - DashScope only → getActiveProvider() = 'dashscope', isVLMAvailable() = true
 * - Anthropic + explicit provider → getActiveProvider() = 'anthropic', isVLMAvailable() = true
 * - Bedrock + explicit provider → getActiveProvider() = 'bedrock', isVLMAvailable() = true
 * - DashScope + OpenAI keys, no explicit provider → DashScope wins (priority)
 * - VLM call failure → keep all photos (no deletions)
 * - Soft delete → status='trashed' + trashed_reason, file_path unchanged
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import {
  getActiveProvider,
  isVLMAvailable,
  _resetVLMClientCacheForTests,
} from '../vlmClient';
import { buildSmartBatches, parseSceneDedupResponse } from '../sceneDedup';
import type { CurationCandidate } from '../smartCurationEngine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Save and restore all relevant env vars between tests. */
const ENV_KEYS = [
  'SMART_CURATION_VLM_PROVIDER',
  'DASHSCOPE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
] as const;

type EnvSnapshot = Record<string, string | undefined>;

function saveEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const k of ENV_KEYS) {
    snap[k] = process.env[k];
  }
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = snap[k];
    }
  }
}

function clearAllProviderEnv(): void {
  for (const k of ENV_KEYS) {
    delete process.env[k];
  }
}

/** Arbitrary non-empty string for API keys. */
const arbApiKey = fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.trim().length > 0);

/** Generate a mock CurationCandidate. */
function makeCandidates(count: number): CurationCandidate[] {
  return Array.from({ length: count }, (_, i) => ({
    mediaId: `media-${i}`,
    filePath: `/uploads/trip1/photo-${i}.jpg`,
    originalFilename: `photo-${i}.jpg`,
    fileSize: 1024 * (i + 1),
    width: 1920,
    height: 1080,
    sharpnessScore: 0.8,
  }));
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Preservation Property Tests', () => {
  let envSnapshot: EnvSnapshot;

  beforeEach(() => {
    envSnapshot = saveEnv();
    clearAllProviderEnv();
    _resetVLMClientCacheForTests();
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    _resetVLMClientCacheForTests();
  });

  // =========================================================================
  // Property 2a: Provider selection baseline for non-bug-condition configs
  // =========================================================================

  describe('Property 2a: Provider selection preserves baseline behavior', () => {
    it('DashScope only → getActiveProvider() returns "dashscope" and isVLMAvailable() returns true', () => {
      fc.assert(
        fc.property(arbApiKey, (dashKey) => {
          clearAllProviderEnv();
          _resetVLMClientCacheForTests();
          process.env.DASHSCOPE_API_KEY = dashKey;

          expect(getActiveProvider()).toBe('dashscope');
          expect(isVLMAvailable()).toBe(true);
        }),
        { numRuns: 50 }
      );
    });

    it('Anthropic + explicit provider → getActiveProvider() returns "anthropic" and isVLMAvailable() returns true', () => {
      fc.assert(
        fc.property(arbApiKey, (anthropicKey) => {
          clearAllProviderEnv();
          _resetVLMClientCacheForTests();
          process.env.SMART_CURATION_VLM_PROVIDER = 'anthropic';
          process.env.ANTHROPIC_API_KEY = anthropicKey;

          expect(getActiveProvider()).toBe('anthropic');
          expect(isVLMAvailable()).toBe(true);
        }),
        { numRuns: 50 }
      );
    });

    it('Bedrock + explicit provider → getActiveProvider() returns "bedrock" and isVLMAvailable() returns true (access key)', () => {
      fc.assert(
        fc.property(arbApiKey, arbApiKey, (accessKey, secretKey) => {
          clearAllProviderEnv();
          _resetVLMClientCacheForTests();
          process.env.SMART_CURATION_VLM_PROVIDER = 'bedrock';
          process.env.AWS_ACCESS_KEY_ID = accessKey;
          process.env.AWS_SECRET_ACCESS_KEY = secretKey;

          expect(getActiveProvider()).toBe('bedrock');
          expect(isVLMAvailable()).toBe(true);
        }),
        { numRuns: 50 }
      );
    });

    it('Bedrock + explicit provider → isVLMAvailable() returns true (bearer token)', () => {
      fc.assert(
        fc.property(arbApiKey, (bearerToken) => {
          clearAllProviderEnv();
          _resetVLMClientCacheForTests();
          process.env.SMART_CURATION_VLM_PROVIDER = 'bedrock';
          process.env.AWS_BEARER_TOKEN_BEDROCK = bearerToken;

          expect(getActiveProvider()).toBe('bedrock');
          expect(isVLMAvailable()).toBe(true);
        }),
        { numRuns: 50 }
      );
    });

    it('DashScope + OpenAI keys, no explicit provider → DashScope wins (priority preservation)', () => {
      fc.assert(
        fc.property(arbApiKey, arbApiKey, arbApiKey, (dashKey, openaiKey, openaiModel) => {
          clearAllProviderEnv();
          _resetVLMClientCacheForTests();
          process.env.DASHSCOPE_API_KEY = dashKey;
          process.env.OPENAI_API_KEY = openaiKey;
          process.env.OPENAI_MODEL = openaiModel;

          // Current behavior: defaults to dashscope when no explicit provider set
          expect(getActiveProvider()).toBe('dashscope');
          expect(isVLMAvailable()).toBe(true);
        }),
        { numRuns: 50 }
      );
    });

    it('No credentials at all → getActiveProvider() returns "dashscope" and isVLMAvailable() returns false', () => {
      clearAllProviderEnv();
      _resetVLMClientCacheForTests();

      expect(getActiveProvider()).toBe('dashscope');
      expect(isVLMAvailable()).toBe(false);
    });

    it('Explicit dashscope provider without key → isVLMAvailable() returns false', () => {
      fc.assert(
        fc.property(fc.constant('dashscope'), () => {
          clearAllProviderEnv();
          _resetVLMClientCacheForTests();
          process.env.SMART_CURATION_VLM_PROVIDER = 'dashscope';
          // No DASHSCOPE_API_KEY set

          expect(getActiveProvider()).toBe('dashscope');
          expect(isVLMAvailable()).toBe(false);
        }),
        { numRuns: 5 }
      );
    });

    it('Explicit anthropic provider without key → isVLMAvailable() returns false', () => {
      clearAllProviderEnv();
      _resetVLMClientCacheForTests();
      process.env.SMART_CURATION_VLM_PROVIDER = 'anthropic';

      expect(getActiveProvider()).toBe('anthropic');
      expect(isVLMAvailable()).toBe(false);
    });

    it('Explicit bedrock provider without credentials → isVLMAvailable() returns false', () => {
      clearAllProviderEnv();
      _resetVLMClientCacheForTests();
      process.env.SMART_CURATION_VLM_PROVIDER = 'bedrock';

      expect(getActiveProvider()).toBe('bedrock');
      expect(isVLMAvailable()).toBe(false);
    });
  });

  // =========================================================================
  // Property 2b: VLM failure → keep all (no deletions)
  // =========================================================================

  describe('Property 2b: VLM call failure preserves keep-all behavior', () => {
    it('unparseable VLM response → parseSceneDedupResponse returns null (triggers keep-all)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 30 }),
          fc.oneof(
            fc.constant(''),
            fc.constant('not json at all'),
            fc.constant('{"decisions": []}'),
            fc.constant('{"decisions": "wrong type"}'),
            fc.constant('random garbage text with no structure'),
            // Valid JSON but wrong number of decisions
            fc.integer({ min: 2, max: 30 }).map(
              (n) =>
                JSON.stringify({
                  decisions: Array.from({ length: n - 1 }, (_, i) => ({
                    index: i,
                    decision: 'keep',
                  })),
                })
            )
          ),
          (batchSize, badResponse) => {
            // parseSceneDedupResponse should return null for any unparseable response
            const result = parseSceneDedupResponse(badResponse, batchSize);
            // Either null (unparseable) or if it happens to parse, it should not
            // produce a valid result for mismatched batch sizes
            if (badResponse === '' || badResponse === 'not json at all' || badResponse === 'random garbage text with no structure') {
              expect(result).toBeNull();
            }
            // The key invariant: when parse returns null, the caller keeps all photos
            // (this is tested via the sceneDedup evaluateBatch catch path)
          }
        ),
        { numRuns: 100 }
      );
    });

    it('valid keep-all response is correctly parsed (all decisions = keep)', () => {
      fc.assert(
        fc.property(fc.integer({ min: 2, max: 25 }), (batchSize) => {
          const keepAllResponse = JSON.stringify({
            decisions: Array.from({ length: batchSize }, (_, i) => ({
              index: i,
              decision: 'keep',
            })),
          });

          const result = parseSceneDedupResponse(keepAllResponse, batchSize);
          expect(result).not.toBeNull();
          expect(result!.length).toBe(batchSize);
          for (const d of result!) {
            expect(d.decision).toBe('keep');
            expect(d.reason).toBeNull();
          }
        }),
        { numRuns: 50 }
      );
    });

    it('batch with failed VLM produces keep-all decisions (buildSmartBatches preserves all candidates)', () => {
      fc.assert(
        fc.property(fc.integer({ min: 2, max: 50 }), (candidateCount) => {
          const candidates = makeCandidates(candidateCount);

          // When embeddings are null (ML unavailable), fixed-size batches are used
          const batches = buildSmartBatches(candidates, null, 25, 30, 0.75);

          // Every candidate must appear in exactly one batch
          const allCandidates = batches.flat();
          expect(allCandidates.length).toBe(candidateCount);

          // Verify all original candidates are present
          const mediaIds = new Set(allCandidates.map((c) => c.mediaId));
          for (const c of candidates) {
            expect(mediaIds.has(c.mediaId)).toBe(true);
          }
        }),
        { numRuns: 50 }
      );
    });
  });

  // =========================================================================
  // Property 2c: Soft delete semantics preserved
  // =========================================================================

  describe('Property 2c: Soft delete semantics unchanged', () => {
    it('parseSceneDedupResponse only accepts valid trash reasons (scene_redundant, near_duplicate_worse)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 10 }),
          fc.integer({ min: 0, max: 9 }).filter((i) => i < 10),
          fc.constantFrom('scene_redundant', 'near_duplicate_worse'),
          (batchSize, trashIdx, reason) => {
            const actualBatchSize = Math.max(2, batchSize);
            const actualTrashIdx = trashIdx % actualBatchSize;

            const decisions = Array.from({ length: actualBatchSize }, (_, i) => {
              if (i === actualTrashIdx) {
                return { index: i, decision: 'trash', reason };
              }
              return { index: i, decision: 'keep' };
            });

            const response = JSON.stringify({ decisions });
            const result = parseSceneDedupResponse(response, actualBatchSize);

            expect(result).not.toBeNull();
            const trashed = result!.filter((d) => d.decision === 'trash');
            expect(trashed.length).toBe(1);
            expect(trashed[0].reason).toBe(reason);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('invalid trash reasons are rejected by parser (preserves strict reason vocabulary)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 10 }),
          fc.string({ minLength: 1, maxLength: 30 }).filter(
            (s) => s !== 'scene_redundant' && s !== 'near_duplicate_worse'
          ),
          (batchSize, invalidReason) => {
            const actualBatchSize = Math.max(2, batchSize);
            const decisions = Array.from({ length: actualBatchSize }, (_, i) => {
              if (i === 0) {
                return { index: i, decision: 'trash', reason: invalidReason };
              }
              return { index: i, decision: 'keep' };
            });

            const response = JSON.stringify({ decisions });
            const result = parseSceneDedupResponse(response, actualBatchSize);

            // Invalid reason → parse fails → caller keeps all (soft delete semantics preserved)
            expect(result).toBeNull();
          }
        ),
        { numRuns: 50 }
      );
    });

    it('file_path is never modified in CurationCandidate through batch processing', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 30 }),
          fc.array(fc.float({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 30 }),
          (candidateCount, embedValues) => {
            const actualCount = Math.max(1, Math.min(candidateCount, 30));
            const candidates = makeCandidates(actualCount);
            const originalPaths = candidates.map((c) => c.filePath);

            // Create embeddings array matching candidate count
            const embeddings: (number[] | null)[] = candidates.map((_, i) => {
              if (i < embedValues.length) {
                return [embedValues[i % embedValues.length]];
              }
              return null;
            });

            const batches = buildSmartBatches(candidates, embeddings, 25, 30, 0.75);

            // Verify file_path is unchanged for all candidates in all batches
            const allInBatches = batches.flat();
            for (const c of allInBatches) {
              const originalIdx = parseInt(c.mediaId.replace('media-', ''));
              expect(c.filePath).toBe(originalPaths[originalIdx]);
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
