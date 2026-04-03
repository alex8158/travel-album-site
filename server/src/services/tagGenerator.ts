import { v4 as uuidv4 } from 'uuid';
import { MediaTag } from '../types';

/**
 * Normalize a tag name: lowercase + remove all spaces.
 */
export function normalizeTagName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '');
}

/**
 * Generate tags for a media item based on naming rules:
 * - Album (trip) title
 * - Upload date in YYYY-MM format
 * - Media type (image/video)
 * - File extension (without dot)
 */
export function generateTags(
  mediaId: string,
  tripTitle: string,
  mediaType: string,
  originalFilename: string,
  uploadDate: Date
): MediaTag[] {
  const now = new Date().toISOString();

  const rawTags: string[] = [
    tripTitle,
    formatYearMonth(uploadDate),
    mediaType,
    extractExtension(originalFilename),
  ];

  return rawTags.map((raw) => ({
    id: uuidv4(),
    mediaId,
    tagName: normalizeTagName(raw),
    createdAt: now,
  }));
}

function formatYearMonth(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function extractExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1 || dotIndex === filename.length - 1) {
    return '';
  }
  return filename.slice(dotIndex + 1);
}
