/**
 * Image utility functions for AI Provider integration.
 *
 * Provides image resizing to meet AI provider size constraints
 * while preserving aspect ratio.
 *
 * Requirements: 1.9
 */

import sharp from 'sharp';

/** Default maximum dimensions for AI provider image inputs */
const DEFAULT_MAX_WIDTH = 768;
const DEFAULT_MAX_HEIGHT = 768;

/**
 * Resize an image (as base64) to fit within the provider's maximum dimensions,
 * preserving aspect ratio. If the image is already within limits, returns it unchanged.
 *
 * @param base64 - Base64-encoded image data
 * @param maxWidth - Maximum allowed width (default 768)
 * @param maxHeight - Maximum allowed height (default 768)
 * @returns Base64-encoded resized image (JPEG format)
 */
export async function resizeForProvider(
  base64: string,
  maxWidth: number = DEFAULT_MAX_WIDTH,
  maxHeight: number = DEFAULT_MAX_HEIGHT,
): Promise<string> {
  const buffer = Buffer.from(base64, 'base64');
  const metadata = await sharp(buffer).metadata();

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  // If already within limits, return as-is
  if (width <= maxWidth && height <= maxHeight) {
    return base64;
  }

  // Calculate scale factor to fit within maxWidth × maxHeight while preserving aspect ratio
  const scaleX = maxWidth / width;
  const scaleY = maxHeight / height;
  const scale = Math.min(scaleX, scaleY);

  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);

  const resized = await sharp(buffer)
    .resize(newWidth, newHeight, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  return resized.toString('base64');
}

/**
 * Get the dimensions of a base64-encoded image.
 */
export async function getImageDimensions(base64: string): Promise<{ width: number; height: number }> {
  const buffer = Buffer.from(base64, 'base64');
  const metadata = await sharp(buffer).metadata();
  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
  };
}
