/**
 * LLM 逐对审查服务 — Layer 2
 *
 * 支持多 Provider 级联回退：OpenAI → Bedrock → DashScope。
 * 自动检测已配置的 provider，首选 provider 失败时级联到下一个。
 * 所有 provider 均失败时回退到 Strict Threshold（从 dedupThresholds.ts 导入）。
 *
 * DashScope（千问 Qwen-VL）使用 OpenAI SDK 配合自定义 base URL 调用。
 */

import OpenAI from 'openai';
import {
  BedrockClient,
  createBedrockClient,
  resizeForAnalysis,
  extractJSON,
} from './bedrockClient';
import { applyStrictThreshold } from './dedupThresholds';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LLMProviderType = 'openai' | 'bedrock' | 'dashscope';

export interface ProviderConfig {
  type: LLMProviderType;
  client: BedrockClient;
}

export interface PairReviewRequest {
  imageA: { id: string; filePath: string };
  imageB: { id: string; filePath: string };
  clipSimilarity: number;
}

export interface PairReviewResult {
  imageAId: string;
  imageBId: string;
  isDuplicate: boolean;
  confidence: number;
  /** 实际使用的 provider（如果 LLM 成功） */
  usedProvider?: LLMProviderType;
  /** 是否因所有 provider 失败而回退到 Strict Threshold */
  fellBackToThreshold?: boolean;
}

// ---------------------------------------------------------------------------
// LLM Prompt
// ---------------------------------------------------------------------------

const PAIR_REVIEW_PROMPT = `You are an image deduplication expert. Compare these two images carefully.

Determine if they are duplicates (same photo with minor differences like cropping, compression, exposure) or distinct photos (different moments, angles, subjects).

Photos of the same scene but with different poses, expressions, or compositions are NOT duplicates.

Return ONLY a JSON object:
{"is_duplicate": true, "confidence": 0.95}

- is_duplicate: true if the images are duplicates, false otherwise
- confidence: a number between 0 and 1 indicating your confidence`;

// ---------------------------------------------------------------------------
// DashScope client factory (OpenAI SDK + custom base URL)
// ---------------------------------------------------------------------------

function createDashScopeClient(): BedrockClient {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY environment variable is required');

  const baseURL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const model = process.env.DASHSCOPE_MODEL || 'qwen-vl-max';

  const openai = new OpenAI({ apiKey, baseURL });

  return {
    async invokeModel(options) {
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

      for (const img of options.images) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${img.mediaType};base64,${img.base64}`, detail: 'low' },
        });
      }
      content.push({ type: 'text', text: options.prompt });

      const response = await openai.chat.completions.create({
        model,
        max_tokens: options.maxTokens ?? 1024,
        messages: [{ role: 'user', content }],
      });

      return response.choices[0]?.message?.content ?? '';
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI client factory (for provider detection — separate from bedrockClient)
// ---------------------------------------------------------------------------

function createOpenAIProviderClient(): BedrockClient {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is required');

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const openai = new OpenAI({ apiKey });

  return {
    async invokeModel(options) {
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

      for (const img of options.images) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${img.mediaType};base64,${img.base64}`, detail: 'low' },
        });
      }
      content.push({ type: 'text', text: options.prompt });

      const response = await openai.chat.completions.create({
        model,
        max_tokens: options.maxTokens ?? 1024,
        messages: [{ role: 'user', content }],
      });

      return response.choices[0]?.message?.content ?? '';
    },
  };
}


// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

/**
 * 自动检测已配置的 LLM provider。
 *
 * 检查环境变量：
 * - OpenAI: OPENAI_API_KEY
 * - Bedrock: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
 * - DashScope: DASHSCOPE_API_KEY
 *
 * 默认级联顺序：OpenAI → Bedrock → DashScope。
 * 当 preferredProvider 指定时，将其排到链首。
 * 首选 provider 环境变量未配置时记录 warning 日志，使用其他已检测到的 provider。
 */
export function detectConfiguredProviders(
  preferredProvider?: string,
): ProviderConfig[] {
  // Check AI_REVIEW_ENABLED — if explicitly set to false, skip all LLM providers
  const aiReviewEnabled = process.env.AI_REVIEW_ENABLED;
  if (aiReviewEnabled !== undefined && aiReviewEnabled.toLowerCase() === 'false') {
    console.log('[llmPairReviewer] AI_REVIEW_ENABLED=false — LLM pair review disabled');
    return [];
  }

  const available: ProviderConfig[] = [];

  // Detect OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      available.push({ type: 'openai', client: createOpenAIProviderClient() });
    } catch (err) {
      console.warn(`[llmPairReviewer] Failed to create OpenAI client: ${err}`);
    }
  }

  // Detect Bedrock
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    try {
      available.push({ type: 'bedrock', client: createBedrockClient() });
    } catch (err) {
      console.warn(`[llmPairReviewer] Failed to create Bedrock client: ${err}`);
    }
  }

  // Detect DashScope
  if (process.env.DASHSCOPE_API_KEY) {
    try {
      available.push({ type: 'dashscope', client: createDashScopeClient() });
    } catch (err) {
      console.warn(`[llmPairReviewer] Failed to create DashScope client: ${err}`);
    }
  }

  // Handle preferred provider
  const preferred = preferredProvider || process.env.LLM_DEDUP_PROVIDER;
  if (preferred) {
    const normalizedPreferred = preferred.toLowerCase() as LLMProviderType;
    const validTypes: LLMProviderType[] = ['openai', 'bedrock', 'dashscope'];

    if (validTypes.includes(normalizedPreferred)) {
      const idx = available.findIndex(p => p.type === normalizedPreferred);
      if (idx >= 0) {
        // Move preferred to front
        const [preferredConfig] = available.splice(idx, 1);
        available.unshift(preferredConfig);
      } else {
        // Preferred provider not configured — log warning
        console.warn(
          `[llmPairReviewer] Preferred provider '${preferred}' is not configured (missing required environment variables). ` +
          `Using other available providers: [${available.map(p => p.type).join(', ')}]`
        );
      }
    } else {
      console.warn(
        `[llmPairReviewer] Invalid LLM_DEDUP_PROVIDER value '${preferred}'. ` +
        `Valid values: openai, bedrock, dashscope`
      );
    }
  }

  return available;
}

// ---------------------------------------------------------------------------
// Pair review — single pair with cascade
// ---------------------------------------------------------------------------

interface LLMDedupResponse {
  is_duplicate: boolean;
  confidence: number;
}

/**
 * 对单个候选对尝试 provider 链中的所有 provider，返回第一个成功的结果。
 * 所有 provider 均失败时返回 null。
 */
async function reviewSinglePair(
  pair: PairReviewRequest,
  providerChain: ProviderConfig[],
): Promise<{ isDuplicate: boolean; confidence: number; usedProvider: LLMProviderType } | null> {
  // Resize both images for analysis
  let base64A: string;
  let base64B: string;
  try {
    [base64A, base64B] = await Promise.all([
      resizeForAnalysis(pair.imageA.filePath),
      resizeForAnalysis(pair.imageB.filePath),
    ]);
  } catch (err) {
    console.error(`[llmPairReviewer] Failed to resize images for pair (${pair.imageA.id}, ${pair.imageB.id}): ${err}`);
    return null;
  }

  for (const provider of providerChain) {
    try {
      const responseText = await provider.client.invokeModel({
        images: [
          { base64: base64A, mediaType: 'image/jpeg' },
          { base64: base64B, mediaType: 'image/jpeg' },
        ],
        prompt: PAIR_REVIEW_PROMPT,
      });

      const result = extractJSON<LLMDedupResponse>(responseText);

      // Validate response structure
      if (typeof result.is_duplicate !== 'boolean' || typeof result.confidence !== 'number') {
        throw new Error(`Invalid LLM response structure: ${JSON.stringify(result)}`);
      }

      return {
        isDuplicate: result.is_duplicate,
        confidence: Math.max(0, Math.min(1, result.confidence)),
        usedProvider: provider.type,
      };
    } catch (err) {
      console.error(
        `[llmPairReviewer] Provider '${provider.type}' failed for pair (${pair.imageA.id}, ${pair.imageB.id}): ${err}`
      );
      // Continue to next provider in cascade
    }
  }

  // All providers failed
  return null;
}

// ---------------------------------------------------------------------------
// reviewPairs — batch review with cascade fallback
// ---------------------------------------------------------------------------

/**
 * 对一组灰区候选对逐对调用 LLM 视觉模型审查。
 *
 * 支持多 provider 级联回退：首选 provider 失败时尝试下一个。
 * 所有 provider 均失败时对该对回退到 Strict Threshold（0.955）判定。
 *
 * @param pairs - 灰区候选对列表
 * @param providerChain - 按优先级排序的 provider 列表
 * @returns 每对的判定结果
 */
export async function reviewPairs(
  pairs: PairReviewRequest[],
  providerChain: ProviderConfig[],
): Promise<PairReviewResult[]> {
  const results: PairReviewResult[] = [];

  for (const pair of pairs) {
    const llmResult = await reviewSinglePair(pair, providerChain);

    if (llmResult) {
      // LLM succeeded
      results.push({
        imageAId: pair.imageA.id,
        imageBId: pair.imageB.id,
        isDuplicate: llmResult.isDuplicate,
        confidence: llmResult.confidence,
        usedProvider: llmResult.usedProvider,
        fellBackToThreshold: false,
      });
    } else {
      // All providers failed — fallback to Strict Threshold
      const isDuplicate = applyStrictThreshold(pair.clipSimilarity);
      console.warn(
        `[llmPairReviewer] All providers failed for pair (${pair.imageA.id}, ${pair.imageB.id}). ` +
        `Falling back to Strict Threshold: similarity=${pair.clipSimilarity}, isDuplicate=${isDuplicate}`
      );
      results.push({
        imageAId: pair.imageA.id,
        imageBId: pair.imageB.id,
        isDuplicate,
        confidence: isDuplicate ? 0.955 : 0,
        fellBackToThreshold: true,
      });
    }
  }

  return results;
}
