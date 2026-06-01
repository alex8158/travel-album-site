/**
 * Bug Condition Exploration Test — OpenAI-compatible VLM Provider 不被识别
 *
 * **Validates: Requirements 1.1, 1.3, 2.1, 2.7**
 *
 * This test encodes the EXPECTED (correct) behavior:
 * - When OPENAI_API_KEY is set and SMART_CURATION_VLM_PROVIDER=openai,
 *   getActiveProvider() should return 'openai'
 * - When OPENAI_API_KEY + OPENAI_MODEL are set (no other provider keys),
 *   isVLMAvailable() should return true
 *
 * On UNFIXED code, these tests FAIL — confirming the bug exists.
 * On FIXED code, these tests PASS — confirming the fix is correct.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import {
  getActiveProvider,
  isVLMAvailable,
  _resetVLMClientCacheForTests,
} from '../vlmClient';

// Helper to save and restore env vars
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
  }
  // Clear all VLM-related env vars first to isolate tests
  const allVLMKeys = [
    'SMART_CURATION_VLM_PROVIDER',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'OPENAI_BASE_URL',
    'DASHSCOPE_API_KEY',
    'ANTHROPIC_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_BEARER_TOKEN_BEDROCK',
  ];
  for (const key of allVLMKeys) {
    delete process.env[key];
  }
  // Set the specified vars
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    // Restore original env
    for (const key of allVLMKeys) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('Bug Condition: OpenAI-compatible VLM Provider not recognised', () => {
  beforeEach(() => {
    _resetVLMClientCacheForTests();
  });

  afterEach(() => {
    _resetVLMClientCacheForTests();
  });

  it('Scenario 1: getActiveProvider() should return "openai" when SMART_CURATION_VLM_PROVIDER=openai', () => {
    withEnv(
      {
        SMART_CURATION_VLM_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
      },
      () => {
        const provider = getActiveProvider();
        // Expected behavior: should return 'openai'
        // Bug condition: returns 'dashscope' (falls back because 'openai' is not recognised)
        expect(provider).toBe('openai');
      }
    );
  });

  it('Scenario 2: isVLMAvailable() should return true when OPENAI_API_KEY + OPENAI_MODEL are set', () => {
    withEnv(
      {
        OPENAI_API_KEY: 'sk-test',
        OPENAI_MODEL: 'gpt-4o',
      },
      () => {
        const available = isVLMAvailable();
        // Expected behavior: should return true (OpenAI provider detected via auto-detect)
        // Bug condition: returns false (falls back to dashscope, checks DASHSCOPE_API_KEY which is unset)
        expect(available).toBe(true);
      }
    );
  });

  it('Scenario 3 (Property): isVLMAvailable() should always return true for any OPENAI_API_KEY + OPENAI_MODEL combination (no other provider keys)', () => {
    fc.assert(
      fc.property(
        // Generate random non-empty API key strings (simulating various key formats)
        fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.trim().length > 0),
        // Generate random non-empty model name strings
        fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.trim().length > 0),
        (apiKey, model) => {
          _resetVLMClientCacheForTests();
          withEnv(
            {
              OPENAI_API_KEY: apiKey,
              OPENAI_MODEL: model,
              // Explicitly unset other provider keys
              DASHSCOPE_API_KEY: undefined,
              ANTHROPIC_API_KEY: undefined,
              AWS_ACCESS_KEY_ID: undefined,
              AWS_SECRET_ACCESS_KEY: undefined,
              AWS_BEARER_TOKEN_BEDROCK: undefined,
            },
            () => {
              // Property: For any valid OPENAI_API_KEY + OPENAI_MODEL combination,
              // with no other provider keys set, isVLMAvailable() must return true
              const available = isVLMAvailable();
              expect(available).toBe(true);
            }
          );
        }
      ),
      { numRuns: 50 }
    );
  });
});
