import type {
  Campaign,
  ProductProfile,
  VideoConceptAndStoryboard,
  SupportedVoiceName,
  ColorSwatch,
  SellingPoint,
  RecommendedAdAngle,
} from '../types.ts';
import type { SampleProductPreset } from './sampleProducts.ts';
import { VOICE_OPTIONS_META } from './milestone2Validators.ts';

export interface StudioFormState {
  title: string;
  price: string;
  brandName: string;
  modelOrVariant: string;
  visiblePackagingText: string;
  brandVoice: string;
  targetAudience: string;
  visualStyle: string;
  imageDataUrl: string;
  selectedPresetId: string;
}

export interface StudioSessionState {
  form: StudioFormState;
  activeCampaign: Campaign | null;
  editableProfile: ProductProfile | null;
  rawJsonText: string;
  jsonParseError: string | null;
  editableStoryboard: VideoConceptAndStoryboard | null;
  creativeAngleHint: string;
  targetFormat: 'Instagram Reels (9:16)' | 'Instagram Stories (9:16)' | 'YouTube Shorts (9:16)';
  desiredDuration: number;
  selectedVoice: SupportedVoiceName;
  voiceStylePrompt: string;
  voiceScriptDraft: string;
  musicPromptDraft: string;
  isAnalyzing: boolean;
  isSavingProfile: boolean;
  isGeneratingStoryboard: boolean;
  isSavingStoryboard: boolean;
  isGeneratingVoiceover: boolean;
  isProcessingMusic: boolean;
  hasUnsavedProfileEdits: boolean;
  hasUnsavedStoryboardEdits: boolean;
  lastRetryAction: 'analyze' | 'storyboard' | 'voiceover' | null;
  warningBanner: string | null;
  errorBanner: string | null;
  statusMessage: string | null;
}

const FABRICATED_PLACEHOLDER_PATTERNS = [
  /^unknown$/i,
  /^unknown\s+brand$/i,
  /^unknown\s+model$/i,
  /^unidentified$/i,
  /^not\s+visible$/i,
  /^not\s+identifiable$/i,
  /^not\s+specified$/i,
  /^not\s+applicable$/i,
  /^none$/i,
  /^none\s+visible$/i,
  /^n\/a$/i,
  /^na$/i,
  /^null$/i,
  /^undefined$/i,
  /^tbd$/i,
  /^independent\s+brand$/i,
  /^generic\s+brand$/i,
  /^brand\s+not\s+visible$/i,
  /^no\s+brand\s+visible$/i,
  /^price\s+on\s+request$/i,
  /^no\s+price\s+visible$/i,
  /^price\s+not\s+visible$/i,
];

export function isUnknownOrPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  return FABRICATED_PLACEHOLDER_TERNS_MATCH(trimmed);
}

function FABRICATED_PLACEHOLDER_TERNS_MATCH(trimmed: string): boolean {
  return FABRICATED_PLACEHOLDER_PATTERNS.some((regex) => regex.test(trimmed));
}

/**
 * Normalizes brand name or model/variant:
 * If it cannot be reliably identified from the image, returns "Unknown" rather than inventing details.
 */
export function normalizeBrandOrModelField(value: unknown): string {
  if (typeof value !== 'string') return 'Unknown';
  const trimmed = value.trim();
  if (!trimmed || isUnknownOrPlaceholder(trimmed)) {
    return 'Unknown';
  }
  return trimmed;
}

/**
 * Normalizes price/offer field:
 * Must remain empty ("") unless explicitly supplied by the user or visibly printed in the image.
 * Never invents "Price on request" or arbitrary numbers.
 */
export function normalizeVisiblePriceField(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || isUnknownOrPlaceholder(trimmed)) {
    return '';
  }
  return trimmed;
}

/**
 * Ensures any AI-inferred target audience is clearly marked as an inference.
 */
export function formatInferredTargetAudience(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || isUnknownOrPlaceholder(trimmed)) return '';
  if (/^\[?inferred/i.test(trimmed) || /\(inferred/i.test(trimmed)) {
    return trimmed;
  }
  return `Inferred: ${trimmed}`;
}

/**
 * Validates and normalizes the raw Gemini multimodal ProductProfile response.
 * Protects against malformed JSON, missing arrays, or fabricated brand/price placeholders.
 */
export function validateAndNormalizeProductProfile(raw: unknown): {
  valid: boolean;
  profile?: ProductProfile;
  error?: string;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      valid: false,
      error: 'Malformed product profile response: expected a JSON object.',
    };
  }

  const obj = raw as Record<string, unknown>;
  const detectedProductName =
    typeof obj.detectedProductName === 'string' && obj.detectedProductName.trim()
      ? obj.detectedProductName.trim()
      : '';

  const category =
    typeof obj.category === 'string' && obj.category.trim() ? obj.category.trim() : '';

  if (!detectedProductName || !category) {
    return {
      valid: false,
      error:
        'Product identification incomplete: Gemini response is missing detectedProductName or category.',
    };
  }

  const subcategory =
    typeof obj.subcategory === 'string' && obj.subcategory.trim()
      ? obj.subcategory.trim()
      : 'General';

  const identifiedBrandName = normalizeBrandOrModelField(obj.identifiedBrandName);
  const identifiedModelOrVariant = normalizeBrandOrModelField(obj.identifiedModelOrVariant);
  const visiblePriceOrOffer = normalizeVisiblePriceField(obj.visiblePriceOrOffer);

  const rawPackaging = Array.isArray(obj.visiblePackagingTextAndLogos)
    ? obj.visiblePackagingTextAndLogos
    : [];
  const visiblePackagingTextAndLogos = rawPackaging
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !isUnknownOrPlaceholder(item));

  const rawConfidence =
    typeof obj.identificationConfidence === 'string'
      ? obj.identificationConfidence.toLowerCase().trim()
      : 'medium';
  const identificationConfidence: 'high' | 'medium' | 'low' =
    rawConfidence === 'high' || rawConfidence === 'low' ? rawConfidence : 'medium';

  const uncertaintyNotes =
    typeof obj.uncertaintyNotes === 'string' && obj.uncertaintyNotes.trim()
      ? obj.uncertaintyNotes.trim()
      : identifiedBrandName === 'Unknown' || identifiedModelOrVariant === 'Unknown'
      ? 'Some brand or model markings were not clearly visible in the image and were marked as Unknown.'
      : 'Primary visual product attributes clearly observed.';

  const productSummary =
    typeof obj.productSummary === 'string' && obj.productSummary.trim()
      ? obj.productSummary.trim()
      : `${detectedProductName} (${category}).`;

  const dominantColors: ColorSwatch[] = Array.isArray(obj.dominantColors)
    ? obj.dominantColors
        .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === 'object'))
        .map((c) => ({
          name: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : 'Observed Tone',
          hex:
            typeof c.hex === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c.hex.trim())
              ? c.hex.trim()
              : '#475569',
          usageRole:
            typeof c.usageRole === 'string' && c.usageRole.trim()
              ? c.usageRole.trim()
              : 'Primary surface',
        }))
    : [];

  const materialsAndTextures = Array.isArray(obj.materialsAndTextures)
    ? obj.materialsAndTextures
        .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
        .map((m) => m.trim())
    : [];

  const estimatedDimensions =
    typeof obj.estimatedDimensions === 'string' && obj.estimatedDimensions.trim()
      ? obj.estimatedDimensions.trim()
      : 'Unknown';

  const detectedFeatures = Array.isArray(obj.detectedFeatures)
    ? obj.detectedFeatures
        .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
        .map((f) => f.trim())
    : [];

  const keySellingPoints: SellingPoint[] = Array.isArray(obj.keySellingPoints)
    ? obj.keySellingPoints
        .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === 'object'))
        .map((s) => ({
          headline:
            typeof s.headline === 'string' && s.headline.trim()
              ? s.headline.trim()
              : detectedProductName,
          proofPoint:
            typeof s.proofPoint === 'string' && s.proofPoint.trim()
              ? s.proofPoint.trim()
              : 'Observed directly in product image',
          emotionalHook:
            typeof s.emotionalHook === 'string' && s.emotionalHook.trim()
              ? s.emotionalHook.trim()
              : 'Designed for everyday utility and visual appeal',
        }))
    : [];

  const rawVoice =
    obj.brandVoiceGuidelines && typeof obj.brandVoiceGuidelines === 'object'
      ? (obj.brandVoiceGuidelines as Record<string, unknown>)
      : {};

  const toneDescriptors = Array.isArray(rawVoice.toneDescriptors)
    ? rawVoice.toneDescriptors
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((t) => t.trim())
    : ['Modern', 'Clear'];

  const wordsToUse = Array.isArray(rawVoice.wordsToUse)
    ? rawVoice.wordsToUse
        .filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
        .map((w) => w.trim())
    : [];

  const wordsToAvoid = Array.isArray(rawVoice.wordsToAvoid)
    ? rawVoice.wordsToAvoid
        .filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
        .map((w) => w.trim())
    : [];

  const targetPersonaSummary = formatInferredTargetAudience(
    rawVoice.targetPersonaSummary || `Shoppers interested in ${category.toLowerCase()}`
  );

  const validPlatforms = ['Instagram Reels', 'Instagram Stories', 'YouTube Shorts'] as const;
  const recommendedAdAngles: RecommendedAdAngle[] = Array.isArray(obj.recommendedAdAngles)
    ? obj.recommendedAdAngles
        .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === 'object'))
        .map((a) => {
          const rawPlat = typeof a.targetPlatform === 'string' ? a.targetPlatform.trim() : '';
          const targetPlatform = (validPlatforms as readonly string[]).includes(rawPlat)
            ? (rawPlat as RecommendedAdAngle['targetPlatform'])
            : 'Instagram Reels';
          return {
            angleName:
              typeof a.angleName === 'string' && a.angleName.trim()
                ? a.angleName.trim()
                : 'Product Hero Showcase',
            targetPlatform,
            hookIdea:
              typeof a.hookIdea === 'string' && a.hookIdea.trim()
                ? a.hookIdea.trim()
                : `Take a closer look at ${detectedProductName}.`,
            visualDirection:
              typeof a.visualDirection === 'string' && a.visualDirection.trim()
                ? a.visualDirection.trim()
                : 'Clean 9:16 vertical studio framing with macro detail focus.',
          };
        })
    : [];

  const suggestedVisualDirection =
    typeof obj.suggestedVisualDirection === 'string' && obj.suggestedVisualDirection.trim()
      ? obj.suggestedVisualDirection.trim()
      : recommendedAdAngles[0]
      ? `${recommendedAdAngles[0].angleName}: ${recommendedAdAngles[0].visualDirection}`
      : 'Clean commercial studio lighting with crisp focus on observed product features';

  const visualFidelityConstraints = Array.isArray(obj.visualFidelityConstraints)
    ? obj.visualFidelityConstraints
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => v.trim())
    : ['Preserve exact product geometry, colors, and visible markings without distortion.'];

  const normalizedProfile: ProductProfile = {
    detectedProductName,
    category,
    subcategory,
    identifiedBrandName,
    identifiedModelOrVariant,
    visiblePriceOrOffer,
    visiblePackagingTextAndLogos,
    identificationConfidence,
    uncertaintyNotes,
    suggestedVisualDirection,
    productSummary,
    dominantColors,
    materialsAndTextures,
    estimatedDimensions,
    detectedFeatures,
    keySellingPoints,
    brandVoiceGuidelines: {
      toneDescriptors,
      wordsToUse,
      wordsToAvoid,
      targetPersonaSummary,
    },
    recommendedAdAngles,
    visualFidelityConstraints,
  };

  return {
    valid: true,
    profile: normalizedProfile,
  };
}

/**
 * Maps a validated ProductProfile into StudioFormState without fabricating missing fields.
 * - Keeps price empty unless user-supplied or visibly present in the image.
 * - Sets brandName and modelOrVariant to "Unknown" if not identifiable.
 * - Clearly marks inferred targetAudience with "Inferred: ".
 */
export function mapExtractedProfileToForm(
  currentForm: StudioFormState,
  profile: ProductProfile
): StudioFormState {
  const userTitle = currentForm.title.trim();
  const userPrice = currentForm.price.trim();
  const userBrand = currentForm.brandName.trim();
  const userModel = currentForm.modelOrVariant.trim();
  const userPackaging = currentForm.visiblePackagingText.trim();
  const userVoice = currentForm.brandVoice.trim();
  const userAudience = currentForm.targetAudience.trim();
  const userVisual = currentForm.visualStyle.trim();

  const extractedBrand = normalizeBrandOrModelField(profile.identifiedBrandName);
  const extractedModel = normalizeBrandOrModelField(profile.identifiedModelOrVariant);
  const extractedPrice = normalizeVisiblePriceField(profile.visiblePriceOrOffer);
  const extractedPackaging =
    profile.visiblePackagingTextAndLogos && profile.visiblePackagingTextAndLogos.length > 0
      ? profile.visiblePackagingTextAndLogos.join(' · ')
      : 'Unknown';

  const inferredVoice =
    profile.brandVoiceGuidelines.toneDescriptors.slice(0, 2).join(' & ') || '';
  const inferredAudience = formatInferredTargetAudience(
    profile.brandVoiceGuidelines.targetPersonaSummary
  );
  const suggestedVisual =
    profile.suggestedVisualDirection ||
    (profile.recommendedAdAngles[0]
      ? `${profile.recommendedAdAngles[0].angleName} — ${profile.recommendedAdAngles[0].visualDirection}`
      : '');

  return {
    ...currentForm,
    title: userTitle || profile.detectedProductName,
    price: userPrice || extractedPrice,
    brandName: userBrand || extractedBrand,
    modelOrVariant: userModel || extractedModel,
    visiblePackagingText: userPackaging || extractedPackaging,
    brandVoice: userVoice || inferredVoice,
    targetAudience: userAudience || inferredAudience,
    visualStyle: userVisual || suggestedVisual,
  };
}

/**
 * Returns a completely blank initial or reset studio state.
 * No preset or previous campaign values are populated.
 */
export function createBlankStudioState(): StudioSessionState {
  return {
    form: {
      title: '',
      price: '',
      brandName: '',
      modelOrVariant: '',
      visiblePackagingText: '',
      brandVoice: '',
      targetAudience: '',
      visualStyle: '',
      imageDataUrl: '',
      selectedPresetId: '',
    },
    activeCampaign: null,
    editableProfile: null,
    rawJsonText: '',
    jsonParseError: null,
    editableStoryboard: null,
    creativeAngleHint: '',
    targetFormat: 'Instagram Reels (9:16)',
    desiredDuration: 15,
    selectedVoice: 'Kore',
    voiceStylePrompt: '',
    voiceScriptDraft: '',
    musicPromptDraft: '',
    isAnalyzing: false,
    isSavingProfile: false,
    isGeneratingStoryboard: false,
    isSavingStoryboard: false,
    isGeneratingVoiceover: false,
    isProcessingMusic: false,
    hasUnsavedProfileEdits: false,
    hasUnsavedStoryboardEdits: false,
    lastRetryAction: null,
    warningBanner: null,
    errorBanner: null,
    statusMessage: null,
  };
}

/**
 * Resets the entire studio session to a clean blank state for "New Product Analysis".
 */
export function resetToBlankProductState(): StudioSessionState {
  return createBlankStudioState();
}

/**
 * Applies an explicitly selected demo preset to the studio state.
 * Invalidates any previous campaign, profile, storyboard, voiceover, or music state.
 */
export function applyPresetToStudioState(
  preset: SampleProductPreset,
  renderedImageDataUrl?: string
): StudioSessionState {
  const blank = createBlankStudioState();
  const dataUrl =
    typeof renderedImageDataUrl === 'string'
      ? renderedImageDataUrl
      : preset.renderCanvasImage();

  return {
    ...blank,
    form: {
      title: preset.title,
      price: preset.price,
      brandName: preset.brandName,
      modelOrVariant: preset.modelOrVariant || '',
      visiblePackagingText: preset.visiblePackagingText || '',
      brandVoice: preset.brandVoice,
      targetAudience: preset.targetAudience,
      visualStyle: preset.visualStyle,
      imageDataUrl: dataUrl,
      selectedPresetId: preset.id,
    },
  };
}

/**
 * Applies a newly uploaded custom product image.
 * Clears previous product metadata and invalidates any existing profile, storyboard,
 * voiceover, and music artifacts so no stale data from a prior product persists.
 */
export function applyUploadedImageToStudioState(
  _previousState: StudioSessionState,
  newImageDataUrl: string,
  startAnalyzing = false
): StudioSessionState {
  const blank = createBlankStudioState();
  return {
    ...blank,
    isAnalyzing: startAnalyzing,
    statusMessage: startAnalyzing
      ? 'Analyzing uploaded product image with Gemini Vision to extract product details...'
      : null,
    form: {
      ...blank.form,
      imageDataUrl: newImageDataUrl,
      selectedPresetId: 'custom-upload',
    },
  };
}

/**
 * Synchronizes studio state when an analyzed or saved Campaign is loaded.
 */
export function applyCampaignToStudioState(campaign: Campaign): StudioSessionState {
  const blank = createBlankStudioState();
  const normalizedCheck = validateAndNormalizeProductProfile(campaign.productProfile);
  const clonedProfile = normalizedCheck.valid && normalizedCheck.profile
    ? structuredClone(normalizedCheck.profile)
    : structuredClone(campaign.productProfile);
  const clonedStoryboard = campaign.storyboard
    ? structuredClone(campaign.storyboard)
    : null;

  const defaultVoice: SupportedVoiceName = campaign.voiceover?.voiceName || 'Kore';
  const defaultVoiceMeta =
    VOICE_OPTIONS_META.find((v) => v.name === defaultVoice) || VOICE_OPTIONS_META[0];

  const defaultScript =
    campaign.voiceover?.scriptTextUsed ||
    clonedStoryboard?.fullVoiceoverScript ||
    clonedProfile.keySellingPoints[0]?.headline ||
    clonedProfile.productSummary ||
    '';

  const defaultMusicPrompt =
    campaign.backgroundMusic?.promptUsed ||
    clonedStoryboard?.musicDirectionPrompt ||
    '';

  const emptyFormWithImage: StudioFormState = {
    ...blank.form,
    title: campaign.title || '',
    price: normalizeVisiblePriceField(campaign.price),
    brandName: normalizeBrandOrModelField(campaign.brandName || clonedProfile.identifiedBrandName),
    modelOrVariant: normalizeBrandOrModelField(
      campaign.modelOrVariant || clonedProfile.identifiedModelOrVariant
    ),
    visiblePackagingText:
      campaign.visiblePackagingText ||
      (clonedProfile.visiblePackagingTextAndLogos &&
      clonedProfile.visiblePackagingTextAndLogos.length > 0
        ? clonedProfile.visiblePackagingTextAndLogos.join(' · ')
        : 'Unknown'),
    brandVoice: campaign.brandVoice || '',
    targetAudience: formatInferredTargetAudience(
      campaign.targetAudience || clonedProfile.brandVoiceGuidelines.targetPersonaSummary
    ),
    visualStyle:
      campaign.visualStyle ||
      clonedProfile.suggestedVisualDirection ||
      '',
    imageDataUrl: campaign.imageDataUrl,
    selectedPresetId: '',
  };

  const mappedForm = mapExtractedProfileToForm(emptyFormWithImage, clonedProfile);

  return {
    ...blank,
    form: mappedForm,
    activeCampaign: {
      ...campaign,
      price: mappedForm.price,
      brandName: mappedForm.brandName,
      modelOrVariant: mappedForm.modelOrVariant,
      visiblePackagingText: mappedForm.visiblePackagingText,
      targetAudience: mappedForm.targetAudience,
      visualStyle: mappedForm.visualStyle,
      productProfile: clonedProfile,
    },
    editableProfile: clonedProfile,
    rawJsonText: JSON.stringify(clonedProfile, null, 2),
    jsonParseError: null,
    editableStoryboard: clonedStoryboard,
    targetFormat: clonedStoryboard?.targetPlatformFormat || 'Instagram Reels (9:16)',
    desiredDuration: clonedStoryboard?.totalDurationSeconds || 15,
    selectedVoice: defaultVoice,
    voiceStylePrompt: campaign.voiceover?.voiceStyle || defaultVoiceMeta.defaultStylePrompt,
    voiceScriptDraft: defaultScript,
    musicPromptDraft: defaultMusicPrompt,
  };
}

/**
 * Handles a TTS voiceover error while strictly preserving the user's current
 * script draft, storyboard edits, profile edits, and voice settings.
 */
export function handleVoiceoverErrorState(
  prevState: StudioSessionState,
  errorMessage: string
): StudioSessionState {
  return {
    ...prevState,
    isGeneratingVoiceover: false,
    statusMessage: null,
    lastRetryAction: 'voiceover',
    errorBanner: errorMessage,
  };
}

/**
 * Merges a campaign update from voiceover or music endpoints without overwriting
 * any unsaved in-memory profile or storyboard edits made by the user.
 */
export function applyVoiceoverOrMusicUpdatePreservingEdits(
  prevState: StudioSessionState,
  updatedCampaign: Campaign
): StudioSessionState {
  const baseState = applyCampaignToStudioState(updatedCampaign);
  return {
    ...baseState,
    form: prevState.hasUnsavedProfileEdits ? prevState.form : baseState.form,
    editableProfile: prevState.hasUnsavedProfileEdits
      ? prevState.editableProfile
      : baseState.editableProfile,
    rawJsonText: prevState.hasUnsavedProfileEdits
      ? prevState.rawJsonText
      : baseState.rawJsonText,
    editableStoryboard: prevState.hasUnsavedStoryboardEdits
      ? prevState.editableStoryboard
      : baseState.editableStoryboard,
    hasUnsavedProfileEdits: prevState.hasUnsavedProfileEdits,
    hasUnsavedStoryboardEdits: prevState.hasUnsavedStoryboardEdits,
    targetFormat: prevState.targetFormat,
    desiredDuration: prevState.desiredDuration,
    creativeAngleHint: prevState.creativeAngleHint,
    selectedVoice: updatedCampaign.voiceover?.voiceName || prevState.selectedVoice,
    voiceStylePrompt: updatedCampaign.voiceover?.voiceStyle || prevState.voiceStylePrompt,
    voiceScriptDraft: prevState.voiceScriptDraft || baseState.voiceScriptDraft,
    musicPromptDraft: prevState.musicPromptDraft || baseState.musicPromptDraft,
  };
}

/**
 * Automatically analyzes a newly uploaded product image via the server-side Gemini multimodal
 * endpoint (/api/campaigns/analyze) and synchronizes the extracted metadata into StudioSessionState.
 */
export async function analyzeUploadedImageWithGemini(
  imageDataUrl: string,
  formOverrides: Partial<StudioFormState> = {},
  fetchImpl: typeof fetch = fetch
): Promise<{
  state: StudioSessionState;
  campaign: Campaign | null;
}> {
  const initialUploadState = applyUploadedImageToStudioState(
    createBlankStudioState(),
    imageDataUrl,
    true
  );

  const payloadForm: StudioFormState = {
    ...initialUploadState.form,
    ...formOverrides,
    imageDataUrl,
    selectedPresetId: formOverrides.selectedPresetId || 'custom-upload',
  };

  try {
    const res = await fetchImpl('/api/campaigns/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadForm),
    });

    let data: Record<string, unknown> = {};
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new Error('Server returned an unreadable response during product analysis.');
    }

    if (!res.ok) {
      const errMsg =
        typeof data.error === 'string' && data.error.trim()
          ? data.error.trim()
          : 'Product image analysis failed.';
      throw new Error(errMsg);
    }

    const campaign = data.campaign as Campaign | undefined;
    if (!campaign || !campaign.productProfile) {
      throw new Error('Server response did not contain a valid analyzed product profile.');
    }

    // Ensure the analyzed campaign's image matches the uploaded image
    if (campaign.imageDataUrl !== imageDataUrl) {
      throw new Error('Image mismatch detected between uploaded image and analysis response.');
    }

    const validation = validateAndNormalizeProductProfile(campaign.productProfile);
    if (!validation.valid || !validation.profile) {
      throw new Error(validation.error || 'Invalid product profile returned by model.');
    }

    const normalizedCampaign: Campaign = {
      ...campaign,
      productProfile: validation.profile,
    };

    const nextState = applyCampaignToStudioState(normalizedCampaign);
    nextState.form.selectedPresetId = payloadForm.selectedPresetId;
    nextState.isAnalyzing = false;
    nextState.statusMessage = `Extracted product metadata from image in ${normalizedCampaign.analysisMetadata.latencyMs} ms (${normalizedCampaign.analysisMetadata.resolvedModel}). Review and edit fields below before generating a script or storyboard.`;

    return {
      state: nextState,
      campaign: nextState.activeCampaign,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Failed to analyze uploaded product image.';
    return {
      state: {
        ...initialUploadState,
        form: payloadForm,
        isAnalyzing: false,
        lastRetryAction: 'analyze',
        errorBanner: message,
        statusMessage: null,
      },
      campaign: null,
    };
  }
}
