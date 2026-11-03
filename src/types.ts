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

export interface Campaign {
  id: string;
  title: string;
  price: string;
  brandName: string;
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
  status: 'analyzed';
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
  models: ModelProbeEntry[];
}
