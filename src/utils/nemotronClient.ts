/**
 * NVIDIA Nemotron Client & Routing Utility
 *
 * Connects to official NVIDIA NIM API endpoints (https://integrate.api.nvidia.com/v1)
 * using the server-side NVIDIA_API_KEY environment variable.
 *
 * Handles:
 *  - Multimodal Vision Product Analysis (nvidia/nemotron-3.5-super-vl-120b-a12b)
 *  - Script & Storyboard Generation (nvidia/llama-3.1-nemotron-70b-instruct)
 *  - Transient error retries with bounded exponential backoff
 *  - Strict JSON response extraction and validation
 *  - Non-sensitive model probe and error categorization
 */

export const DEFAULT_NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export const DEFAULT_NVIDIA_VISION_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
export const DEFAULT_NVIDIA_TEXT_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct';
export const FALLBACK_NVIDIA_TEXT_MODEL = 'nvidia/nemotron-4-340b-instruct';

export interface NemotronChatMessage {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
}

export interface NemotronCompletionOptions {
  model?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  timeoutMs?: number;
  responseFormatJson?: boolean;
}

export interface NemotronApiErrorDetails {
  category: 'missing_key' | 'auth_error' | 'rate_limited' | 'timeout' | 'model_error' | 'malformed_response';
  status?: number;
  message: string;
  isTransient: boolean;
}

export class NemotronError extends Error {
  public readonly category: NemotronApiErrorDetails['category'];
  public readonly statusCode?: number;
  public readonly isTransient: boolean;

  constructor(details: NemotronApiErrorDetails) {
    super(details.message);
    this.name = 'NemotronError';
    this.category = details.category;
    this.statusCode = details.status;
    this.isTransient = details.isTransient;
  }
}

/**
 * Retrieves the NVIDIA API key from process environment.
 * Throws a clean NemotronError if not set.
 */
export function getNvidiaApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = (env.NVIDIA_API_KEY || '').trim();
  if (!key) {
    throw new NemotronError({
      category: 'missing_key',
      status: 401,
      message:
        'NVIDIA API key (NVIDIA_API_KEY) is not set on the server. Please set NVIDIA_API_KEY in your environment.',
      isTransient: false,
    });
  }
  return key;
}

export function getNvidiaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.NVIDIA_BASE_URL || '').trim();
  return raw ? raw.replace(/\/+$/, '') : DEFAULT_NVIDIA_BASE_URL;
}

export function getNvidiaVisionModel(env: NodeJS.ProcessEnv = process.env): string {
  return (env.NVIDIA_VISION_MODEL || '').trim() || DEFAULT_NVIDIA_VISION_MODEL;
}

export function getNvidiaTextModel(env: NodeJS.ProcessEnv = process.env): string {
  return (env.NVIDIA_TEXT_MODEL || '').trim() || DEFAULT_NVIDIA_TEXT_MODEL;
}

/**
 * Checks if an HTTP status code or message represents a transient issue suitable for retry.
 */
export function isTransientNemotronStatus(status?: number, message?: string): boolean {
  if (status && [429, 500, 502, 503, 504].includes(status)) {
    return true;
  }
  if (!message) return false;
  return (
    /\b429\b/i.test(message) ||
    /\b503\b/i.test(message) ||
    /\b504\b/i.test(message) ||
    /rate\s+limit/i.test(message) ||
    /quota/i.test(message) ||
    /high\s+demand/i.test(message) ||
    /timeout/i.test(message) ||
    /ETIMEDOUT/i.test(message) ||
    /ECONNRESET/i.test(message) ||
    /fetch\s+failed/i.test(message)
  );
}

/**
 * Strips markdown code fences (```json ... ``` or ``` ...) and whitespace.
 */
export function extractJsonFromText(rawText: string): string {
  if (!rawText) return '';
  const trimmed = rawText.trim();
  const fenceRegex = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i;
  const match = trimmed.match(fenceRegex);
  if (match) {
    return match[1].trim();
  }
  // Try locating first '{' and last '}'
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1).trim();
  }
  return trimmed;
}

/**
 * Makes an OpenAI-compatible chat completion request to the NVIDIA NIM endpoint.
 */
export async function callNemotronChatCompletion(
  messages: NemotronChatMessage[],
  options: NemotronCompletionOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<{ text: string; modelUsed: string; latencyMs: number; usage?: Record<string, number> }> {
  const apiKey = getNvidiaApiKey(env);
  const baseUrl = getNvidiaBaseUrl(env);
  const model = options.model || getNvidiaTextModel(env);
  const timeoutMs = options.timeoutMs ?? 45000;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  const payload: Record<string, unknown> = {
    model,
    messages,
    temperature: options.temperature ?? 0.2,
    top_p: options.top_p ?? 0.95,
    max_tokens: options.max_tokens ?? 2048,
  };

  if (options.responseFormatJson) {
    payload.response_format = { type: 'json_object' };
  }

  const startTime = Date.now();
  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': 'ai-ad-studio-nemotron',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startTime;
    const rawBody = await response.text();

    if (!response.ok) {
      const isTransient = isTransientNemotronStatus(response.status, rawBody);
      let parsedError = rawBody;
      try {
        const errorJson = JSON.parse(rawBody);
        parsedError =
          errorJson.error?.message ||
          errorJson.message ||
          errorJson.detail ||
          rawBody.slice(0, 200);
      } catch {
        parsedError = rawBody.slice(0, 200);
      }

      if (response.status === 401 || response.status === 403) {
        throw new NemotronError({
          category: 'auth_error',
          status: response.status,
          message: `NVIDIA API authentication failed (${response.status}): ${parsedError}. Please verify your NVIDIA_API_KEY.`,
          isTransient: false,
        });
      }

      if (response.status === 429) {
        throw new NemotronError({
          category: 'rate_limited',
          status: 429,
          message: `NVIDIA API rate limit reached: ${parsedError}.`,
          isTransient: true,
        });
      }

      throw new NemotronError({
        category: 'model_error',
        status: response.status,
        message: `NVIDIA API returned HTTP ${response.status} for model ${model}: ${parsedError}`,
        isTransient,
      });
    }

    let parsedResponse: any;
    try {
      parsedResponse = JSON.parse(rawBody);
    } catch {
      throw new NemotronError({
        category: 'malformed_response',
        message: `NVIDIA API returned malformed JSON response for model ${model}.`,
        isTransient: false,
      });
    }

    const content = parsedResponse.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new NemotronError({
        category: 'malformed_response',
        message: `NVIDIA model ${model} returned an empty completion response.`,
        isTransient: false,
      });
    }

    return {
      text: content.trim(),
      modelUsed: parsedResponse.model || model,
      latencyMs,
      usage: parsedResponse.usage,
    };
  } catch (err: unknown) {
    if (err instanceof NemotronError) {
      throw err;
    }
    const isAbort =
      err instanceof Error &&
      (err.name === 'AbortError' || err.message.toLowerCase().includes('aborted'));
    if (isAbort) {
      throw new NemotronError({
        category: 'timeout',
        message: `NVIDIA API request for model ${model} timed out after ${timeoutMs}ms.`,
        isTransient: true,
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new NemotronError({
      category: 'model_error',
      message: `Failed to connect to NVIDIA API (${baseUrl}): ${msg}`,
      isTransient: isTransientNemotronStatus(undefined, msg),
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Executes an operation with exponential backoff and optional model fallback.
 */
export async function executeWithNemotronFallback<T>(
  operation: (modelId: string, attempt: number) => Promise<T>,
  models: string[],
  options: {
    maxRetriesPerModel?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  } = {}
): Promise<{ result: T; resolvedModel: string; attempts: number; latencyMs: number }> {
  const maxRetries = options.maxRetriesPerModel ?? 2;
  const baseDelay = options.baseDelayMs ?? 300;
  const maxDelay = options.maxDelayMs ?? 1500;
  const sleep = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let lastError: Error | null = null;
  const startTime = Date.now();
  let totalAttempts = 0;

  for (const model of models) {
    for (let attempt = 1; attempt <= 1 + maxRetries; attempt++) {
      totalAttempts++;
      try {
        const result = await operation(model, attempt);
        return {
          result,
          resolvedModel: model,
          attempts: totalAttempts,
          latencyMs: Date.now() - startTime,
        };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isTransient =
          err instanceof NemotronError ? err.isTransient : isTransientNemotronStatus(undefined, lastError.message);

        if (isTransient && attempt <= maxRetries) {
          const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt - 1));
          await sleep(delay);
          continue;
        }
        break; // Next model in chain
      }
    }
  }

  throw lastError || new Error('All configured NVIDIA Nemotron models failed.');
}
