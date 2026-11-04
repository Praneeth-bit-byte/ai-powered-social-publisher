import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type, GenerateContentResponse } from '@google/genai';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  Campaign,
  ProductProfile,
  VideoConceptAndStoryboard,
  VoiceoverAudioAsset,
  BackgroundMusicState,
  ModelProbeEntry,
  ModelVerificationReport,
} from './src/types.ts';
import {
  ensureValidWavBuffer,
  verifyWavFormat24kMono16Bit,
  estimateWavDurationSeconds,
  validateVoiceoverRequest,
  validateStoryboardUpdate,
  buildAndValidateMusicState,
} from './src/utils/milestone2Validators.ts';
import {
  validateAndNormalizeProductProfile,
  normalizeBrandOrModelField,
  normalizeVisiblePriceField,
  formatInferredTargetAudience,
} from './src/utils/studioState.ts';
import {
  PRIMARY_STORYBOARD_MODEL,
  VERIFIED_FALLBACK_STORYBOARD_MODEL,
  PRIMARY_TTS_MODEL,
  FALLBACK_TTS_MODEL,
  SUPPORTED_TTS_TASK_MODELS,
  AllModelsFailedError,
  getPreferredStoryboardModel,
  executeWithVerifiedModelFallback,
  parseAndValidateGeneratedStoryboard,
  setVerifiedAvailableModels,
} from './src/utils/modelRouter.ts';

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.cwd(), 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');

function ensureDataStore(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
  }
  if (!fs.existsSync(CAMPAIGNS_FILE)) {
    fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify([], null, 2), 'utf-8');
  }
}

function readCampaigns(): Campaign[] {
  ensureDataStore();
  try {
    const raw = fs.readFileSync(CAMPAIGNS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCampaigns(campaigns: Campaign[]): void {
  ensureDataStore();
  fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify(campaigns, null, 2), 'utf-8');
}

function getGenAIClient(timeoutMs?: number): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set on the server. Please verify your API key in AI Studio Settings > Secrets.'
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

const PRODUCT_PROFILE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    detectedProductName: {
      type: Type.STRING,
      description: 'Concise commercial name of the product identified directly from the image.',
    },
    category: {
      type: Type.STRING,
      description: 'Primary commercial product category (e.g., Kitchen Appliances, Skincare, Athletic Footwear).',
    },
    subcategory: {
      type: Type.STRING,
      description: 'Specific product subcategory (e.g., Espresso Machines, Vitamin C Serums, Trail Running Shoes).',
    },
    identifiedBrandName: {
      type: Type.STRING,
      description:
        'Brand name ONLY if visibly printed on the product/packaging or 100% confidently identifiable. If not visible or uncertain, output "Unknown". Never invent or guess a brand name.',
    },
    identifiedModelOrVariant: {
      type: Type.STRING,
      description:
        'Visible model name, variant, size, or volume ONLY if visible in the image or confidently identifiable. If not visible or uncertain, output "Unknown". Never invent model numbers.',
    },
    visiblePriceOrOffer: {
      type: Type.STRING,
      description:
        'Price or promotional offer ONLY if explicitly printed and readable in the image. Otherwise output "" (empty string). Never guess or invent a price.',
    },
    visiblePackagingTextAndLogos: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        'Exact packaging text, label copy, badges, and logo marks visibly readable on the product or packaging. Output an empty array [] if no text or logo is readable.',
    },
    identificationConfidence: {
      type: Type.STRING,
      description: 'One of: "high", "medium", or "low" reflecting how clearly the product and its markings are visible.',
    },
    uncertaintyNotes: {
      type: Type.STRING,
      description:
        'Honest note explaining any unreadable labels, occluded areas, or uncertain identification details (or confirming clear visibility).',
    },
    suggestedVisualDirection: {
      type: Type.STRING,
      description:
        'Suggested commercial lighting, camera movement, and 9:16 visual marketing direction grounded in the observed product.',
    },
    productSummary: {
      type: Type.STRING,
      description: '2-3 sentence positioning summary describing visual appearance, craftsmanship, and core value proposition.',
    },
    dominantColors: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: 'Descriptive color name (e.g., Matte Obsidian, Brushed Brass).' },
          hex: { type: Type.STRING, description: '6-digit hex color code starting with # (e.g., #181A1F).' },
          usageRole: { type: Type.STRING, description: 'Where this color appears on the product or scene.' },
        },
        required: ['name', 'hex', 'usageRole'],
      },
    },
    materialsAndTextures: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Visible surface materials, finishes, and tactile textures.',
    },
    estimatedDimensions: {
      type: Type.STRING,
      description: 'Estimated form factor, scale, or packaging proportions based on visual cues (or "Unknown" if unclear).',
    },
    detectedFeatures: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Distinct physical features, components, or design details visibly observable on the product.',
    },
    keySellingPoints: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          headline: { type: Type.STRING, description: 'Punchy benefit-first headline for short-form video.' },
          proofPoint: { type: Type.STRING, description: 'Concrete visual or material evidence supporting the claim.' },
          emotionalHook: { type: Type.STRING, description: 'Why the target audience cares emotionally or practically.' },
        },
        required: ['headline', 'proofPoint', 'emotionalHook'],
      },
    },
    brandVoiceGuidelines: {
      type: Type.OBJECT,
      properties: {
        toneDescriptors: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '3-5 adjectives defining the recommended brand voice.',
        },
        wordsToUse: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Power words and vocabulary aligned with the product.',
        },
        wordsToAvoid: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Off-brand clichés or exaggerated claims to avoid.',
        },
        targetPersonaSummary: {
          type: Type.STRING,
          description:
            'Likely target audience persona inferred from the product, prefixed with "Inferred: " to clearly mark it as an inference.',
        },
      },
      required: ['toneDescriptors', 'wordsToUse', 'wordsToAvoid', 'targetPersonaSummary'],
    },
    recommendedAdAngles: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          angleName: { type: Type.STRING, description: 'Name of the creative marketing angle.' },
          targetPlatform: {
            type: Type.STRING,
            description: 'One of: Instagram Reels, Instagram Stories, or YouTube Shorts.',
          },
          hookIdea: {
            type: Type.STRING,
            description: 'Opening 3-second visual and verbal hook.',
          },
          visualDirection: {
            type: Type.STRING,
            description: 'Camera movement, lighting, and shot composition guidance for 9:16 vertical video.',
          },
        },
        required: ['angleName', 'targetPlatform', 'hookIdea', 'visualDirection'],
      },
    },
    visualFidelityConstraints: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Strict visual guardrails to preserve product geometry, label legibility, and color accuracy during video generation.',
    },
  },
  required: [
    'detectedProductName',
    'category',
    'subcategory',
    'identifiedBrandName',
    'identifiedModelOrVariant',
    'visiblePriceOrOffer',
    'visiblePackagingTextAndLogos',
    'identificationConfidence',
    'uncertaintyNotes',
    'suggestedVisualDirection',
    'productSummary',
    'dominantColors',
    'materialsAndTextures',
    'estimatedDimensions',
    'detectedFeatures',
    'keySellingPoints',
    'brandVoiceGuidelines',
    'recommendedAdAngles',
    'visualFidelityConstraints',
  ],
};

const STORYBOARD_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    conceptTitle: {
      type: Type.STRING,
      description: 'Compelling commercial title for this 9:16 video ad concept.',
    },
    openingHook3s: {
      type: Type.STRING,
      description: 'Punchy first 3-second verbal and visual hook designed to stop scrolling.',
    },
    fullVoiceoverScript: {
      type: Type.STRING,
      description: 'Complete spoken voiceover script (35-65 words, natural spoken cadence, no stage directions in brackets).',
    },
    brandSafetyVerification: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '3-4 bullet checks confirming truthful claims, brand voice compliance, and visual product fidelity.',
    },
    masterCinematicPrompt9x16: {
      type: Type.STRING,
      description: 'Comprehensive 9:16 vertical video generation prompt describing lighting, camera motion, surface textures, and exact product preservation.',
    },
    musicDirectionPrompt: {
      type: Type.STRING,
      description: 'Instrumental background music direction specifying tempo (BPM), instrumentation, mood, and mix ducking under voiceover.',
    },
    shots: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          shotNumber: { type: Type.INTEGER, description: 'Sequential shot number starting at 1.' },
          durationSeconds: { type: Type.INTEGER, description: 'Duration of this shot in seconds (typically 3 to 5 seconds).' },
          shotType: {
            type: Type.STRING,
            description: 'Shot framing type (e.g., 01. Macro Hero Hook, 02. Tactile Material Detail, 03. Feature in Action, 04. Brand Call-to-Action).',
          },
          sceneDescription: {
            type: Type.STRING,
            description: 'Clear description of what happens visually in this 9:16 vertical frame.',
          },
          cameraMovement: {
            type: Type.STRING,
            description: 'Precise camera motion (e.g., Slow push-in macro gimbal, orbital pan, crisp rack focus).',
          },
          visualPrompt9x16: {
            type: Type.STRING,
            description: 'Self-contained 9:16 image-to-video prompt for this shot preserving exact product colors, materials, and silhouette.',
          },
          onScreenTextOverlay: {
            type: Type.STRING,
            description: 'Short, punchy subtitle or text overlay displayed in the safe zone during this shot.',
          },
          spokenVoiceoverSegment: {
            type: Type.STRING,
            description: 'Portion of the spoken voiceover script delivered during this shot.',
          },
          productFidelityNote: {
            type: Type.STRING,
            description: 'Specific instruction ensuring product geometry, label, and color palette remain undistorted.',
          },
        },
        required: [
          'shotNumber',
          'durationSeconds',
          'shotType',
          'sceneDescription',
          'cameraMovement',
          'visualPrompt9x16',
          'onScreenTextOverlay',
          'spokenVoiceoverSegment',
          'productFidelityNote',
        ],
      },
    },
  },
  required: [
    'conceptTitle',
    'openingHook3s',
    'fullVoiceoverScript',
    'brandSafetyVerification',
    'masterCinematicPrompt9x16',
    'musicDirectionPrompt',
    'shots',
  ],
};

function parseDataUrl(dataUrl: string): { mimeType: string; base64Data: string } {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i);
  if (!match) {
    throw new Error('Invalid image format. Please upload a valid PNG, JPEG, or WEBP image.');
  }
  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  return { mimeType, base64Data: match[2] };
}

export async function createAppServer() {
  ensureDataStore();
  const app = express();

  app.use(express.json({ limit: '25mb' }));

  // Serve generated WAV voiceovers and audio files with byte-range support
  app.get('/api/audio/:filename', (req: Request, res: Response) => {
    const rawName = path.basename(String(req.params.filename || ''));
    if (!rawName || !/^[a-zA-Z0-9_.-]+\.(wav|mp3)$/i.test(rawName)) {
      res.status(400).json({ error: 'Invalid audio filename.' });
      return;
    }
    const filePath = path.join(AUDIO_DIR, rawName);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Audio file not found.' });
      return;
    }
    const ext = path.extname(rawName).toLowerCase();
    const contentType = ext === '.mp3' ? 'audio/mpeg' : 'audio/wav';
    const stat = fs.statSync(filePath);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(filePath).pipe(res);
  });

  // 1. Live Gemini Model & API Readiness Verification Endpoint
  app.get('/api/system/verify-models', async (_req: Request, res: Response) => {
    const apiKeyConfigured = Boolean(process.env.GEMINI_API_KEY);
    const candidateModels: Array<{
      modelId: string;
      role: string;
      milestone: string;
      requiresPaidKey: boolean;
      supportedAlternative: string;
      testType: 'generateContent' | 'tts' | 'paid_music' | 'paid_video';
    }> = [
      {
        modelId: 'gemini-3.1-flash-lite',
        role: 'Verified Active Multimodal Vision, Storyboard & Structured JSON Engine',
        milestone: 'Milestone 1, 2 & 4',
        requiresPaidKey: false,
        supportedAlternative: 'gemini-3.8-flash / gemini-flash-latest',
        testType: 'generateContent',
      },
      {
        modelId: 'gemini-3.8-flash',
        role: 'Primary Multimodal Product Vision, Storyboard & 6-Point SEO Rubric Evaluator',
        milestone: 'Milestone 1, 2 & 4',
        requiresPaidKey: false,
        supportedAlternative: 'gemini-3.1-flash-lite (automatic server-side fallback when 503 high demand occurs)',
        testType: 'generateContent',
      },
      {
        modelId: 'gemini-3.8-flash-lite-tts',
        role: 'AI Voiceover Synthesis (24kHz Mono 16-bit WAV Audio — Kore, Puck, Charon, Fenrir, Zephyr)',
        milestone: 'Milestone 2',
        requiresPaidKey: false,
        supportedAlternative: 'gemini-3.8-flash-tts',
        testType: 'tts',
      },
      {
        modelId: 'lyria-3-clip-preview',
        role: 'AI Background Music Clip Generation (30s Instrumental Audio)',
        milestone: 'Milestone 2',
        requiresPaidKey: true,
        supportedAlternative: 'Optional Custom Audio Upload (.mp3/.wav) or Voiceover-Only Mode (no fake music claims)',
        testType: 'paid_music',
      },
      {
        modelId: 'gemini-omni-1.1-flash',
        role: 'Native 9:16 Image-to-Video Generation & Multi-Turn Editing (Interactions API)',
        milestone: 'Milestone 3',
        requiresPaidKey: true,
        supportedAlternative: 'Server-side FFmpeg 9:16 Dynamic Motion-Canvas Compositor (renders real .mp4 without paid tier)',
        testType: 'paid_video',
      },
    ];

    if (!apiKeyConfigured) {
      const report: ModelVerificationReport = {
        checkedAt: new Date().toISOString(),
        apiKeyConfigured: false,
        recommendedVisionModel: 'gemini-3.1-flash-lite',
        recommendedTtsModel: 'gemini-3.8-flash-lite-tts',
        models: candidateModels.map((m) => ({
          modelId: m.modelId,
          role: m.role,
          milestone: m.milestone,
          requiresPaidKey: m.requiresPaidKey,
          status: 'unavailable',
          latencyMs: null,
          detailMessage: 'GEMINI_API_KEY is not present in the server environment.',
          supportedAlternative: m.supportedAlternative,
        })),
      };
      res.json(report);
      return;
    }

    const ai = getGenAIClient(12000);
    const results: ModelProbeEntry[] = [];
    let recommendedVisionModel = '';
    let recommendedTtsModel = 'gemini-3.8-flash-lite-tts';

    for (const candidate of candidateModels) {
      const start = Date.now();
      if (candidate.testType === 'paid_video') {
        results.push({
          modelId: candidate.modelId,
          role: candidate.role,
          milestone: candidate.milestone,
          requiresPaidKey: true,
          status: 'paid_tier_required',
          latencyMs: null,
          detailMessage:
            'Requires a billing-enabled Gemini API key via the Interactions API (ai.interactions.create). Paired with FFmpeg 9:16 compositor in Milestone 3.',
          supportedAlternative: candidate.supportedAlternative,
        });
        continue;
      }

      if (candidate.testType === 'paid_music') {
        results.push({
          modelId: candidate.modelId,
          role: candidate.role,
          milestone: candidate.milestone,
          requiresPaidKey: true,
          status: 'paid_tier_required',
          latencyMs: null,
          detailMessage:
            'Lyria music generation (lyria-3-clip-preview) requires a billing-enabled Gemini API key. You can test live Lyria generation in Milestone 2 or use custom audio / voiceover-only mode.',
          supportedAlternative: candidate.supportedAlternative,
        });
        continue;
      }

      try {
        if (candidate.testType === 'generateContent') {
          await ai.models.generateContent({
            model: candidate.modelId,
            contents: 'Reply with OK',
          });
          const latencyMs = Date.now() - start;
          if (!recommendedVisionModel) {
            recommendedVisionModel = candidate.modelId;
          }
          results.push({
            modelId: candidate.modelId,
            role: candidate.role,
            milestone: candidate.milestone,
            requiresPaidKey: candidate.requiresPaidKey,
            status: 'available',
            latencyMs,
            detailMessage: `Verified live on your API key (${latencyMs} ms response).`,
            supportedAlternative: candidate.supportedAlternative,
          });
        } else if (candidate.testType === 'tts') {
          await ai.models.generateContent({
            model: candidate.modelId,
            contents: [{ role: 'user', parts: [{ text: 'Ready.' }] }],
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: 'Kore' },
                },
              },
            },
          });
          const latencyMs = Date.now() - start;
          recommendedTtsModel = candidate.modelId;
          results.push({
            modelId: candidate.modelId,
            role: candidate.role,
            milestone: candidate.milestone,
            requiresPaidKey: candidate.requiresPaidKey,
            status: 'available',
            latencyMs,
            detailMessage: `Verified live 24kHz WAV audio synthesis (${latencyMs} ms response).`,
            supportedAlternative: candidate.supportedAlternative,
          });
        }
      } catch (err: unknown) {
        const latencyMs = Date.now() - start;
        const rawMsg = err instanceof Error ? err.message : String(err);
        const isQuotaOrPaid =
          rawMsg.includes('429') ||
          rawMsg.includes('RESOURCE_EXHAUSTED') ||
          rawMsg.includes('billing');
        results.push({
          modelId: candidate.modelId,
          role: candidate.role,
          milestone: candidate.milestone,
          requiresPaidKey: candidate.requiresPaidKey,
          status: isQuotaOrPaid ? 'paid_tier_required' : 'fallback_available',
          latencyMs,
          detailMessage: `Model returned: ${rawMsg.slice(0, 140)}. Automatic fallback is active.`,
          supportedAlternative: candidate.supportedAlternative,
        });
      }
    }

    const verifiedGenModels = results
      .filter((r) => r.status === 'available' && (r.modelId === PRIMARY_STORYBOARD_MODEL || r.modelId === VERIFIED_FALLBACK_STORYBOARD_MODEL))
      .map((r) => r.modelId);
    if (verifiedGenModels.length > 0) {
      setVerifiedAvailableModels(verifiedGenModels);
    }

    const report: ModelVerificationReport = {
      checkedAt: new Date().toISOString(),
      apiKeyConfigured: true,
      recommendedVisionModel: recommendedVisionModel || VERIFIED_FALLBACK_STORYBOARD_MODEL,
      recommendedTtsModel,
      models: results,
    };

    res.json(report);
  });

  // 2. List Saved Campaigns
  app.get('/api/campaigns', (_req: Request, res: Response) => {
    const campaigns = readCampaigns();
    res.json({ campaigns });
  });

  // 3. Analyze Product Image & Brand Details (Milestone 1 Core Pipeline)
  app.post('/api/campaigns/analyze', async (req: Request, res: Response) => {
    try {
      const {
        title = '',
        price = '',
        brandName = '',
        modelOrVariant = '',
        visiblePackagingText = '',
        brandVoice = '',
        targetAudience = '',
        visualStyle = '',
        imageDataUrl = '',
      } = req.body ?? {};

      if (!imageDataUrl || typeof imageDataUrl !== 'string') {
        res.status(400).json({ error: 'A valid product image is required for multimodal analysis.' });
        return;
      }

      const { mimeType, base64Data } = parseDataUrl(imageDataUrl);
      const ai = getGenAIClient();

      const promptText = `Analyze this uploaded product image using strict visual evidence to extract accurate product identification and metadata for 9:16 vertical social video ads (Instagram Reels, Instagram Stories, and YouTube Shorts).

Optional User-Supplied Hints (use only if provided below; otherwise rely strictly on the image):
- User Product Title Hint: ${title.trim() || 'None provided — identify from image'}
- User Price / Offer Hint: ${price.trim() || 'None provided — leave visiblePriceOrOffer empty ("") unless a price is literally visible in the image'}
- User Brand Name Hint: ${brandName.trim() || 'None provided — extract ONLY if visible or confidently identifiable; otherwise output "Unknown"'}
- User Model / Variant Hint: ${modelOrVariant.trim() || 'None provided — extract ONLY if visible or confidently identifiable; otherwise output "Unknown"'}
- User Brand Voice Preference: ${brandVoice.trim() || 'None provided — infer best-fit commercial tone from the product'}
- User Target Audience Hint: ${targetAudience.trim() || 'None provided — infer likely target audience and prefix with "Inferred: "'}
- User Visual Direction Hint: ${visualStyle.trim() || 'None provided — suggest lighting, camera movement, and marketing angle based on the observed product'}

Strict Non-Fabrication & Extraction Rules:
1. Product Name & Category: Identify the specific product name (detectedProductName), primary category, and subcategory supported by the image.
2. Brand Name (identifiedBrandName): Extract the brand name ONLY if visibly printed on the product/packaging or 100% confidently identifiable. If not visible or uncertain, set identifiedBrandName to "Unknown". Do NOT invent or guess a brand name.
3. Visible Model or Variant (identifiedModelOrVariant): Extract the exact model, variant, size, or volume ONLY if visible or confidently identifiable. Otherwise set identifiedModelOrVariant to "Unknown".
4. Visible Packaging Text, Label & Logo (visiblePackagingTextAndLogos): Transcribe any readable packaging text, label copy, and visible logo marks verbatim. If no text or logo is visible or readable, return an empty array [].
5. Price / Offer (visiblePriceOrOffer): Keep empty ("") unless a price or promotional offer is explicitly printed in the image. Never invent a price.
6. Observable Features & Attributes: Extract dominant colors (with 6-digit hex codes), visible materials/textures, and physical features directly observable in the photo.
7. Likely Target Audience (brandVoiceGuidelines.targetPersonaSummary): Infer the most likely buyer persona and clearly mark it as an inference by starting with "Inferred: ".
8. Suggested Marketing Angle & Visual Direction: Provide suggestedVisualDirection and 3 platform-specific recommendedAdAngles grounded in the observed product.`;

      const execution = await executeWithVerifiedModelFallback(
        async (candidateModel) => {
          const response = await ai.models.generateContent({
            model: candidateModel,
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType,
                    data: base64Data,
                  },
                },
                {
                  text: promptText,
                },
              ],
            },
            config: {
              systemInstruction:
                'You are an accurate multimodal product analyst and creative director for AI Ad Studio. Always output strictly valid JSON adhering to PRODUCT_PROFILE_SCHEMA. Never fabricate brand names, model numbers, packaging text, or prices. If brand or model is not visible, output "Unknown". If price is not visible, output "". Always prefix inferred target audience with "Inferred: ".',
              responseMimeType: 'application/json',
              responseSchema: PRODUCT_PROFILE_SCHEMA,
            },
          });

          if (!response || !response.text) {
            throw new Error(`Model ${candidateModel} returned an empty analysis response.`);
          }

          let rawParsed: unknown;
          try {
            rawParsed = JSON.parse(response.text.trim());
          } catch {
            throw new Error(`Model ${candidateModel} returned malformed JSON during product identification.`);
          }

          const validation = validateAndNormalizeProductProfile(rawParsed);
          if (!validation.valid || !validation.profile) {
            throw new Error(validation.error || 'Failed to validate extracted product profile.');
          }

          return validation.profile;
        },
        {
          primaryModel: getPreferredStoryboardModel(),
          maxRetriesPerModel: 2,
          baseDelayMs: 250,
          maxDelayMs: 1200,
        }
      );

      const parsedProfile = execution.result;
      const {
        requestedModel,
        resolvedModel,
        fallbackUsed,
        fallbackReason,
        latencyMs,
      } = execution;
      const now = new Date().toISOString();
      const inferredVoice =
        parsedProfile.brandVoiceGuidelines.toneDescriptors.slice(0, 2).join(' & ') ||
        'Modern Commercial';

      const finalBrandName = brandName.trim()
        ? brandName.trim()
        : normalizeBrandOrModelField(parsedProfile.identifiedBrandName);

      const finalModelOrVariant = modelOrVariant.trim()
        ? modelOrVariant.trim()
        : normalizeBrandOrModelField(parsedProfile.identifiedModelOrVariant);

      const finalPrice = price.trim()
        ? price.trim()
        : normalizeVisiblePriceField(parsedProfile.visiblePriceOrOffer);

      const finalPackagingText = visiblePackagingText.trim()
        ? visiblePackagingText.trim()
        : parsedProfile.visiblePackagingTextAndLogos &&
          parsedProfile.visiblePackagingTextAndLogos.length > 0
        ? parsedProfile.visiblePackagingTextAndLogos.join(' · ')
        : 'Unknown';

      const finalTargetAudience = targetAudience.trim()
        ? targetAudience.trim()
        : formatInferredTargetAudience(parsedProfile.brandVoiceGuidelines.targetPersonaSummary);

      const finalVisualStyle = visualStyle.trim()
        ? visualStyle.trim()
        : parsedProfile.suggestedVisualDirection ||
          'Clean commercial studio lighting with crisp focus on observed product features';

      const newCampaign: Campaign = {
        id: `cmp_${crypto.randomUUID().slice(0, 8)}`,
        title: title.trim() || parsedProfile.detectedProductName,
        price: finalPrice,
        brandName: finalBrandName,
        modelOrVariant: finalModelOrVariant,
        visiblePackagingText: finalPackagingText,
        brandVoice: brandVoice.trim() || inferredVoice,
        targetAudience: finalTargetAudience,
        visualStyle: finalVisualStyle,
        imageDataUrl,
        productProfile: parsedProfile,
        analysisMetadata: {
          requestedModel,
          resolvedModel,
          fallbackUsed,
          fallbackReason,
          latencyMs,
          analyzedAt: now,
        },
        status: 'analyzed',
        createdAt: now,
        updatedAt: now,
      };

      const campaigns = readCampaigns();
      campaigns.unshift(newCampaign);
      writeCampaigns(campaigns);

      res.status(201).json({ campaign: newCampaign });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unexpected server error during product analysis.';
      console.error('Error in POST /api/campaigns/analyze:', message);
      res.status(500).json({ error: message });
    }
  });

  // 4. Update an Analyzed Campaign & Structured Product Profile (Visual or JSON edits)
  app.put('/api/campaigns/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const campaigns = readCampaigns();
      const index = campaigns.findIndex((c) => c.id === id);
      if (index === -1) {
        res.status(404).json({ error: 'Campaign not found.' });
        return;
      }

      const existing = campaigns[index];
      const {
        title,
        price,
        brandName,
        modelOrVariant,
        visiblePackagingText,
        brandVoice,
        targetAudience,
        visualStyle,
        productProfile,
      } = req.body ?? {};

      const updated: Campaign = {
        ...existing,
        title: typeof title === 'string' ? title : existing.title,
        price: typeof price === 'string' ? price : existing.price,
        brandName: typeof brandName === 'string' ? brandName : existing.brandName,
        modelOrVariant:
          typeof modelOrVariant === 'string' ? modelOrVariant : existing.modelOrVariant,
        visiblePackagingText:
          typeof visiblePackagingText === 'string'
            ? visiblePackagingText
            : existing.visiblePackagingText,
        brandVoice: typeof brandVoice === 'string' ? brandVoice : existing.brandVoice,
        targetAudience: typeof targetAudience === 'string' ? targetAudience : existing.targetAudience,
        visualStyle: typeof visualStyle === 'string' ? visualStyle : existing.visualStyle,
        productProfile: productProfile && typeof productProfile === 'object' ? productProfile : existing.productProfile,
        updatedAt: new Date().toISOString(),
      };

      campaigns[index] = updated;
      writeCampaigns(campaigns);

      res.json({ campaign: updated });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to update campaign.';
      res.status(500).json({ error: message });
    }
  });

  // 5. MILESTONE 2: Generate Brand-Safe Video Concept, Script & 9:16 Shot-by-Shot Storyboard
  app.post('/api/campaigns/:id/storyboard', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const campaigns = readCampaigns();
      const index = campaigns.findIndex((c) => c.id === id);
      if (index === -1) {
        res.status(404).json({ error: 'Campaign not found. Please analyze a product first.' });
        return;
      }

      const existingCampaign = campaigns[index];
      const {
        targetPlatformFormat = 'Instagram Reels (9:16)',
        desiredDurationSeconds = 15,
        creativeAngleHint = '',
        title,
        price,
        brandName,
        modelOrVariant,
        visiblePackagingText,
        brandVoice,
        targetAudience,
        visualStyle,
        productProfile,
      } = req.body ?? {};

      // Preserve any user-edited profile and campaign metadata passed from the studio
      let activeProfile = existingCampaign.productProfile;
      if (productProfile && typeof productProfile === 'object') {
        const profileValidation = validateAndNormalizeProductProfile(productProfile);
        if (profileValidation.valid && profileValidation.profile) {
          activeProfile = profileValidation.profile;
        }
      }

      const campaign: Campaign = {
        ...existingCampaign,
        title: typeof title === 'string' && title.trim() ? title.trim() : existingCampaign.title,
        price: typeof price === 'string' ? price.trim() : existingCampaign.price,
        brandName:
          typeof brandName === 'string' && brandName.trim()
            ? brandName.trim()
            : existingCampaign.brandName,
        modelOrVariant:
          typeof modelOrVariant === 'string' && modelOrVariant.trim()
            ? modelOrVariant.trim()
            : existingCampaign.modelOrVariant,
        visiblePackagingText:
          typeof visiblePackagingText === 'string' && visiblePackagingText.trim()
            ? visiblePackagingText.trim()
            : existingCampaign.visiblePackagingText,
        brandVoice:
          typeof brandVoice === 'string' && brandVoice.trim()
            ? brandVoice.trim()
            : existingCampaign.brandVoice,
        targetAudience:
          typeof targetAudience === 'string' && targetAudience.trim()
            ? targetAudience.trim()
            : existingCampaign.targetAudience,
        visualStyle:
          typeof visualStyle === 'string' && visualStyle.trim()
            ? visualStyle.trim()
            : existingCampaign.visualStyle,
        productProfile: activeProfile,
      };

      const validFormats = [
        'Instagram Reels (9:16)',
        'Instagram Stories (9:16)',
        'YouTube Shorts (9:16)',
      ] as const;
      const chosenFormat = validFormats.includes(targetPlatformFormat)
        ? targetPlatformFormat
        : 'Instagram Reels (9:16)';

      const targetSec = Math.max(10, Math.min(30, Number(desiredDurationSeconds) || 15));
      const ai = getGenAIClient();

      const prompt = `Create a brand-safe vertical 9:16 video ad concept, spoken voiceover script, and shot-by-shot storyboard for the following analyzed product campaign.

Campaign & Brand Context:
- Product Title: ${campaign.title}
- Brand Name: ${campaign.brandName}
- Price / Offer: ${campaign.price || 'Not specified — do not invent a price'}
- Brand Voice: ${campaign.brandVoice}
- Target Audience: ${campaign.targetAudience}
- Visual Aesthetic: ${campaign.visualStyle}
- Target Platform Format: ${chosenFormat}
- Target Total Duration: ~${targetSec} seconds (create 4 to 5 timed shots whose durations sum to approximately ${targetSec} seconds)
- Creative Angle Preference: ${creativeAngleHint || 'Use strongest product selling point'}

Structured Product Profile (Ground Truth):
${JSON.stringify(campaign.productProfile, null, 2)}

Strict Requirements:
1. Preserve 100% product accuracy: reference the exact dominant colors (${campaign.productProfile.dominantColors.map((c) => `${c.name} ${c.hex}`).join(', ')}), materials (${campaign.productProfile.materialsAndTextures.join(', ')}), and visual fidelity constraints.
2. Write a punchy 3-second opening hook and a natural, high-converting spoken voiceover script (${Math.round(targetSec * 2.4)} to ${Math.round(targetSec * 2.8)} words total, plain spoken text only—no bracketed stage directions inside fullVoiceoverScript).
3. Ensure every shot's spokenVoiceoverSegment combines seamlessly into the fullVoiceoverScript.
4. Provide a detailed 9:16 vertical visualPrompt9x16 for each shot that keeps the product undistorted and centered in the vertical safe zone.`;

      const preferredPrimaryModel = getPreferredStoryboardModel();
      const fallbackModel =
        preferredPrimaryModel === PRIMARY_STORYBOARD_MODEL
          ? VERIFIED_FALLBACK_STORYBOARD_MODEL
          : PRIMARY_STORYBOARD_MODEL;

      const execution = await executeWithVerifiedModelFallback(
        async (candidateModel) => {
          const response = await ai.models.generateContent({
            model: candidateModel,
            contents: prompt,
            config: {
              systemInstruction:
                'You are an executive short-form video director and scriptwriter. Output strictly valid JSON conforming to STORYBOARD_SCHEMA. Never fabricate unverified claims.',
              responseMimeType: 'application/json',
              responseSchema: STORYBOARD_SCHEMA,
            },
          });

          if (!response || !response.text) {
            throw new Error(`Model ${candidateModel} returned an empty storyboard response.`);
          }

          return response.text;
        },
        {
          primaryModel: preferredPrimaryModel,
          verifiedFallbackModels: [fallbackModel],
          maxRetriesPerModel: 2,
          baseDelayMs: 250,
          maxDelayMs: 1200,
        }
      );

      const storyboard = parseAndValidateGeneratedStoryboard(execution.result, chosenFormat, {
        requestedModel: execution.requestedModel,
        resolvedModel: execution.resolvedModel,
        fallbackUsed: execution.fallbackUsed,
        fallbackReason: execution.fallbackReason,
        latencyMs: execution.latencyMs,
        generatedAt: new Date().toISOString(),
      });

      const updatedCampaign: Campaign = {
        ...campaign,
        storyboard,
        status: campaign.voiceover ? 'audio_ready' : 'storyboard_ready',
        updatedAt: new Date().toISOString(),
      };

      campaigns[index] = updatedCampaign;
      writeCampaigns(campaigns);

      res.status(201).json({ campaign: updatedCampaign });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to generate storyboard.';
      const statusCode = error instanceof AllModelsFailedError ? 503 : 500;
      console.error('Error in POST /api/campaigns/:id/storyboard:', message);
      res.status(statusCode).json({
        error: message,
        ...(error instanceof AllModelsFailedError ? { attempts: error.attempts } : {}),
      });
    }
  });

  // 6. MILESTONE 2: Save User Edits to Script & Storyboard Before Audio Generation
  app.put('/api/campaigns/:id/storyboard', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const campaigns = readCampaigns();
      const index = campaigns.findIndex((c) => c.id === id);
      if (index === -1) {
        res.status(404).json({ error: 'Campaign not found.' });
        return;
      }

      const existing = campaigns[index];
      const validation = validateStoryboardUpdate(
        req.body?.storyboard ?? req.body,
        existing.storyboard?.generationMetadata
      );

      if (!validation.valid || !validation.storyboard) {
        res.status(400).json({ error: validation.error || 'Invalid storyboard data.' });
        return;
      }

      const updatedCampaign: Campaign = {
        ...existing,
        storyboard: validation.storyboard,
        status: existing.voiceover ? 'audio_ready' : 'storyboard_ready',
        updatedAt: new Date().toISOString(),
      };

      campaigns[index] = updatedCampaign;
      writeCampaigns(campaigns);

      res.json({ campaign: updatedCampaign });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to update storyboard.';
      res.status(500).json({ error: message });
    }
  });

  // 7. MILESTONE 2: Generate Real AI Voiceover WAV File (gemini-3.8-flash-lite-tts)
  app.post('/api/campaigns/:id/voiceover', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const campaigns = readCampaigns();
      const index = campaigns.findIndex((c) => c.id === id);
      if (index === -1) {
        res.status(404).json({ error: 'Campaign not found.' });
        return;
      }

      const validation = validateVoiceoverRequest(req.body);
      if (!validation.valid || !validation.voiceName || !validation.scriptText) {
        res.status(400).json({ error: validation.error || 'Invalid voiceover parameters.' });
        return;
      }

      const { voiceName, voiceStyle = 'Confident commercial narrator', scriptText } = validation;
      const ai = getGenAIClient();

      const ttsExecution = await executeWithVerifiedModelFallback(
        async (candidateModel) => {
          const ttsResponse = await ai.models.generateContent({
            model: candidateModel,
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: scriptText,
                    speechMetadata: {
                      style: voiceStyle,
                    },
                  },
                ],
              },
            ],
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName,
                  },
                },
              },
            },
          });

          const candidatePart = ttsResponse.candidates?.[0]?.content?.parts?.find(
            (p) => p.inlineData?.data
          );
          if (!candidatePart?.inlineData?.data) {
            throw new Error(`Model ${candidateModel} did not return audio data.`);
          }
          return candidatePart.inlineData.data;
        },
        {
          primaryModel: PRIMARY_TTS_MODEL,
          verifiedFallbackModels: [FALLBACK_TTS_MODEL],
          supportedTaskModels: SUPPORTED_TTS_TASK_MODELS,
          maxRetriesPerModel: 1,
          baseDelayMs: 250,
          maxDelayMs: 1000,
        }
      );

      const base64Audio = ttsExecution.result;
      const resolvedModel = ttsExecution.resolvedModel;
      const latencyMs = ttsExecution.latencyMs;

      const rawBuffer = Buffer.from(base64Audio, 'base64');
      const wavBuffer = ensureValidWavBuffer(rawBuffer, 24000, 1, 16);
      const wavFormatVerification = verifyWavFormat24kMono16Bit(wavBuffer);
      if (!wavFormatVerification.valid) {
        throw new Error(
          wavFormatVerification.error || 'Generated WAV failed 24kHz 16-bit mono verification.'
        );
      }

      const durationEstimateSeconds = estimateWavDurationSeconds(wavBuffer, 24000);

      const filename = `vo_${id}_${Date.now()}.wav`;
      const filePath = path.join(AUDIO_DIR, filename);
      fs.writeFileSync(filePath, wavBuffer);

      const voiceoverAsset: VoiceoverAudioAsset = {
        id: `vo_${crypto.randomUUID().slice(0, 8)}`,
        voiceName,
        voiceStyle,
        scriptTextUsed: scriptText,
        audioFileUrl: `/api/audio/${filename}`,
        mimeType: 'audio/wav',
        byteLength: wavBuffer.length,
        sampleRateHz: 24000,
        durationEstimateSeconds,
        resolvedModel,
        latencyMs,
        generatedAt: new Date().toISOString(),
      };

      const existing = campaigns[index];
      let preservedStoryboard = existing.storyboard;
      if (req.body?.storyboard && typeof req.body.storyboard === 'object') {
        const sbValidation = validateStoryboardUpdate(
          req.body.storyboard,
          existing.storyboard?.generationMetadata
        );
        if (sbValidation.valid && sbValidation.storyboard) {
          preservedStoryboard = sbValidation.storyboard;
        }
      }

      const updatedCampaign: Campaign = {
        ...existing,
        storyboard: preservedStoryboard,
        voiceover: voiceoverAsset,
        backgroundMusic: existing.backgroundMusic || {
          status: 'not_requested',
          statusMessage:
            'No background music generated yet. Lyria (lyria-3-clip-preview) requires a paid API key, or you can upload a custom royalty-free track.',
          updatedAt: new Date().toISOString(),
        },
        status: 'audio_ready',
        updatedAt: new Date().toISOString(),
      };

      campaigns[index] = updatedCampaign;
      writeCampaigns(campaigns);

      res.status(201).json({ campaign: updatedCampaign, voiceover: voiceoverAsset });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to generate AI voiceover.';
      console.error('Error in POST /api/campaigns/:id/voiceover:', message);
      res.status(500).json({ error: message });
    }
  });

  // 8. MILESTONE 2: Background Music Handler (Lyria Probe or Honest Optional Placeholder / Custom Upload)
  app.post('/api/campaigns/:id/music', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const campaigns = readCampaigns();
      const index = campaigns.findIndex((c) => c.id === id);
      if (index === -1) {
        res.status(404).json({ error: 'Campaign not found.' });
        return;
      }

      const existing = campaigns[index];
      const {
        mode = 'lyria',
        musicPrompt = existing.storyboard?.musicDirectionPrompt ||
          'Generate a 15-second modern commercial instrumental track.',
        customAudioDataUrl = '',
      } = req.body ?? {};

      const now = new Date().toISOString();

      // Option A: Clear / Set Voiceover-Only Optional Placeholder State
      if (mode === 'placeholder') {
        const built = buildAndValidateMusicState({
          mode: 'placeholder',
          musicPrompt: String(musicPrompt),
          nowIso: now,
        });
        if (!built.valid || !built.musicState) {
          res.status(400).json({ error: built.error || 'Invalid music state.' });
          return;
        }
        const updated: Campaign = {
          ...existing,
          backgroundMusic: built.musicState,
          updatedAt: now,
        };
        campaigns[index] = updated;
        writeCampaigns(campaigns);
        res.json({ campaign: updated });
        return;
      }

      // Option B: User uploaded a custom royalty-free MP3/WAV track
      if (mode === 'upload') {
        const built = buildAndValidateMusicState({
          mode: 'upload',
          musicPrompt: String(musicPrompt),
          customAudioDataUrl: String(customAudioDataUrl),
          nowIso: now,
        });
        if (!built.valid || !built.musicState || !built.parsedUpload) {
          res.status(400).json({
            error: built.error || 'Invalid audio file. Please upload a valid MP3 or WAV file.',
          });
          return;
        }

        const filename = `bgm_${id}_${Date.now()}.${built.parsedUpload.ext}`;
        fs.writeFileSync(path.join(AUDIO_DIR, filename), built.parsedUpload.buffer);

        const musicState: BackgroundMusicState = {
          ...built.musicState,
          audioFileUrl: `/api/audio/${filename}`,
        };
        const updated: Campaign = { ...existing, backgroundMusic: musicState, updatedAt: now };
        campaigns[index] = updated;
        writeCampaigns(campaigns);
        res.json({ campaign: updated });
        return;
      }

      // Option C: Attempt live Lyria generation (`lyria-3-clip-preview`)
      const ai = getGenAIClient(25000);
      try {
        const stream = await ai.models.generateContentStream({
          model: 'lyria-3-clip-preview',
          contents: String(musicPrompt),
        });

        const audioChunks: Buffer[] = [];
        let mimeType = 'audio/mpeg';

        for await (const chunk of stream) {
          const parts = chunk.candidates?.[0]?.content?.parts;
          if (!parts) continue;
          for (const part of parts) {
            if (part.inlineData?.data) {
              if (audioChunks.length === 0 && part.inlineData.mimeType) {
                mimeType = part.inlineData.mimeType;
              }
              audioChunks.push(Buffer.from(part.inlineData.data, 'base64'));
            }
          }
        }

        if (audioChunks.length === 0) {
          throw new Error('Lyria stream returned 0 audio chunks.');
        }

        const fullBuf = Buffer.concat(audioChunks);
        const ext = mimeType.includes('wav') ? 'wav' : 'mp3';
        const filename = `lyria_${id}_${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(AUDIO_DIR, filename), fullBuf);

        const musicState: BackgroundMusicState = {
          status: 'generated',
          modelAttempted: 'lyria-3-clip-preview',
          statusMessage: `Generated 30s AI background music via lyria-3-clip-preview (${(fullBuf.length / 1024).toFixed(1)} KB).`,
          audioFileUrl: `/api/audio/${filename}`,
          mimeType,
          promptUsed: String(musicPrompt),
          updatedAt: now,
        };

        const updated: Campaign = { ...existing, backgroundMusic: musicState, updatedAt: now };
        campaigns[index] = updated;
        writeCampaigns(campaigns);
        res.status(201).json({ campaign: updated });
      } catch (lyriaErr: unknown) {
        const rawErr = lyriaErr instanceof Error ? lyriaErr.message : String(lyriaErr);
        const built = buildAndValidateMusicState({
          mode: 'unavailable_paid_tier',
          musicPrompt: String(musicPrompt),
          errorDetail: rawErr,
          nowIso: now,
        });
        const musicState = built.musicState!;
        const updated: Campaign = { ...existing, backgroundMusic: musicState, updatedAt: now };
        campaigns[index] = updated;
        writeCampaigns(campaigns);
        res.status(200).json({ campaign: updated, warning: musicState.statusMessage });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to process background music request.';
      res.status(500).json({ error: message });
    }
  });

  // 9. Delete a Campaign
  app.delete('/api/campaigns/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const campaigns = readCampaigns();
    const filtered = campaigns.filter((c) => c.id !== id);
    writeCampaigns(filtered);
    res.json({ deletedId: id });
  });

  return app;
}

async function startServer() {
  const app = await createAppServer();

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AI Ad Studio server listening on http://0.0.0.0:${PORT}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
