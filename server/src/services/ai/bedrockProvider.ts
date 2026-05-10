import { createBedrockClient, type BedrockClient } from '../bedrockClient';
import type { AIProvider, AIProviderMetadata, AIResponse } from './types';

// Approximate token estimation (1 token ≈ 4 characters for English text)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * BedrockProvider wraps the existing createBedrockClient() to implement
 * the unified AIProvider interface.
 */
export class BedrockProvider implements AIProvider {
  readonly metadata: AIProviderMetadata;
  private client: BedrockClient;

  constructor() {
    this.client = createBedrockClient();

    const model = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0';

    this.metadata = {
      name: 'bedrock',
      model,
      capabilities: ['text-generation', 'image-analysis'],
      // Claude Haiku pricing (approximate per-token costs in USD)
      costPerInputToken: 0.00000025,   // $0.25 per 1M input tokens
      costPerOutputToken: 0.00000125,  // $1.25 per 1M output tokens
    };
  }

  async generateText(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<AIResponse> {
    const start = Date.now();

    const text = await this.client.invokeModel({
      images: [],
      prompt,
      maxTokens: options?.maxTokens ?? 1024,
    });

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

    const text = await this.client.invokeModel({
      images,
      prompt,
      maxTokens: options?.maxTokens ?? 1024,
    });

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
      await this.client.invokeModel({
        images: [],
        prompt: 'Respond with "ok".',
        maxTokens: 10,
      });

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
}
