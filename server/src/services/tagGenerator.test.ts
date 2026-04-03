import { describe, it, expect } from 'vitest';
import { normalizeTagName, generateTags } from './tagGenerator';

describe('normalizeTagName', () => {
  it('should lowercase and remove spaces', () => {
    expect(normalizeTagName('My Trip')).toBe('mytrip');
  });

  it('should handle multiple spaces', () => {
    expect(normalizeTagName('A  B  C')).toBe('abc');
  });

  it('should handle already lowercase no-space input', () => {
    expect(normalizeTagName('image')).toBe('image');
  });

  it('should handle empty string', () => {
    expect(normalizeTagName('')).toBe('');
  });

  it('should handle tabs and mixed whitespace', () => {
    expect(normalizeTagName("Hello\tWorld")).toBe('helloworld');
  });

  it('should handle uppercase only', () => {
    expect(normalizeTagName('JPEG')).toBe('jpeg');
  });
});

describe('generateTags', () => {
  const mediaId = 'media-123';
  const tripTitle = 'Summer Vacation';
  const mediaType = 'image';
  const filename = 'photo.jpg';
  const uploadDate = new Date('2024-07-15T10:00:00Z');

  it('should generate at least 4 tags', () => {
    const tags = generateTags(mediaId, tripTitle, mediaType, filename, uploadDate);
    expect(tags.length).toBeGreaterThanOrEqual(4);
  });

  it('should include normalized trip title tag', () => {
    const tags = generateTags(mediaId, tripTitle, mediaType, filename, uploadDate);
    const names = tags.map((t) => t.tagName);
    expect(names).toContain('summervacation');
  });

  it('should include YYYY-MM date tag', () => {
    const tags = generateTags(mediaId, tripTitle, mediaType, filename, uploadDate);
    const names = tags.map((t) => t.tagName);
    expect(names).toContain('2024-07');
  });

  it('should include media type tag', () => {
    const tags = generateTags(mediaId, tripTitle, mediaType, filename, uploadDate);
    const names = tags.map((t) => t.tagName);
    expect(names).toContain('image');
  });

  it('should include file extension tag without dot', () => {
    const tags = generateTags(mediaId, tripTitle, mediaType, filename, uploadDate);
    const names = tags.map((t) => t.tagName);
    expect(names).toContain('jpg');
  });

  it('should set mediaId on all tags', () => {
    const tags = generateTags(mediaId, tripTitle, mediaType, filename, uploadDate);
    for (const tag of tags) {
      expect(tag.mediaId).toBe(mediaId);
    }
  });

  it('should assign unique ids to each tag', () => {
    const tags = generateTags(mediaId, tripTitle, mediaType, filename, uploadDate);
    const ids = tags.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should set createdAt on all tags', () => {
    const tags = generateTags(mediaId, tripTitle, mediaType, filename, uploadDate);
    for (const tag of tags) {
      expect(tag.createdAt).toBeTruthy();
      // Should be a valid ISO string
      expect(() => new Date(tag.createdAt)).not.toThrow();
    }
  });

  it('should handle video media type', () => {
    const tags = generateTags(mediaId, tripTitle, 'video', 'clip.mp4', uploadDate);
    const names = tags.map((t) => t.tagName);
    expect(names).toContain('video');
    expect(names).toContain('mp4');
  });

  it('should handle trip title with spaces', () => {
    const tags = generateTags(mediaId, 'My Great Trip', mediaType, filename, uploadDate);
    const names = tags.map((t) => t.tagName);
    expect(names).toContain('mygreattrip');
  });

  it('should handle January date correctly (zero-padded month)', () => {
    const janDate = new Date('2025-01-05T00:00:00Z');
    const tags = generateTags(mediaId, tripTitle, mediaType, filename, janDate);
    const names = tags.map((t) => t.tagName);
    expect(names).toContain('2025-01');
  });
});
