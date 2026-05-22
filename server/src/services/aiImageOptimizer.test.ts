import { describe, it, expect } from 'vitest';
import { parseAdjustmentParams, validateAndClamp } from './aiImageOptimizer';

describe('validateAndClamp', () => {
  it('should return defaults when all fields are missing', () => {
    const result = validateAndClamp({});
    expect(result).toEqual({ brightness: 1.0, contrast: 1.0, saturation: 1.0, sharpness: 1.0 });
  });

  it('should pass through valid values within [0, 2]', () => {
    const result = validateAndClamp({ brightness: 1.2, contrast: 0.8, saturation: 1.5, sharpness: 1.1 });
    expect(result).toEqual({ brightness: 1.2, contrast: 0.8, saturation: 1.5, sharpness: 1.1 });
  });

  it('should clamp values below 0 to 0', () => {
    const result = validateAndClamp({ brightness: -0.5, contrast: -1, saturation: -100, sharpness: -0.01 });
    expect(result).toEqual({ brightness: 0, contrast: 0, saturation: 0, sharpness: 0 });
  });

  it('should clamp values above 2 to 2', () => {
    const result = validateAndClamp({ brightness: 2.5, contrast: 3, saturation: 100, sharpness: 2.01 });
    expect(result).toEqual({ brightness: 2, contrast: 2, saturation: 2, sharpness: 2 });
  });

  it('should default non-numeric fields to 1.0', () => {
    const result = validateAndClamp({ brightness: 'high', contrast: null, saturation: true, sharpness: undefined });
    expect(result).toEqual({ brightness: 1.0, contrast: 1.0, saturation: 1.0, sharpness: 1.0 });
  });

  it('should default NaN to 1.0', () => {
    const result = validateAndClamp({ brightness: NaN, contrast: 1.3, saturation: NaN, sharpness: 0.5 });
    expect(result).toEqual({ brightness: 1.0, contrast: 1.3, saturation: 1.0, sharpness: 0.5 });
  });

  it('should handle boundary values exactly at 0 and 2', () => {
    const result = validateAndClamp({ brightness: 0, contrast: 2, saturation: 0, sharpness: 2 });
    expect(result).toEqual({ brightness: 0, contrast: 2, saturation: 0, sharpness: 2 });
  });

  it('should handle partial fields (mix of valid and missing)', () => {
    const result = validateAndClamp({ brightness: 1.4, sharpness: 1.2 });
    expect(result).toEqual({ brightness: 1.4, contrast: 1.0, saturation: 1.0, sharpness: 1.2 });
  });
});

describe('parseAdjustmentParams', () => {
  it('should parse direct valid JSON', () => {
    const input = '{"brightness": 1.2, "contrast": 1.1, "saturation": 1.3, "sharpness": 1.0}';
    const result = parseAdjustmentParams(input);
    expect(result).toEqual({ brightness: 1.2, contrast: 1.1, saturation: 1.3, sharpness: 1.0 });
  });

  it('should parse JSON from markdown code block with json tag', () => {
    const input = '这是分析结果：\n```json\n{"brightness": 1.3, "contrast": 1.2, "saturation": 1.4, "sharpness": 1.1}\n```\n请参考以上建议。';
    const result = parseAdjustmentParams(input);
    expect(result).toEqual({ brightness: 1.3, contrast: 1.2, saturation: 1.4, sharpness: 1.1 });
  });

  it('should parse JSON from markdown code block without json tag', () => {
    const input = '```\n{"brightness": 1.1, "contrast": 1.0, "saturation": 1.2, "sharpness": 1.0}\n```';
    const result = parseAdjustmentParams(input);
    expect(result).toEqual({ brightness: 1.1, contrast: 1.0, saturation: 1.2, sharpness: 1.0 });
  });

  it('should extract JSON from prose-wrapped text', () => {
    const input = '根据分析，建议参数为 {"brightness": 1.4, "contrast": 1.1, "saturation": 1.5, "sharpness": 1.2} 以上。';
    const result = parseAdjustmentParams(input);
    expect(result).toEqual({ brightness: 1.4, contrast: 1.1, saturation: 1.5, sharpness: 1.2 });
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
    const input = '{"brightness": 3.0, "contrast": -1, "saturation": "high", "sharpness": 1.1}';
    const result = parseAdjustmentParams(input);
    expect(result).toEqual({ brightness: 2, contrast: 0, saturation: 1.0, sharpness: 1.1 });
  });

  it('should handle JSON with extra fields (ignores them)', () => {
    const input = '{"brightness": 1.2, "contrast": 1.1, "saturation": 1.3, "sharpness": 1.0, "extra": "ignored"}';
    const result = parseAdjustmentParams(input);
    expect(result).toEqual({ brightness: 1.2, contrast: 1.1, saturation: 1.3, sharpness: 1.0 });
  });

  it('should handle JSON with missing fields (defaults to 1.0)', () => {
    const input = '{"brightness": 1.3}';
    const result = parseAdjustmentParams(input);
    expect(result).toEqual({ brightness: 1.3, contrast: 1.0, saturation: 1.0, sharpness: 1.0 });
  });

  it('should return null for JSON array', () => {
    const input = '[1.2, 1.1, 1.3, 1.0]';
    const result = parseAdjustmentParams(input);
    expect(result).toBeNull();
  });
});
