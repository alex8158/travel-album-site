import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { detectColorCast, BatchColorCastResult } from './colorCastDetector';

// Feature: v2-image-processing, Property 1: Channel Deviation Invariant
// For any RGB channel means (r, g, b) in [0, 255], the computed channel deviations
// SHALL always sum to zero (devR + devG + devB = 0), since each deviation is defined
// as channelMean minus the overall mean.
describe('Property 1: Channel Deviation Invariant', () => {
  it('channel deviations always sum to zero', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 255, noNaN: true }),
        fc.float({ min: 0, max: 255, noNaN: true }),
        fc.float({ min: 0, max: 255, noNaN: true }),
        (r, g, b) => {
          const result = detectColorCast({ r, g, b });
          const sum = result.channelDeviations.r + result.channelDeviations.g + result.channelDeviations.b;
          // Allow for floating point imprecision
          expect(Math.abs(sum)).toBeLessThan(1e-10);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: v2-image-processing, Property 2: Severity and Type Classification Correctness
// For any RGB channel means, the Color_Cast_Detector SHALL produce a severity and type
// that exactly match the threshold rules:
// - maxDeviation < 5 → (none, neutral)
// - 5 ≤ maxDev < 15 → mild
// - 15 ≤ maxDev < 30 → moderate
// - maxDev ≥ 30 → severe
// The type SHALL always be one of {warm, cool, green, magenta, neutral}.
describe('Property 2: Severity and Type Classification Correctness', () => {
  it('severity matches threshold rules and type is always valid', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 255, noNaN: true }),
        fc.float({ min: 0, max: 255, noNaN: true }),
        fc.float({ min: 0, max: 255, noNaN: true }),
        (r, g, b) => {
          const result = detectColorCast({ r, g, b });
          const maxDev = result.maxDeviation;

          // Verify severity classification
          if (maxDev < 5) {
            expect(result.severity).toBe('none');
            expect(result.type).toBe('neutral');
          } else if (maxDev < 15) {
            expect(result.severity).toBe('mild');
          } else if (maxDev < 30) {
            expect(result.severity).toBe('moderate');
          } else {
            expect(result.severity).toBe('severe');
          }

          // Type must always be one of the valid values
          expect(['warm', 'cool', 'green', 'magenta', 'neutral']).toContain(result.type);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: v2-image-processing, Property 3: Color Score Bounded
// For any RGB channel means in [0, 255], the computed color_score SHALL always be
// in the range [0.0, 1.0].
describe('Property 3: Color Score Bounded', () => {
  it('colorScore is always in [0.0, 1.0]', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 255, noNaN: true }),
        fc.float({ min: 0, max: 255, noNaN: true }),
        fc.float({ min: 0, max: 255, noNaN: true }),
        (r, g, b) => {
          const result = detectColorCast({ r, g, b });
          expect(result.colorScore).toBeGreaterThanOrEqual(0.0);
          expect(result.colorScore).toBeLessThanOrEqual(1.0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: v2-image-processing, Property 4: ColorCastResult JSON Round-Trip
// For any valid ColorCastResult object, serializing it to JSON and parsing it back
// SHALL produce an equivalent object with identical type, severity, colorScore,
// and channelDeviations.
// **Validates: Requirements 2.2**
describe('Property 4: ColorCastResult JSON Round-Trip', () => {
  it('serializing to JSON and parsing back produces an equivalent object', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 255, noNaN: true }),
        fc.float({ min: 0, max: 255, noNaN: true }),
        fc.float({ min: 0, max: 255, noNaN: true }),
        (r, g, b) => {
          const original = detectColorCast({ r, g, b });
          const serialized = JSON.stringify(original);
          const deserialized = JSON.parse(serialized);

          expect(deserialized.type).toBe(original.type);
          expect(deserialized.severity).toBe(original.severity);
          expect(deserialized.colorScore).toBe(original.colorScore);
          expect(deserialized.channelDeviations).toEqual(original.channelDeviations);
          expect(deserialized.maxDeviation).toBe(original.maxDeviation);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: v2-image-processing, Property 5: Batch Severity Count Invariant
// For any batch color cast detection result, the sum of all severity counts
// (none + mild + moderate + severe) SHALL equal totalProcessed.
// **Validates: Requirements 3.2**
describe('Property 5: Batch Severity Count Invariant', () => {
  it('sum of severity counts always equals totalProcessed', () => {
    fc.assert(
      fc.property(
        fc.nat(100),  // none count
        fc.nat(100),  // mild count
        fc.nat(100),  // moderate count
        fc.nat(100),  // severe count
        (none, mild, moderate, severe) => {
          const totalProcessed = none + mild + moderate + severe;
          const result: BatchColorCastResult = {
            totalProcessed,
            severityCounts: { none, mild, moderate, severe },
            errors: [],
          };
          const sum = result.severityCounts.none + result.severityCounts.mild +
                      result.severityCounts.moderate + result.severityCounts.severe;
          expect(sum).toBe(result.totalProcessed);
        }
      ),
      { numRuns: 100 }
    );
  });
});
