import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { authFetch } from './contexts/AuthContext';

// ============================================================
// Highlight Tier (精华) Types
// ============================================================

/** A single photo in the highlight tier response. */
export interface TierPhotoItem {
  id: string;
  filePath: string;
  thumbnailUrl: string;
  originalUrl: string;
  category: string | null;
  reason: string | null;
}

/** Response shape for tier photos endpoints. */
export interface TierPhotosResponse {
  photos: TierPhotoItem[];
  slideshowUrl: string | null;
}

export function apiPost<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
  return axios.post(url, data, config);
}

export function isApiError(error: unknown): boolean {
  return axios.isAxiosError(error);
}

export function getApiErrorMessage(error: unknown): string | undefined {
  if (axios.isAxiosError(error)) {
    return error.response?.data?.error?.message;
  }
  return undefined;
}

export async function updateCategory(mediaId: string, category: string): Promise<Response> {
  return authFetch(`/api/media/${mediaId}/category`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category }),
  });
}

// ============================================================
// AI Photo Highlights
// ============================================================

/** Summary of an AI highlight evaluation run for a trip. */
export interface HighlightEvaluation {
  tripId: string;
  totalPhotos: number;
  highlightCount: number;
  similarGroupCount: number;
  batchesProcessed: number;
  batchesFailed: number;
  usedProvider?: string;
  /** Number of photos trashed by the post-VLM global survivor dedup stage */
  globalSimilarityAfterVlmDeletedCount?: number;
}

/** Per-photo AI highlight evaluation result. */
export interface HighlightPhoto {
  photoId: string;
  tripId: string;
  isHighlight: boolean;
  /** Concise explanation (max 100 chars) when isHighlight is true. */
  reason: string;
  /** ISO 8601 timestamp. */
  evaluatedAt: string;
}

/** A group of visually similar photos with a recommended best photo. */
export interface SimilarGroup {
  groupId: string;
  tripId: string;
  memberPhotoIds: string[];
  bestPhotoId: string;
  /** ISO 8601 timestamp. */
  evaluatedAt: string;
}

/** Error thrown when a highlights API call fails. */
export class HighlightsApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'HighlightsApiError';
    this.status = status;
    this.code = code;
  }
}

async function readErrorBody(res: Response): Promise<{ message: string; code?: string }> {
  const body = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  return {
    message: body?.error?.message || `请求失败（HTTP ${res.status}）`,
    code: body?.error?.code,
  };
}

/**
 * Trigger AI highlight evaluation for a trip.
 *
 * Calls `POST /api/trips/:id/highlights`. Returns the evaluation summary on
 * success. Throws `HighlightsApiError` on non-2xx responses; status 409
 * indicates that an evaluation is already running for this trip.
 */
export async function triggerHighlightEvaluation(tripId: string): Promise<HighlightEvaluation> {
  const res = await authFetch(`/api/trips/${tripId}/highlights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const { message, code } = await readErrorBody(res);
    throw new HighlightsApiError(message, res.status, code);
  }
  return (await res.json()) as HighlightEvaluation;
}

/**
 * Fetch the list of AI-evaluated highlight photos for a trip.
 *
 * Calls `GET /api/trips/:id/highlights`. Returns an array of HighlightPhoto
 * records. Throws `HighlightsApiError` on non-2xx responses.
 */
export async function getHighlights(tripId: string): Promise<HighlightPhoto[]> {
  const res = await authFetch(`/api/trips/${tripId}/highlights`);
  if (!res.ok) {
    const { message, code } = await readErrorBody(res);
    throw new HighlightsApiError(message, res.status, code);
  }
  const body = await res.json();
  // Accept either a bare array or a wrapped { highlights: [...] } object.
  if (Array.isArray(body)) return body as HighlightPhoto[];
  return (body?.highlights ?? []) as HighlightPhoto[];
}

/**
 * Fetch the list of similar photo groups for a trip.
 *
 * Calls `GET /api/trips/:id/similar-groups`. Returns an array of SimilarGroup
 * records. Throws `HighlightsApiError` on non-2xx responses.
 */
export async function getSimilarGroups(tripId: string): Promise<SimilarGroup[]> {
  const res = await authFetch(`/api/trips/${tripId}/similar-groups`);
  if (!res.ok) {
    const { message, code } = await readErrorBody(res);
    throw new HighlightsApiError(message, res.status, code);
  }
  const body = await res.json();
  // Accept either a bare array or a wrapped { groups: [...] } / { similarGroups: [...] } object.
  if (Array.isArray(body)) return body as SimilarGroup[];
  return (body?.groups ?? body?.similarGroups ?? []) as SimilarGroup[];
}


// ============================================================
// Highlight Tier (精华) API
// ============================================================

/**
 * Fetch highlight tier photos for a trip (public endpoint).
 *
 * Calls `GET /api/trips/:id/tier-photos`. Returns tier photos and slideshow URL.
 * Throws `HighlightsApiError` on non-2xx responses.
 */
export async function getTierPhotos(tripId: string): Promise<TierPhotosResponse> {
  try {
    const res = await axios.get<TierPhotosResponse>(`/api/trips/${tripId}/tier-photos`);
    return res.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      const body = error.response.data as { error?: { code?: string; message?: string } } | null;
      const message = body?.error?.message || `请求失败（HTTP ${error.response.status}）`;
      const code = body?.error?.code;
      throw new HighlightsApiError(message, error.response.status, code);
    }
    throw error;
  }
}

/**
 * Fetch highlight tier photos for a trip (authenticated endpoint for My Gallery).
 *
 * Calls `GET /api/my/trips/:id/tier-photos`. Returns tier photos and slideshow URL.
 * Throws `HighlightsApiError` on non-2xx responses.
 */
export async function getMyTierPhotos(tripId: string): Promise<TierPhotosResponse> {
  const res = await authFetch(`/api/my/trips/${tripId}/tier-photos`);
  if (!res.ok) {
    const { message, code } = await readErrorBody(res);
    throw new HighlightsApiError(message, res.status, code);
  }
  return (await res.json()) as TierPhotosResponse;
}
