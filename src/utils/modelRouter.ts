import type { VideoConceptAndStoryboard } from '../types.ts';
import { recomputeShotTimecodes } from './milestone2Validators.ts';

/**
 * The API & Milestones live verification probe confirms `gemini-3.1-flash-lite` is
 * Verified Available on the active API key while `gemini-3.8-flash` experiences
 * 503 high-demand errors. Both models support structured JSON output with STORYBOARD_SCHEMA.
 *
 * Therefore, storyboard generation routes to the verified available model (`gemini-3.1-flash-lite`)
 * first, with bounded exponential backoff retries for transient 503/UNAVAILABLE errors,
 * and falls back only to task-verified models (`gemini-3.8-flash`).
 */
export const VERIFIED_AVAILABLE_STORYBOARD_MODEL = 'gemini-3.1-flash-lite';
export const SECONDARY_STORYBOARD_MODEL = 'gemini-3.8-flash';
export const PRIMARY_STORYBOARD_MODEL = VERIFIED_AVAILABLE_STORYBOARD_MODEL;
export const VERIFIED_FALLBACK_STORYBOARD_MODEL = SECONDARY_STORYBOARD_MODEL;

export const PRIMARY_TTS_MODEL = 'gemini-3.8-flash-lite-tts';
export const FALLBACK_TTS_MODEL = 'gemini-3.8-flash-tts';

/**
 * Only models explicitly verified as supporting structured JSON + storyboard generation
 * for this task are eligible in the storyboard model chain.
 */
export const SUPPORTED_STORYBOARD_TASK_MODELS: ReadonlySet<string> = new Set([
  VERIFIED_AVAILABLE_STORYBOARD_MODEL,
  SECONDARY_STORYBOARD_MODEL,
]);

export const SUPPORTED_TTS_TASK_MODELS: ReadonlySet<string> = new Set([
  PRIMARY_TTS_MODEL,
  FALLBACK_TTS_MODEL,
]);

// Ordered list of models verified as available by the server's live probe.
// Defaults to ['gemini-3.1-flash-lite', 'gemini-3.8-flash'] with gemini-3.1-flash-lite first.
let liveVerifiedOrderedModels: string[] = [
  VERIFIED_AVAILABLE_STORYBOARD_MODEL,
  SECONDARY_STORYBOARD_MODEL,
];

export function markModelVerifiedAvailable(modelId: string): void {
  if (SUPPORTED_STORYBOARD_TASK_MODELS.has(modelId)) {
    if (!liveVerifiedOrderedModels.includes(modelId)) {
      liveVerifiedOrderedModels.unshift(modelId);
    }
  }
}

export function setVerifiedAvailableModels(modelIds: Iterable<string>): void {
  const valid: string[] = [];
  for (const id of modelIds) {
    if (SUPPORTED_STORYBOARD_TASK_MODELS.has(id) && !valid.includes(id)) {
      valid.push(id);
    }
  }
  if (valid.length > 0) {
    // Keep any other task-supported model as a verified schema-compatible fallback
    for (const supported of SUPPORTED_STORYBOARD_TASK_MODELS) {
      if (!valid.includes(supported)) {
        valid.push(supported);
      }
    }
    liveVerifiedOrderedModels = valid;
  } else {
    liveVerifiedOrderedModels = [
      VERIFIED_AVAILABLE_STORYBOARD_MODEL,
      SECONDARY_STORYBOARD_MODEL,
    ];
  }
}

export function getVerifiedAvailableModels(): string[] {
  return [...liveVerifiedOrderedModels];
}

export function getPreferredStoryboardModel(): string {
  return liveVerifiedOrderedModels[0] || VERIFIED_AVAILABLE_STORYBOARD_MODEL;
}

export interface ModelAttemptRecord {
  modelId: string;
  attemptNumber: number;
  status: 'success' | 'failed';
  transient: boolean;
  backoffMs?: number;
  errorMessage?: string;
}

export interface ModelFallbackExecutionResult<T> {
  result: T;
  requestedModel: string;
  resolvedModel: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
  latencyMs: number;
  attempts: ModelAttemptRecord[];
}

export interface ModelFallbackOptions {
  primaryModel?: string;
  verifiedFallbackModels?: string[];
  supportedTaskModels?: ReadonlySet<string>;
  maxRetriesPerModel?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Detects whether an error from the Gemini SDK / HTTP transport is a transient
 * availability or rate-limit condition (e.g., 503 UNAVAILABLE, high demand, overloaded,
 * 429 RESOURCE_EXHAUSTED, 502/504 gateway timeout, or network reset).
 */
export function isTransientGeminiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    /\b503\b/i.test(message) ||
    /\bUNAVAILABLE\b/i.test(message) ||
    /high\s+demand/i.test(message) ||
    /overloaded/i.test(message) ||
    /temporarily\s+unavailable/i.test(message) ||
    /\b429\b/i.test(message) ||
    /\bRESOURCE_EXHAUSTED\b/i.test(message) ||
    /\b502\b/i.test(message) ||
    /\b504\b/i.test(message) ||
    /DEADLINE_EXCEEDED/i.test(message) ||
    /ETIMEDOUT/i.test(message) ||
    /ECONNRESET/i.test(message) ||
    /fetch\s+failed/i.test(message)
  );
}

/**
 * Computes bounded exponential backoff delay in milliseconds:
 * retryIndex 0 (first retry) -> baseDelayMs
 * retryIndex 1 (second retry) -> min(maxDelayMs, baseDelayMs * 2)
 */
export function computeExponentialBackoffMs(
  retryIndex: number,
  baseDelayMs = 250,
  maxDelayMs = 1500
): number {
  const safeIndex = Math.max(0, retryIndex);
  const rawDelay = baseDelayMs * Math.pow(2, safeIndex);
  return Math.min(maxDelayMs, Math.round(rawDelay));
}

/**
 * Builds the ordered list of models to try:
 * 1. Primary verified available model (default: gemini-3.1-flash-lite)
 * 2. Only verified, task-supported fallback models (e.g. gemini-3.8-flash)
 * Filters out any unverified or unsupported model IDs.
 */
export function buildVerifiedStoryboardModelChain(
  primaryModel: string = getPreferredStoryboardModel(),
  candidateFallbacks: string[] = getVerifiedAvailableModels(),
  supportedSet: ReadonlySet<string> = SUPPORTED_STORYBOARD_TASK_MODELS
): string[] {
  const chain: string[] = [];
  if (primaryModel && supportedSet.has(primaryModel)) {
    chain.push(primaryModel);
  } else {
    const defaultPrimary = Array.from(supportedSet)[0] || VERIFIED_AVAILABLE_STORYBOARD_MODEL;
    chain.push(defaultPrimary);
  }

  for (const candidate of candidateFallbacks) {
    if (candidate && supportedSet.has(candidate) && !chain.includes(candidate)) {
      chain.push(candidate);
    }
  }

  return chain;
}

export class AllModelsFailedError extends Error {
  public readonly requestedModel: string;
  public readonly attempts: ModelAttemptRecord[];

  constructor(message: string, requestedModel: string, attempts: ModelAttemptRecord[]) {
    super(message);
    this.name = 'AllModelsFailedError';
    this.requestedModel = requestedModel;
    this.attempts = attempts;
  }
}

/**
 * Executes a Gemini generation operation starting with the verified available primary model,
 * retrying transient 503/UNAVAILABLE errors with bounded exponential backoff,
 * and falling back only to verified task-supported models.
 *
 * Never fabricates a result if all configured models fail.
 */
export async function executeWithVerifiedModelFallback<T>(
  operation: (modelId: string, attemptNumber: number) => Promise<T>,
  options: ModelFallbackOptions = {}
): Promise<ModelFallbackExecutionResult<T>> {
  const supportedSet = options.supportedTaskModels ?? SUPPORTED_STORYBOARD_TASK_MODELS;
  const primaryModel = options.primaryModel || getPreferredStoryboardModel();
  const fallbackCandidates =
    options.verifiedFallbackModels ?? getVerifiedAvailableModels();
  const maxRetriesPerModel =
    typeof options.maxRetriesPerModel === 'number'
      ? Math.max(0, Math.min(4, options.maxRetriesPerModel))
      : 2;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 1200;
  const sleepFn = options.sleepFn ?? defaultSleep;

  const modelChain = buildVerifiedStoryboardModelChain(
    primaryModel,
    fallbackCandidates,
    supportedSet
  );
  const effectivePrimary = modelChain[0];
  const attempts: ModelAttemptRecord[] = [];
  const startTime = Date.now();
  let primaryFailureSummary = '';

  for (let modelIdx = 0; modelIdx < modelChain.length; modelIdx++) {
    const modelId = modelChain[modelIdx];
    const maxAttemptsForModel = 1 + maxRetriesPerModel;

    for (let attempt = 1; attempt <= maxAttemptsForModel; attempt++) {
      try {
        const result = await operation(modelId, attempt);
        attempts.push({
          modelId,
          attemptNumber: attempt,
          status: 'success',
          transient: false,
        });

        markModelVerifiedAvailable(modelId);
        const latencyMs = Date.now() - startTime;
        const fallbackUsed = modelId !== effectivePrimary;
        const fallbackReason = fallbackUsed
          ? `Primary model ${effectivePrimary} failed (${primaryFailureSummary || '503 UNAVAILABLE'}); succeeded using verified fallback model ${modelId}.`
          : attempt > 1
          ? `Model ${modelId} recovered on attempt ${attempt} after transient 503/UNAVAILABLE retry.`
          : undefined;

        return {
          result,
          requestedModel: effectivePrimary,
          resolvedModel: modelId,
          fallbackUsed,
          fallbackReason,
          latencyMs,
          attempts,
        };
      } catch (err: unknown) {
        const rawMsg = err instanceof Error ? err.message : String(err ?? 'Unknown model error');
        const transient = isTransientGeminiError(err);
        const canRetrySameModel = transient && attempt < maxAttemptsForModel;
        const backoffMs = canRetrySameModel
          ? computeExponentialBackoffMs(attempt - 1, baseDelayMs, maxDelayMs)
          : undefined;

        attempts.push({
          modelId,
          attemptNumber: attempt,
          status: 'failed',
          transient,
          backoffMs,
          errorMessage: rawMsg.slice(0, 200),
        });

        if (modelId === effectivePrimary) {
          primaryFailureSummary = rawMsg.slice(0, 120);
        }

        if (canRetrySameModel && backoffMs !== undefined) {
          await sleepFn(backoffMs);
          continue;
        }

        // Move to next verified model in chain if this model exhausted retries or hit a non-retryable error
        break;
      }
    }
  }

  const perModelSummary = modelChain
    .map((m) => {
      const modelAttempts = attempts.filter((a) => a.modelId === m);
      const lastErr = modelAttempts[modelAttempts.length - 1]?.errorMessage || 'Unknown error';
      return `${m} (${modelAttempts.length} attempt${modelAttempts.length === 1 ? '' : 's'}): ${lastErr}`;
    })
    .join(' | ');

  throw new AllModelsFailedError(
    `Generation failed after trying all verified Gemini models. [${perModelSummary}]`,
    effectivePrimary,
    attempts
  );
}

/**
 * Validates and normalizes the raw JSON storyboard returned by Gemini.
 * Ensures no empty or fabricated storyboard can be saved as successful.
 */
export function parseAndValidateGeneratedStoryboard(
  rawJsonText: string,
  chosenFormat: 'Instagram Reels (9:16)' | 'Instagram Stories (9:16)' | 'YouTube Shorts (9:16)',
  generationMetadata: VideoConceptAndStoryboard['generationMetadata']
): VideoConceptAndStoryboard {
  if (!rawJsonText || !rawJsonText.trim()) {
    throw new Error('Gemini returned an empty storyboard response.');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJsonText.trim()) as Record<string, unknown>;
  } catch {
    throw new Error('Gemini returned malformed JSON for the storyboard.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid storyboard payload structure.');
  }

  const conceptTitle =
    typeof parsed.conceptTitle === 'string' ? parsed.conceptTitle.trim() : '';
  const openingHook3s =
    typeof parsed.openingHook3s === 'string' ? parsed.openingHook3s.trim() : '';
  const fullVoiceoverScript =
    typeof parsed.fullVoiceoverScript === 'string'
      ? parsed.fullVoiceoverScript.trim()
      : '';
  const masterCinematicPrompt9x16 =
    typeof parsed.masterCinematicPrompt9x16 === 'string'
      ? parsed.masterCinematicPrompt9x16.trim()
      : '';
  const musicDirectionPrompt =
    typeof parsed.musicDirectionPrompt === 'string'
      ? parsed.musicDirectionPrompt.trim()
      : '';

  const rawShots = Array.isArray(parsed.shots) ? parsed.shots : [];
  if (!conceptTitle || !fullVoiceoverScript || rawShots.length === 0) {
    throw new Error(
      'Incomplete storyboard generated: missing conceptTitle, fullVoiceoverScript, or shots.'
    );
  }

  for (let i = 0; i < rawShots.length; i++) {
    const s = rawShots[i] as Record<string, unknown>;
    if (
      !s ||
      typeof s.sceneDescription !== 'string' ||
      !s.sceneDescription.trim() ||
      typeof s.visualPrompt9x16 !== 'string' ||
      !s.visualPrompt9x16.trim()
    ) {
      throw new Error(
        `Incomplete storyboard shot #${i + 1}: missing sceneDescription or visualPrompt9x16.`
      );
    }
  }

  const { normalizedShots, totalDurationSeconds } = recomputeShotTimecodes(rawShots);
  const wordCount = fullVoiceoverScript
    .split(/\s+/)
    .filter(Boolean).length;

  const brandSafetyVerification = Array.isArray(parsed.brandSafetyVerification)
    ? parsed.brandSafetyVerification
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
    : [];

  return {
    conceptTitle,
    targetPlatformFormat: chosenFormat,
    totalDurationSeconds,
    openingHook3s,
    fullVoiceoverScript,
    estimatedWordCount: wordCount,
    brandSafetyVerification,
    masterCinematicPrompt9x16,
    musicDirectionPrompt,
    shots: normalizedShots,
    generationMetadata,
  };
}
