import {
  RekognitionClient,
  DetectLabelsCommand,
} from '@aws-sdk/client-rekognition';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';
import type { MediaItemRow } from '../helpers/mediaItemRow';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImageCategory = 'people' | 'animal' | 'landscape' | 'other';

export interface ClassifyResult {
  category: ImageCategory;
  allCategories: ImageCategory[];
  labels: string[];
}

// ---------------------------------------------------------------------------
// Label constants
// ---------------------------------------------------------------------------

export const PEOPLE_LABELS = [
  'Person', 'Human', 'Face', 'People', 'Man', 'Woman', 'Child', 'Boy', 'Girl',
];

export const ANIMAL_LABELS = [
  'Dog', 'Cat', 'Bird', 'Animal', 'Pet', 'Wildlife', 'Fish', 'Mammal', 'Reptile', 'Insect',
];

export const LANDSCAPE_LABELS = [
  'Mountain', 'Beach', 'Sky', 'Ocean', 'Forest', 'Lake', 'River', 'Sunset',
  'Sunrise', 'Nature', 'Scenery', 'Landscape', 'Sea', 'Cloud', 'Field',
  'Valley', 'Waterfall', 'Desert',
];

// ---------------------------------------------------------------------------
// Pure mapping function (exported for testability)
// ---------------------------------------------------------------------------

function matchesAny(label: string, knownLabels: string[]): boolean {
  const lower = label.toLowerCase();
  return knownLabels.some((k) => k.toLowerCase() === lower);
}

export function mapLabelsToCategory(labels: string[]): ClassifyResult {
  let hasPeople = false;
  let hasAnimal = false;
  let hasLandscape = false;

  for (const label of labels) {
    if (matchesAny(label, PEOPLE_LABELS)) hasPeople = true;
    if (matchesAny(label, ANIMAL_LABELS)) hasAnimal = true;
    if (matchesAny(label, LANDSCAPE_LABELS)) hasLandscape = true;
  }

  const allCategories: ImageCategory[] = [];
  if (hasPeople) allCategories.push('people');
  if (hasAnimal) allCategories.push('animal');
  if (hasLandscape) allCategories.push('landscape');

  // Priority: people > animal > landscape > other
  let category: ImageCategory = 'other';
  if (hasPeople) category = 'people';
  else if (hasAnimal) category = 'animal';
  else if (hasLandscape) category = 'landscape';

  return { category, allCategories, labels };
}

// ---------------------------------------------------------------------------
// Rekognition client helper
// ---------------------------------------------------------------------------

function createRekognitionClient(): RekognitionClient {
  const region = process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  return new RekognitionClient({
    region,
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Classify a single image buffer via Rekognition
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function classifyImage(imageBytes: Buffer): Promise<ClassifyResult> {
  const client = createRekognitionClient();
  const command = new DetectLabelsCommand({
    Image: { Bytes: imageBytes },
    MaxLabels: 20,
    MinConfidence: 70,
  });

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await client.send(command);
      const labelNames = (response.Labels ?? []).map((l) => l.Name ?? '').filter(Boolean);
      return mapLabelsToCategory(labelNames);
    } catch (err: unknown) {
      lastError = err;
      const isThrottling =
        err instanceof Error && (err.name === 'ThrottlingException' || err.name === 'Throttling');
      if (isThrottling && attempt < 2) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      throw err;
    }
  }

  // Should not reach here, but just in case
  throw lastError;
}

// ---------------------------------------------------------------------------
// Classify all images in a trip
// ---------------------------------------------------------------------------

export async function classifyTrip(tripId: string): Promise<void> {
  const db = getDb();
  const storageProvider = getStorageProvider();

  const rows = db.prepare(
    "SELECT * FROM media_items WHERE trip_id = ? AND media_type = 'image' AND status = 'active'"
  ).all(tripId) as MediaItemRow[];

  const updateCategoryStmt = db.prepare(
    'UPDATE media_items SET category = ? WHERE id = ?'
  );

  const deleteOldTagsStmt = db.prepare(
    "DELETE FROM media_tags WHERE media_id = ? AND (tag_name LIKE 'category:%' OR tag_name LIKE 'rekognition:%')"
  );

  const insertTagStmt = db.prepare(
    'INSERT INTO media_tags (id, media_id, tag_name, created_at) VALUES (?, ?, ?, ?)'
  );

  const appendErrorStmt = db.prepare(
    `UPDATE media_items
     SET processing_error = CASE
       WHEN processing_error IS NULL THEN ?
       ELSE processing_error || char(10) || ?
     END
     WHERE id = ?`
  );

  for (const row of rows) {
    try {
      const imageBuffer = await storageProvider.read(row.file_path);
      const result = await classifyImage(imageBuffer);

      // Update main category on media_items
      updateCategoryStmt.run(result.category, row.id);

      // Delete-then-insert tags
      deleteOldTagsStmt.run(row.id);

      const now = new Date().toISOString();

      // Write category:xxx tags for all matched categories
      for (const cat of result.allCategories) {
        insertTagStmt.run(uuidv4(), row.id, `category:${cat}`, now);
      }
      // If no categories matched (other), still write category:other
      if (result.allCategories.length === 0) {
        insertTagStmt.run(uuidv4(), row.id, 'category:other', now);
      }

      // Write rekognition:xxx tags for original labels
      for (const label of result.labels) {
        insertTagStmt.run(uuidv4(), row.id, `rekognition:${label}`, now);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const errorText = `[classify] ${message}`;

      // Classify as 'other' on failure
      updateCategoryStmt.run('other', row.id);

      // Clean old tags and write category:other
      deleteOldTagsStmt.run(row.id);
      insertTagStmt.run(uuidv4(), row.id, 'category:other', new Date().toISOString());

      appendErrorStmt.run(errorText, errorText, row.id);
    }
  }
}
