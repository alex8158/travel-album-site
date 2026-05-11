// Barrel exports
export * from './types';
export { AIProviderRegistry, type InvocationContext } from './registry';
export { BedrockProvider } from './bedrockProvider';
export { OpenAIProvider } from './openaiProvider';
export { ContentAnalyzer } from './contentAnalyzer';
export { EditPlanner, hasAIAnalysis, calculateWeightedScore, fallbackSelection } from './editPlanner';
export { TextGenerator } from './textGenerator';
export { CostTracker } from './costTracker';
export { BudgetController } from './budgetController';
export { getModelPricing, FALLBACK_INPUT_PRICE_PER_MTOKEN, FALLBACK_OUTPUT_PRICE_PER_MTOKEN } from './pricingConfig';
export { resizeForProvider, getImageDimensions } from './imageUtils';
export {
  executeDegradationChain,
  getAvailableProvider,
  isAIServiceConfigured,
  setRegistryGetter,
  type DegradationLevel,
  type DegradationResult,
  type DegradationOptions,
} from './degradationStrategy';

import { AIProviderRegistry } from './registry';
import { BedrockProvider } from './bedrockProvider';
import { OpenAIProvider } from './openaiProvider';
import { setRegistryGetter } from './degradationStrategy';

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
      const provider = new OpenAIProvider();
      registryInstance.register(provider.metadata.name, provider);
    }

    // Inject the registry getter into degradationStrategy to avoid circular dependency
    setRegistryGetter(() => getAIProviderRegistry());
  }
  return registryInstance;
}
