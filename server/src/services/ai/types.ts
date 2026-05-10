// AI response standard format
export interface AIResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
}

// Provider capabilities
export type AICapability = 'text-generation' | 'image-analysis' | 'embedding';

// Provider metadata
export interface AIProviderMetadata {
  name: string;
  model: string;
  capabilities: AICapability[];
  costPerInputToken: number;
  costPerOutputToken: number;
}

// Unified Provider interface
export interface AIProvider {
  readonly metadata: AIProviderMetadata;

  generateText(prompt: string, options?: {
    maxTokens?: number;
    temperature?: number;
  }): Promise<AIResponse>;

  analyzeImage(images: Array<{ base64: string; mediaType: string }>, prompt: string, options?: {
    maxTokens?: number;
  }): Promise<AIResponse>;

  getHealth(): Promise<{ available: boolean; latencyMs: number }>;
}
