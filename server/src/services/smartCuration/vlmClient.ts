/**
 * VLM Client — unified provider-agnostic interface
 *
 * Smart-curation has three stages that all need the same shape of VLM call:
 *   - Phase 1 (vlmSelector):   pick best-of-group
 *   - Phase 2 (aiReview):      per-photo keep/trash judgement
 *   - Phase 3 (aiFinalDedup):  cross-photo redundancy
 *
 * Each stage just needs "send N images + a prompt, get text back". This module
 * gives them one function — `callVLM` — that talks to whichever provider is
 * configured: Anthropic Claude or Alibaba DashScope (qwen-vl-max via OpenAI-
 * compatible endpoint).
 *
 * Provider selection
 * ------------------
 *   SMART_CURATION_VLM_PROVIDER = 'anthropic' | 'dashscope'   (default: 'dashscope')
 *
 * The choice is intentionally **single-provider with no automatic fallback**:
 * deployments in mainland China set `dashscope`; overseas deployments set
 * `anthropic`. Mixing models inside one trip would muddle the curation
 * decisions and is not what we want.
 *
 * Per-provider configuration
 * --------------------------
 *   ANTHROPIC_API_KEY                        Anthropic key (sk-ant-...)
 *   SMART_CURATION_ANTHROPIC_MODEL           default: claude-opus-4-7
 *   ANTHROPIC_BASE_URL                       optional override
 *
 *   DASHSCOPE_API_KEY                        DashScope key
 *   SMART_CURATION_DASHSCOPE_MODEL           default: qwen-vl-max
 *                                            (legacy DASHSCOPE_MODEL still honoured)
 *   DASHSCOPE_BASE_URL                       default OpenAI-compatible endpoint
 *
 *   SMART_CURATION_VLM_TIMEOUT_MS            request timeout, default 60s
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { createBedrockClient } from '../bedrockClient';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type VLMProvider = 'anthropic' | 'dashscope' | 'bedrock' | 'openai';

export interface VLMImage {
  /** Base-64 encoded image bytes (no data: prefix). */
  base64: string;
  /** MIME type, defaults to image/jpeg. */
  mediaType?: string;
}

export interface VLMRequest {
  images: VLMImage[];
  prompt: string;
  /** Max output tokens, defaults to 2048. */
  maxTokens?: number;
}

export interface VLMResponse {
  /** Raw text content from the model. */
  text: string;
  /** Provider that handled this call (useful for log/debug). */
  provider: VLMProvider;
  /** Concrete model id, e.g. claude-opus-4-7, qwen-vl-max. */
  model: string;
  /** Token accounting if the provider reports it. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 2048;

const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-7';
const DEFAULT_DASHSCOPE_MODEL = 'qwen-vl-max';
const DEFAULT_BEDROCK_MODEL = 'anthropic.claude-sonnet-4-20250514';

function readTimeoutMs(): number {
  const raw = process.env.SMART_CURATION_VLM_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

/** All valid provider values for type-checking and validation. */
const VALID_PROVIDERS: readonly VLMProvider[] = ['anthropic', 'dashscope', 'bedrock', 'openai'];

/**
 * Build a diagnostic string showing set/unset status of relevant env vars.
 * NEVER prints actual secret values — only "set" or "unset".
 */
function envStatusSummary(): string {
  const vars: Record<string, boolean> = {
    DASHSCOPE_API_KEY: !!process.env.DASHSCOPE_API_KEY,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    AWS_ACCESS_KEY_ID: !!process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: !!process.env.AWS_SECRET_ACCESS_KEY,
    AWS_BEARER_TOKEN_BEDROCK: !!process.env.AWS_BEARER_TOKEN_BEDROCK,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    OPENAI_MODEL: !!process.env.OPENAI_MODEL,
    OPENAI_BASE_URL: !!process.env.OPENAI_BASE_URL,
  };
  return Object.entries(vars)
    .map(([k, v]) => `${k}=${v ? 'set' : 'unset'}`)
    .join(', ');
}

/**
 * Resolve the active provider from env using a two-layer strategy:
 *
 * 1. **Explicit**: If `SMART_CURATION_VLM_PROVIDER` is set to a valid value,
 *    use it strictly (no auto-detection).
 * 2. **Auto-detect**: If unset, probe credentials in priority order:
 *    DashScope → Anthropic → Bedrock → OpenAI-compatible.
 *    This preserves backward compatibility (DashScope was the old default).
 *
 * Falls back to 'dashscope' only when no provider can be detected at all
 * (matches legacy behavior for deployments with no credentials configured).
 */
export function getActiveProvider(): VLMProvider {
  const raw = (process.env.SMART_CURATION_VLM_PROVIDER || '').trim().toLowerCase();

  // Layer 1: Explicit provider setting
  if (raw !== '') {
    if ((VALID_PROVIDERS as readonly string[]).includes(raw)) {
      const provider = raw as VLMProvider;
      console.log(
        `[vlmClient] Provider resolved: provider=${provider}, method=explicit, env: ${envStatusSummary()}`
      );
      return provider;
    }
    // Invalid explicit value — warn and fall through to auto-detect
    console.warn(
      `[vlmClient] SMART_CURATION_VLM_PROVIDER="${raw}" is not recognised; ` +
      `valid values: ${VALID_PROVIDERS.join(' | ')}. Falling back to auto-detect.`
    );
  }

  // Layer 2: Auto-detect by credential presence (priority order)
  let detected: VLMProvider;

  if (process.env.DASHSCOPE_API_KEY) {
    detected = 'dashscope';
  } else if (process.env.ANTHROPIC_API_KEY) {
    detected = 'anthropic';
  } else if (
    process.env.AWS_BEARER_TOKEN_BEDROCK ||
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
  ) {
    detected = 'bedrock';
  } else if (process.env.OPENAI_API_KEY) {
    detected = 'openai';
  } else {
    // No credentials found at all — fall back to dashscope (legacy default)
    detected = 'dashscope';
  }

  console.log(
    `[vlmClient] Provider resolved: provider=${detected}, method=auto-detect, env: ${envStatusSummary()}`
  );
  return detected;
}

/**
 * Whether the configured provider has its credentials set.
 *
 * Stages call this to decide whether they should run at all (when the answer
 * is `false` they skip themselves and keep every photo as-is — the same
 * behaviour as before this refactor).
 */
export function isVLMAvailable(): boolean {
  switch (getActiveProvider()) {
    case 'anthropic':
      return !!process.env.ANTHROPIC_API_KEY;
    case 'dashscope':
      return !!process.env.DASHSCOPE_API_KEY;
    case 'bedrock':
      // Bedrock accepts either a bearer token (AWS_BEARER_TOKEN_BEDROCK) or
      // standard AWS access-key credentials. The SDK resolves these itself,
      // so treat the provider as available if any of them is present.
      return (
        !!process.env.AWS_BEARER_TOKEN_BEDROCK ||
        !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
      );
    case 'openai':
      return !!(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
  }
}

/**
 * Resolve the concrete model id used for the active provider. Exported for
 * log messages so we can write `VLM provider=anthropic model=claude-opus-4-7`.
 */
export function getActiveModel(): string {
  switch (getActiveProvider()) {
    case 'anthropic':
      return process.env.SMART_CURATION_ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
    case 'dashscope':
      // Honour both the new and the legacy env var.
      return (
        process.env.SMART_CURATION_DASHSCOPE_MODEL ||
        process.env.DASHSCOPE_MODEL ||
        DEFAULT_DASHSCOPE_MODEL
      );
    case 'bedrock':
      return (
        process.env.SMART_CURATION_BEDROCK_MODEL ||
        process.env.BEDROCK_MODEL_ID ||
        DEFAULT_BEDROCK_MODEL
      );
    case 'openai':
      return process.env.OPENAI_MODEL || '';
  }
}

// ---------------------------------------------------------------------------
// Anthropic provider
//
// Supports both the standard Anthropic API (api.anthropic.com with sk-ant-...)
// and AWS Claude Platform (Anthropic on AWS — requires base URL override and
// an `anthropic-workspace-id` header). The latter is detected by
// ANTHROPIC_WORKSPACE_ID being set; when it is, every request gets the
// header injected.
// ---------------------------------------------------------------------------

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (anthropicClient) return anthropicClient;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is required');

  // AWS Claude Platform requires a workspace-id header on every request.
  // The Anthropic Node SDK lets us pass defaultHeaders that get merged with
  // every request, so set it once at construction time.
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
  const defaultHeaders: Record<string, string> = {};
  if (workspaceId) {
    defaultHeaders['anthropic-workspace-id'] = workspaceId;
  }

  anthropicClient = new Anthropic({
    apiKey,
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    timeout: readTimeoutMs(),
    ...(Object.keys(defaultHeaders).length > 0 ? { defaultHeaders } : {}),
  });
  return anthropicClient;
}

async function callAnthropic(req: VLMRequest): Promise<VLMResponse> {
  const client = getAnthropicClient();
  const model = process.env.SMART_CURATION_ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;

  // Anthropic message content: each image as { type: 'image', source: { ... } },
  // followed by the prompt text. Keeping image-first preserves index ordering
  // so the parser's "index N refers to the Nth image" contract still holds.
  const content: Anthropic.Messages.ContentBlockParam[] = req.images.map((img) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: (img.mediaType || 'image/jpeg') as
        | 'image/jpeg'
        | 'image/png'
        | 'image/gif'
        | 'image/webp',
      data: img.base64,
    },
  }));
  content.push({ type: 'text', text: req.prompt });

  const response = await client.messages.create({
    model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: [{ role: 'user', content }],
  });

  // The response content is an array of blocks; we only care about text.
  // Concatenate any text blocks (in practice there is one).
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((b) => b.text)
    .join('');

  return {
    text,
    provider: 'anthropic',
    model,
    usage: {
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// DashScope (qwen-vl-max via OpenAI-compatible endpoint)
// ---------------------------------------------------------------------------

let dashscopeClient: OpenAI | null = null;

function getDashscopeClient(): OpenAI {
  if (dashscopeClient) return dashscopeClient;

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY environment variable is required');

  const baseURL =
    process.env.DASHSCOPE_BASE_URL ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1';

  dashscopeClient = new OpenAI({
    apiKey,
    baseURL,
    timeout: readTimeoutMs(),
  });
  return dashscopeClient;
}

async function callDashscope(req: VLMRequest): Promise<VLMResponse> {
  const client = getDashscopeClient();
  const model =
    process.env.SMART_CURATION_DASHSCOPE_MODEL ||
    process.env.DASHSCOPE_MODEL ||
    DEFAULT_DASHSCOPE_MODEL;

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = req.images.map(
    (img) => ({
      type: 'image_url',
      image_url: {
        url: `data:${img.mediaType || 'image/jpeg'};base64,${img.base64}`,
        detail: 'high' as const,
      },
    })
  );
  content.push({ type: 'text', text: req.prompt });

  const response = await client.chat.completions.create({
    model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: 0,
    messages: [{ role: 'user', content }],
  });

  const text = response.choices[0]?.message?.content ?? '';

  return {
    text,
    provider: 'dashscope',
    model,
    usage: {
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Bedrock (Claude / Nova via AWS Bedrock) — reuses the project's bedrockClient
// ---------------------------------------------------------------------------

// The bedrockClient picks its model from BEDROCK_MODEL_ID. To let smart-curation
// use its own model independent of the rest of the app, we set BEDROCK_MODEL_ID
// from SMART_CURATION_BEDROCK_MODEL (if provided) before constructing the client.
let bedrockClientCache: ReturnType<typeof createBedrockClient> | null = null;

function getBedrockClient(): ReturnType<typeof createBedrockClient> {
  if (bedrockClientCache) return bedrockClientCache;

  // If smart-curation specifies its own model, surface it to createBedrockClient
  // via the env var it reads. We only override when explicitly set so we don't
  // clobber a globally-configured BEDROCK_MODEL_ID unintentionally.
  const scModel = process.env.SMART_CURATION_BEDROCK_MODEL;
  if (scModel && !process.env.BEDROCK_MODEL_ID) {
    process.env.BEDROCK_MODEL_ID = scModel;
  }

  bedrockClientCache = createBedrockClient();
  return bedrockClientCache;
}

async function callBedrock(req: VLMRequest): Promise<VLMResponse> {
  const client = getBedrockClient();
  const text = await client.invokeModel({
    images: req.images.map((img) => ({
      base64: img.base64,
      mediaType: img.mediaType || 'image/jpeg',
    })),
    prompt: req.prompt,
    maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
  });

  return {
    text,
    provider: 'bedrock',
    model: getActiveModel(),
    // The project's bedrockClient does not surface token usage; omit it.
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider (GPT-4o, vLLM, Ollama, LiteLLM, etc.)
// ---------------------------------------------------------------------------

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (openaiClient) return openaiClient;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is required');

  openaiClient = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    timeout: readTimeoutMs(),
  });
  return openaiClient;
}

async function callOpenAI(req: VLMRequest): Promise<VLMResponse> {
  const client = getOpenAIClient();
  const model = process.env.OPENAI_MODEL;
  if (!model) throw new Error('OPENAI_MODEL environment variable is required for openai provider');

  // Build content parts: images as image_url (base64 data URIs) + text prompt
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = req.images.map(
    (img) => ({
      type: 'image_url',
      image_url: {
        url: `data:${img.mediaType || 'image/jpeg'};base64,${img.base64}`,
        detail: 'high' as const,
      },
    })
  );
  content.push({ type: 'text', text: req.prompt });

  const response = await client.chat.completions.create({
    model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: 0,
    messages: [{ role: 'user', content }],
  });

  const text = response.choices[0]?.message?.content ?? '';

  return {
    text,
    provider: 'openai',
    model,
    usage: {
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Vision/image warning tracking
// ---------------------------------------------------------------------------

/** Track whether we've already emitted the vision/image warning to avoid spam. */
let visionWarningEmitted = false;

const VISION_ERROR_KEYWORDS = ['vision', 'image', 'multimodal', 'unsupported'];

function isVisionRelatedError(message: string): boolean {
  const lower = message.toLowerCase();
  return VISION_ERROR_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Check if a VLM response text is parseable as JSON.
 */
function isParseableJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    // Also try extracting JSON from markdown fences
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      try {
        JSON.parse(fenceMatch[1].trim());
        return true;
      } catch {
        return false;
      }
    }
    // Try finding a JSON object in the text
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(trimmed);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic VLM call with automatic cascade fallback.
 *
 * Routes to the configured primary provider. If the call fails with an
 * authentication or authorization error (401/403), automatically tries the
 * next available provider in priority order. This ensures that a single
 * expired key doesn't kill the entire pipeline when other providers are
 * configured.
 *
 * Throws only when ALL available providers have been exhausted.
 */
export async function callVLM(req: VLMRequest): Promise<VLMResponse> {
  if (req.images.length === 0) {
    throw new Error('callVLM: at least one image is required');
  }

  const primaryProvider = getActiveProvider();

  // Build cascade: primary first, then other providers that have credentials
  const cascade: VLMProvider[] = [primaryProvider];
  const allProviders: VLMProvider[] = ['anthropic', 'dashscope', 'bedrock', 'openai'];
  for (const p of allProviders) {
    if (p === primaryProvider) continue;
    if (hasCredentials(p)) cascade.push(p);
  }

  let lastError: Error | null = null;

  for (const provider of cascade) {
    const model = getModelForProvider(provider);
    try {
      let response: VLMResponse;
      switch (provider) {
        case 'anthropic':
          response = await callAnthropic(req);
          break;
        case 'dashscope':
          response = await callDashscope(req);
          break;
        case 'bedrock':
          response = await callBedrock(req);
          break;
        case 'openai':
          response = await callOpenAI(req);
          break;
        default:
          throw new Error(`callVLM: unsupported provider "${provider}"`);
      }

      // Post-call diagnostic log
      const parseable = isParseableJson(response.text);
      console.log(
        `[vlmClient] VLM call: provider=${response.provider}, model=${response.model}, ` +
        `images=${req.images.length}, responseLength=${response.text.length}, parseable=${parseable}`
      );

      return response;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      lastError = err instanceof Error ? err : new Error(errorMsg);

      // Check if this is an auth error that warrants trying the next provider
      const isAuthError = isAuthenticationError(errorMsg);

      console.error(
        `[vlmClient] VLM call failed: provider=${provider}, model=${model}, error=${errorMsg}`
      );

      // Vision/image support warning (emit only once)
      if (!visionWarningEmitted && isVisionRelatedError(errorMsg)) {
        console.warn(
          `[vlmClient] WARNING: endpoint may not support vision/image input`
        );
        visionWarningEmitted = true;
      }

      // Only cascade on auth errors; other errors (rate limit, timeout, etc.)
      // are likely to affect all providers, so just throw immediately.
      if (!isAuthError) {
        throw lastError;
      }

      // Try next provider in cascade
      const nextIdx = cascade.indexOf(provider) + 1;
      if (nextIdx < cascade.length) {
        console.warn(
          `[vlmClient] Auth error on ${provider}, cascading to ${cascade[nextIdx]}...`
        );
      }
    }
  }

  // All providers exhausted
  throw lastError ?? new Error('callVLM: all providers failed');
}

/**
 * Check if a provider has its credentials configured (without activating it).
 */
function hasCredentials(provider: VLMProvider): boolean {
  switch (provider) {
    case 'anthropic': return !!process.env.ANTHROPIC_API_KEY;
    case 'dashscope': return !!process.env.DASHSCOPE_API_KEY;
    case 'bedrock':
      return !!process.env.AWS_BEARER_TOKEN_BEDROCK ||
        !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
    case 'openai': return !!(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
  }
}

/**
 * Get the model name for a specific provider (used in cascade logging).
 */
function getModelForProvider(provider: VLMProvider): string {
  switch (provider) {
    case 'anthropic':
      return process.env.SMART_CURATION_ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
    case 'dashscope':
      return process.env.SMART_CURATION_DASHSCOPE_MODEL || process.env.DASHSCOPE_MODEL || DEFAULT_DASHSCOPE_MODEL;
    case 'bedrock':
      return process.env.SMART_CURATION_BEDROCK_MODEL || process.env.BEDROCK_MODEL_ID || DEFAULT_BEDROCK_MODEL;
    case 'openai':
      return process.env.OPENAI_MODEL || '';
  }
}

/**
 * Check if an error message indicates an authentication/authorization failure.
 */
function isAuthenticationError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('authentication') ||
    lower.includes('unauthorized') ||
    lower.includes('403') ||
    lower.includes('401') ||
    lower.includes('signature expired') ||
    lower.includes('invalid api key') ||
    lower.includes('permission denied');
}

/**
 * Reset the cached SDK clients. Used by tests that mutate env vars between
 * cases. Production code never calls this.
 */
export function _resetVLMClientCacheForTests(): void {
  anthropicClient = null;
  dashscopeClient = null;
  bedrockClientCache = null;
  openaiClient = null;
  visionWarningEmitted = false;
}
