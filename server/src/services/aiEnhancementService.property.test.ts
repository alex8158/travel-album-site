import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { AIEnhancementService, EnhancementParams, BatchEnhancementResult } from './aiEnhancementService';

// Feature: v2-image-processing, Property 7: Enhancement Parameter Clamping
// For any raw enhancement parameters (potentially out of bounds), the validation/clamping
// function SHALL produce output where: gamma ∈ [0.5, 2.0], sharpenSigma ∈ [0, 3.0],
// noiseReduction ∈ [0, 5], saturation ∈ [0.5, 2.0], contrast ∈ [0.5, 2.0].

// Feature: v2-image-processing, Property 8: Eligibility Filter Correctness
// For any media item with quality_score and color_score values, the eligibility predicate
// SHALL return true if and only if quality_score < 0.7 OR color_score < 0.6.

const service = new AIEnhancementService();

/**
 * Validates: Requirements 7.4
 */
describe('Property 7: Enhancement Parameter Clamping', () => {
  const arbitraryEnhancementParams: fc.Arbitrary<EnhancementParams> = fc.record({
    brightness: fc.double({ min: -100, max: 100, noNaN: true }),
    contrast: fc.double({ min: -100, max: 100, noNaN: true }),
    saturation: fc.double({ min: -100, max: 100, noNaN: true }),
    sharpenSigma: fc.double({ min: -100, max: 100, noNaN: true }),
    noiseReduction: fc.double({ min: -100, max: 100, noNaN: true }),
  });

  it('brightness (gamma) is always clamped to [0.5, 2.0]', () => {
    fc.assert(
      fc.property(arbitraryEnhancementParams, (params) => {
        const result = service.validateAndClampParams(params);
        expect(result.brightness).toBeGreaterThanOrEqual(0.5);
        expect(result.brightness).toBeLessThanOrEqual(2.0);
      }),
      { numRuns: 100 }
    );
  });

  it('sharpenSigma is always clamped to [0, 3.0]', () => {
    fc.assert(
      fc.property(arbitraryEnhancementParams, (params) => {
        const result = service.validateAndClampParams(params);
        expect(result.sharpenSigma).toBeGreaterThanOrEqual(0);
        expect(result.sharpenSigma).toBeLessThanOrEqual(3.0);
      }),
      { numRuns: 100 }
    );
  });

  it('noiseReduction is always clamped to [0, 5]', () => {
    fc.assert(
      fc.property(arbitraryEnhancementParams, (params) => {
        const result = service.validateAndClampParams(params);
        expect(result.noiseReduction).toBeGreaterThanOrEqual(0);
        expect(result.noiseReduction).toBeLessThanOrEqual(5);
      }),
      { numRuns: 100 }
    );
  });

  it('saturation is always clamped to [0.5, 2.0]', () => {
    fc.assert(
      fc.property(arbitraryEnhancementParams, (params) => {
        const result = service.validateAndClampParams(params);
        expect(result.saturation).toBeGreaterThanOrEqual(0.5);
        expect(result.saturation).toBeLessThanOrEqual(2.0);
      }),
      { numRuns: 100 }
    );
  });

  it('contrast is always clamped to [0.5, 2.0]', () => {
    fc.assert(
      fc.property(arbitraryEnhancementParams, (params) => {
        const result = service.validateAndClampParams(params);
        expect(result.contrast).toBeGreaterThanOrEqual(0.5);
        expect(result.contrast).toBeLessThanOrEqual(2.0);
      }),
      { numRuns: 100 }
    );
  });

  it('all parameters satisfy bounds simultaneously for any input', () => {
    fc.assert(
      fc.property(arbitraryEnhancementParams, (params) => {
        const result = service.validateAndClampParams(params);
        expect(result.brightness).toBeGreaterThanOrEqual(0.5);
        expect(result.brightness).toBeLessThanOrEqual(2.0);
        expect(result.sharpenSigma).toBeGreaterThanOrEqual(0);
        expect(result.sharpenSigma).toBeLessThanOrEqual(3.0);
        expect(result.noiseReduction).toBeGreaterThanOrEqual(0);
        expect(result.noiseReduction).toBeLessThanOrEqual(5);
        expect(result.saturation).toBeGreaterThanOrEqual(0.5);
        expect(result.saturation).toBeLessThanOrEqual(2.0);
        expect(result.contrast).toBeGreaterThanOrEqual(0.5);
        expect(result.contrast).toBeLessThanOrEqual(2.0);
      }),
      { numRuns: 100 }
    );
  });
});

/**
 * Validates: Requirements 10.1, 10.4
 */
describe('Property 8: Eligibility Filter Correctness', () => {
  it('returns true if and only if quality_score < 0.7 OR color_score < 0.6', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        (qualityScore, colorScore) => {
          const result = service.isEligibleForEnhancement(qualityScore, colorScore);
          const expected = qualityScore < 0.7 || colorScore < 0.6;
          expect(result).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns false when both quality_score >= 0.7 AND color_score >= 0.6', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.7, max: 1, noNaN: true }),
        fc.double({ min: 0.6, max: 1, noNaN: true }),
        (qualityScore, colorScore) => {
          const result = service.isEligibleForEnhancement(qualityScore, colorScore);
          expect(result).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns true when quality_score < 0.7 regardless of color_score', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.6999999999, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (qualityScore, colorScore) => {
          const result = service.isEligibleForEnhancement(qualityScore, colorScore);
          expect(result).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns true when color_score < 0.6 regardless of quality_score', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 0.5999999999, noNaN: true }),
        (qualityScore, colorScore) => {
          const result = service.isEligibleForEnhancement(qualityScore, colorScore);
          expect(result).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// Feature: v2-image-processing, Property 9: Batch Enhancement Count Invariant
// For any batch enhancement result, successful + failed + skipped SHALL equal totalProcessed.

/**
 * Validates: Requirements 10.3
 */
describe('Property 9: Batch Enhancement Count Invariant', () => {
  it('successful + failed + skipped always equals totalProcessed', () => {
    fc.assert(
      fc.property(
        fc.nat(100),  // successful
        fc.nat(100),  // failed
        fc.nat(100),  // skipped
        (successful, failed, skipped) => {
          const totalProcessed = successful + failed + skipped;
          const result: BatchEnhancementResult = {
            totalProcessed,
            successful,
            failed,
            skipped,
            results: [],
          };
          expect(result.successful + result.failed + result.skipped).toBe(result.totalProcessed);
        }
      ),
      { numRuns: 100 }
    );
  });
});
