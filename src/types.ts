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
  status: 'analyzed' | 'storyboard_ready' | 'audio_ready';
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
