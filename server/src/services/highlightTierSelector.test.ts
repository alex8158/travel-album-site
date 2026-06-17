import { describe, it, expect } from 'vitest';
import { parseTierResponse, TierCandidate } from './highlightTierSelector';

describe('parseTierResponse', () => {
  const batchPhotos: TierCandidate[] = [
    { id: 'photo-0', filePath: '/photos/0.jpg', category: 'animal' },
    { id: 'photo-1', filePath: '/photos/1.jpg', category: 'animal' },
    { id: 'photo-2', filePath: '/photos/2.jpg', category: 'animal' },
    { id: 'photo-3', filePath: '/photos/3.jpg', category: 'animal' },
    { id: 'photo-4', filePath: '/photos/4.jpg', category: 'animal' },
  ];

  it('should parse a valid VLM response with selected array', () => {
    const responseText = JSON.stringify({
      selected: [
        { index: 0, reason: 'Great shot' },
        { index: 3, reason: 'Unique moment' },
      ],
    });

    const picks = parseTierResponse(responseText, batchPhotos);
    expect(picks).toEqual([
      { photoId: 'photo-0', reason: 'Great shot' },
      { photoId: 'photo-3', reason: 'Unique moment' },
    ]);
  });

  it('should handle JSON wrapped in markdown code blocks', () => {
    const responseText = '```json\n{"selected": [{"index": 1, "reason": "Sharp focus"}]}\n```';

    const picks = parseTierResponse(responseText, batchPhotos);
    expect(picks).toEqual([{ photoId: 'photo-1', reason: 'Sharp focus' }]);
  });

  it('should filter out entries with out-of-range indices', () => {
    const responseText = JSON.stringify({
      selected: [
        { index: -1, reason: 'Invalid negative' },
        { index: 2, reason: 'Valid' },
        { index: 5, reason: 'Out of range' },
        { index: 100, reason: 'Way out of range' },
      ],
    });

    const picks = parseTierResponse(responseText, batchPhotos);
    expect(picks).toEqual([{ photoId: 'photo-2', reason: 'Valid' }]);
  });

  it('should filter out entries with non-integer indices', () => {
    const responseText = JSON.stringify({
      selected: [
        { index: 1.5, reason: 'Float index' },
        { index: 'two', reason: 'String index' },
        { index: 2, reason: 'Valid integer' },
      ],
    });

    const picks = parseTierResponse(responseText, batchPhotos);
    expect(picks).toEqual([{ photoId: 'photo-2', reason: 'Valid integer' }]);
  });

  it('should filter out non-object entries in selected array', () => {
    const responseText = JSON.stringify({
      selected: [null, 'string', 42, { index: 0, reason: 'Valid' }],
    });

    const picks = parseTierResponse(responseText, batchPhotos);
    expect(picks).toEqual([{ photoId: 'photo-0', reason: 'Valid' }]);
  });

  it('should use empty string when reason is missing', () => {
    const responseText = JSON.stringify({
      selected: [{ index: 1 }],
    });

    const picks = parseTierResponse(responseText, batchPhotos);
    expect(picks).toEqual([{ photoId: 'photo-1', reason: '' }]);
  });

  it('should use empty string when reason is not a string', () => {
    const responseText = JSON.stringify({
      selected: [{ index: 0, reason: 123 }],
    });

    const picks = parseTierResponse(responseText, batchPhotos);
    expect(picks).toEqual([{ photoId: 'photo-0', reason: '' }]);
  });

  it('should truncate reason strings longer than 100 characters', () => {
    const longReason = 'A'.repeat(150);
    const responseText = JSON.stringify({
      selected: [{ index: 0, reason: longReason }],
    });

    const picks = parseTierResponse(responseText, batchPhotos);
    expect(picks[0].reason).toHaveLength(100);
    expect(picks[0].reason).toBe('A'.repeat(100));
  });

  it('should not truncate reason strings of exactly 100 characters', () => {
    const exactReason = 'B'.repeat(100);
    const responseText = JSON.stringify({
      selected: [{ index: 0, reason: exactReason }],
    });

    const picks = parseTierResponse(responseText, batchPhotos);
    expect(picks[0].reason).toHaveLength(100);
    expect(picks[0].reason).toBe(exactReason);
  });

  it('should throw when response has no selected array', () => {
    const responseText = JSON.stringify({ highlights: [{ index: 0 }] });

    expect(() => parseTierResponse(responseText, batchPhotos)).toThrow(
      'Invalid tier VLM response: missing "selected" array',
    );
  });

  it('should throw when selected is not an array', () => {
    const responseText = JSON.stringify({ selected: 'not an array' });

    expect(() => parseTierResponse(responseText, batchPhotos)).toThrow(
      'Invalid tier VLM response: missing "selected" array',
    );
  });

  it('should throw when response is not valid JSON', () => {
    expect(() => parseTierResponse('not json at all', batchPhotos)).toThrow();
  });

  it('should return empty array when selected array is empty', () => {
    const responseText = JSON.stringify({ selected: [] });

    const picks = parseTierResponse(responseText, batchPhotos);
    expect(picks).toEqual([]);
  });

  it('should handle entries missing the index field', () => {
    const responseText = JSON.stringify({
      selected: [{ reason: 'No index field' }, { index: 4, reason: 'Has index' }],
    });

    const picks = parseTierResponse(responseText, batchPhotos);
    expect(picks).toEqual([{ photoId: 'photo-4', reason: 'Has index' }]);
  });
});
