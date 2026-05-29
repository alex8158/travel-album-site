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

export type VLMProvider = 'anthropic' | 'dashscope' | 'bedrock';

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

/**
 * Resolve the active provider from env. Falls back to dashscope when unset to
 * preserve existing deployments. An invalid value logs a warning and falls
 * back the same way rather than crashing the pipeline.
 */
export function getActiveProvider(): VLMProvider {
  const raw = (process.env.SMART_CURATION_VLM_PROVIDER || '').trim().toLowerCase();
  if (raw === 'anthropic' || raw === 'dashscope' || raw === 'bedrock') return raw;
  if (raw !== '') {
    console.warn(
      `[vlmClient] SMART_CURATION_VLM_PROVIDER="${raw}" is not recognised; ` +
      `using 'dashscope'. Valid values: 'anthropic' | 'dashscope' | 'bedrock'.`
    );
  }
  return 'dashscope';
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
        detail: 'low',
      },
    })
  );
  content.push({ type: 'text', text: req.prompt });

  const response = await client.chat.completions.create({
    model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
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
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic VLM call. Routes to whichever provider is configured via
 * `SMART_CURATION_VLM_PROVIDER`. Throws if the provider's credentials are not
 * set or if the upstream call fails — callers handle their own conservative
 * fallback (typically: keep every photo in the affected batch).
 */
export async function callVLM(req: VLMRequest): Promise<VLMResponse> {
  if (req.images.length === 0) {
    throw new Error('callVLM: at least one image is required');
  }

  switch (getActiveProvider()) {
    case 'anthropic':
      return callAnthropic(req);
    case 'dashscope':
      return callDashscope(req);
    case 'bedrock':
      return callBedrock(req);
  }
}

/**
 * Reset the cached SDK clients. Used by tests that mutate env vars between
 * cases. Production code never calls this.
 */
export function _resetVLMClientCacheForTests(): void {
  anthropicClient = null;
  dashscopeClient = null;
  bedrockClientCache = null;
}
