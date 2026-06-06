import { describe, it, expect } from 'vitest';
import { parseAdjustmentParams, validateAndClamp } from './aiImageOptimizer';

describe('validateAndClamp', () => {
  it('should return defaults when all fields are missing', () => {
    const result = validateAndClamp({});
    expect(result).toEqual({
      brightness: 1.0, contrast: 1.0, saturation: 1.0,
      sharpness: 1.0, clarity: 1.0, temperature: 0,
    });
  });

  it('should pass through valid values within allowed ranges', () => {
    // brightness: [0.8, 1.15], contrast: [0.8, 1.2], others: [0, 2], temperature: [-1, 1]
    const result = validateAndClamp({ brightness: 1.1, contrast: 0.9, saturation: 1.5, sharpness: 1.1, clarity: 1.3, temperature: 0.5 });
    expect(result).toEqual({ brightness: 1.1, contrast: 0.9, saturation: 1.5, sharpness: 1.1, clarity: 1.3, temperature: 0.5 });
  });

  it('should clamp brightness below 0.8 to 0.8', () => {
    const result = validateAndClamp({ brightness: -0.5 });
    expect(result.brightness).toBe(0.8);
  });

  it('should clamp brightness above 1.15 to 1.15', () => {
    const result = validateAndClamp({ brightness: 2.5 });
    expect(result.brightness).toBe(1.15);
  });

  it('should clamp contrast below 0.8 to 0.8', () => {
    const result = validateAndClamp({ contrast: -1 });
    expect(result.contrast).toBe(0.8);
  });

  it('should clamp contrast above 1.2 to 1.2', () => {
    const result = validateAndClamp({ contrast: 3 });
    expect(result.contrast).toBe(1.2);
  });

  it('should clamp saturation/sharpness/clarity to [0, 2]', () => {
    const result = validateAndClamp({ saturation: -100, sharpness: 100, clarity: 5 });
    expect(result.saturation).toBe(0);
    expect(result.sharpness).toBe(2);
    expect(result.clarity).toBe(2);
  });

  it('should clamp temperature to [-1, 1]', () => {
    const below = validateAndClamp({ temperature: -5 });
    const above = validateAndClamp({ temperature: 5 });
    expect(below.temperature).toBe(-1);
    expect(above.temperature).toBe(1);
  });

  it('should default non-numeric fields to their neutral value', () => {
    const result = validateAndClamp({ brightness: 'high', contrast: null, saturation: true, sharpness: undefined });
    expect(result).toEqual({
      brightness: 1.0, contrast: 1.0, saturation: 1.0,
      sharpness: 1.0, clarity: 1.0, temperature: 0,
    });
  });

  it('should default NaN to neutral value', () => {
    const result = validateAndClamp({ brightness: NaN, contrast: 1.0, saturation: NaN, sharpness: 0.5 });
    expect(result.brightness).toBe(1.0);
    expect(result.contrast).toBe(1.0);
    expect(result.saturation).toBe(1.0);
    expect(result.sharpness).toBe(0.5);
  });

  it('should handle boundary values exactly at limits', () => {
    const result = validateAndClamp({ brightness: 0.8, contrast: 1.2, saturation: 0, sharpness: 2, temperature: -1 });
    expect(result).toEqual({ brightness: 0.8, contrast: 1.2, saturation: 0, sharpness: 2, clarity: 1.0, temperature: -1 });
  });

  it('should handle partial fields (mix of valid and missing)', () => {
    const result = validateAndClamp({ brightness: 1.1, sharpness: 1.2 });
    expect(result).toEqual({
      brightness: 1.1, contrast: 1.0, saturation: 1.0,
      sharpness: 1.2, clarity: 1.0, temperature: 0,
    });
  });
});

describe('parseAdjustmentParams', () => {
  it('should parse direct valid JSON', () => {
    const input = '{"brightness": 1.1, "contrast": 1.1, "saturation": 1.3, "sharpness": 1.0, "clarity": 1.0, "temperature": 0}';
    const result = parseAdjustmentParams(input);
    expect(result).toEqual({ brightness: 1.1, contrast: 1.1, saturation: 1.3, sharpness: 1.0, clarity: 1.0, temperature: 0 });
  });

  it('should parse JSON from markdown code block with json tag', () => {
    const input = '这是分析结果：\n```json\n{"brightness": 1.1, "contrast": 1.2, "saturation": 1.4, "sharpness": 1.1, "clarity": 1.2, "temperature": 0.3}\n```\n请参考以上建议。';
    const result = parseAdjustmentParams(input);
    expect(result).toEqual({ brightness: 1.1, contrast: 1.2, saturation: 1.4, sharpness: 1.1, clarity: 1.2, temperature: 0.3 });
  });

  it('should parse JSON from markdown code block without json tag', () => {
    const input = '```\n{"brightness": 1.0, "contrast": 1.0, "saturation": 1.2, "sharpness": 1.0, "clarity": 1.0, "temperature": 0}\n```';
    const result = parseAdjustmentParams(input);
    expect(result).toEqual({ brightness: 1.0, contrast: 1.0, saturation: 1.2, sharpness: 1.0, clarity: 1.0, temperature: 0 });
  });

  it('should extract JSON from prose-wrapped text', () => {
    const input = '根据分析，建议参数为 {"brightness": 1.15, "contrast": 1.1, "saturation": 1.5, "sharpness": 1.2, "clarity": 1.0, "temperature": 0} 以上。';
    const result = parseAdjustmentParams(input);
    // brightness clamped to 1.15 (max), contrast clamped to 1.1 (within [0.8, 1.2])
    expect(result).toEqual({ brightness: 1.15, contrast: 1.1, saturation: 1.5, sharpness: 1.2, clarity: 1.0, temperature: 0 });
  });

  it('should return null for text with no JSON', () => {
    const input = '这张照片已经很好了，不需要调整。';
    const result = parseAdjustmentParams(input);
    expect(result).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseAdjustmentParams('')).toBeNull();
  });

  it('should return null for invalid JSON that cannot be extracted', () => {
    const input = '{brightness: 1.2, contrast: 1.1}'; // not valid JSON (no quotes on keys)
    const result = parseAdjustmentParams(input);
    expect(result).toBeNull();
  });

  it('should apply validation and clamping to extracted values', () => {
    // brightness 3.0 -> clamped to 1.15, contrast -1 -> clamped to 0.8, saturation "high" -> default 1.0
    const input = '{"brightness": 3.0, "contrast": -1, "saturation": "high", "sharpness": 1.1}';
    const result = parseAdjustmentParams(input);
    expect(result).toEqual({ brightness: 1.15, contrast: 0.8, saturation: 1.0, sharpness: 1.1, clarity: 1.0, temperature: 0 });
  });

  it('should handle JSON with extra fields (ignores them)', () => {
    const input = '{"brightness": 1.1, "contrast": 1.1, "saturation": 1.3, "sharpness": 1.0, "extra": "ignored"}';
    const result = parseAdjustmentParams(input);
    expect(result).toEqual({ brightness: 1.1, contrast: 1.1, saturation: 1.3, sharpness: 1.0, clarity: 1.0, temperature: 0 });
  });

  it('should handle JSON with missing fields (defaults to neutral)', () => {
    const input = '{"brightness": 1.1}';
    const result = parseAdjustmentParams(input);
    expect(result).toEqual({ brightness: 1.1, contrast: 1.0, saturation: 1.0, sharpness: 1.0, clarity: 1.0, temperature: 0 });
  });

  it('should return null for JSON array', () => {
    const input = '[1.2, 1.1, 1.3, 1.0]';
    const result = parseAdjustmentParams(input);
    expect(result).toBeNull();
  });
});
