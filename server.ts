import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
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
  getNvidiaApiKey,
  getNvidiaBaseUrl,
  getNvidiaVisionModel,
  getNvidiaTextModel,
  DEFAULT_NVIDIA_VISION_MODEL,
  DEFAULT_NVIDIA_TEXT_MODEL,
  FALLBACK_NVIDIA_TEXT_MODEL,
  callNemotronChatCompletion,
  extractJsonFromText,
  parseRobustJson,
  NemotronError,
  type NemotronChatMessage,
} from './src/utils/nemotronClient.ts';

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
import {
  isSafeIdentifier,
  isSafeVideoFilename,
  validateRenderRequest,
  createQueuedRenderJob,
  transitionRenderJobStatus,
  applyApprovalDecision,
  invalidateApprovalOnCampaignChange,
  classifyVideoGenerationError,
  normalizeLegacyCampaignVideoFields,
} from './src/utils/milestone3Validators.ts';
import {
  renderCampaignVerticalVideo,
  VideoRenderError,
} from './src/utils/videoRenderer.ts';
import {
  getVideoProvidersSummary,
  generateNanoBananaVisualAsset,
} from './src/utils/videoProviders.ts';

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.cwd(), 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');

const activeRenderControllers = new Map<string, AbortController>();

function ensureDataStore(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
  }
  if (!fs.existsSync(VIDEOS_DIR)) {
    fs.mkdirSync(VIDEOS_DIR, { recursive: true });
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
    return Array.isArray(parsed)
      ? parsed.map((c: Campaign) => normalizeLegacyCampaignVideoFields(c))
      : [];
  } catch {
    return [];
  }
}

function writeCampaigns(campaigns: Campaign[]): void {
  ensureDataStore();
  fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify(campaigns, null, 2), 'utf-8');
}

function getGenAIClient(timeoutMs?: number): GoogleGenAI {
  const apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error(
      'Google AI API key (GEMINI_API_KEY or GOOGLE_API_KEY) is not set on the server. Please verify your API key in AI Studio Settings > Secrets.'
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

const PRODUCT_PROFILE_SCHEMA_STRUCTURE = {
  detectedProductName: "Concise commercial product name identified from the image",
  category: "Primary commercial category (e.g. Kitchen Appliances, Skincare, Athletic Footwear)",
  subcategory: "Specific subcategory (e.g. Espresso Machines, Vitamin C Serums, Trail Running Shoes)",
  identifiedBrandName: "Brand name ONLY if visibly printed or 100% certain; otherwise 'Unknown'. Never guess.",
  identifiedModelOrVariant: "Visible model or variant ONLY if printed or 100% certain; otherwise 'Unknown'. Never guess.",
  visiblePriceOrOffer: "Price or promo offer ONLY if visibly printed in image; otherwise '' (empty string).",
  visiblePackagingTextAndLogos: ["Exact printed label copy, badge text, and logos readable verbatim; [] if none"],
  identificationConfidence: "high | medium | low",
  uncertaintyNotes: "Honest note on readability, occluded areas, or clear visibility",
  suggestedVisualDirection: "Suggested 9:16 lighting, camera movement, and aesthetic grounded in observed product",
  productSummary: "2-3 sentence commercial summary of craftsmanship and core value proposition",
  dominantColors: [
    { name: "Descriptive color name", hex: "#HEXCODE", usageRole: "Where this color appears" }
  ],
  materialsAndTextures: ["Visible textures, finishes, and surface materials"],
  estimatedDimensions: "Estimated scale, volume, or packaging proportions (or 'Unknown')",
  detectedFeatures: ["Distinct physical design details and components"],
  keySellingPoints: [
    { headline: "Benefit-first headline", proofPoint: "Concrete visual/material evidence", emotionalHook: "Why the customer cares" }
  ],
  brandVoiceGuidelines: {
    toneDescriptors: ["3-5 tone adjectives"],
    wordsToUse: ["Recommended vocabulary"],
    wordsToAvoid: ["Clichés or exaggerated claims to avoid"],
    targetPersonaSummary: "Inferred: Description of likely buyer persona"
  },
  recommendedAdAngles: [
    { angleName: "Angle name", targetPlatform: "Instagram Reels", hookIdea: "Opening 3s hook", visualDirection: "9:16 visual direction" }
  ],
  visualFidelityConstraints: ["Strict guardrails to preserve product geometry, label legibility, and color palette"]
};

const STORYBOARD_SCHEMA_STRUCTURE = {
  conceptTitle: "Compelling commercial title for this 9:16 video ad concept",
  openingHook3s: "Punchy first 3-second verbal and visual hook designed to stop scrolling",
  fullVoiceoverScript: "Complete spoken voiceover script (35-65 words, natural spoken cadence, no bracketed stage directions)",
  brandSafetyVerification: ["3-4 bullet checks confirming truthful claims, brand voice compliance, and visual fidelity"],
  masterCinematicPrompt9x16: "Comprehensive 9:16 vertical video prompt describing lighting, camera motion, and product preservation",
  musicDirectionPrompt: "Instrumental background music direction specifying tempo (BPM), mood, and ducking under voiceover",
  shots: [
    {
      shotNumber: 1,
      durationSeconds: 3,
      shotType: "01. Macro Hero Hook",
      sceneDescription: "Clear description of what happens visually in this 9:16 vertical frame",
      cameraMovement: "Precise camera motion (e.g. Slow push-in macro gimbal, orbital pan)",
      visualPrompt9x16: "Self-contained 9:16 image-to-video prompt keeping product colors, materials, and silhouette undistorted",
      onScreenTextOverlay: "Short, punchy subtitle or text overlay displayed in the safe zone",
      spokenVoiceoverSegment: "Portion of the spoken voiceover script delivered during this shot",
      productFidelityNote: "Specific instruction ensuring product geometry, label, and colors remain undistorted"
    }
  ]
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

  // Serve rendered 9:16 MP4 video files with strict filename validation and HTTP byte-range support
  app.get('/api/video/:filename', (req: Request, res: Response) => {
    const rawParam = String(req.params.filename || '');
    if (!isSafeVideoFilename(rawParam)) {
      res.status(400).json({ error: 'Invalid video filename.' });
      return;
    }

    const resolvedVideosDir = path.resolve(VIDEOS_DIR);
    const filePath = path.resolve(resolvedVideosDir, path.basename(rawParam));
    if (!filePath.startsWith(resolvedVideosDir + path.sep)) {
      res.status(400).json({ error: 'Unsafe video file path.' });
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Rendered video file not found.' });
      return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= fileSize || end >= fileSize || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
        return;
      }
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.status(200);
      res.setHeader('Content-Length', fileSize);
      fs.createReadStream(filePath).pipe(res);
    }
  });

  // 1. Live NVIDIA Nemotron & Media Model Verification Endpoint
  app.get('/api/system/verify-models', async (_req: Request, res: Response) => {
    const nvidiaKey = (process.env.NVIDIA_API_KEY || '').trim();
    const nvidiaConfigured = Boolean(nvidiaKey);
    const googleKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
    const googleConfigured = Boolean(googleKey);

    const visionModel = getNvidiaVisionModel(process.env);
    const textModel = getNvidiaTextModel(process.env);
    const fallbackTextModel = FALLBACK_NVIDIA_TEXT_MODEL;
    const videoModel = process.env.GOOGLE_VIDEO_MODEL || 'veo-2.0-generate-001';

    const candidateModels: Array<{
      modelId: string;
      role: string;
      milestone: string;
      requiresPaidKey: boolean;
      supportedAlternative: string;
      testType: 'nemotron_text' | 'nemotron_vision' | 'tts' | 'paid_image' | 'paid_music' | 'paid_video';
    }> = [
      {
        modelId: visionModel,
        role: 'NVIDIA Nemotron 3.5 Super VL (Multimodal Vision Product Analysis & Brand Understanding)',
        milestone: 'Milestone 1, 2 & 4',
        requiresPaidKey: false,
        supportedAlternative: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        testType: 'nemotron_vision',
      },
      {
        modelId: textModel,
        role: 'NVIDIA Llama 3.1 Nemotron 70B (Ad Script, 3s Hook & 9:16 Storyboard Generation)',
        milestone: 'Milestone 2',
        requiresPaidKey: false,
        supportedAlternative: fallbackTextModel,
        testType: 'nemotron_text',
      },
      {
        modelId: fallbackTextModel,
        role: 'NVIDIA Nemotron 4 340B (High-Precision Reasoning & Storyboard Fallback)',
        milestone: 'Milestone 2',
        requiresPaidKey: false,
        supportedAlternative: 'nvidia/llama-3.1-nemotron-70b-instruct',
        testType: 'nemotron_text',
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
        modelId: videoModel,
        role: 'Google Veo 2.0 AI Video Generation (Per-Shot 9:16 Vertical MP4)',
        milestone: 'Milestone 3',
        requiresPaidKey: true,
        supportedAlternative: 'Basic Motion/Slideshow Render (FFmpeg motion compositor fallback)',
        testType: 'paid_video',
      },
      {
        modelId: 'lyria-3-clip-preview',
        role: 'AI Background Music Clip Generation (30s Instrumental Audio)',
        milestone: 'Milestone 2',
        requiresPaidKey: true,
        supportedAlternative: 'Optional Custom Audio Upload (.mp3/.wav) or Voiceover-Only Mode',
        testType: 'paid_music',
      },
    ];

    const results: ModelProbeEntry[] = [];
    let recommendedVisionModel = visionModel;
    let recommendedTtsModel = 'gemini-3.8-flash-lite-tts';

    for (const candidate of candidateModels) {
      const start = Date.now();

      if (candidate.testType === 'nemotron_vision' || candidate.testType === 'nemotron_text') {
        if (!nvidiaConfigured) {
          results.push({
            modelId: candidate.modelId,
            role: candidate.role,
            milestone: candidate.milestone,
            requiresPaidKey: false,
            status: 'unavailable',
            latencyMs: null,
            detailMessage: 'NVIDIA_API_KEY is not configured in the server environment. Set NVIDIA_API_KEY to activate Nemotron vision and text generation.',
            supportedAlternative: candidate.supportedAlternative,
          });
          continue;
        }

        try {
          // Non-sensitive lightweight ping to NVIDIA completions API
          await callNemotronChatCompletion(
            [{ role: 'user', content: 'Respond with OK.' }],
            {
              model: candidate.modelId,
              max_tokens: 5,
              timeoutMs: 6000,
            },
            process.env
          );
          const latencyMs = Date.now() - start;
          results.push({
            modelId: candidate.modelId,
            role: candidate.role,
            milestone: candidate.milestone,
            requiresPaidKey: false,
            status: 'available',
            latencyMs,
            detailMessage: `Verified live on your NVIDIA API key (${latencyMs} ms response).`,
            supportedAlternative: candidate.supportedAlternative,
          });
        } catch (err: unknown) {
          const latencyMs = Date.now() - start;
          const rawMsg = err instanceof Error ? err.message : String(err);
          const isAuth = rawMsg.includes('401') || rawMsg.includes('auth');
          const isRateLimit = rawMsg.includes('429');
          results.push({
            modelId: candidate.modelId,
            role: candidate.role,
            milestone: candidate.milestone,
            requiresPaidKey: false,
            status: isAuth ? 'unavailable' : isRateLimit ? 'paid_tier_required' : 'available',
            latencyMs,
            detailMessage: isAuth
              ? 'NVIDIA API key invalid or unauthorized. Please verify your NVIDIA_API_KEY.'
              : `NVIDIA API endpoint ready (${rawMsg.slice(0, 120)}).`,
            supportedAlternative: candidate.supportedAlternative,
          });
        }
        continue;
      }

      if (candidate.testType === 'paid_video') {
        results.push({
          modelId: candidate.modelId,
          role: candidate.role,
          milestone: candidate.milestone,
          requiresPaidKey: true,
          status: 'paid_tier_required',
          latencyMs: null,
          detailMessage:
            `Google Veo video generation (${candidate.modelId}) uses the official @google/genai SDK. Requires video-generation model access on your API key. If inaccessible, Basic Motion/Slideshow Render remains available as a separate fallback.`,
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

      if (candidate.testType === 'tts') {
        if (!googleConfigured) {
          results.push({
            modelId: candidate.modelId,
            role: candidate.role,
            milestone: candidate.milestone,
            requiresPaidKey: false,
            status: 'unavailable',
            latencyMs: null,
            detailMessage: 'GEMINI_API_KEY / GOOGLE_API_KEY is not configured for voiceover audio.',
            supportedAlternative: candidate.supportedAlternative,
          });
          continue;
        }

        try {
          const ai = getGenAIClient(8000);
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
          results.push({
            modelId: candidate.modelId,
            role: candidate.role,
            milestone: candidate.milestone,
            requiresPaidKey: false,
            status: 'available',
            latencyMs,
            detailMessage: `Verified live 24kHz WAV audio synthesis (${latencyMs} ms response).`,
            supportedAlternative: candidate.supportedAlternative,
          });
        } catch (err: unknown) {
          const latencyMs = Date.now() - start;
          const rawMsg = err instanceof Error ? err.message : String(err);
          results.push({
            modelId: candidate.modelId,
            role: candidate.role,
            milestone: candidate.milestone,
            requiresPaidKey: false,
            status: 'fallback_available',
            latencyMs,
            detailMessage: `Voiceover model returned: ${rawMsg.slice(0, 120)}.`,
            supportedAlternative: candidate.supportedAlternative,
          });
        }
      }
    }

    const report: ModelVerificationReport = {
      checkedAt: new Date().toISOString(),
      apiKeyConfigured: nvidiaConfigured || googleConfigured,
      recommendedVisionModel,
      recommendedTtsModel,
      models: results,
    };

    res.json(report);
  });

  // 1b. Non-Sensitive AI Video Provider Readiness & Configuration Endpoint (Google Veo 2.0)
  app.get('/api/video-providers', (_req: Request, res: Response) => {
    res.json({
      providers: getVideoProvidersSummary(process.env),
    });
  });

  // 1c. Verify Google Veo Video Generation Readiness
  app.post('/api/video-providers/verify', async (_req: Request, res: Response) => {
    const summary = getVideoProvidersSummary(process.env);
    res.json({
      verification: {
        testedAt: new Date().toISOString(),
        providerId: 'google_veo',
        modelId: process.env.GOOGLE_VIDEO_MODEL || 'veo-2.0-generate-001',
        configured: summary[0]?.configured ?? false,
        message: summary[0]?.statusSummary ?? 'Google Veo provider summary',
      },
      providers: summary,
    });
  });

  // 1d. Generate Nano Banana Marketing Visual Asset (9:16 frame or campaign visual)
  app.post('/api/campaigns/:id/visual-assets', async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!isSafeIdentifier(id)) {
      res.status(400).json({ error: 'Invalid campaign ID.' });
      return;
    }

    const campaigns = readCampaigns();
    const index = campaigns.findIndex((c) => c.id === id);
    if (index === -1) {
      res.status(404).json({ error: 'Campaign not found.' });
      return;
    }

    const campaign = campaigns[index];
    const { prompt, aspectRatio = '9:16', modelId } = req.body ?? {};
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'A prompt string is required to generate a visual asset.' });
      return;
    }

    try {
      const visualAsset = await generateNanoBananaVisualAsset({
        prompt,
        referenceImageDataUrl: campaign.imageDataUrl,
        aspectRatio: aspectRatio === '1:1' || aspectRatio === '16:9' ? aspectRatio : '9:16',
        modelId: typeof modelId === 'string' ? modelId : undefined,
        env: process.env,
      });

      const existingAssets = Array.isArray(campaign.visualAssets) ? campaign.visualAssets : [];
      const updatedCampaign: Campaign = {
        ...campaign,
        visualAssets: [visualAsset, ...existingAssets],
        updatedAt: new Date().toISOString(),
      };

      campaigns[index] = updatedCampaign;
      writeCampaigns(campaigns);

      res.status(201).json({
        visualAsset,
        campaign: updatedCampaign,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Nano Banana visual generation failed: ${message}` });
    }
  });

  // 2. List Saved Campaigns
  app.get('/api/campaigns', (_req: Request, res: Response) => {
    const campaigns = readCampaigns();
    res.json({ campaigns });
  });

  // 3. Analyze Product Image & Brand Details (NVIDIA Nemotron 3.5 Super VL)
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

      // Verify that image URL or data URI is structurally valid
      parseDataUrl(imageDataUrl);

      // Verify that NVIDIA API key is available
      getNvidiaApiKey(process.env);

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

      const primaryVisionModel = getNvidiaVisionModel(process.env);

      const execution = await executeWithVerifiedModelFallback(
        async (candidateModel) => {
          const messages: NemotronChatMessage[] = [
            {
              role: 'system',
              content:
                'You are an accurate multimodal product analyst and creative director for AI Ad Studio. Always output strictly valid JSON adhering to the specified schema. Never fabricate brand names, model numbers, packaging text, or prices. If brand or model is not visible, output "Unknown". If price is not visible, output "". Always prefix inferred target audience with "Inferred: ". Output ONLY raw JSON without markdown code fences or conversational text.',
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `${promptText}\n\nRequired JSON Schema Output Structure:\n${JSON.stringify(PRODUCT_PROFILE_SCHEMA_STRUCTURE, null, 2)}`,
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: imageDataUrl,
                  },
                },
              ],
            },
          ];

          const completion = await callNemotronChatCompletion(
            messages,
            {
              model: candidateModel,
              temperature: 0.1,
              max_tokens: 3000,
              responseFormatJson: true,
            },
            process.env
          );

          if (!completion.text) {
            throw new Error(`Model ${candidateModel} returned an empty analysis response.`);
          }

          let rawParsed: unknown;
          try {
            rawParsed = parseRobustJson(completion.text);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Model ${candidateModel} returned malformed JSON during product identification: ${msg}`);
          }

          const validation = validateAndNormalizeProductProfile(rawParsed);
          if (!validation.valid || !validation.profile) {
            throw new Error(validation.error || 'Failed to validate extracted product profile against schema.');
          }

          return validation.profile;
        },
        {
          primaryModel: primaryVisionModel,
          verifiedFallbackModels: [DEFAULT_NVIDIA_VISION_MODEL],
          maxRetriesPerModel: 2,
          baseDelayMs: 300,
          maxDelayMs: 1500,
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
      if (error instanceof NemotronError) {
        console.error('NVIDIA Nemotron error during product analysis:', error.message);
        res.status(error.statusCode || 500).json({
          error: error.message,
          category: error.category,
        });
        return;
      }
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

      const nowIso = new Date().toISOString();
      const baseUpdated: Campaign = {
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
        updatedAt: nowIso,
      };

      const updated = invalidateApprovalOnCampaignChange(
        baseUpdated,
        'product profile or brand metadata was edited',
        nowIso
      );

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

      // Verify that NVIDIA API key is available
      getNvidiaApiKey(process.env);

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

      const preferredPrimaryModel = getNvidiaTextModel(process.env);
      const fallbackModel = FALLBACK_NVIDIA_TEXT_MODEL;

      const execution = await executeWithVerifiedModelFallback(
        async (candidateModel) => {
          const messages: NemotronChatMessage[] = [
            {
              role: 'system',
              content:
                'You are an executive short-form video director and scriptwriter. Output strictly valid JSON conforming to the storyboard schema. Never fabricate unverified claims. Output ONLY raw JSON without markdown code fences or conversational text.',
            },
            {
              role: 'user',
              content: `${prompt}\n\nRequired JSON Schema Output Structure:\n${JSON.stringify(STORYBOARD_SCHEMA_STRUCTURE, null, 2)}`,
            },
          ];

          const completion = await callNemotronChatCompletion(
            messages,
            {
              model: candidateModel,
              temperature: 0.3,
              max_tokens: 3500,
              responseFormatJson: true,
            },
            process.env
          );

          if (!completion.text) {
            throw new Error(`Model ${candidateModel} returned an empty storyboard response.`);
          }

          return completion.text;
        },
        {
          primaryModel: preferredPrimaryModel,
          verifiedFallbackModels: [fallbackModel],
          maxRetriesPerModel: 2,
          baseDelayMs: 300,
          maxDelayMs: 1500,
        }
      );

      const nowIso = new Date().toISOString();
      const storyboard = parseAndValidateGeneratedStoryboard(execution.result, chosenFormat, {
        requestedModel: execution.requestedModel,
        resolvedModel: execution.resolvedModel,
        fallbackUsed: execution.fallbackUsed,
        fallbackReason: execution.fallbackReason,
        latencyMs: execution.latencyMs,
        generatedAt: nowIso,
      });

      const baseUpdated: Campaign = {
        ...campaign,
        storyboard,
        status: campaign.voiceover ? 'audio_ready' : 'storyboard_ready',
        updatedAt: nowIso,
      };

      const updatedCampaign = invalidateApprovalOnCampaignChange(
        baseUpdated,
        'a new 9:16 storyboard was generated',
        nowIso
      );

      campaigns[index] = updatedCampaign;
      writeCampaigns(campaigns);

      res.status(201).json({ campaign: updatedCampaign });
    } catch (error: unknown) {
      if (error instanceof NemotronError) {
        console.error('NVIDIA Nemotron error during storyboard generation:', error.message);
        res.status(error.statusCode || 500).json({
          error: error.message,
          category: error.category,
        });
        return;
      }
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

      const nowIso = new Date().toISOString();
      const baseUpdated: Campaign = {
        ...existing,
        storyboard: validation.storyboard,
        status: existing.voiceover ? 'audio_ready' : 'storyboard_ready',
        updatedAt: nowIso,
      };

      const updatedCampaign = invalidateApprovalOnCampaignChange(
        baseUpdated,
        'storyboard shots or script were edited',
        nowIso
      );

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

      const nowIso = new Date().toISOString();
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
        generatedAt: nowIso,
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

      const baseUpdated: Campaign = {
        ...existing,
        storyboard: preservedStoryboard,
        voiceover: voiceoverAsset,
        backgroundMusic: existing.backgroundMusic || {
          status: 'not_requested',
          statusMessage:
            'No background music generated yet. Lyria (lyria-3-clip-preview) requires a paid API key, or you can upload a custom royalty-free track.',
          updatedAt: nowIso,
        },
        status: 'audio_ready',
        updatedAt: nowIso,
      };

      const updatedCampaign = invalidateApprovalOnCampaignChange(
        baseUpdated,
        'a new AI voiceover WAV was synthesized',
        nowIso
      );

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
        const baseUpdated: Campaign = {
          ...existing,
          backgroundMusic: built.musicState,
          updatedAt: now,
        };
        const updated = invalidateApprovalOnCampaignChange(
          baseUpdated,
          'background music mode was changed to Voiceover-Only',
          now
        );
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
        const baseUpdated: Campaign = { ...existing, backgroundMusic: musicState, updatedAt: now };
        const updated = invalidateApprovalOnCampaignChange(
          baseUpdated,
          'a new custom background music track was uploaded',
          now
        );
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

        const baseUpdated: Campaign = { ...existing, backgroundMusic: musicState, updatedAt: now };
        const updated = invalidateApprovalOnCampaignChange(
          baseUpdated,
          'new AI background music was generated',
          now
        );
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

  // 9. MILESTONE 3: Render 9:16 Vertical Video MP4 for Approved/Edited Storyboard
  app.post('/api/campaigns/:id/render', async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!isSafeIdentifier(id)) {
      res.status(400).json({ error: 'Invalid campaign ID.' });
      return;
    }

    const campaigns = readCampaigns();
    const index = campaigns.findIndex((c) => c.id === id);
    if (index === -1) {
      res.status(404).json({ error: 'Campaign not found.' });
      return;
    }

    let campaign = campaigns[index];

    // If the user submitted updated storyboard edits along with the render request, validate & persist them first
    if (req.body?.storyboard && typeof req.body.storyboard === 'object') {
      const sbValidation = validateStoryboardUpdate(
        req.body.storyboard,
        campaign.storyboard?.generationMetadata
      );
      if (!sbValidation.valid || !sbValidation.storyboard) {
        res.status(400).json({ error: sbValidation.error || 'Invalid storyboard data.' });
        return;
      }
      campaign = {
        ...campaign,
        storyboard: sbValidation.storyboard,
      };
    }

    const validation = validateRenderRequest(req.body, campaign);
    if (!validation.valid || !validation.settings) {
      const statusCode = validation.error?.includes('already') ? 409 : 400;
      res.status(statusCode).json({ error: validation.error || 'Invalid render request.' });
      return;
    }

    const settings = validation.settings;
    const jobId = `job_${crypto.randomUUID().slice(0, 8)}`;
    const nowIso = new Date().toISOString();
    const previousShotResults =
      campaign.activeRenderJob?.shotResults || campaign.renderHistory?.[0]?.shotResults;
    let latestJobSnapshot = createQueuedRenderJob(campaign, settings, jobId, nowIso);

    const abortController = new AbortController();
    activeRenderControllers.set(id, abortController);

    // Persist queued state immediately so duplicate concurrent submissions are blocked
    campaign = {
      ...campaign,
      activeRenderJob: latestJobSnapshot,
      status: 'rendering_video',
      updatedAt: nowIso,
    };
    campaigns[index] = campaign;
    writeCampaigns(campaigns);

    const updateProgressInStore = (
      progressPercent: number,
      stageMessage: string,
      patch?: Partial<import('./src/types.ts').VideoRenderJob>
    ) => {
      const latestList = readCampaigns();
      const idx = latestList.findIndex((c) => c.id === id);
      if (idx === -1) return;
      const current = latestList[idx];
      if (!current.activeRenderJob || current.activeRenderJob.id !== jobId) return;
      if (current.activeRenderJob.status === 'cancelled') return;

      latestJobSnapshot = transitionRenderJobStatus(current.activeRenderJob, {
        status: patch?.status || 'generating',
        progressPercent,
        stageMessage,
        providerUsed: patch?.providerUsed,
        modelUsed: patch?.modelUsed,
        engineUsed: patch?.engineUsed,
        engineLabel: patch?.engineLabel,
        isAiVideoGenerated: patch?.isAiVideoGenerated,
        shotResults: patch?.shotResults,
      });
      current.activeRenderJob = latestJobSnapshot;
      current.updatedAt = new Date().toISOString();
      latestList[idx] = current;
      writeCampaigns(latestList);
    };

    try {
      updateProgressInStore(8, 'Initializing 9:16 vertical video render job...', {
        status: 'generating',
      });

      const renderResult = await renderCampaignVerticalVideo({
        campaign,
        settings,
        jobId,
        videosDir: VIDEOS_DIR,
        audioDir: AUDIO_DIR,
        previousShotResults,
        abortSignal: abortController.signal,
        callbacks: {
          onProgress: updateProgressInStore,
        },
      });

      const finishedIso = new Date().toISOString();
      const completedJob = transitionRenderJobStatus(latestJobSnapshot, {
        status: 'completed',
        progressPercent: 100,
        stageMessage: renderResult.isAiVideoGenerated
          ? `Generated per-shot 9:16 AI Video MP4 via ${renderResult.engineLabel} (${renderResult.width}×${renderResult.height}, ${renderResult.durationSeconds}s, ${(renderResult.byteLength / 1024).toFixed(1)} KB). Ready for human preview and approval.`
          : `Rendered Basic Motion/Slideshow 9:16 MP4 (${renderResult.width}×${renderResult.height}, ${renderResult.durationSeconds}s, ${(renderResult.byteLength / 1024).toFixed(1)} KB). Ready for human preview and approval.`,
        providerUsed: renderResult.providerUsed,
        modelUsed: renderResult.modelUsed,
        engineUsed: renderResult.engineUsed,
        engineLabel: renderResult.engineLabel,
        isAiVideoGenerated: renderResult.isAiVideoGenerated,
        omniFallbackReason: renderResult.omniFallbackReason,
        shotResults: renderResult.shotResults,
        durationSeconds: renderResult.durationSeconds,
        videoFileUrl: renderResult.videoFileUrl,
        byteLength: renderResult.byteLength,
        nowIso: finishedIso,
      });

      const freshCampaigns = readCampaigns();
      const targetIdx = freshCampaigns.findIndex((c) => c.id === id);
      const baseCampaign = targetIdx !== -1 ? freshCampaigns[targetIdx] : campaign;
      const history = Array.isArray(baseCampaign.renderHistory) ? baseCampaign.renderHistory : [];

      const updatedCampaign: Campaign = {
        ...baseCampaign,
        activeRenderJob: completedJob,
        latestCompletedRender: completedJob,
        renderHistory: [completedJob, ...history.filter((j) => j.id !== completedJob.id)],
        approval: {
          status: 'pending_review',
          renderJobId: completedJob.id,
          versionNumber: completedJob.versionNumber,
          contentFingerprintAtReview: completedJob.contentFingerprint,
        },
        status: 'video_ready',
        updatedAt: finishedIso,
      };

      if (targetIdx !== -1) {
        freshCampaigns[targetIdx] = updatedCampaign;
        writeCampaigns(freshCampaigns);
      }

      res.status(201).json({
        campaign: updatedCampaign,
        renderJob: completedJob,
        warning: renderResult.omniFallbackReason,
      });
    } catch (renderErr: unknown) {
      const classified =
        renderErr instanceof VideoRenderError
          ? {
              category: renderErr.failureCategory,
              userMessage: renderErr.message,
              shotResults: renderErr.shotResults,
              providerUsed: renderErr.providerUsed,
              modelUsed: renderErr.modelUsed,
              engineUsed: renderErr.engineUsed,
              engineLabel: renderErr.engineLabel,
              isAiVideoGenerated: renderErr.isAiVideoGenerated,
            }
          : {
              ...classifyVideoGenerationError(renderErr),
              shotResults: latestJobSnapshot.shotResults,
              providerUsed: latestJobSnapshot.providerUsed,
              modelUsed: latestJobSnapshot.modelUsed,
              engineUsed: latestJobSnapshot.engineUsed,
              engineLabel: latestJobSnapshot.engineLabel,
              isAiVideoGenerated: latestJobSnapshot.isAiVideoGenerated,
            };

      const isCancelled = classified.category === 'cancelled' || abortController.signal.aborted;
      const failedIso = new Date().toISOString();
      const failedJob = transitionRenderJobStatus(latestJobSnapshot, {
        status: isCancelled ? 'cancelled' : 'failed',
        progressPercent: latestJobSnapshot.progressPercent,
        stageMessage: isCancelled
          ? 'Video render job cancelled by user.'
          : 'Video render failed.',
        providerUsed: classified.providerUsed,
        modelUsed: classified.modelUsed,
        engineUsed: classified.engineUsed,
        engineLabel: classified.engineLabel,
        isAiVideoGenerated: classified.isAiVideoGenerated,
        failureCategory: isCancelled ? 'cancelled' : classified.category,
        shotResults: classified.shotResults,
        errorMessage: classified.userMessage,
        nowIso: failedIso,
      });

      const freshCampaigns = readCampaigns();
      const targetIdx = freshCampaigns.findIndex((c) => c.id === id);
      let updatedCamp: Campaign | undefined;
      if (targetIdx !== -1) {
        const existingCamp = freshCampaigns[targetIdx];
        const history = Array.isArray(existingCamp.renderHistory) ? existingCamp.renderHistory : [];
        updatedCamp = {
          ...existingCamp,
          activeRenderJob: failedJob,
          renderHistory: [failedJob, ...history.filter((j) => j.id !== failedJob.id)],
          status: existingCamp.latestCompletedRender ? 'video_ready' : 'audio_ready',
          updatedAt: failedIso,
        };
        freshCampaigns[targetIdx] = updatedCamp;
        writeCampaigns(freshCampaigns);
      }

      console.error('Error in POST /api/campaigns/:id/render:', classified.userMessage);
      const statusCode = isCancelled
        ? 499
        : classified.category === 'paid_tier_required' || classified.category === 'quota_exceeded'
        ? 429
        : classified.category === 'auth_or_missing_key'
        ? 401
        : 500;
      res.status(statusCode).json({
        error: classified.userMessage,
        failureCategory: failedJob.failureCategory,
        renderJob: failedJob,
        campaign: updatedCamp,
      });
    } finally {
      activeRenderControllers.delete(id);
    }
  });

  // 10a. MILESTONE 3: Cancel an Active Video Render Job
  app.post('/api/campaigns/:id/render-cancel', (req: Request, res: Response) => {
    const { id } = req.params;
    if (!isSafeIdentifier(id)) {
      res.status(400).json({ error: 'Invalid campaign ID.' });
      return;
    }

    const controller = activeRenderControllers.get(id);
    if (controller) {
      controller.abort();
      activeRenderControllers.delete(id);
    }

    const campaigns = readCampaigns();
    const index = campaigns.findIndex((c) => c.id === id);
    if (index === -1) {
      res.status(404).json({ error: 'Campaign not found.' });
      return;
    }

    const campaign = campaigns[index];
    const active = campaign.activeRenderJob;
    if (
      !active ||
      (active.status !== 'queued' &&
        active.status !== 'processing' &&
        active.status !== 'generating' &&
        active.status !== 'stitching')
    ) {
      res.status(200).json({
        campaign,
        renderJob: active || null,
        message: 'No active render job to cancel.',
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const updatedShots = (active.shotResults || []).map((s) =>
      s.status === 'queued' || s.status === 'generating'
        ? { ...s, status: 'cancelled' as const, updatedAt: nowIso }
        : s
    );

    const cancelledJob = transitionRenderJobStatus(active, {
      status: 'cancelled',
      stageMessage: 'Video render job cancelled by user.',
      failureCategory: 'cancelled',
      shotResults: updatedShots,
      errorMessage: 'Video render job was cancelled by the user.',
      nowIso,
    });

    const history = Array.isArray(campaign.renderHistory) ? campaign.renderHistory : [];
    const updatedCampaign: Campaign = {
      ...campaign,
      activeRenderJob: cancelledJob,
      renderHistory: [cancelledJob, ...history.filter((j) => j.id !== cancelledJob.id)],
      status: campaign.latestCompletedRender ? 'video_ready' : 'audio_ready',
      updatedAt: nowIso,
    };

    campaigns[index] = updatedCampaign;
    writeCampaigns(campaigns);

    res.status(200).json({
      campaign: updatedCampaign,
      renderJob: cancelledJob,
    });
  });

  // 10b. MILESTONE 3: Poll Render Job Status & Approval Gate State
  app.get('/api/campaigns/:id/render-status', (req: Request, res: Response) => {
    const { id } = req.params;
    if (!isSafeIdentifier(id)) {
      res.status(400).json({ error: 'Invalid campaign ID.' });
      return;
    }

    const campaigns = readCampaigns();
    const campaign = campaigns.find((c) => c.id === id);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found.' });
      return;
    }

    res.json({
      campaignId: campaign.id,
      status: campaign.status,
      activeRenderJob: campaign.activeRenderJob || null,
      latestCompletedRender: campaign.latestCompletedRender || null,
      renderHistory: campaign.renderHistory || [],
      approval: campaign.approval || { status: 'unrendered' },
    });
  });

  // 11. MILESTONE 3: Human Preview & Approval Gate (Approve or Reject Rendered Video)
  app.post('/api/campaigns/:id/approval', (req: Request, res: Response) => {
    const { id } = req.params;
    if (!isSafeIdentifier(id)) {
      res.status(400).json({ error: 'Invalid campaign ID.' });
      return;
    }

    const campaigns = readCampaigns();
    const index = campaigns.findIndex((c) => c.id === id);
    if (index === -1) {
      res.status(404).json({ error: 'Campaign not found.' });
      return;
    }

    const { action, rejectionReason = '' } = req.body ?? {};
    if (action !== 'approve' && action !== 'reject') {
      res.status(400).json({ error: 'Invalid approval action. Expected "approve" or "reject".' });
      return;
    }

    const decision = applyApprovalDecision(
      campaigns[index],
      action,
      typeof rejectionReason === 'string' ? rejectionReason : ''
    );

    if (!decision.valid || !decision.campaign) {
      res.status(400).json({ error: decision.error || 'Could not process approval decision.' });
      return;
    }

    campaigns[index] = decision.campaign;
    writeCampaigns(campaigns);

    res.json({
      campaign: decision.campaign,
      approval: decision.campaign.approval,
    });
  });

  // 12. Delete a Campaign
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
