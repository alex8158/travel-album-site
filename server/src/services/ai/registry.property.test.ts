import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { AIProviderRegistry } from './registry';
import { AIProvider } from './types';

// Feature: v2-image-processing, Property 6: Registry Provider Lookup
// For any set of providers registered with unique names, requesting a provider by its
// registered name SHALL return that exact provider instance, and requesting a
// non-registered name SHALL throw an error.

function createMockProvider(name: string): AIProvider {
  return {
    metadata: { name, model: 'test', capabilities: ['text-generation'], costPerInputToken: 0, costPerOutputToken: 0 },
    generateText: async () => ({ text: '', inputTokens: 0, outputTokens: 0, elapsedMs: 0 }),
    analyzeImage: async () => ({ text: '', inputTokens: 0, outputTokens: 0, elapsedMs: 0 }),
    getHealth: async () => ({ available: true, latencyMs: 0 }),
  };
}

describe('Property 6: Registry Provider Lookup', () => {
  it('get(name) returns the exact provider instance for each registered name', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1 }),
        (names) => {
          const registry = new AIProviderRegistry();
          const providers = new Map<string, AIProvider>();

          // Register all providers
          for (const name of names) {
            const provider = createMockProvider(name);
            providers.set(name, provider);
            registry.register(name, provider);
          }

          // Verify get(name) returns the exact same instance
          for (const name of names) {
            const retrieved = registry.get(name);
            expect(retrieved).toBe(providers.get(name));
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('get(nonRegisteredName) throws an error', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (registeredNames, candidateName) => {
          // Only test when candidateName is NOT in the registered set
          if (registeredNames.includes(candidateName)) return;

          const registry = new AIProviderRegistry();

          for (const name of registeredNames) {
            registry.register(name, createMockProvider(name));
          }

          // Requesting a non-registered name should throw
          expect(() => registry.get(candidateName)).toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });
});
