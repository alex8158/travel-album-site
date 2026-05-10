// Barrel exports
export * from './types';
export { AIProviderRegistry, type InvocationContext } from './registry';
export { BedrockProvider } from './bedrockProvider';
export { OpenAIProvider } from './openaiProvider';

import { AIProviderRegistry } from './registry';
import { BedrockProvider } from './bedrockProvider';
import { OpenAIProvider } from './openaiProvider';

let registryInstance: AIProviderRegistry | null = null;

/**
 * Singleton factory that returns a shared AIProviderRegistry instance.
 * On first call, creates the registry and registers available providers.
 * BedrockProvider is always registered; OpenAIProvider is only registered
 * if the OPENAI_API_KEY environment variable is set.
 */
export function getAIProviderRegistry(): AIProviderRegistry {
  if (!registryInstance) {
    registryInstance = new AIProviderRegistry();
    registryInstance.register('bedrock', new BedrockProvider());

    if (process.env.OPENAI_API_KEY) {
      registryInstance.register('openai', new OpenAIProvider());
    }
  }
  return registryInstance;
}
