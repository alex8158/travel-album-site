import path from 'path';

const IMAGE_MIME_PREFIXES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
];

const VIDEO_MIME_PREFIXES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
];

const EXTENSION_MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
};

export type MediaType = 'image' | 'video' | 'unknown';

export interface ClassifyResult {
  type: MediaType;
  mimeType: string;
}

function categorize(mimeType: string): MediaType {
  if (IMAGE_MIME_PREFIXES.includes(mimeType)) return 'image';
  if (VIDEO_MIME_PREFIXES.includes(mimeType)) return 'video';
  return 'unknown';
}

/**
 * Classify a file by reading its magic bytes (via file-type),
 * falling back to extension-based detection, and returning 'unknown' otherwise.
 */
export async function classify(filePath: string): Promise<ClassifyResult> {
  // 1. Try magic bytes detection via file-type (ESM-only, dynamic import)
  try {
    const { fileTypeFromFile } = await import('file-type');
    const result = await fileTypeFromFile(filePath);
    if (result) {
      const type = categorize(result.mime);
      if (type !== 'unknown') {
        return { type, mimeType: result.mime };
      }
    }
  } catch {
    // file-type couldn't read the file — fall through to extension
  }

  // 2. Fall back to extension-based detection
  const ext = path.extname(filePath).toLowerCase();
  const extMime = EXTENSION_MIME_MAP[ext];
  if (extMime) {
    return { type: categorize(extMime), mimeType: extMime };
  }

  // 3. Unknown
  console.warn(`[FileClassifier] Unable to classify file: ${filePath}`);
  return { type: 'unknown', mimeType: 'application/octet-stream' };
}
