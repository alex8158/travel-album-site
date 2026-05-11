/**
 * pricingConfig — AI 模型单价配置
 *
 * 存储各 AI 提供商和模型的 token 单价配置。
 * 支持通过环境变量覆盖默认单价。
 *
 * Requirements: 5.2, 5.5
 */

import type { ModelPricing } from './types';

// ---------------------------------------------------------------------------
// Default Pricing (per million tokens, USD)
// ---------------------------------------------------------------------------

const DEFAULT_PRICING: ModelPricing[] = [
  // AWS Bedrock Claude models
  {
    provider: 'bedrock',
    model: 'anthropic.claude-3-haiku-20240307-v1:0',
    inputPricePerMToken: 0.25,
    outputPricePerMToken: 1.25,
  },
  {
    provider: 'bedrock',
    model: 'anthropic.claude-3-sonnet-20240229-v1:0',
    inputPricePerMToken: 3.0,
    outputPricePerMToken: 15.0,
  },
  {
    provider: 'bedrock',
    model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    inputPricePerMToken: 3.0,
    outputPricePerMToken: 15.0,
  },
  // OpenAI models
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    inputPricePerMToken: 0.15,
    outputPricePerMToken: 0.60,
  },
  {
    provider: 'openai',
    model: 'gpt-4o',
    inputPricePerMToken: 2.50,
    outputPricePerMToken: 10.0,
  },
];

// ---------------------------------------------------------------------------
// Fallback pricing for unknown models
// ---------------------------------------------------------------------------

/** Fallback input price per million tokens (USD) when model is not found */
export const FALLBACK_INPUT_PRICE_PER_MTOKEN = 1.0;

/** Fallback output price per million tokens (USD) when model is not found */
export const FALLBACK_OUTPUT_PRICE_PER_MTOKEN = 3.0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the full pricing configuration.
 * Merges default pricing with any environment variable overrides.
 *
 * Environment variable format:
 *   AI_PRICING_<PROVIDER>_<MODEL_SLUG>_INPUT=<price>
 *   AI_PRICING_<PROVIDER>_<MODEL_SLUG>_OUTPUT=<price>
 *
 * Example:
 *   AI_PRICING_OPENAI_GPT4O_INPUT=3.0
 *   AI_PRICING_OPENAI_GPT4O_OUTPUT=12.0
 */
export function getModelPricing(): ModelPricing[] {
  return DEFAULT_PRICING.map(pricing => {
    const slug = modelToSlug(pricing.provider, pricing.model);
    const inputEnv = process.env[`AI_PRICING_${slug}_INPUT`];
    const outputEnv = process.env[`AI_PRICING_${slug}_OUTPUT`];

    return {
      ...pricing,
      inputPricePerMToken: parseEnvPrice(inputEnv) ?? pricing.inputPricePerMToken,
      outputPricePerMToken: parseEnvPrice(outputEnv) ?? pricing.outputPricePerMToken,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert provider + model name to an environment variable slug.
 * e.g. ('bedrock', 'anthropic.claude-3-haiku-20240307-v1:0') → 'BEDROCK_ANTHROPIC_CLAUDE_3_HAIKU'
 */
function modelToSlug(provider: string, model: string): string {
  // Take the meaningful part of the model name (before version date)
  const simplified = model
    .replace(/[-.:]/g, '_')
    .replace(/\d{8,}/g, '')  // remove date stamps
    .replace(/_+/g, '_')
    .replace(/_v\d+_?\d*$/i, '')
    .replace(/_+$/, '')
    .toUpperCase();

  return `${provider.toUpperCase()}_${simplified}`;
}

function parseEnvPrice(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseFloat(value);
  return !isNaN(parsed) && parsed >= 0 ? parsed : undefined;
}
