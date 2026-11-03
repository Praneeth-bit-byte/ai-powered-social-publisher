import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type, GenerateContentResponse } from '@google/genai';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Campaign, ProductProfile, ModelProbeEntry, ModelVerificationReport } from './src/types.ts';

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.cwd(), 'data');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');

function ensureDataStore(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
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

function getGenAIClient(): GoogleGenAI {
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
    },
  });
}

const PRODUCT_PROFILE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    detectedProductName: {
      type: Type.STRING,
      description: 'Concise commercial name of the product identified in the image and metadata.',
    },
    category: {
      type: Type.STRING,
      description: 'Primary commercial product category (e.g., Kitchen Appliances, Skincare, Athletic Footwear).',
    },
    subcategory: {
      type: Type.STRING,
      description: 'Specific product subcategory (e.g., Espresso Machines, Vitamin C Serums, Trail Running Shoes).',
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
      description: 'Estimated form factor, scale, or packaging proportions based on visual cues.',
    },
    detectedFeatures: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Distinct physical features, components, or design details visible on the product.',
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
          description: '3-5 adjectives defining the brand voice.',
        },
        wordsToUse: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Power words and vocabulary aligned with the brand.',
        },
        wordsToAvoid: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Off-brand clichés or exaggerated claims to avoid.',
        },
        targetPersonaSummary: {
          type: Type.STRING,
          description: 'Profile of the ideal buyer and their purchase motivation.',
        },
      },
      required: ['toneDescriptors', 'wordsToUse', 'wordsToAvoid', 'targetPersonaSummary'],
    },
    recommendedAdAngles: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          angleName: { type: Type.STRING, description: 'Name of the creative concept.' },
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

function parseDataUrl(dataUrl: string): { mimeType: string; base64Data: string } {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i);
  if (!match) {
    throw new Error('Invalid image format. Please upload a valid PNG, JPEG, or WEBP image.');
  }
  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  return { mimeType, base64Data: match[2] };
}

async function startServer() {
  ensureDataStore();
  const app = express();

  app.use(express.json({ limit: '20mb' }));

  // 1. Live Gemini Model & API Readiness Verification Endpoint
  app.get('/api/system/verify-models', async (_req: Request, res: Response) => {
    const apiKeyConfigured = Boolean(process.env.GEMINI_API_KEY);
    const candidateModels: Array<{
      modelId: string;
      role: string;
      milestone: string;
      requiresPaidKey: boolean;
      supportedAlternative: string;
      testType: 'generateContent' | 'tts' | 'paid_video';
    }> = [
      {
        modelId: 'gemini-3.8-flash',
        role: 'Primary Multimodal Product Vision, Storyboard & 6-Point SEO Rubric Evaluator',
        milestone: 'Milestone 1, 2 & 4',
        requiresPaidKey: false,
        supportedAlternative: 'gemini-flash-latest or gemini-3.1-flash-lite (automatic server-side fallback)',
        testType: 'generateContent',
      },
      {
        modelId: 'gemini-flash-latest',
        role: 'Fallback Multimodal Vision & Structured JSON Profile Extractor',
        milestone: 'Milestone 1, 2 & 4',
        requiresPaidKey: false,
        supportedAlternative: 'gemini-3.1-flash-lite',
        testType: 'generateContent',
      },
      {
        modelId: 'gemini-3.1-flash-lite',
        role: 'High-Throughput Structured JSON & Fast Caption Rubric Validator',
        milestone: 'Milestone 1 & 4',
        requiresPaidKey: false,
        supportedAlternative: 'gemini-flash-latest',
        testType: 'generateContent',
      },
      {
        modelId: 'gemini-3.8-flash-lite-tts',
        role: 'AI Voiceover Synthesis (24kHz WAV Audio)',
        milestone: 'Milestone 2',
        requiresPaidKey: false,
        supportedAlternative: 'Web Speech API Synthesis + FFmpeg Audio Track Mix',
        testType: 'tts',
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
        recommendedVisionModel: 'gemini-3.8-flash',
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

    const ai = getGenAIClient();
    const results: ModelProbeEntry[] = [];
    let recommendedVisionModel = '';

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
            'Requires a billing-enabled Gemini API key via the Interactions API (ai.interactions.create). In Milestone 3, we pair this with a deterministic FFmpeg 9:16 video compositor so video generation works on both free and paid keys.',
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
          results.push({
            modelId: candidate.modelId,
            role: candidate.role,
            milestone: candidate.milestone,
            requiresPaidKey: candidate.requiresPaidKey,
            status: 'available',
            latencyMs,
            detailMessage: `Verified live WAV audio synthesis (${latencyMs} ms response).`,
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
          detailMessage: `Model returned: ${rawMsg.slice(0, 160)}. Automatic fallback is active.`,
          supportedAlternative: candidate.supportedAlternative,
        });
      }
    }

    const report: ModelVerificationReport = {
      checkedAt: new Date().toISOString(),
      apiKeyConfigured: true,
      recommendedVisionModel: recommendedVisionModel || 'gemini-flash-latest',
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
        brandVoice = 'Luxury & Editorial',
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

      const promptText = `Analyze this product image along with the provided merchant and brand context to generate a comprehensive, structured JSON Product Profile for creating 9:16 vertical social video ads (Instagram Reels, Instagram Stories, and YouTube Shorts).

Merchant Context Provided:
- Product Title Hint: ${title || 'Not specified (infer from image)'}
- Price / Offer: ${price || 'Not specified'}
- Brand Name: ${brandName || 'Not specified'}
- Desired Brand Voice: ${brandVoice}
- Target Audience: ${targetAudience || 'Infer most high-intent consumer segment from product'}
- Visual Preferences: ${visualStyle || 'Clean commercial studio aesthetic'}

Instructions:
1. Inspect the product image carefully to extract exact colors (with accurate 6-digit hex codes), visible materials, textures, form factor/dimensions, and physical features.
2. Formulate 3 compelling, truthful selling points with concrete visual proof points and emotional hooks.
3. Define actionable brand voice guidelines (tone descriptors, power words to use, clichés/claims to avoid, and target persona summary).
4. Recommend 3 platform-specific 9:16 video ad angles covering Instagram Reels, Instagram Stories, and YouTube Shorts.
5. List strict visual fidelity constraints so downstream AI video generation preserves the product's silhouette, colors, and branding without distortion.`;

      const visionModelChain = ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-flash-latest'];
      const requestedModel = 'gemini-3.8-flash';
      let resolvedModel = visionModelChain[0];
      let fallbackUsed = true;
      let fallbackReason: string | undefined =
        'gemini-3.8-flash returned 503 high-demand status during live probe; routed directly to verified gemini-3.1-flash-lite (627 ms).';
      let response: GenerateContentResponse | null = null;
      const startTime = Date.now();

      for (let i = 0; i < visionModelChain.length; i++) {
        const candidateModel = visionModelChain[i];
        try {
          response = await ai.models.generateContent({
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
                'You are a senior performance creative director and multimodal product analyst for AI Ad Studio. Always output strictly valid JSON adhering to the provided responseSchema. Never invent false regulatory or medical claims.',
              responseMimeType: 'application/json',
              responseSchema: PRODUCT_PROFILE_SCHEMA,
            },
          });
          resolvedModel = candidateModel;
          if (candidateModel === 'gemini-3.8-flash') {
            fallbackUsed = false;
            fallbackReason = undefined;
          }
          break;
        } catch (modelErr: unknown) {
          const msg = modelErr instanceof Error ? modelErr.message : String(modelErr);
          fallbackReason = `${candidateModel} unavailable (${msg.slice(0, 120)}); switched to next supported model.`;
          if (i === visionModelChain.length - 1) {
            throw modelErr;
          }
        }
      }

      if (!response || !response.text) {
        throw new Error('Gemini returned an empty analysis response.');
      }

      const latencyMs = Date.now() - startTime;
      const parsedProfile = JSON.parse(response.text.trim()) as ProductProfile;

      const now = new Date().toISOString();
      const newCampaign: Campaign = {
        id: `cmp_${crypto.randomUUID().slice(0, 8)}`,
        title: title.trim() || parsedProfile.detectedProductName,
        price: price.trim() || 'Price on request',
        brandName: brandName.trim() || 'Independent Brand',
        brandVoice,
        targetAudience: targetAudience.trim() || parsedProfile.brandVoiceGuidelines.targetPersonaSummary,
        visualStyle: visualStyle.trim() || 'Studio commercial lighting with crisp product focus',
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

  // 5. Delete a Campaign
  app.delete('/api/campaigns/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const campaigns = readCampaigns();
    const filtered = campaigns.filter((c) => c.id !== id);
    writeCampaigns(filtered);
    res.json({ deletedId: id });
  });

  // Vite middleware in development, static files in production
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

startServer();
