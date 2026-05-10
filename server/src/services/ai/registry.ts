import { v4 as uuid } from 'uuid';
import { AIProvider, AIResponse } from './types';
import { getDb } from '../../database';

export interface InvocationContext {
  mediaId?: string;
  segmentId?: string;
  taskType: string;
}

export class AIProviderRegistry {
  private providers: Map<string, AIProvider> = new Map();
  private defaultProviderName: string;

  constructor() {
    this.defaultProviderName = process.env.AI_PROVIDER || '';
  }

  register(name: string, provider: AIProvider): void {
    this.providers.set(name, provider);
    // If no default is configured via env, use the first registered provider
    if (!this.defaultProviderName) {
      this.defaultProviderName = name;
    }
  }

  get(name?: string): AIProvider {
    if (!name) {
      return this.getDefault();
    }
    const provider = this.providers.get(name);
    if (!provider) {
      const available = this.listProviders();
      throw new Error(
        `AI provider "${name}" is not registered. Available providers: [${available.join(', ')}]`
      );
    }
    return provider;
  }

  getDefault(): AIProvider {
    const provider = this.providers.get(this.defaultProviderName);
    if (!provider) {
      const available = this.listProviders();
      if (available.length === 0) {
        throw new Error('No AI providers registered');
      }
      // Fallback to first registered if configured default isn't available
      return this.providers.values().next().value!;
    }
    return provider;
  }

  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  async invokeText(
    prompt: string,
    context: InvocationContext,
    options?: { providerName?: string; maxTokens?: number }
  ): Promise<AIResponse> {
    const provider = this.get(options?.providerName);
    const invocationId = this.createInvocationRecord(provider, context);

    try {
      const response = await provider.generateText(prompt, { maxTokens: options?.maxTokens });
      this.markCompleted(invocationId, response, provider);
      return response;
    } catch (err: unknown) {
      this.markFailed(invocationId, err);
      throw err;
    }
  }

  async invokeImageAnalysis(
    images: Array<{ base64: string; mediaType: string }>,
    prompt: string,
    context: InvocationContext,
    options?: { providerName?: string; maxTokens?: number }
  ): Promise<AIResponse> {
    const provider = this.get(options?.providerName);
    const invocationId = this.createInvocationRecord(provider, context);

    try {
      const response = await provider.analyzeImage(images, prompt, { maxTokens: options?.maxTokens });
      this.markCompleted(invocationId, response, provider);
      return response;
    } catch (err: unknown) {
      this.markFailed(invocationId, err);
      throw err;
    }
  }

  private createInvocationRecord(provider: AIProvider, context: InvocationContext): string {
    const id = uuid();
    const now = new Date().toISOString();
    const db = getDb();

    db.prepare(
      `INSERT INTO ai_invocations (id, media_id, segment_id, provider, model_name, task_type, status, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(
      id,
      context.mediaId || null,
      context.segmentId || null,
      provider.metadata.name,
      provider.metadata.model,
      context.taskType,
      now,
      now
    );

    return id;
  }

  private markCompleted(invocationId: string, response: AIResponse, provider: AIProvider): void {
    const now = new Date().toISOString();
    const estimatedCost =
      response.inputTokens * provider.metadata.costPerInputToken +
      response.outputTokens * provider.metadata.costPerOutputToken;
    const db = getDb();

    db.prepare(
      `UPDATE ai_invocations
       SET status = 'completed',
           response_payload = ?,
           input_tokens = ?,
           output_tokens = ?,
           estimated_cost = ?,
           finished_at = ?
       WHERE id = ?`
    ).run(
      JSON.stringify({ text: response.text }),
      response.inputTokens,
      response.outputTokens,
      estimatedCost,
      now,
      invocationId
    );
  }

  private markFailed(invocationId: string, err: unknown): void {
    const now = new Date().toISOString();
    const errorMessage = err instanceof Error ? err.message : String(err);
    const db = getDb();

    db.prepare(
      `UPDATE ai_invocations
       SET status = 'failed',
           error_message = ?,
           finished_at = ?
       WHERE id = ?`
    ).run(errorMessage, now, invocationId);
  }
}
