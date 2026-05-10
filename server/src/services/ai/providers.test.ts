import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the bedrockClient module before importing BedrockProvider
const mockInvokeModel = vi.fn();
vi.mock('../bedrockClient', () => ({
  createBedrockClient: () => ({
    invokeModel: mockInvokeModel,
  }),
}));

// Mock the openai module before importing OpenAIProvider
const mockCreate = vi.fn();
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockCreate,
        },
      };
    },
  };
});

import { BedrockProvider } from './bedrockProvider';
import { OpenAIProvider } from './openaiProvider';

describe('BedrockProvider', () => {
  let provider: BedrockProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new BedrockProvider();
  });

  it('should have correct metadata', () => {
    expect(provider.metadata.name).toBe('bedrock');
    expect(provider.metadata.capabilities).toContain('text-generation');
    expect(provider.metadata.capabilities).toContain('image-analysis');
  });

  describe('generateText', () => {
    it('should return a valid AIResponse with text, token counts, and elapsed time', async () => {
      mockInvokeModel.mockResolvedValue('This is a generated response');

      const result = await provider.generateText('Hello world');

      expect(result.text).toBe('This is a generated response');
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBeGreaterThan(0);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(mockInvokeModel).toHaveBeenCalledWith({
        images: [],
        prompt: 'Hello world',
        maxTokens: 1024,
      });
    });
  });

  describe('analyzeImage', () => {
    it('should return a valid AIResponse with text, token counts (including image tokens), and elapsed time', async () => {
      mockInvokeModel.mockResolvedValue('Image contains a sunset');

      const images = [{ base64: 'abc123', mediaType: 'image/jpeg' }];
      const result = await provider.analyzeImage(images, 'Describe this image');

      expect(result.text).toBe('Image contains a sunset');
      expect(result.inputTokens).toBeGreaterThan(0);
      // Image tokens should be included (1000 per image)
      expect(result.inputTokens).toBeGreaterThanOrEqual(1000);
      expect(result.outputTokens).toBeGreaterThan(0);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(mockInvokeModel).toHaveBeenCalledWith({
        images,
        prompt: 'Describe this image',
        maxTokens: 1024,
      });
    });
  });

  describe('getHealth', () => {
    it('should return available=true when client works', async () => {
      mockInvokeModel.mockResolvedValue('ok');

      const health = await provider.getHealth();

      expect(health.available).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should return available=false when client throws', async () => {
      mockInvokeModel.mockRejectedValue(new Error('Connection refused'));

      const health = await provider.getHealth();

      expect(health.available).toBe(false);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('OpenAIProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test-key-123');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should throw if OPENAI_API_KEY is not set', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    // Clear the env var entirely
    delete process.env.OPENAI_API_KEY;

    expect(() => new OpenAIProvider()).toThrow('OPENAI_API_KEY environment variable is required');
  });

  it('should have correct metadata', () => {
    const provider = new OpenAIProvider();

    expect(provider.metadata.name).toBe('openai');
    expect(provider.metadata.capabilities).toContain('text-generation');
    expect(provider.metadata.capabilities).toContain('image-analysis');
  });

  describe('generateText', () => {
    it('should return a valid AIResponse', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'OpenAI generated text' } }],
      });

      const provider = new OpenAIProvider();
      const result = await provider.generateText('Test prompt');

      expect(result.text).toBe('OpenAI generated text');
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBeGreaterThan(0);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('analyzeImage', () => {
    it('should return a valid AIResponse', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'A beautiful landscape photo' } }],
      });

      const provider = new OpenAIProvider();
      const images = [{ base64: 'imgdata', mediaType: 'image/png' }];
      const result = await provider.analyzeImage(images, 'Describe this');

      expect(result.text).toBe('A beautiful landscape photo');
      expect(result.inputTokens).toBeGreaterThanOrEqual(1000);
      expect(result.outputTokens).toBeGreaterThan(0);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getHealth', () => {
    it('should return available=true when API works', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'ok' } }],
      });

      const provider = new OpenAIProvider();
      const health = await provider.getHealth();

      expect(health.available).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should return available=false when API throws', async () => {
      mockCreate.mockRejectedValue(new Error('API error'));

      const provider = new OpenAIProvider();
      const health = await provider.getHealth();

      expect(health.available).toBe(false);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});
