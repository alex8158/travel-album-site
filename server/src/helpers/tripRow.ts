import type { Trip, TripVisibility } from '../types';

export interface TripRow {
  id: string;
  title: string;
  description: string | null;
  cover_image_id: string | null;
  visibility: string;
  created_at: string;
  updated_at: string;
}

export function rowToTrip(row: TripRow): Trip {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    coverImageId: row.cover_image_id ?? undefined,
    visibility: row.visibility as TripVisibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
