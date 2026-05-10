import OpenAI from 'openai';
import type { AIProvider, AIProviderMetadata, AIResponse } from './types';

// Approximate token estimation (1 token ≈ 4 characters for English text)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OpenAIProvider wraps the OpenAI SDK to implement the unified AIProvider interface.
 *
 * Supports any OpenAI-compatible API by setting OPENAI_BASE_URL:
 * - OpenAI: (default) https://api.openai.com/v1
 * - 千问 (Qwen-VL): https://dashscope.aliyuncs.com/compatible-mode/v1
 * - DeepSeek: https://api.deepseek.com/v1
 * - 月之暗面 (Moonshot): https://api.moonshot.cn/v1
 * - 智谱 (GLM-4V): https://open.bigmodel.cn/api/paas/v4
 */
export class OpenAIProvider implements AIProvider {
  readonly metadata: AIProviderMetadata;
  private openai: OpenAI;
  private model: string;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is required');

    const baseURL = process.env.OPENAI_BASE_URL || undefined;
    this.openai = new OpenAI({ apiKey, baseURL });
    this.model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    // Determine provider name from baseURL for cost tracking
    const providerName = this.detectProviderName(baseURL);

    this.metadata = {
      name: providerName,
      model: this.model,
      capabilities: ['text-generation', 'image-analysis'],
      // Default pricing (GPT-4o-mini); actual cost depends on provider
      costPerInputToken: 0.00000015,   // $0.15 per 1M input tokens
      costPerOutputToken: 0.0000006,   // $0.60 per 1M output tokens
    };
  }

  private detectProviderName(baseURL?: string): string {
    if (!baseURL) return 'openai';
    if (baseURL.includes('dashscope')) return 'qwen';
    if (baseURL.includes('deepseek')) return 'deepseek';
    if (baseURL.includes('moonshot')) return 'moonshot';
    if (baseURL.includes('bigmodel')) return 'zhipu';
    return 'openai-compatible';
  }

  async generateText(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<AIResponse> {
    const start = Date.now();

    const text = await this.invokeWithRetry([], prompt, options?.maxTokens ?? 1024);

    const elapsedMs = Date.now() - start;

    return {
      text,
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens(text),
      elapsedMs,
    };
  }

  async analyzeImage(
    images: Array<{ base64: string; mediaType: string }>,
    prompt: string,
    options?: { maxTokens?: number },
  ): Promise<AIResponse> {
    const start = Date.now();

    const text = await this.invokeWithRetry(images, prompt, options?.maxTokens ?? 1024);

    const elapsedMs = Date.now() - start;

    // Estimate input tokens: prompt text + image tokens (roughly 1000 tokens per image)
    const promptTokens = estimateTokens(prompt);
    const imageTokens = images.length * 1000;

    return {
      text,
      inputTokens: promptTokens + imageTokens,
      outputTokens: estimateTokens(text),
      elapsedMs,
    };
  }

  async getHealth(): Promise<{ available: boolean; latencyMs: number }> {
    const start = Date.now();

    try {
      await this.invokeWithRetry([], 'Respond with "ok".', 10);

      return {
        available: true,
        latencyMs: Date.now() - start,
      };
    } catch {
      return {
        available: false,
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Internal helper that calls the OpenAI chat completions API with retry on rate limits.
   */
  private async invokeWithRetry(
    images: Array<{ base64: string; mediaType: string }>,
    prompt: string,
    maxTokens: number,
  ): Promise<string> {
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

    for (const img of images) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${img.mediaType};base64,${img.base64}`, detail: 'low' },
      });
    }
    content.push({ type: 'text', text: prompt });

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.openai.chat.completions.create({
          model: this.model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content }],
        });
        return response.choices[0]?.message?.content ?? '';
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
  }
}
