import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
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
  'anthropic.claude-sonnet-4-20250514',
  'amazon.nova-pro-v1:0',
  'amazon.nova-lite-v1:0',
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
      inferenceConfig: { maxNewTokens: maxTokens },
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
              err.name === 'ValidationException' ||
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
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
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

const SINGLE_IMAGE_PROMPT = `Analyze this image and return a JSON object with exactly two fields:
1. "blur_status": "blurry" if the image is out of focus or has motion blur, "clear" otherwise. Note: dark or low-light images are NOT blurry unless they are actually out of focus.
2. "category": classify the main subject as one of: "people", "animal", "landscape", "other".
   - "people": humans are the main subject
   - "animal": animals are the main subject (including underwater marine life, even if divers are present)
   - "landscape": natural scenery, cityscapes, architecture with no prominent living subjects
   - "other": food, objects, abstract, etc.

Return ONLY a JSON object, no other text:
{"blur_status": "clear", "category": "landscape"}`;

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
