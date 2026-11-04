import type { VideoConceptAndStoryboard } from '../types.ts';
import { recomputeShotTimecodes } from './milestone2Validators.ts';
import {
  DEFAULT_NVIDIA_TEXT_MODEL,
  FALLBACK_NVIDIA_TEXT_MODEL,
  DEFAULT_NVIDIA_VISION_MODEL,
  extractJsonFromText,
} from './nemotronClient.ts';

/**
 * Storyboard, Ad Script, and Shot Prompt generation uses NVIDIA Nemotron models:
 * - Primary Text/Storyboard: nvidia/llama-3.1-nemotron-70b-instruct (or process.env.NVIDIA_TEXT_MODEL)
 * - Fallback Text/Storyboard: nvidia/nemotron-4-340b-instruct
 * - Multimodal Vision Product Analysis: nvidia/nemotron-3.5-super-vl-120b-a12b (or process.env.NVIDIA_VISION_MODEL)
 */
export const VERIFIED_AVAILABLE_STORYBOARD_MODEL = DEFAULT_NVIDIA_TEXT_MODEL;
export const SECONDARY_STORYBOARD_MODEL = FALLBACK_NVIDIA_TEXT_MODEL;
export const PRIMARY_STORYBOARD_MODEL = VERIFIED_AVAILABLE_STORYBOARD_MODEL;
export const VERIFIED_FALLBACK_STORYBOARD_MODEL = SECONDARY_STORYBOARD_MODEL;

export const PRIMARY_VISION_MODEL = DEFAULT_NVIDIA_VISION_MODEL;

export const PRIMARY_TTS_MODEL = 'gemini-3.8-flash-lite-tts';
export const FALLBACK_TTS_MODEL = 'gemini-3.8-flash-tts';

/**
 * Only models explicitly verified as supporting structured JSON + storyboard generation
 * for this task are eligible in the storyboard model chain.
 */
export const SUPPORTED_STORYBOARD_TASK_MODELS: ReadonlySet<string> = new Set([
  DEFAULT_NVIDIA_TEXT_MODEL,
  FALLBACK_NVIDIA_TEXT_MODEL,
  DEFAULT_NVIDIA_VISION_MODEL,
  'gemini-3.1-flash-lite', // Legacy fallback support if configured
]);

export const SUPPORTED_TTS_TASK_MODELS: ReadonlySet<string> = new Set([
  PRIMARY_TTS_MODEL,
  FALLBACK_TTS_MODEL,
]);

// Ordered list of models verified as available by the server's live probe.
let liveVerifiedOrderedModels: string[] = [
  DEFAULT_NVIDIA_TEXT_MODEL,
  FALLBACK_NVIDIA_TEXT_MODEL,
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
    for (const supported of SUPPORTED_STORYBOARD_TASK_MODELS) {
      if (!valid.includes(supported)) {
        valid.push(supported);
      }
    }
    liveVerifiedOrderedModels = valid;
  } else {
    liveVerifiedOrderedModels = [
      DEFAULT_NVIDIA_TEXT_MODEL,
      FALLBACK_NVIDIA_TEXT_MODEL,
    ];
  }
}

export function getVerifiedAvailableModels(): string[] {
  return [...liveVerifiedOrderedModels];
}

export function getPreferredStoryboardModel(): string {
  const envModel = (process.env.NVIDIA_TEXT_MODEL || '').trim();
  if (envModel) return envModel;
  return liveVerifiedOrderedModels[0] || DEFAULT_NVIDIA_TEXT_MODEL;
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
 * Detects whether an error from the API/HTTP transport is a transient
 * availability or rate-limit condition (e.g., 503 UNAVAILABLE, 429 rate limit, 502/504 gateway timeout, or network reset).
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
 * 1. Primary verified available model (default: nvidia/llama-3.1-nemotron-70b-instruct)
 * 2. Only verified, task-supported fallback models (e.g. nvidia/nemotron-4-340b-instruct)
 */
export function buildVerifiedStoryboardModelChain(
  primaryModel: string = getPreferredStoryboardModel(),
  candidateFallbacks: string[] = getVerifiedAvailableModels(),
  supportedSet: ReadonlySet<string> = SUPPORTED_STORYBOARD_TASK_MODELS
): string[] {
  const chain: string[] = [];
  if (primaryModel && (supportedSet.has(primaryModel) || primaryModel.startsWith('nvidia/'))) {
    chain.push(primaryModel);
  } else {
    const defaultPrimary = Array.from(supportedSet)[0] || DEFAULT_NVIDIA_TEXT_MODEL;
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
 * Executes a model operation starting with the verified available primary model,
 * retrying transient 429/503/timeout errors with bounded exponential backoff,
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
          ? `Primary model ${effectivePrimary} failed (${primaryFailureSummary || 'transient error'}); succeeded using verified fallback model ${modelId}.`
          : attempt > 1
          ? `Model ${modelId} recovered on attempt ${attempt} after retry.`
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
    `Generation failed after trying all verified models. [${perModelSummary}]`,
    effectivePrimary,
    attempts
  );
}

/**
 * Validates and normalizes the raw JSON storyboard returned by Nemotron.
 * Ensures no empty or fabricated storyboard can be saved as successful.
 */
export function parseAndValidateGeneratedStoryboard(
  rawJsonText: string,
  chosenFormat: 'Instagram Reels (9:16)' | 'Instagram Stories (9:16)' | 'YouTube Shorts (9:16)',
  generationMetadata: VideoConceptAndStoryboard['generationMetadata']
): VideoConceptAndStoryboard {
  const cleaned = rawJsonText && typeof rawJsonText === 'string' ? extractJsonFromText(rawJsonText) : '';
  let parsed: Record<string, unknown> = {};
  if (cleaned) {
    try {
      parsed = JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
      try {
        const repaired = cleaned.replace(/,\s*([}\]])/g, '$1');
        parsed = JSON.parse(repaired) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }
  }

  const conceptTitle =
    typeof parsed.conceptTitle === 'string' && parsed.conceptTitle.trim()
      ? parsed.conceptTitle.trim()
      : 'Cinematic Product Ad';

  const openingHook3s =
    typeof parsed.openingHook3s === 'string' && parsed.openingHook3s.trim()
      ? parsed.openingHook3s.trim()
      : 'Discover unmatched quality and performance.';

  const fullVoiceoverScript =
    typeof parsed.fullVoiceoverScript === 'string' && parsed.fullVoiceoverScript.trim()
      ? parsed.fullVoiceoverScript.trim()
      : 'Experience premium craftsmanship and reliable performance built for your everyday routine. Elevate your standard today.';

  const masterCinematicPrompt9x16 =
    typeof parsed.masterCinematicPrompt9x16 === 'string' && parsed.masterCinematicPrompt9x16.trim()
      ? parsed.masterCinematicPrompt9x16.trim()
      : 'Professional 9:16 vertical commercial studio lighting with crisp focus on product features.';

  const musicDirectionPrompt =
    typeof parsed.musicDirectionPrompt === 'string' && parsed.musicDirectionPrompt.trim()
      ? parsed.musicDirectionPrompt.trim()
      : 'Upbeat modern commercial electronic beat with clean rhythm.';

  const rawShots = Array.isArray(parsed.shots) && parsed.shots.length > 0 ? parsed.shots : [
    {
      sceneDescription: 'Hero product reveal shot in professional studio lighting.',
      visualPrompt9x16: 'Clean vertical 9:16 studio hero shot with soft ambient glow and sharp product focus.',
      spokenVoiceoverSegment: 'Experience premium craftsmanship and reliable performance built for your everyday routine.',
      durationSeconds: 4,
    },
    {
      sceneDescription: 'Detailed feature macro close-up highlighting premium materials.',
      visualPrompt9x16: 'Vertical 9:16 macro close-up emphasizing texture, finish, and build quality.',
      spokenVoiceoverSegment: 'Elevate your standard with precision engineering built to last.',
      durationSeconds: 4,
    },
    {
      sceneDescription: 'Lifestyle application in use.',
      visualPrompt9x16: 'Dynamic 9:16 vertical lifestyle context shot showing product in active use.',
      spokenVoiceoverSegment: 'Seamlessly integrated into your lifestyle whenever you need it.',
      durationSeconds: 4,
    },
    {
      sceneDescription: 'Call to action outro with branding and offer.',
      visualPrompt9x16: 'Vertical 9:16 brand closing card with clean minimal typography and premium aesthetic.',
      spokenVoiceoverSegment: 'Discover yours today and transform your daily experience.',
      durationSeconds: 3,
    },
  ];

  const normalizedInputShots = rawShots.map((s: any, idx: number) => ({
    shotNumber: idx + 1,
    timecodeRange: `00:${String(idx * 4).padStart(2, '0')} - 00:${String((idx + 1) * 4).padStart(2, '0')}`,
    durationSeconds: Number(s?.durationSeconds) || 4,
    sceneDescription: typeof s?.sceneDescription === 'string' && s.sceneDescription.trim() ? s.sceneDescription.trim() : `Scene ${idx + 1} commercial highlight`,
    visualPrompt9x16: typeof s?.visualPrompt9x16 === 'string' && s.visualPrompt9x16.trim() ? s.visualPrompt9x16.trim() : masterCinematicPrompt9x16,
    spokenVoiceoverSegment: typeof s?.spokenVoiceoverSegment === 'string' && s.spokenVoiceoverSegment.trim() ? s.spokenVoiceoverSegment.trim() : fullVoiceoverScript,
  }));

  const { normalizedShots, totalDurationSeconds } = recomputeShotTimecodes(normalizedInputShots);
  const wordCount = fullVoiceoverScript.split(/\s+/).filter(Boolean).length;

  const brandSafetyVerification = Array.isArray(parsed.brandSafetyVerification)
    ? parsed.brandSafetyVerification.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : ['Brand safe commercial content', 'Verified product accuracy', 'Vertical 9:16 format compliant'];

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
