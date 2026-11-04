import { GoogleGenAI } from '@google/genai';
import type {
  AiVideoProviderId,
  GeneratedVisualAsset,
  RenderEnginePreference,
  RenderEngineUsed,
  RenderFailureCategory,
  StoryboardShot,
  VideoProviderStatusInfo,
} from '../types.ts';
import {
  classifyVideoGenerationError,
  verifyPlayableMp4Buffer,
} from './milestone3Validators.ts';

export const DEFAULT_GOOGLE_VEO_MODEL_ID = 'veo-2.0-generate-001';
export const DEFAULT_GOOGLE_IMAGE_MODEL_ID = 'gemini-3.1-flash-lite-image';
export const DEFAULT_GOOGLE_VEO_TIMEOUT_MS = 240000;

export interface ProviderRequestOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  onProgressUpdate?: (message: string, progressPercent?: number) => void;
}

export interface GenerateShotVideoParams extends ProviderRequestOptions {
  shot: StoryboardShot;
  shotIndex: number;
  prompt: string;
  mimeType: string;
  base64Data: string;
  aspectRatio: '9:16';
  durationSeconds: number;
  resolution: '720p' | '1080p';
  modelId?: string;
  client?: GoogleGenAI;
}

export type ProviderVideoSource =
  | { kind: 'buffer'; buffer: Buffer; mimeType?: string }
  | { kind: 'url'; url: string; headers?: Record<string, string> };

export interface ProviderJobSubmissionResult {
  jobId: string;
  providerId: AiVideoProviderId;
  modelUsed: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  videoSource?: ProviderVideoSource;
  errorMessage?: string;
}

export interface ProviderJobStatusResult {
  jobId: string;
  providerId: AiVideoProviderId;
  modelUsed: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progressPercent?: number;
  videoSource?: ProviderVideoSource;
  errorMessage?: string;
}

export interface NormalizedProviderError {
  providerId: AiVideoProviderId;
  providerName: string;
  modelId: string;
  category: RenderFailureCategory;
  retryable: boolean;
  httpStatus?: number;
  rawMessage: string;
  userMessage: string;
}

export interface AiVideoProviderAdapter {
  readonly providerId: AiVideoProviderId;
  readonly providerName: string;
  readonly enginePreference: RenderEnginePreference;
  readonly engineUsed: RenderEngineUsed;
  readonly defaultModelId: string;
  readonly supportedModels: string[];
  readonly envVarName: string;
  readonly docsUrl: string;
  readonly supportedAspectRatios: string[];
  readonly supportedDurationsSeconds: number[];
  isConfigured(env?: NodeJS.ProcessEnv): boolean;
  generateShotVideo(params: GenerateShotVideoParams): Promise<ProviderJobSubmissionResult>;
  getJobStatus(
    jobId: string,
    options?: ProviderRequestOptions & { modelId?: string; client?: GoogleGenAI }
  ): Promise<ProviderJobStatusResult>;
  cancelJob(
    jobId: string,
    options?: ProviderRequestOptions
  ): Promise<{ cancelled: boolean; detail: string }>;
  downloadGeneratedVideo(
    source: ProviderVideoSource,
    options?: ProviderRequestOptions
  ): Promise<Buffer>;
  normalizeProviderError(err: unknown, modelId?: string): NormalizedProviderError;
}

/**
 * Helper to retrieve an initialized server-side Google GenAI client.
 * Respects GEMINI_API_KEY or GOOGLE_API_KEY. Never exposes the key to client code.
 */
export function getGoogleGenAIClient(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs?: number
): GoogleGenAI {
  const apiKey = (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error(
      'Google AI API key is not configured. Set GEMINI_API_KEY or GOOGLE_API_KEY in the server environment.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    },
  });
}

/**
 * Downloads and cryptographically verifies that a raw video payload from Google Veo
 * or custom generator is an authentic, non-empty playable MP4 file.
 */
export async function downloadAndVerifyVideoSource(
  source: ProviderVideoSource,
  providerLabel: string,
  options?: ProviderRequestOptions
): Promise<Buffer> {
  let rawBuffer: Buffer;

  if (source.kind === 'buffer') {
    rawBuffer = source.buffer;
  } else {
    const fetchFn = options?.fetchImpl || globalThis.fetch;
    const res = await fetchFn(source.url, {
      method: 'GET',
      headers: source.headers || {},
      signal: options?.signal,
    });
    if (!res.ok) {
      throw new Error(
        `Failed to download generated video from ${providerLabel} (HTTP ${res.status}: ${res.statusText}).`
      );
    }
    const arrayBuffer = await res.arrayBuffer();
    rawBuffer = Buffer.from(arrayBuffer);
  }

  const verified = verifyPlayableMp4Buffer(rawBuffer);
  if (!verified.valid) {
    throw new Error(
      `${providerLabel} returned an invalid or unplayable MP4 video: ${verified.error || 'corrupted stream'}`
    );
  }

  return rawBuffer;
}

/**
 * Google Veo 2.0 AI Video Generation Provider Adapter.
 * Uses the official @google/genai SDK (ai.models.generateVideos and ai.operations.getVideosOperation).
 */
export class GoogleVeoVideoProviderAdapter implements AiVideoProviderAdapter {
  public readonly providerId: AiVideoProviderId = 'google_veo';
  public readonly providerName = 'Google Veo 2.0';
  public readonly enginePreference: RenderEnginePreference = 'ai_video_google_veo';
  public readonly engineUsed: RenderEngineUsed = 'google_veo_video';
  public readonly defaultModelId: string = DEFAULT_GOOGLE_VEO_MODEL_ID;
  public readonly supportedModels: string[] = ['veo-2.0-generate-001', 'veo-2.0-generate-exp'];
  public readonly envVarName = 'GOOGLE_VIDEO_MODEL';
  public readonly docsUrl = 'https://ai.google.dev/gemini-api/docs/models/gemini';
  public readonly supportedAspectRatios: string[] = ['9:16', '16:9'];
  public readonly supportedDurationsSeconds: number[] = [5, 8];

  public isConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    const key = (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '').trim();
    return Boolean(key);
  }

  public async generateShotVideo(
    params: GenerateShotVideoParams
  ): Promise<ProviderJobSubmissionResult> {
    const env = params.env || process.env;
    const client = params.client || getGoogleGenAIClient(env, params.timeoutMs || DEFAULT_GOOGLE_VEO_TIMEOUT_MS);
    const modelUsed = params.modelId || env.GOOGLE_VIDEO_MODEL || this.defaultModelId;
    const durationSeconds = params.durationSeconds <= 5 ? 5 : 8;

    params.onProgressUpdate?.(
      `Submitting Shot 0${params.shot.shotNumber} to ${this.providerName} (${modelUsed}, 9:16, ${durationSeconds}s)...`,
      15
    );

    try {
      const operation = await client.models.generateVideos({
        model: modelUsed,
        prompt: params.prompt,
        image: {
          imageBytes: params.base64Data,
          mimeType: params.mimeType,
        },
        config: {
          numberOfVideos: 1,
          aspectRatio: '9:16',
          durationSeconds,
          fps: 24,
        },
      });

      const jobId = operation.name || `veo_op_${Date.now()}_shot${params.shot.shotNumber}`;

      // Check if already completed synchronously
      if (operation.done) {
        const genVideo = operation.response?.generatedVideos?.[0]?.video;
        if (genVideo?.videoBytes) {
          const buffer = Buffer.from(genVideo.videoBytes, 'base64');
          return {
            jobId,
            providerId: this.providerId,
            modelUsed,
            status: 'completed',
            videoSource: { kind: 'buffer', buffer, mimeType: genVideo.mimeType || 'video/mp4' },
          };
        }
        if (genVideo?.uri) {
          return {
            jobId,
            providerId: this.providerId,
            modelUsed,
            status: 'completed',
            videoSource: { kind: 'url', url: genVideo.uri },
          };
        }
        if (operation.error) {
          const errObj = operation.error as { message?: string };
          return {
            jobId,
            providerId: this.providerId,
            modelUsed,
            status: 'failed',
            errorMessage: errObj?.message || String(operation.error) || 'Veo video generation operation reported error.',
          };
        }
      }

      return {
        jobId,
        providerId: this.providerId,
        modelUsed,
        status: 'processing',
      };
    } catch (err: unknown) {
      const normalized = this.normalizeProviderError(err, modelUsed);
      return {
        jobId: `err_${Date.now()}`,
        providerId: this.providerId,
        modelUsed,
        status: 'failed',
        errorMessage: normalized.userMessage,
      };
    }
  }

  public async getJobStatus(
    jobId: string,
    options?: ProviderRequestOptions & { modelId?: string; client?: GoogleGenAI }
  ): Promise<ProviderJobStatusResult> {
    const env = options?.env || process.env;
    const client = options?.client || getGoogleGenAIClient(env, options?.timeoutMs || 30000);
    const modelUsed = options?.modelId || env.GOOGLE_VIDEO_MODEL || this.defaultModelId;

    try {
      const operation = await client.operations.getVideosOperation({
        operation: { name: jobId } as any,
      });

      if (!operation.done) {
        return {
          jobId,
          providerId: this.providerId,
          modelUsed,
          status: 'processing',
          progressPercent: 50,
        };
      }

      if (operation.error) {
        const errObj = operation.error as { message?: string };
        return {
          jobId,
          providerId: this.providerId,
          modelUsed,
          status: 'failed',
          errorMessage: errObj?.message || String(operation.error) || 'Veo video generation operation reported error.',
        };
      }

      const genVideo = operation.response?.generatedVideos?.[0]?.video;
      if (genVideo?.videoBytes) {
        const buffer = Buffer.from(genVideo.videoBytes, 'base64');
        return {
          jobId,
          providerId: this.providerId,
          modelUsed,
          status: 'completed',
          progressPercent: 100,
          videoSource: { kind: 'buffer', buffer, mimeType: genVideo.mimeType || 'video/mp4' },
        };
      }

      if (genVideo?.uri) {
        return {
          jobId,
          providerId: this.providerId,
          modelUsed,
          status: 'completed',
          progressPercent: 100,
          videoSource: { kind: 'url', url: genVideo.uri },
        };
      }

      return {
        jobId,
        providerId: this.providerId,
        modelUsed,
        status: 'failed',
        errorMessage: 'Veo operation finished but did not return video bytes or download URI.',
      };
    } catch (err: unknown) {
      const normalized = this.normalizeProviderError(err, modelUsed);
      return {
        jobId,
        providerId: this.providerId,
        modelUsed,
        status: 'failed',
        errorMessage: normalized.userMessage,
      };
    }
  }

  public async cancelJob(
    jobId: string,
    _options?: ProviderRequestOptions
  ): Promise<{ cancelled: boolean; detail: string }> {
    return {
      cancelled: true,
      detail: `Cancelled tracking for Veo job ${jobId}.`,
    };
  }

  public async downloadGeneratedVideo(
    source: ProviderVideoSource,
    options?: ProviderRequestOptions
  ): Promise<Buffer> {
    return downloadAndVerifyVideoSource(source, this.providerName, options);
  }

  public normalizeProviderError(err: unknown, modelId = this.defaultModelId): NormalizedProviderError {
    const rawMessage = err instanceof Error ? err.message : String(err || 'Unknown Google Veo error');
    const lower = rawMessage.toLowerCase();

    let category: RenderFailureCategory = 'validation_error';
    let retryable = false;
    let httpStatus: number | undefined;

    if (lower.includes('aborted') || lower.includes('cancelled') || lower.includes('canceled')) {
      category = 'cancelled';
      retryable = false;
    } else if (
      lower.includes('401') ||
      lower.includes('unauthenticated') ||
      lower.includes('unauthorized') ||
      lower.includes('invalid api key') ||
      lower.includes('missing api key') ||
      lower.includes('api key not configured') ||
      lower.includes('not configured') ||
      lower.includes('not set')
    ) {
      category = 'auth_or_missing_key';
      httpStatus = 401;
      retryable = false;
    } else if (
      lower.includes('403') ||
      lower.includes('permission') ||
      lower.includes('not supported') ||
      lower.includes('not enabled') ||
      lower.includes('paid tier') ||
      lower.includes('billing')
    ) {
      category = 'paid_tier_required';
      httpStatus = 403;
      retryable = false;
    } else if (
      lower.includes('429') ||
      lower.includes('resource_exhausted') ||
      lower.includes('quota') ||
      lower.includes('rate limit')
    ) {
      category = 'quota_exceeded';
      httpStatus = 429;
      retryable = true;
    } else if (
      lower.includes('404') ||
      lower.includes('not found') ||
      lower.includes('model not found') ||
      lower.includes('model_unavailable')
    ) {
      category = 'model_unavailable';
      httpStatus = 404;
      retryable = false;
    } else if (
      lower.includes('invalid mp4') ||
      lower.includes('non-video') ||
      lower.includes('zero duration') ||
      lower.includes('unplayable')
    ) {
      category = 'invalid_video_output';
      retryable = false;
    } else if (
      lower.includes('500') ||
      lower.includes('503') ||
      lower.includes('502') ||
      lower.includes('504') ||
      lower.includes('unavailable') ||
      lower.includes('high demand') ||
      lower.includes('timeout') ||
      lower.includes('fetch failed')
    ) {
      category = 'transient_error';
      httpStatus = 503;
      retryable = true;
    }

    const userMessage =
      category === 'quota_exceeded'
        ? `Google Veo video generation rate limit or quota exceeded for ${modelId}: ${rawMessage}`
        : category === 'paid_tier_required'
        ? `Google Veo (${modelId}) requires a billing-enabled Google AI API key with video-generation access enabled. Set a paid key in Settings > Secrets, or use Basic Motion/Slideshow Render.`
        : category === 'model_unavailable'
        ? `Google Veo model ${modelId} is not accessible or enabled on this API key: ${rawMessage}`
        : `${this.providerName} (${modelId}) error: ${rawMessage}`;

    return {
      providerId: this.providerId,
      providerName: this.providerName,
      modelId,
      category,
      retryable,
      httpStatus,
      rawMessage,
      userMessage,
    };
  }
}

export const GOOGLE_VEO_ADAPTER = new GoogleVeoVideoProviderAdapter();

/**
 * Resolves the AI video provider adapter.
 */
export function resolveAiVideoProviderAdapter(
  _pref?: RenderEnginePreference | string
): AiVideoProviderAdapter {
  return GOOGLE_VEO_ADAPTER;
}

/**
 * Generates marketing visual assets (campaign visuals, storyboard frames, thumbnails)
 * using the Google Nano Banana image-generation model family:
 * - gemini-3.1-flash-lite-image (default)
 * - gemini-nano-banana-2.1 (high-fidelity 1K/2K/4K)
 * - gemini-3-pro-image (pro)
 */
export async function generateNanoBananaVisualAsset(params: {
  prompt: string;
  referenceImageDataUrl?: string;
  aspectRatio?: '9:16' | '1:1' | '16:9';
  modelId?: string;
  env?: NodeJS.ProcessEnv;
  client?: GoogleGenAI;
}): Promise<GeneratedVisualAsset> {
  const env = params.env || process.env;
  const client = params.client || getGoogleGenAIClient(env);
  const model = params.modelId || env.GOOGLE_IMAGE_MODEL || DEFAULT_GOOGLE_IMAGE_MODEL_ID;
  const aspectRatio = params.aspectRatio || '9:16';

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  if (params.referenceImageDataUrl) {
    const match = params.referenceImageDataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i);
    if (match) {
      const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
      parts.push({
        inlineData: {
          mimeType: mime,
          data: match[2],
        },
      });
    }
  }

  parts.push({
    text: params.prompt,
  });

  const response = await client.models.generateContent({
    model,
    contents: {
      parts,
    },
    config: {
      imageConfig: {
        aspectRatio,
      },
    },
  });

  let imageDataUrl = '';
  let mimeType = 'image/png';

  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData?.data) {
      mimeType = part.inlineData.mimeType || 'image/png';
      imageDataUrl = `data:${mimeType};base64,${part.inlineData.data}`;
      break;
    }
  }

  if (!imageDataUrl) {
    throw new Error(
      `Nano Banana image model (${model}) responded but did not return image bytes. Check prompt or billing tier.`
    );
  }

  return {
    id: `vis_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    modelUsed: model,
    prompt: params.prompt,
    promptUsed: params.prompt,
    aspectRatio,
    imageDataUrl,
    mimeType,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Returns non-sensitive readiness & capability metadata for Google Veo 2.0.
 * Never exposes secret API keys.
 */
export function getVideoProvidersSummary(
  env: NodeJS.ProcessEnv = typeof process !== 'undefined' ? process.env : {}
): VideoProviderStatusInfo[] {
  const apiKeyConfigured = Boolean((env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '').trim());
  const videoModel = env.GOOGLE_VIDEO_MODEL || DEFAULT_GOOGLE_VEO_MODEL_ID;

  const statusSummary = apiKeyConfigured
    ? `Google AI API key is configured. AI Video generation uses ${videoModel} (9:16 vertical MP4). Note: Video generation requires video model access on your Google AI API key. If quota or access is unavailable, select Basic Motion/Slideshow Render.`
    : 'Google AI API key (GEMINI_API_KEY / GOOGLE_API_KEY) is not set in server environment variables. Configure your API key to enable Google Veo 2.0 AI Video generation.';

  return [
    {
      providerId: GOOGLE_VEO_ADAPTER.providerId,
      providerName: GOOGLE_VEO_ADAPTER.providerName,
      enginePreference: GOOGLE_VEO_ADAPTER.enginePreference,
      defaultModelId: videoModel,
      supportedModels: GOOGLE_VEO_ADAPTER.supportedModels,
      envVarName: GOOGLE_VEO_ADAPTER.envVarName,
      configured: apiKeyConfigured,
      modelAvailable: apiKeyConfigured,
      timeoutMs: DEFAULT_GOOGLE_VEO_TIMEOUT_MS,
      requiresPaidTierOrCredits: true,
      supportedAspectRatios: GOOGLE_VEO_ADAPTER.supportedAspectRatios,
      supportedDurationsSeconds: GOOGLE_VEO_ADAPTER.supportedDurationsSeconds,
      docsUrl: GOOGLE_VEO_ADAPTER.docsUrl,
      statusSummary,
    },
  ];
}

/**
 * Executes shot video generation with polling, progress updates, and retries.
 */
export async function executeProviderShotGeneration(
  adapter: AiVideoProviderAdapter,
  params: GenerateShotVideoParams
): Promise<{
  videoBuffer: Buffer;
  providerId: AiVideoProviderId;
  modelUsed: string;
  remoteJobId?: string;
  attempts: number;
  latencyMs: number;
}> {
  const startMs = Date.now();
  const pollIntervalMs = params.pollIntervalMs || 4000;
  const maxPollAttempts = params.maxPollAttempts || 60;
  const maxTransientAttempts = 2;

  let attempts = 0;
  let lastNormalizedError: NormalizedProviderError | undefined;

  for (let retry = 0; retry < maxTransientAttempts; retry++) {
    attempts += 1;

    if (params.signal?.aborted) {
      throw adapter.normalizeProviderError(
        new Error('Video render job was cancelled by the user.'),
        params.modelId
      );
    }

    let remoteJobId = '';
    try {
      const submission = await adapter.generateShotVideo(params);
      remoteJobId = submission.jobId;

      let finalVideoSource = submission.videoSource;
      let currentStatus = submission.status;

      if (currentStatus === 'failed') {
        throw new Error(submission.errorMessage || `${adapter.providerName} job failed immediately.`);
      }
      if (currentStatus === 'cancelled') {
        throw new Error('Video render job was cancelled by the user.');
      }

      let pollCount = 0;
      while (
        (currentStatus === 'queued' || currentStatus === 'processing') &&
        pollCount < maxPollAttempts
      ) {
        if (params.signal?.aborted) {
          await adapter.cancelJob(remoteJobId, params);
          throw new Error('Video render job was cancelled by the user.');
        }

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

        if (params.signal?.aborted) {
          await adapter.cancelJob(remoteJobId, params);
          throw new Error('Video render job was cancelled by the user.');
        }

        pollCount += 1;
        const polled = await adapter.getJobStatus(remoteJobId, params);
        currentStatus = polled.status;

        if (typeof polled.progressPercent === 'number') {
          params.onProgressUpdate?.(
            `Shot 0${params.shot.shotNumber} generating on ${adapter.providerName} (${polled.progressPercent}%)...`,
            polled.progressPercent
          );
        }
        if (polled.videoSource) {
          finalVideoSource = polled.videoSource;
        }
        if (currentStatus === 'failed') {
          throw new Error(polled.errorMessage || `${adapter.providerName} job ${remoteJobId} failed.`);
        }
        if (currentStatus === 'cancelled') {
          throw new Error('Video render job was cancelled by the user.');
        }
      }

      if (currentStatus !== 'completed' || !finalVideoSource) {
        throw new Error(
          `${adapter.providerName} (${submission.modelUsed}) timed out waiting for video completion (job ${remoteJobId}).`
        );
      }

      const videoBuffer = await adapter.downloadGeneratedVideo(finalVideoSource, params);

      return {
        videoBuffer,
        providerId: adapter.providerId,
        modelUsed: submission.modelUsed,
        remoteJobId,
        attempts,
        latencyMs: Date.now() - startMs,
      };
    } catch (err: unknown) {
      if (params.signal?.aborted && remoteJobId) {
        await adapter.cancelJob(remoteJobId, params).catch(() => undefined);
      }
      const normalized = adapter.normalizeProviderError(err, params.modelId);
      lastNormalizedError = normalized;

      if (!normalized.retryable || retry >= maxTransientAttempts - 1) {
        throw normalized;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw (
    lastNormalizedError ||
    adapter.normalizeProviderError(new Error(`${adapter.providerName} video generation failed.`))
  );
}
