export type TripVisibility = 'public' | 'unlisted';

export interface Trip {
  id: string;
  title: string;
  description?: string;
  coverImageId?: string;
  visibility: TripVisibility;
  userId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MediaItem {
  id: string;
  tripId: string;
  filePath: string;
  thumbnailPath?: string;
  mediaType: 'image' | 'video' | 'unknown';
  mimeType: string;
  originalFilename: string;
  fileSize: number;
  width?: number;
  height?: number;
  perceptualHash?: string;
  qualityScore?: number;
  sharpnessScore?: number;
  duplicateGroupId?: string;
  status: 'active' | 'trashed' | 'deleted';
  trashedReason?: string;
  processingError?: string;
  blurStatus?: 'clear' | 'suspect' | 'blurry';
  exposureScore?: number;
  contrastScore?: number;
  noiseScore?: number;
  phash?: string;
  optimizedPath?: string;
  compiledPath?: string;
  userId?: string;
  visibility: 'public' | 'private';
  avgBrightness?: number;
  contrastLevel?: number;
  colorCastR?: number;
  colorCastG?: number;
  colorCastB?: number;
  noiseLevel?: number;
  category?: string;
  createdAt: string;
}

export interface DuplicateGroup {
  id: string;
  tripId: string;
  defaultImageId: string;
  imageCount: number;
  createdAt: string;
}

export interface TripSummary {
  id: string;
  title: string;
  descriptionExcerpt?: string;
  coverImageUrl: string;
  mediaCount: number;
  visibility: TripVisibility;
  createdAt: string;
}

export interface GalleryData {
  trip: Trip;
  images: GalleryImage[];
  videos: MediaItem[];
}

export interface GalleryImage {
  item: MediaItem;
  isDefault: boolean;
  duplicateGroup?: DuplicateGroup;
  thumbnailUrl: string;
  originalUrl: string;
}

export interface QualityScore {
  sharpness: number | null;
  exposure: number | null;
  contrast: number | null;
  resolution: number | null;
  noiseArtifact: number | null;
  fileSize: number | null;
  overall: number;
}

export interface ProcessResult {
  tripId: string;
  totalImages: number;
  totalVideos: number;
  blurryDeletedCount: number;
  dedupDeletedCount: number;
  analyzedCount: number;
  optimizedCount: number;
  classifiedCount: number;
  categoryStats: {
    people: number;
    animal: number;
    landscape: number;
    other: number;
  };
  compiledCount: number;
  failedCount: number;
  coverImageId: string | null;
}

export interface ProcessOptions {
  blurThreshold?: number;
  outputConfig?: {
    maxResolution?: number;
    jpegQuality?: number;
    videoResolution?: number;
  };
}

export interface User {
  id: string;
  username: string;
  role: 'admin' | 'regular';
  status: 'active' | 'pending' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export interface JwtPayload {
  userId: string;
  role: 'admin' | 'regular';
}

export interface MediaTag {
  id: string;
  mediaId: string;
  tagName: string;
  createdAt: string;
}
