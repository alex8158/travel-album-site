import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import OpenAI from 'openai';
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BedrockInvokeOptions {
  images: Array<{ base64: string; mediaType: string }>;
  prompt: string;
  maxTokens?: number;
}

export interface BedrockClient {
  invokeModel(options: BedrockInvokeOptions): Promise<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Model configuration — fallback chain for vision-capable models
// ---------------------------------------------------------------------------

const MODEL_FALLBACK_CHAIN = [
  'amazon.nova-pro-v1:0',
  'amazon.nova-2-lite-v1:0',
  'amazon.nova-lite-v1:0',
  'anthropic.claude-sonnet-4-20250514',
];

function isClaudeModel(modelId: string): boolean {
  return modelId.startsWith('anthropic.');
}

function isNovaModel(modelId: string): boolean {
  return modelId.startsWith('amazon.nova');
}

function buildRequestBody(
  modelId: string,
  images: Array<{ base64: string; mediaType: string }>,
  prompt: string,
  maxTokens: number,
): string {
  if (isClaudeModel(modelId)) {
    // Claude Messages API format
    const content: unknown[] = [];
    for (const img of images) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
      });
    }
    content.push({ type: 'text', text: prompt });
    return JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }],
    });
  }

  if (isNovaModel(modelId)) {
    // Amazon Nova format
    const content: unknown[] = [];
    for (const img of images) {
      content.push({
        image: { format: 'jpeg', source: { bytes: img.base64 } },
      });
    }
    content.push({ text: prompt });
    return JSON.stringify({
      messages: [{ role: 'user', content }],
      inferenceConfig: { max_new_tokens: maxTokens },
    });
  }

  // Default: try Claude format
  const content: unknown[] = [];
  for (const img of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    });
  }
  content.push({ type: 'text', text: prompt });
  return JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
  });
}

function extractResponseText(modelId: string, responseBody: Record<string, unknown>): string {
  if (isClaudeModel(modelId)) {
    const content = responseBody.content as Array<{ text?: string }> | undefined;
    return content?.[0]?.text ?? '';
  }
  if (isNovaModel(modelId)) {
    const output = responseBody.output as { message?: { content?: Array<{ text?: string }> } } | undefined;
    return output?.message?.content?.[0]?.text ?? '';
  }
  // Default: try Claude format
  const content = responseBody.content as Array<{ text?: string }> | undefined;
  return content?.[0]?.text ?? '';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBedrockClient(): BedrockClient {
  const region = process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const configuredModelId = process.env.BEDROCK_MODEL_ID || '';

  const client = new BedrockRuntimeClient({
    region,
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  });

  // If user specified a model, use only that; otherwise try fallback chain
  const modelsToTry = configuredModelId
    ? [configuredModelId]
    : MODEL_FALLBACK_CHAIN;

  // Track which model works (sticky after first success)
  let activeModelId: string | null = null;

  return {
    async invokeModel(options: BedrockInvokeOptions): Promise<string> {
      const models = activeModelId ? [activeModelId] : modelsToTry;

      for (const modelId of models) {
        const body = buildRequestBody(modelId, options.images, options.prompt, options.maxTokens ?? 1024);
        const command = new InvokeModelCommand({
          modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: new TextEncoder().encode(body),
        });

        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await client.send(command);
            const responseBody = JSON.parse(new TextDecoder().decode(response.body));
            const text = extractResponseText(modelId, responseBody);
            activeModelId = modelId; // Sticky — use this model for future calls
            console.log(`[BedrockClient] Using model: ${modelId}`);
            return text;
          } catch (err: unknown) {
            lastError = err;
            const isThrottling = err instanceof Error && err.name === 'ThrottlingException';
            if (isThrottling && attempt < 2) {
              await sleep(Math.pow(2, attempt) * 1000);
              continue;
            }
            // Model access denied or not available — try next model
            const isAccessDenied = err instanceof Error && (
              err.name === 'AccessDeniedException' ||
              err.name === 'ResourceNotFoundException'
            );
            if (isAccessDenied) {
              console.warn(`[BedrockClient] Model ${modelId} not available, trying next...`);
              break; // Break retry loop, try next model
            }
            throw err;
          }
        }
      }

      throw new Error(`All Bedrock models failed. Tried: ${models.join(', ')}`);
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI client factory
// ---------------------------------------------------------------------------

function createOpenAIClient(): BedrockClient {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is required');

  const openai = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  return {
    async invokeModel(options: BedrockInvokeOptions): Promise<string> {
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

      for (const img of options.images) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${img.mediaType};base64,${img.base64}`, detail: 'low' },
        });
      }
      content.push({ type: 'text', text: options.prompt });

      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await openai.chat.completions.create({
            model,
            max_tokens: options.maxTokens ?? 1024,
            messages: [{ role: 'user', content }],
          });
          const text = response.choices[0]?.message?.content ?? '';
          console.log(`[OpenAIClient] Using model: ${model}`);
          return text;
        } catch (err: unknown) {
          lastError = err;
          if (err instanceof Error && err.message.includes('Rate limit')) {
            await sleep(Math.pow(2, attempt) * 1000);
            continue;
          }
          throw err;
        }
      }
      throw lastError;
    },
  };
}

// ---------------------------------------------------------------------------
// Unified client factory — picks provider based on AI_PROVIDER env var
// ---------------------------------------------------------------------------

export function createAIClient(): BedrockClient {
  const provider = process.env.AI_PROVIDER || 'bedrock';
  if (provider === 'openai') return createOpenAIClient();
  return createBedrockClient();
}

// ---------------------------------------------------------------------------
// JSON extraction helper
// ---------------------------------------------------------------------------

export function extractJSON<T = unknown>(text: string): T {
  // 1. Try to extract JSON from markdown code blocks: ```json ... ``` or ``` ... ```
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    return JSON.parse(codeBlockMatch[1].trim()) as T;
  }

  // 2. Try to parse the entire text as JSON
  try {
    return JSON.parse(text.trim()) as T;
  } catch {
    // continue to next strategy
  }

  // 3. Try to find the first { ... } or [ ... ] in the text
  const objectMatch = text.match(/(\{[\s\S]*\})/);
  if (objectMatch) {
    return JSON.parse(objectMatch[1]) as T;
  }

  const arrayMatch = text.match(/(\[[\s\S]*\])/);
  if (arrayMatch) {
    return JSON.parse(arrayMatch[1]) as T;
  }

  // 4. Nothing worked
  throw new Error(`Failed to extract JSON from response: ${text.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Image resize helper
// ---------------------------------------------------------------------------

export async function resizeForAnalysis(imagePath: string): Promise<string> {
  try {
    const buffer = await sharp(imagePath, { failOn: 'none' })
      .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return buffer.toString('base64');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to resize image ${imagePath}: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Single image analysis (blur + classification combined)
// ---------------------------------------------------------------------------

import type { ImageCategory } from './imageClassifier';

export interface SingleImageAnalysis {
  blur_status: 'clear' | 'blurry';
  category: ImageCategory;
}

const SINGLE_IMAGE_PROMPT = `Look at this image carefully and return a JSON object with exactly two fields:

1. "blur_status": "blurry" if the image is out of focus or has motion blur, "clear" otherwise. Dark or low-light images are NOT blurry.

2. "category": What is the MAIN SUBJECT of this photo? Choose one:
   - "animal": if ANY animal is visible (lion, elephant, giraffe, bird, fish, dog, cat, whale, turtle, etc.) — even if there is also scenery in the background. Safari/wildlife photos are ALWAYS "animal".
   - "people": if humans are the main subject (portraits, group photos, selfies)
   - "landscape": ONLY if there are NO animals and NO people — pure scenery, buildings, mountains, ocean without creatures
   - "other": food, objects, abstract art, etc.

IMPORTANT: If you can see ANY animal in the photo, even small or in the background, classify as "animal". A photo of a lion in grassland is "animal", NOT "landscape".

Return ONLY a JSON object:
{"blur_status": "clear", "category": "animal"}`;

export async function analyzeImageWithBedrock(
  imagePath: string,
  bedrockClient: BedrockClient,
): Promise<SingleImageAnalysis> {
  try {
    const base64 = await resizeForAnalysis(imagePath);
    const response = await bedrockClient.invokeModel({
      images: [{ base64, mediaType: 'image/jpeg' }],
      prompt: SINGLE_IMAGE_PROMPT,
    });
    const result = extractJSON<SingleImageAnalysis>(response);
    // Validate fields
    const validBlur = ['clear', 'blurry'];
    const validCategory = ['people', 'animal', 'landscape', 'other'];
    if (!validBlur.includes(result.blur_status)) result.blur_status = 'clear';
    if (!validCategory.includes(result.category)) result.category = 'other';
    return result;
  } catch (err) {
    console.error('[bedrockAnalysis] Failed to analyze image:', err);
    return { blur_status: 'clear', category: 'other' };
  }
}
