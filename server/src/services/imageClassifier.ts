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

export interface LabelWithConfidence {
  name: string;
  confidence: number;
}

export function mapLabelsToCategory(labels: string[]): ClassifyResult;
export function mapLabelsToCategory(labels: LabelWithConfidence[]): ClassifyResult;
export function mapLabelsToCategory(labels: string[] | LabelWithConfidence[]): ClassifyResult {
  // Normalize to LabelWithConfidence
  const items: LabelWithConfidence[] = labels.map((l) =>
    typeof l === 'string' ? { name: l, confidence: 80 } : l
  );

  let hasPeople = false;
  let hasAnimal = false;
  let hasLandscape = false;
  let animalMaxConf = 0;
  let animalCount = 0;
  let peopleMaxConf = 0;
  let peopleCount = 0;

  for (const item of items) {
    if (matchesAny(item.name, PEOPLE_LABELS)) {
      hasPeople = true;
      peopleCount++;
      peopleMaxConf = Math.max(peopleMaxConf, item.confidence);
    }
    if (matchesAny(item.name, ANIMAL_LABELS)) {
      hasAnimal = true;
      animalCount++;
      animalMaxConf = Math.max(animalMaxConf, item.confidence);
    }
    if (matchesAny(item.name, LANDSCAPE_LABELS)) hasLandscape = true;
  }

  const allCategories: ImageCategory[] = [];
  if (hasPeople) allCategories.push('people');
  if (hasAnimal) allCategories.push('animal');
  if (hasLandscape) allCategories.push('landscape');

  // Classification rules:
  // 1. When both people AND animal are detected:
  //    - If animal has more labels OR higher max confidence → animal
  //    - Otherwise → people
  //    (This handles underwater photos with divers + marine life)
  // 2. people only → people
  // 3. animal vs landscape: animal needs strong evidence (2+ labels or conf >= 85)
  // 4. landscape only → landscape
  let category: ImageCategory = 'other';

  if (hasPeople && hasAnimal) {
    // Both detected — compare strength
    if (animalCount > peopleCount || (animalCount === peopleCount && animalMaxConf > peopleMaxConf)) {
      category = 'animal';
    } else {
      category = 'people';
    }
  } else if (hasPeople) {
    category = 'people';
  } else if (hasAnimal) {
    const animalIsStrong = animalCount >= 2 || animalMaxConf >= 85;
    if (hasLandscape && !animalIsStrong) {
      category = 'landscape';
    } else {
      category = 'animal';
    }
  } else if (hasLandscape) {
    category = 'landscape';
  }

  const labelNames = items.map((i) => i.name);
  return { category, allCategories, labels: labelNames };
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

export async function classifyImage(imageBytes: Buffer): Promise<ClassifyResult>;
export async function classifyImage(s3Bucket: string, s3Key: string): Promise<ClassifyResult>;
export async function classifyImage(bytesOrBucket: Buffer | string, s3Key?: string): Promise<ClassifyResult> {
  const client = createRekognitionClient();

  // Build Image parameter: S3Object if bucket+key provided, Bytes otherwise
  const imageParam = typeof bytesOrBucket === 'string' && s3Key
    ? { S3Object: { Bucket: bytesOrBucket, Name: s3Key } }
    : { Bytes: bytesOrBucket as Buffer };

  const command = new DetectLabelsCommand({
    Image: imageParam,
    MaxLabels: 20,
    MinConfidence: 70,
  });

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await client.send(command);
      const labelsWithConf: LabelWithConfidence[] = (response.Labels ?? [])
        .filter((l) => l.Name)
        .map((l) => ({ name: l.Name!, confidence: l.Confidence ?? 0 }));
      return mapLabelsToCategory(labelsWithConf);
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

  const s3Bucket = process.env.S3_BUCKET || '';
  const useS3 = process.env.STORAGE_TYPE === 's3' && s3Bucket;

  for (const row of rows) {
    try {
      let result: ClassifyResult;
      if (useS3) {
        // Use S3Object — no size limit, no download needed
        result = await classifyImage(s3Bucket, row.file_path);
      } else {
        // Fallback: read file and pass as Bytes
        const imageBuffer = await storageProvider.read(row.file_path);
        result = await classifyImage(imageBuffer);
      }

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
