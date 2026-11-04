export interface ColorSwatch {
  name: string;
  hex: string;
  usageRole: string;
}

export interface SellingPoint {
  headline: string;
  proofPoint: string;
  emotionalHook: string;
}

export interface BrandVoiceGuidelines {
  toneDescriptors: string[];
  wordsToUse: string[];
  wordsToAvoid: string[];
  targetPersonaSummary: string;
}

export interface RecommendedAdAngle {
  angleName: string;
  targetPlatform: 'Instagram Reels' | 'Instagram Stories' | 'YouTube Shorts';
  hookIdea: string;
  visualDirection: string;
}

export interface ProductProfile {
  detectedProductName: string;
  category: string;
  subcategory: string;
  identifiedBrandName?: string;
  identifiedModelOrVariant?: string;
  visiblePriceOrOffer?: string;
  visiblePackagingTextAndLogos?: string[];
  identificationConfidence?: 'high' | 'medium' | 'low';
  uncertaintyNotes?: string;
  suggestedVisualDirection?: string;
  productSummary: string;
  dominantColors: ColorSwatch[];
  materialsAndTextures: string[];
  estimatedDimensions: string;
  detectedFeatures: string[];
  keySellingPoints: SellingPoint[];
  brandVoiceGuidelines: BrandVoiceGuidelines;
  recommendedAdAngles: RecommendedAdAngle[];
  visualFidelityConstraints: string[];
}

export type SupportedVoiceName = 'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr';

export interface StoryboardShot {
  shotNumber: number;
  durationSeconds: number;
  timecodeRange: string;
  shotType: string;
  sceneDescription: string;
  cameraMovement: string;
  visualPrompt9x16: string;
  onScreenTextOverlay: string;
  spokenVoiceoverSegment: string;
  productFidelityNote: string;
}

export interface VideoConceptAndStoryboard {
  conceptTitle: string;
  targetPlatformFormat: 'Instagram Reels (9:16)' | 'Instagram Stories (9:16)' | 'YouTube Shorts (9:16)';
  totalDurationSeconds: number;
  openingHook3s: string;
  fullVoiceoverScript: string;
  estimatedWordCount: number;
  brandSafetyVerification: string[];
  masterCinematicPrompt9x16: string;
  musicDirectionPrompt: string;
  shots: StoryboardShot[];
  generationMetadata: {
    requestedModel: string;
    resolvedModel: string;
    fallbackUsed: boolean;
    fallbackReason?: string;
    latencyMs: number;
    generatedAt: string;
  };
}

export interface VoiceoverAudioAsset {
  id: string;
  voiceName: SupportedVoiceName;
  voiceStyle: string;
  scriptTextUsed: string;
  audioFileUrl: string;
  mimeType: 'audio/wav';
  byteLength: number;
  sampleRateHz: number;
  durationEstimateSeconds: number;
  resolvedModel: string;
  latencyMs: number;
  generatedAt: string;
}

export interface BackgroundMusicState {
  status: 'not_requested' | 'generated' | 'unavailable_paid_tier' | 'custom_uploaded';
  modelAttempted?: string;
  statusMessage: string;
  audioFileUrl?: string;
  mimeType?: string;
  promptUsed?: string;
  updatedAt: string;
}

export type RenderJobStatus =
  | 'idle'
  | 'queued'
  | 'processing'
  | 'generating'
  | 'stitching'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AiVideoProviderId = 'google_veo' | 'gemini_omni';

export type RenderEnginePreference =
  | 'ai_video_google_veo'
  | 'basic_slideshow_ffmpeg'
  | 'ffmpeg_motion_compositor';

export type RenderEngineUsed =
  | 'google_veo_video'
  | 'ffmpeg_motion_compositor';

export type RenderFailureCategory =
  | 'paid_tier_required'
  | 'quota_exceeded'
  | 'auth_or_missing_key'
  | 'model_unavailable'
  | 'invalid_video_output'
  | 'transient_error'
  | 'cancelled'
  | 'validation_error';

export type ShotRenderStatus = 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled';

export interface ShotRenderState {
  shotNumber: number;
  shotType: string;
  durationSeconds: number;
  status: ShotRenderStatus;
  providerUsed?: AiVideoProviderId | 'ffmpeg_local';
  engineUsed?: RenderEngineUsed;
  modelUsed?: string;
  remoteJobId?: string;
  clipFileUrl?: string;
  conformedFilePath?: string;
  byteLength?: number;
  attempts: number;
  latencyMs?: number;
  promptUsed?: string;
  errorMessage?: string;
  failureCategory?: RenderFailureCategory;
  updatedAt: string;
}

export interface VideoRenderSettings {
  resolution: '1080x1920' | '720x1280';
  includeSubtitles: boolean;
  enginePreference: RenderEnginePreference;
  revisionNote?: string;
  retryFailedShotsOnly?: boolean;
}

export interface VideoRenderJob {
  id: string;
  campaignId: string;
  versionNumber: number;
  status: RenderJobStatus;
  progressPercent: number;
  stageMessage: string;
  requestedEngine: RenderEnginePreference;
  providerUsed?: AiVideoProviderId | 'ffmpeg_local';
  modelUsed?: string;
  engineUsed: RenderEngineUsed;
  engineLabel: string;
  isAiVideoGenerated?: boolean;
  omniFallbackReason?: string;
  failureCategory?: RenderFailureCategory;
  shotResults?: ShotRenderState[];
  resolution: '1080x1920' | '720x1280';
  width: number;
  height: number;
  aspectRatio: '9:16';
  fps: number;
  durationSeconds: number;
  targetDurationSeconds: number;
  includeSubtitles: boolean;
  audioModeSummary: string;
  revisionNote?: string;
  videoFileUrl?: string;
  mimeType?: 'video/mp4';
  byteLength?: number;
  contentFingerprint: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
}

export interface VideoProviderStatusInfo {
  providerId: AiVideoProviderId;
  providerName: string;
  enginePreference: RenderEnginePreference;
  defaultModelId: string;
  supportedModels: string[];
  envVarName: string;
  configured: boolean;
  modelAvailable: boolean;
  disabledReason?: string;
  timeoutMs?: number;
  requiresPaidTierOrCredits: boolean;
  supportedAspectRatios: string[];
  supportedDurationsSeconds: number[];
  docsUrl: string;
  statusSummary: string;
}

export interface GeneratedVisualAsset {
  id: string;
  campaignId?: string;
  assetType?: 'campaign_hero' | 'storyboard_frame' | 'video_thumbnail';
  shotNumber?: number;
  prompt: string;
  promptUsed?: string;
  modelUsed: string;
  imageDataUrl: string;
  mimeType?: string;
  aspectRatio: '1:1' | '9:16' | '16:9';
  createdAt: string;
}

export interface VideoApprovalState {
  status: 'unrendered' | 'pending_review' | 'approved' | 'rejected' | 'invalidated';
  renderJobId?: string;
  versionNumber?: number;
  reviewedAt?: string;
  rejectionReason?: string;
  invalidationReason?: string;
  contentFingerprintAtReview?: string;
}

export interface Campaign {
  id: string;
  title: string;
  price: string;
  brandName: string;
  modelOrVariant?: string;
  visiblePackagingText?: string;
  brandVoice: string;
  targetAudience: string;
  visualStyle: string;
  imageDataUrl: string;
  productProfile: ProductProfile;
  analysisMetadata: {
    requestedModel: string;
    resolvedModel: string;
    fallbackUsed: boolean;
    fallbackReason?: string;
    latencyMs: number;
    analyzedAt: string;
  };
  storyboard?: VideoConceptAndStoryboard;
  voiceover?: VoiceoverAudioAsset;
  backgroundMusic?: BackgroundMusicState;
  visualAssets?: GeneratedVisualAsset[];
  activeRenderJob?: VideoRenderJob;
  latestCompletedRender?: VideoRenderJob;
  renderHistory?: VideoRenderJob[];
  approval?: VideoApprovalState;
  status:
    | 'analyzed'
    | 'storyboard_ready'
    | 'audio_ready'
    | 'rendering_video'
    | 'video_ready'
    | 'approved_for_publish';
  createdAt: string;
  updatedAt: string;
}

export interface ModelProbeEntry {
  modelId: string;
  role: string;
  milestone: string;
  requiresPaidKey: boolean;
  status: 'available' | 'fallback_available' | 'paid_tier_required' | 'unavailable';
  latencyMs: number | null;
  detailMessage: string;
  supportedAlternative: string;
}

export interface ModelVerificationReport {
  checkedAt: string;
  apiKeyConfigured: boolean;
  recommendedVisionModel: string;
  recommendedTtsModel: string;
  models: ModelProbeEntry[];
}

