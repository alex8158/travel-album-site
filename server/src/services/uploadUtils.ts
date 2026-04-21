export function calculatePartSize(fileSize: number): number {
  if (fileSize > 10 * 1024 * 1024 * 1024) return 128 * 1024 * 1024;  // >10GB: 128MB
  if (fileSize > 1 * 1024 * 1024 * 1024) return 64 * 1024 * 1024;    // >1GB: 64MB
  if (fileSize > 500 * 1024 * 1024) return 32 * 1024 * 1024;          // >500MB: 32MB
  return 16 * 1024 * 1024;                                             // default: 16MB
}

export const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100MB

export const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv']);
