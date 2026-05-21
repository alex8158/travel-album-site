import OpenAI from 'openai';
import { getDb } from '../database';
import { getStorageProvider } from '../storage/factory';
import { resizeForAnalysis } from './bedrockClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScreeningResult {
  keep: number[];
  remove: number[];
  reason: string;
}

export interface AiScreeningResult {
  totalProcessed: number;
  totalRemoved: number;
  batchResults: Array<{ batch: number; removed: number; reason: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 10;

const SCREENING_PROMPT = `You are a photo curator for a travel album. I'm showing you a group of similar photos.

Your tasks:
1. Identify which photos are of the same subject/scene (even from different angles)
2. Remove any blurry, out-of-focus, or poorly exposed photos
3. From photos of the same subject, keep only the BEST 1-2 photos (sharpest, best composition, best lighting)

Return a JSON object:
{"keep": [0, 3], "remove": [1, 2, 4], "reason": "Photos 1,2,4 are blurry or duplicate angles of the same fish"}

- "keep": array of image indices (0-based) to keep
- "remove": array of image indices to trash
- "reason": brief explanation

Be aggressive about removing duplicates and blurry photos. When in doubt, remove.`;

// ---------------------------------------------------------------------------
// DashScope client (reuses pattern from llmPairReviewer)
// ---------------------------------------------------------------------------

function createScreeningClient(): OpenAI {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY environment variable is required');

  const baseURL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  return new OpenAI({ apiKey, baseURL });
}

// ---------------------------------------------------------------------------
// Main screening function
// ---------------------------------------------------------------------------

export async function runAiScreening(tripId: string): Promise<AiScreeningResult> {
  const db = getDb();
  const storageProvider = getStorageProvider();

  // Get all active images for this trip after dedup
  const activeImages = db.prepare(
    `SELECT id, file_path FROM media_items
     WHERE trip_id = ? AND media_type = 'image' AND status = 'active'
     ORDER BY created_at ASC`
  ).all(tripId) as Array<{ id: string; file_path: string }>;

  if (activeImages.length <= 1) {
    return { totalProcessed: 0, totalRemoved: 0, batchResults: [] };
  }

  const model = process.env.DASHSCOPE_MODEL || 'qwen-vl-max';
  const client = createScreeningClient();

  // Split into batches
  const batches: Array<Array<{ id: string; file_path: string }>> = [];
  for (let i = 0; i < activeImages.length; i += BATCH_SIZE) {
    batches.push(activeImages.slice(i, i + BATCH_SIZE));
  }

  const result: AiScreeningResult = {
    totalProcessed: activeImages.length,
    totalRemoved: 0,
    batchResults: [],
  };

  const trashStmt = db.prepare(
    `UPDATE media_items SET status = 'trashed', trashed_reason = 'ai_screening' WHERE id = ?`
  );

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];

    try {
      // Prepare images as base64 thumbnails
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

      let prepFailed = false;
      for (let imgIdx = 0; imgIdx < batch.length; imgIdx++) {
        const img = batch[imgIdx];
        try {
          const localPath = await storageProvider.downloadToTemp(img.file_path);
          const base64 = await resizeForAnalysis(localPath);
          content.push({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[pipeline] aiScreening: failed to prepare image ${img.id}: ${msg}`);
          prepFailed = true;
          break;
        }
      }

      if (prepFailed || content.length === 0) {
        console.log(`[pipeline] aiScreening: batch ${batchIdx + 1}/${batches.length} skipped (prep failed)`);
        continue;
      }

      content.push({ type: 'text', text: SCREENING_PROMPT });

      // Call qwen-vl-max
      const response = await client.chat.completions.create({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content }],
      });

      const responseText = response.choices[0]?.message?.content ?? '';

      // Parse response
      const screening = parseScreeningResponse(responseText, batch.length);

      if (screening && screening.remove.length > 0) {
        // Mark removed images as trashed
        for (const removeIdx of screening.remove) {
          if (removeIdx >= 0 && removeIdx < batch.length) {
            trashStmt.run(batch[removeIdx].id);
          }
        }
        const removedCount = screening.remove.filter(i => i >= 0 && i < batch.length).length;
        result.totalRemoved += removedCount;
        result.batchResults.push({
          batch: batchIdx + 1,
          removed: removedCount,
          reason: screening.reason,
        });
        console.log(`[pipeline] aiScreening: batch ${batchIdx + 1}/${batches.length}, removed ${removedCount} images`);
      } else {
        console.log(`[pipeline] aiScreening: batch ${batchIdx + 1}/${batches.length}, no removals`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[pipeline] aiScreening: batch ${batchIdx + 1}/${batches.length} failed: ${msg}`);
      // Skip failed batch and continue
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Response parsing helper
// ---------------------------------------------------------------------------

function parseScreeningResponse(text: string, batchSize: number): ScreeningResult | null {
  try {
    // Try to extract JSON from markdown code blocks
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    let jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : text.trim();

    // Try to find JSON object in the text
    if (!jsonStr.startsWith('{')) {
      const objectMatch = jsonStr.match(/(\{[\s\S]*\})/);
      if (objectMatch) {
        jsonStr = objectMatch[1];
      }
    }

    const parsed = JSON.parse(jsonStr) as ScreeningResult;

    // Validate the response
    if (!Array.isArray(parsed.keep) || !Array.isArray(parsed.remove)) {
      return null;
    }

    // Filter out invalid indices
    parsed.keep = parsed.keep.filter(i => typeof i === 'number' && i >= 0 && i < batchSize);
    parsed.remove = parsed.remove.filter(i => typeof i === 'number' && i >= 0 && i < batchSize);

    // Ensure no overlap between keep and remove
    const keepSet = new Set(parsed.keep);
    parsed.remove = parsed.remove.filter(i => !keepSet.has(i));

    if (!parsed.reason || typeof parsed.reason !== 'string') {
      parsed.reason = 'AI screening';
    }

    return parsed;
  } catch {
    return null;
  }
}
