import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GoogleGenAI } from '@google/genai';
import type {
  AiVideoProviderId,
  Campaign,
  RenderEngineUsed,
  RenderFailureCategory,
  ShotRenderState,
  StoryboardShot,
  VideoRenderJob,
  VideoRenderSettings,
} from '../types.ts';
import {
  buildCommercialShotVideoPrompt,
  classifyVideoGenerationError,
  createInitialShotRenderStates,
  getEngineDisplayMetadata,
  isAiVideoEnginePreference,
  isSafeIdentifier,
  updateShotRenderState,
  verifyAudioVideoDurationSync,
  verifyPlayableMp4Buffer,
} from './milestone3Validators.ts';
import {
  DEFAULT_GOOGLE_VEO_MODEL_ID,
  downloadAndVerifyVideoSource,
  executeProviderShotGeneration,
  resolveAiVideoProviderAdapter,
  type AiVideoProviderAdapter,
} from './videoProviders.ts';

const execFileAsync = promisify(execFile);

export const PRIMARY_AI_VIDEO_MODEL = DEFAULT_GOOGLE_VEO_MODEL_ID;

export class VideoRenderError extends Error {
  public readonly failureCategory: RenderFailureCategory;
  public readonly shotResults: ShotRenderState[];
  public readonly providerUsed?: AiVideoProviderId | 'ffmpeg_local';
  public readonly modelUsed?: string;
  public readonly engineUsed: RenderEngineUsed;
  public readonly engineLabel: string;
  public readonly isAiVideoGenerated: boolean;

  constructor(
    message: string,
    options: {
      failureCategory: RenderFailureCategory;
      shotResults: ShotRenderState[];
      providerUsed?: AiVideoProviderId | 'ffmpeg_local';
      modelUsed?: string;
      engineUsed: RenderEngineUsed;
      engineLabel: string;
      isAiVideoGenerated: boolean;
    }
  ) {
    super(message);
    this.name = 'VideoRenderError';
    this.failureCategory = options.failureCategory;
    this.shotResults = options.shotResults;
    this.providerUsed = options.providerUsed;
    this.modelUsed = options.modelUsed;
    this.engineUsed = options.engineUsed;
    this.engineLabel = options.engineLabel;
    this.isAiVideoGenerated = options.isAiVideoGenerated;
  }
}

const FONT_BOLD_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Bold.ttf',
];

const FONT_REGULAR_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Regular.ttf',
];

const FONT_MONO_CANDIDATES = [
  '/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-SemiBold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
];

function resolveExistingFont(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Wraps a text string into lines of at most `maxCharsPerLine` characters and at most `maxLines` lines
 * so that burned-in 9:16 titles and subtitles never clip outside the vertical safe zone.
 */
export function wrapTextForVerticalOverlay(
  rawText: string,
  maxCharsPerLine = 32,
  maxLines = 3
): string {
  const cleaned = String(rawText || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';

  const words = cleaned.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      currentLine = candidate;
    } else {
      if (currentLine) {
        lines.push(currentLine);
        if (lines.length >= maxLines) {
          const lastIdx = maxLines - 1;
          lines[lastIdx] = `${lines[lastIdx].slice(0, Math.max(1, maxCharsPerLine - 1))}…`;
          return lines.join('\n');
        }
      }
      currentLine = word.length > maxCharsPerLine ? word.slice(0, maxCharsPerLine) : word;
    }
  }

  if (currentLine && lines.length < maxLines) {
    lines.push(currentLine);
  }

  return lines.join('\n');
}

/**
 * Normalizes a 6-digit hex color (e.g. "#1C1917") to FFmpeg hex format ("0x1c1917"),
 * falling back to `fallbackHex` if invalid.
 */
function toFfmpegHexColor(hexInput: string | undefined, fallbackHex = '0x0f172a'): string {
  if (!hexInput || typeof hexInput !== 'string') return fallbackHex;
  const cleaned = hexInput.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return `0x${cleaned.toLowerCase()}`;
  }
  return fallbackHex;
}

/**
 * Resolves a campaign audio URL (e.g., "/api/audio/vo_cmp_123.wav") to a verified safe file path
 * inside `audioDir`, preventing path traversal or external path access.
 */
export function resolveSafeAudioFilePath(
  audioFileUrl: string | undefined,
  audioDir: string
): string | null {
  if (!audioFileUrl || typeof audioFileUrl !== 'string') return null;
  const prefix = '/api/audio/';
  const rawFilename = audioFileUrl.startsWith(prefix)
    ? audioFileUrl.slice(prefix.length)
    : path.basename(audioFileUrl);

  if (
    !rawFilename ||
    rawFilename.includes('..') ||
    rawFilename.includes('/') ||
    rawFilename.includes('\\') ||
    !/^[a-zA-Z0-9_.-]+\.(wav|mp3)$/i.test(rawFilename)
  ) {
    return null;
  }

  const resolvedAudioDir = path.resolve(audioDir);
  const fullPath = path.resolve(resolvedAudioDir, rawFilename);
  if (!fullPath.startsWith(resolvedAudioDir + path.sep)) {
    return null;
  }

  if (!fs.existsSync(fullPath)) {
    return null;
  }

  return fullPath;
}

export interface ProbedMp4Metadata {
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  videoDurationSeconds: number;
  audioDurationSeconds: number;
  containerDurationSeconds: number;
}

/**
 * Uses `ffprobe` to inspect the rendered MP4 file and extract real stream dimensions, codecs,
 * and audio/video durations.
 */
export async function probeRenderedVideoFile(mp4FilePath: string): Promise<ProbedMp4Metadata> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,duration:format=duration',
      '-of',
      'json',
      mp4FilePath,
    ],
    { timeout: 15000 }
  );

  const parsed = JSON.parse(stdout || '{}') as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      duration?: string;
    }>;
    format?: { duration?: string };
  };

  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const containerDuration = Number(parsed.format?.duration || 0);

  const videoDurationSeconds = Number(videoStream?.duration || containerDuration || 0);
  const audioDurationSeconds = Number(audioStream?.duration || containerDuration || 0);

  return {
    width: Number(videoStream?.width || 0),
    height: Number(videoStream?.height || 0),
    videoCodec: String(videoStream?.codec_name || ''),
    audioCodec: String(audioStream?.codec_name || ''),
    videoDurationSeconds,
    audioDurationSeconds,
    containerDurationSeconds: containerDuration || videoDurationSeconds,
  };
}

export interface RenderExecutionCallbacks {
  onProgress?: (
    progressPercent: number,
    stageMessage: string,
    patch?: Partial<VideoRenderJob>
  ) => void;
}

export type OmniShotVideoGeneratorFn = (params: {
  shot: StoryboardShot;
  shotIndex: number;
  prompt: string;
  mimeType: string;
  base64Data: string;
  duration: '5s' | '10s';
  resolution: '720p' | '1080p';
  signal?: AbortSignal;
}) => Promise<{ videoBuffer: Buffer; modelUsed: string }>;

export interface RenderPipelineResult {
  outputFilePath: string;
  videoFileUrl: string;
  byteLength: number;
  width: number;
  height: number;
  durationSeconds: number;
  providerUsed: AiVideoProviderId | 'ffmpeg_local';
  modelUsed: string;
  engineUsed: RenderEngineUsed;
  engineLabel: string;
  isAiVideoGenerated: boolean;
  omniFallbackReason?: string;
  shotResults: ShotRenderState[];
  probedMetadata: ProbedMp4Metadata;
}

/**
 * Decodes `campaign.imageDataUrl` into a local image file inside `tempDir`.
 */
function writeProductImageToTempFile(imageDataUrl: string, tempDir: string): {
  filePath: string;
  mimeType: string;
  base64Data: string;
} {
  const match = imageDataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i);
  if (!match) {
    throw new Error('Campaign product image must be a valid PNG, JPEG, or WEBP data URL.');
  }
  const rawMime = match[1].toLowerCase();
  const mimeType = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.byteLength < 32) {
    throw new Error('Decoded product image buffer is empty or corrupted.');
  }
  const filePath = path.join(tempDir, `product_source.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return { filePath, mimeType, base64Data };
}

/**
 * Generates an animated 9:16 commercial video clip for a single storyboard shot using
 * the `GoogleVeoVideoProviderAdapter` (`google_veo`), or an injected `omniShotGenerator`
 * for deterministic unit testing.
 * Never substitutes a static FFmpeg slideshow on failure.
 */
async function generateSingleShotWithProviderAdapter(params: {
  adapter: AiVideoProviderAdapter;
  shot: StoryboardShot;
  shotIndex: number;
  prompt: string;
  mimeType: string;
  base64Data: string;
  width: number;
  getGenAIClient?: (timeoutMs?: number) => GoogleGenAI;
  omniShotGenerator?: OmniShotVideoGeneratorFn;
  abortSignal?: AbortSignal;
  onProgressUpdate?: (message: string, progressPercent?: number) => void;
}): Promise<{
  videoBuffer: Buffer;
  providerId: AiVideoProviderId;
  modelUsed: string;
  remoteJobId?: string;
  attempts: number;
  latencyMs: number;
}> {
  const {
    adapter,
    shot,
    shotIndex,
    prompt,
    mimeType,
    base64Data,
    width,
    omniShotGenerator,
    abortSignal,
    onProgressUpdate,
  } = params;

  const durationParam: '5s' | '10s' = Number(shot.durationSeconds) > 5 ? '10s' : '5s';
  const resolutionParam: '720p' | '1080p' = width >= 1080 ? '1080p' : '720p';
  const startMs = Date.now();

  if (abortSignal?.aborted) {
    throw adapter.normalizeProviderError(
      new Error('Video render job was cancelled by the user.'),
      adapter.defaultModelId
    );
  }

  if (omniShotGenerator) {
    let attempts = 0;
    const maxAttempts = 2;
    let lastErr: unknown;
    while (attempts < maxAttempts) {
      attempts += 1;
      if (abortSignal?.aborted) {
        throw adapter.normalizeProviderError(
          new Error('Video render job was cancelled by the user.'),
          adapter.defaultModelId
        );
      }
      try {
        const result = await omniShotGenerator({
          shot,
          shotIndex,
          prompt,
          mimeType,
          base64Data,
          duration: durationParam,
          resolution: resolutionParam,
          signal: abortSignal,
        });
        const verifiedBuffer = await downloadAndVerifyVideoSource(
          { kind: 'buffer', buffer: result.videoBuffer, mimeType: 'video/mp4' },
          `${adapter.providerName} (${result.modelUsed})`
        );
        return {
          videoBuffer: verifiedBuffer,
          providerId: adapter.providerId,
          modelUsed: result.modelUsed,
          remoteJobId: `custom_${shot.shotNumber}_${attempts}`,
          attempts,
          latencyMs: Date.now() - startMs,
        };
      } catch (err) {
        lastErr = err;
        const normalized = adapter.normalizeProviderError(err, adapter.defaultModelId);
        if (!normalized.retryable || attempts >= maxAttempts) {
          throw normalized;
        }
      }
    }
    throw adapter.normalizeProviderError(lastErr, adapter.defaultModelId);
  }

  return executeProviderShotGeneration(adapter, {
    shot,
    shotIndex,
    prompt,
    mimeType,
    base64Data,
    aspectRatio: '9:16',
    durationSeconds: Number(shot.durationSeconds) || 5,
    resolution: resolutionParam,
    signal: abortSignal,
    onProgressUpdate,
  });
}

/**
 * Conforms a raw AI-generated MP4 shot clip to exact 9:16 dimensions (`width`x`height`),
 * 24fps, H.264/yuv420p, and exact `durationSec`, optionally burning in the shot's lower-third
 * voiceover caption and on-screen hook overlay while keeping the full-bleed animated AI video unobstructed.
 */
async function conformAiShotClipWithFfmpeg(params: {
  rawAiVideoPath: string;
  outputShotPath: string;
  shot: StoryboardShot;
  shotIndex: number;
  campaign: Campaign;
  settings: VideoRenderSettings;
  tempDir: string;
  width: number;
  height: number;
}): Promise<void> {
  const {
    rawAiVideoPath,
    outputShotPath,
    shot,
    shotIndex,
    campaign,
    settings,
    tempDir,
    width,
    height,
  } = params;

  const durationSec = Math.max(1, Math.min(15, Math.round(Number(shot.durationSeconds) || 3)));
  const scaleFactor = width / 1080;

  const fontBold = resolveExistingFont(FONT_BOLD_CANDIDATES);
  const fontRegular = resolveExistingFont(FONT_REGULAR_CANDIDATES);
  const fontBoldArg = fontBold ? `fontfile=${fontBold}:` : '';
  const fontRegularArg = fontRegular ? `fontfile=${fontRegular}:` : '';

  const filterChain: string[] = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    `fps=24`,
  ];

  const hookOverlayText = shot.onScreenTextOverlay?.trim() || '';
  if (hookOverlayText) {
    const hookTxtPath = path.join(tempDir, `ai_hook_${shotIndex}.txt`);
    fs.writeFileSync(hookTxtPath, wrapTextForVerticalOverlay(hookOverlayText, 28, 2), 'utf-8');
    filterChain.push(
      `drawtext=${fontBoldArg}textfile=${hookTxtPath}:fontcolor=white:fontsize=${Math.round(
        40 * scaleFactor
      )}:line_spacing=${Math.round(
        10 * scaleFactor
      )}:box=1:boxcolor=0x090d16@0.72:boxborderw=${Math.round(
        16 * scaleFactor
      )}:x=(w-text_w)/2:y=${Math.round(1420 * scaleFactor)}`
    );
  }

  const spokenText =
    shot.spokenVoiceoverSegment?.trim() ||
    campaign.storyboard?.fullVoiceoverScript?.trim() ||
    '';
  if (settings.includeSubtitles && spokenText) {
    const subTxtPath = path.join(tempDir, `ai_sub_${shotIndex}.txt`);
    fs.writeFileSync(subTxtPath, wrapTextForVerticalOverlay(spokenText, 36, 3), 'utf-8');
    filterChain.push(
      `drawtext=${fontRegularArg}textfile=${subTxtPath}:fontcolor=0xf8fafc:fontsize=${Math.round(
        30 * scaleFactor
      )}:line_spacing=${Math.round(
        8 * scaleFactor
      )}:box=1:boxcolor=0x0f172a@0.82:boxborderw=${Math.round(
        14 * scaleFactor
      )}:x=(w-text_w)/2:y=${Math.round(1560 * scaleFactor)}`
    );
  }

  filterChain.push('format=yuv420p');

  // Use stream_loop -1 on input so if a 5s AI clip is conformed to e.g. 6s it seamlessly covers the duration
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-stream_loop',
      '-1',
      '-i',
      rawAiVideoPath,
      '-vf',
      filterChain.join(','),
      '-t',
      String(durationSec),
      '-r',
      '24',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-movflags',
      '+faststart',
      outputShotPath,
    ],
    { timeout: 45000 }
  );
}

/**
 * Renders a single storyboard shot using the FFmpeg 9:16 Motion-Compositor (Basic Motion/Slideshow Mode):
 * - Preserves true product geometry and colors (never stretches the product photo)
 * - Applies shot-specific camera pan/zoom framing grounded in `shot.cameraMovement`
 * - Overlays top brand/offer safe-zone bar, shot badge, on-screen text hook, and optional subtitles
 */
async function renderSingleShotWithFfmpeg(params: {
  shot: StoryboardShot;
  shotIndex: number;
  totalShots: number;
  campaign: Campaign;
  settings: VideoRenderSettings;
  productImagePath: string;
  tempDir: string;
  width: number;
  height: number;
}): Promise<string> {
  const {
    shot,
    shotIndex,
    totalShots,
    campaign,
    settings,
    productImagePath,
    tempDir,
    width,
    height,
  } = params;

  const durationSec = Math.max(1, Math.min(15, Math.round(Number(shot.durationSeconds) || 3)));
  const scaleFactor = width / 1080;

  // Step 1: Prepare a normalized product showcase card that preserves exact aspect ratio
  const cardWidth = Math.round(900 * scaleFactor);
  const cardHeight = Math.round(920 * scaleFactor);
  const productCardPath = path.join(tempDir, `product_card_${shotIndex}.png`);

  // Subtle framing variation per shot to reflect camera focus while preserving 100% product accuracy
  const innerPad = shotIndex % 2 === 1 ? Math.round(28 * scaleFactor) : Math.round(56 * scaleFactor);
  const innerW = cardWidth - innerPad * 2;
  const innerH = cardHeight - innerPad * 2;

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      productImagePath,
      '-vf',
      `scale=${innerW}:${innerH}:force_original_aspect_ratio=decrease,pad=${cardWidth}:${cardHeight}:(ow-iw)/2:(oh-ih)/2:color=0x111827`,
      '-frames:v',
      '1',
      productCardPath,
    ],
    { timeout: 20000 }
  );

  // Step 2: Write UTF-8 text files for drawtext (prevents any special character escaping issues)
  const brandClean =
    campaign.brandName && campaign.brandName !== 'Unknown' ? campaign.brandName.trim() : '';
  const priceClean = campaign.price ? campaign.price.trim() : '';
  const headerLine = [brandClean.toUpperCase(), campaign.title.trim(), priceClean]
    .filter(Boolean)
    .join('  ·  ');

  const headerTxtPath = path.join(tempDir, `header_${shotIndex}.txt`);
  fs.writeFileSync(
    headerTxtPath,
    wrapTextForVerticalOverlay(headerLine, 42, 1),
    'utf-8'
  );

  const shotMetaLine = `SHOT 0${shot.shotNumber}/${totalShots} (${shot.timecodeRange})  ·  ${shot.shotType}`;
  const shotMetaTxtPath = path.join(tempDir, `meta_${shotIndex}.txt`);
  fs.writeFileSync(
    shotMetaTxtPath,
    wrapTextForVerticalOverlay(shotMetaLine, 48, 1),
    'utf-8'
  );

  const hookOverlayText =
    shot.onScreenTextOverlay?.trim() ||
    campaign.storyboard?.openingHook3s?.trim() ||
    campaign.title;
  const hookTxtPath = path.join(tempDir, `hook_${shotIndex}.txt`);
  fs.writeFileSync(
    hookTxtPath,
    wrapTextForVerticalOverlay(hookOverlayText, 26, 2),
    'utf-8'
  );

  const spokenText =
    shot.spokenVoiceoverSegment?.trim() ||
    campaign.storyboard?.fullVoiceoverScript?.trim() ||
    '';
  const subtitleTxtPath = path.join(tempDir, `sub_${shotIndex}.txt`);
  fs.writeFileSync(
    subtitleTxtPath,
    wrapTextForVerticalOverlay(spokenText, 36, 3),
    'utf-8'
  );

  const cameraLine = `Camera: ${shot.cameraMovement || 'Smooth studio motion'}${
    settings.revisionNote ? ` · Rev: ${settings.revisionNote}` : ''
  }`;
  const cameraTxtPath = path.join(tempDir, `cam_${shotIndex}.txt`);
  fs.writeFileSync(
    cameraTxtPath,
    wrapTextForVerticalOverlay(cameraLine, 52, 1),
    'utf-8'
  );

  // Step 3: Build dynamic camera drift expression based on shot movement
  const camLower = (shot.cameraMovement || '').toLowerCase();
  const driftPx = Math.round(26 * scaleFactor);
  let overlayXExpr = `(W-w)/2`;
  let overlayYExpr = `${Math.round(350 * scaleFactor)}`;

  if (camLower.includes('pan') || camLower.includes('track') || shotIndex % 3 === 1) {
    overlayXExpr = `(W-w)/2-${driftPx}+2*${driftPx}*(t/${durationSec})`;
  } else if (camLower.includes('tilt') || camLower.includes('rise') || shotIndex % 3 === 2) {
    overlayYExpr = `${Math.round(368 * scaleFactor)}-${Math.round(36 * scaleFactor)}*(t/${durationSec})`;
  } else {
    overlayXExpr = `(W-w)/2-${Math.round(14 * scaleFactor)}+${Math.round(28 * scaleFactor)}*(t/${durationSec})`;
    overlayYExpr = `${Math.round(360 * scaleFactor)}-${Math.round(22 * scaleFactor)}*(t/${durationSec})`;
  }

  const fontBold = resolveExistingFont(FONT_BOLD_CANDIDATES);
  const fontRegular = resolveExistingFont(FONT_REGULAR_CANDIDATES);
  const fontMono = resolveExistingFont(FONT_MONO_CANDIDATES);

  const dominantBgHex = toFfmpegHexColor(
    campaign.productProfile?.dominantColors?.[0]?.hex,
    '0x0b1120'
  );
  const accentHex = toFfmpegHexColor(
    campaign.productProfile?.dominantColors?.[1]?.hex,
    '0xea580c'
  );

  const topBarH = Math.round(230 * scaleFactor);
  const bottomBarY = Math.round(1330 * scaleFactor);
  const bottomBarH = height - bottomBarY;
  const accentBarH = Math.round(8 * scaleFactor);

  const filterSteps: string[] = [
    `[0:v][1:v]overlay=x='${overlayXExpr}':y='${overlayYExpr}':shortest=1`,
    `drawbox=x=0:y=0:w=${width}:h=${topBarH}:color=0x090d16@0.92:t=fill`,
    `drawbox=x=0:y=${topBarH}:w=${width}:h=${accentBarH}:color=${accentHex}@0.95:t=fill`,
    `drawbox=x=0:y=${bottomBarY}:w=${width}:h=${bottomBarH}:color=0x090d16@0.92:t=fill`,
    `drawbox=x=0:y=${bottomBarY}:w=${width}:h=${accentBarH}:color=${accentHex}@0.95:t=fill`,
  ];

  const fontBoldArg = fontBold ? `fontfile=${fontBold}:` : '';
  const fontRegularArg = fontRegular ? `fontfile=${fontRegular}:` : '';
  const fontMonoArg = fontMono ? `fontfile=${fontMono}:` : '';

  filterSteps.push(
    `drawtext=${fontBoldArg}textfile=${headerTxtPath}:fontcolor=white:fontsize=${Math.round(
      32 * scaleFactor
    )}:x=(w-text_w)/2:y=${Math.round(68 * scaleFactor)}`
  );

  filterSteps.push(
    `drawtext=${fontMonoArg}textfile=${shotMetaTxtPath}:fontcolor=0xfb923c:fontsize=${Math.round(
      24 * scaleFactor
    )}:x=(w-text_w)/2:y=${Math.round(132 * scaleFactor)}`
  );

  filterSteps.push(
    `drawtext=${fontRegularArg}textfile=${cameraTxtPath}:fontcolor=0x94a3b8:fontsize=${Math.round(
      20 * scaleFactor
    )}:x=(w-text_w)/2:y=${Math.round(176 * scaleFactor)}`
  );

  filterSteps.push(
    `drawtext=${fontBoldArg}textfile=${hookTxtPath}:fontcolor=white:fontsize=${Math.round(
      46 * scaleFactor
    )}:line_spacing=${Math.round(12 * scaleFactor)}:x=(w-text_w)/2:y=${Math.round(
      1385 * scaleFactor
    )}`
  );

  if (settings.includeSubtitles && spokenText) {
    filterSteps.push(
      `drawtext=${fontRegularArg}textfile=${subtitleTxtPath}:fontcolor=0xe2e8f0:fontsize=${Math.round(
        31 * scaleFactor
      )}:line_spacing=${Math.round(10 * scaleFactor)}:box=1:boxcolor=0x1e293b@0.85:boxborderw=${Math.round(
        18 * scaleFactor
      )}:x=(w-text_w)/2:y=${Math.round(1545 * scaleFactor)}`
    );
  }

  filterSteps.push(`fade=t=in:st=0:d=0.22,format=yuv420p[vout]`);

  const shotOutputPath = path.join(tempDir, `shot_${shotIndex}.mp4`);

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${dominantBgHex}:s=${width}x${height}:d=${durationSec}:r=24`,
      '-loop',
      '1',
      '-t',
      String(durationSec),
      '-r',
      '24',
      '-i',
      productCardPath,
      '-filter_complex',
      filterSteps.join(','),
      '-map',
      '[vout]',
      '-t',
      String(durationSec),
      '-r',
      '24',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '21',
      '-pix_fmt',
      'yuv420p',
      '-an',
      shotOutputPath,
    ],
    { timeout: 45000 }
  );

  return shotOutputPath;
}

/**
 * Executes the complete 9:16 vertical MP4 video rendering pipeline for a campaign:
 * - In `ai_video_omni` mode: Generates a genuine animated 9:16 video clip per storyboard shot
 *   using `gemini-omni-1.1-flash` (`ai.interactions.create`), validates each clip, conforms it to
 *   exact shot timing, and NEVER silently substitutes the static FFmpeg slideshow on failure.
 * - In `basic_slideshow_ffmpeg` / `ffmpeg_motion_compositor` mode: Renders the local FFmpeg
 *   static product card slideshow explicitly labeled as non-AI video.
 * - Supports per-shot progress tracking, `retryFailedShotsOnly` (reusing already-completed shots),
 *   and `abortSignal` cancellation.
 */
export async function renderCampaignVerticalVideo(params: {
  campaign: Campaign;
  settings: VideoRenderSettings;
  jobId: string;
  videosDir: string;
  audioDir: string;
  getGenAIClient?: (timeoutMs?: number) => GoogleGenAI;
  videoProviderAdapter?: AiVideoProviderAdapter;
  omniShotGenerator?: OmniShotVideoGeneratorFn;
  previousShotResults?: ShotRenderState[];
  abortSignal?: AbortSignal;
  callbacks?: RenderExecutionCallbacks;
}): Promise<RenderPipelineResult> {
  const {
    campaign,
    settings,
    jobId,
    videosDir,
    audioDir,
    getGenAIClient,
    videoProviderAdapter,
    omniShotGenerator,
    previousShotResults,
    abortSignal,
    callbacks,
  } = params;

  if (!isSafeIdentifier(campaign.id) || !isSafeIdentifier(jobId)) {
    throw new Error('Unsafe campaign or render job identifier.');
  }

  if (!campaign.storyboard || campaign.storyboard.shots.length === 0) {
    throw new Error('Campaign storyboard is missing or has zero shots.');
  }

  const voiceoverPath = resolveSafeAudioFilePath(campaign.voiceover?.audioFileUrl, audioDir);
  if (!voiceoverPath) {
    throw new Error(
      'Campaign voiceover WAV file could not be found on the server. Please regenerate the voiceover in Step 03.'
    );
  }

  const musicPath =
    campaign.backgroundMusic &&
    (campaign.backgroundMusic.status === 'custom_uploaded' ||
      campaign.backgroundMusic.status === 'generated')
      ? resolveSafeAudioFilePath(campaign.backgroundMusic.audioFileUrl, audioDir)
      : null;

  if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
  }

  const resolvedVideosDir = path.resolve(videosDir);
  const [width, height] = settings.resolution === '720x1280' ? [720, 1280] : [1080, 1920];
  const shots = campaign.storyboard.shots;
  const totalTargetDuration = Math.max(
    3,
    shots.reduce((sum, s) => sum + Math.max(1, Math.min(15, Math.round(Number(s.durationSeconds) || 3))), 0)
  );

  const isStrictAiMode = isAiVideoEnginePreference(settings.enginePreference);
  const activeAdapter: AiVideoProviderAdapter | null = isStrictAiMode
    ? videoProviderAdapter || resolveAiVideoProviderAdapter(settings.enginePreference)
    : null;

  const engineMeta = getEngineDisplayMetadata(settings.enginePreference);
  let providerUsed: AiVideoProviderId | 'ffmpeg_local' = activeAdapter
    ? activeAdapter.providerId
    : engineMeta.providerUsed;
  let modelUsed = activeAdapter ? activeAdapter.defaultModelId : engineMeta.modelUsed;
  let engineUsed: RenderEngineUsed = activeAdapter
    ? activeAdapter.engineUsed
    : engineMeta.engineUsed;
  let engineLabel = activeAdapter
    ? `${activeAdapter.providerName} · ${activeAdapter.defaultModelId}`
    : engineMeta.engineLabel;
  let isAiVideoGenerated = engineMeta.isAiVideoGenerated;
  let omniFallbackReason: string | undefined;

  let shotResults: ShotRenderState[] = createInitialShotRenderStates(
    campaign,
    previousShotResults || campaign.activeRenderJob?.shotResults || campaign.renderHistory?.[0]?.shotResults,
    Boolean(settings.retryFailedShotsOnly)
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `adstudio_render_${jobId}_`));

  const checkAbort = () => {
    if (abortSignal?.aborted) {
      shotResults = shotResults.map((s) =>
        s.status === 'generating' || s.status === 'queued'
          ? { ...s, status: 'cancelled', updatedAt: new Date().toISOString() }
          : s
      );
      throw new VideoRenderError('Video render job was cancelled by the user.', {
        failureCategory: 'cancelled',
        shotResults,
        providerUsed,
        modelUsed,
        engineUsed,
        engineLabel,
        isAiVideoGenerated,
      });
    }
  };

  try {
    checkAbort();
    callbacks?.onProgress?.(
      10,
      isStrictAiMode && activeAdapter
        ? `Decoding product reference image and preparing per-shot 9:16 prompts for ${activeAdapter.providerName}...`
        : 'Decoding product image and preparing 9:16 vertical studio canvas...',
      {
        status: 'generating',
        shotResults,
        providerUsed,
        modelUsed,
        engineUsed,
        engineLabel,
        isAiVideoGenerated,
      }
    );

    const { filePath: productImagePath, mimeType, base64Data } = writeProductImageToTempFile(
      campaign.imageDataUrl,
      tempDir
    );

    const shotFilePaths: string[] = [];

    if (isStrictAiMode && activeAdapter) {
      // STRICT PER-SHOT AI VIDEO GENERATION MODE (Never silently falls back to static FFmpeg slideshow)
      for (let i = 0; i < shots.length; i++) {
        checkAbort();
        const shot = shots[i];
        const existingShotState = shotResults.find((s) => s.shotNumber === shot.shotNumber);
        const persistedShotFilename = `render_${campaign.id}_shot_${shot.shotNumber}.mp4`;
        const persistedShotPath = path.resolve(resolvedVideosDir, persistedShotFilename);

        // Reuse already-completed shot if retryFailedShotsOnly is enabled and the MP4 clip exists and is valid
        if (
          settings.retryFailedShotsOnly &&
          existingShotState?.status === 'completed' &&
          fs.existsSync(persistedShotPath)
        ) {
          const checkBuf = fs.readFileSync(persistedShotPath);
          if (verifyPlayableMp4Buffer(checkBuf).valid) {
            shotFilePaths.push(persistedShotPath);
            const pct = 15 + Math.round(((i + 1) / shots.length) * 60);
            callbacks?.onProgress?.(
              pct,
              `Reused verified AI video clip for Shot 0${shot.shotNumber}/${shots.length} (${shot.shotType})...`,
              { status: 'generating', shotResults }
            );
            continue;
          }
        }

        const shotPrompt = buildCommercialShotVideoPrompt(campaign, shot);
        shotResults = updateShotRenderState(shotResults, shot.shotNumber, {
          status: 'generating',
          providerUsed: activeAdapter.providerId,
          engineUsed: activeAdapter.engineUsed,
          modelUsed: activeAdapter.defaultModelId,
          promptUsed: shotPrompt,
          errorMessage: undefined,
          failureCategory: undefined,
        });

        const startPct = 15 + Math.round((i / shots.length) * 60);
        callbacks?.onProgress?.(
          startPct,
          `Generating AI video for Shot 0${shot.shotNumber}/${shots.length} (${shot.shotType}) via ${activeAdapter.providerName} (${activeAdapter.defaultModelId})...`,
          { status: 'generating', shotResults }
        );

        try {
          const genResult = await generateSingleShotWithProviderAdapter({
            adapter: activeAdapter,
            shot,
            shotIndex: i,
            prompt: shotPrompt,
            mimeType,
            base64Data,
            width,
            getGenAIClient,
            omniShotGenerator,
            abortSignal,
            onProgressUpdate: (msg) => {
              callbacks?.onProgress?.(startPct, msg, {
                status: 'generating',
                shotResults,
              });
            },
          });

          modelUsed = genResult.modelUsed;
          providerUsed = genResult.providerId;
          engineLabel = `${activeAdapter.providerName} · ${genResult.modelUsed}`;

          const rawAiShotPath = path.join(tempDir, `raw_ai_shot_${shot.shotNumber}.mp4`);
          fs.writeFileSync(rawAiShotPath, genResult.videoBuffer);

          // Probe raw clip to verify it has a genuine video stream with non-zero dimensions and duration
          const rawProbe = await probeRenderedVideoFile(rawAiShotPath);
          if (
            !rawProbe.videoCodec ||
            rawProbe.width <= 0 ||
            rawProbe.height <= 0 ||
            rawProbe.videoDurationSeconds <= 0
          ) {
            throw new Error(
              `Invalid video output from ${activeAdapter.providerName}: raw clip has no playable video stream (codec=${rawProbe.videoCodec}, ${rawProbe.width}x${rawProbe.height}, duration=${rawProbe.videoDurationSeconds}s).`
            );
          }

          await conformAiShotClipWithFfmpeg({
            rawAiVideoPath: rawAiShotPath,
            outputShotPath: persistedShotPath,
            shot,
            shotIndex: i,
            campaign,
            settings,
            tempDir,
            width,
            height,
          });

          const conformedBuf = fs.readFileSync(persistedShotPath);
          const conformedCheck = verifyPlayableMp4Buffer(conformedBuf);
          if (!conformedCheck.valid) {
            throw new Error(
              `Invalid video output: conformed AI clip for Shot ${shot.shotNumber} failed MP4 check: ${conformedCheck.error}`
            );
          }

          shotFilePaths.push(persistedShotPath);
          shotResults = updateShotRenderState(shotResults, shot.shotNumber, {
            status: 'completed',
            providerUsed: genResult.providerId,
            engineUsed: activeAdapter.engineUsed,
            modelUsed: genResult.modelUsed,
            remoteJobId: genResult.remoteJobId,
            clipFileUrl: `/api/video/${persistedShotFilename}`,
            conformedFilePath: persistedShotPath,
            byteLength: conformedBuf.byteLength,
            attempts: (existingShotState?.attempts || 0) + genResult.attempts,
            latencyMs: genResult.latencyMs,
            promptUsed: shotPrompt,
            errorMessage: undefined,
            failureCategory: undefined,
          });

          const donePct = 15 + Math.round(((i + 1) / shots.length) * 60);
          callbacks?.onProgress?.(
            donePct,
            `Completed AI video clip for Shot 0${shot.shotNumber}/${shots.length} (${shot.shotType}) via ${genResult.modelUsed}.`,
            { status: 'generating', shotResults }
          );
        } catch (shotErr: unknown) {
          const classified = classifyVideoGenerationError(
            shotErr,
            `${activeAdapter.providerName} (${activeAdapter.defaultModelId})`
          );
          shotResults = updateShotRenderState(shotResults, shot.shotNumber, {
            status: classified.category === 'cancelled' ? 'cancelled' : 'failed',
            providerUsed: activeAdapter.providerId,
            engineUsed: activeAdapter.engineUsed,
            modelUsed: activeAdapter.defaultModelId,
            attempts: (existingShotState?.attempts || 0) + 1,
            promptUsed: shotPrompt,
            errorMessage: classified.userMessage,
            failureCategory: classified.category,
          });

          if (classified.category === 'cancelled') {
            shotResults = shotResults.map((s) =>
              s.status === 'queued' ? { ...s, status: 'cancelled' } : s
            );
          }

          throw new VideoRenderError(
            `Shot 0${shot.shotNumber} (${shot.shotType}) AI video generation failed: ${classified.userMessage}`,
            {
              failureCategory: classified.category,
              shotResults,
              providerUsed: activeAdapter.providerId,
              modelUsed: activeAdapter.defaultModelId,
              engineUsed: activeAdapter.engineUsed,
              engineLabel: `${activeAdapter.providerName} · ${activeAdapter.defaultModelId}`,
              isAiVideoGenerated: false,
            }
          );
        }
      }
    } else {
      // BASIC MOTION / SLIDESHOW RENDER MODE (FFmpeg Static Product Card Compositor)
      for (let i = 0; i < shots.length; i++) {
        checkAbort();
        const shot = shots[i];
        const shotStartMs = Date.now();
        shotResults = updateShotRenderState(shotResults, shot.shotNumber, {
          status: 'generating',
          providerUsed: 'ffmpeg_local',
          engineUsed: 'ffmpeg_motion_compositor',
          modelUsed: 'ffmpeg_motion_compositor',
        });

        const pct = 20 + Math.round(((i + 1) / shots.length) * 50);
        callbacks?.onProgress?.(
          pct,
          `Compositing Basic Motion Card for Shot 0${shot.shotNumber}/${shots.length} (${shot.timecodeRange} · ${shot.shotType}) at ${width}×${height}...`,
          { status: 'generating', shotResults }
        );

        const shotPath = await renderSingleShotWithFfmpeg({
          shot,
          shotIndex: i,
          totalShots: shots.length,
          campaign,
          settings,
          productImagePath,
          tempDir,
          width,
          height,
        });

        const persistedShotFilename = `render_${campaign.id}_shot_${shot.shotNumber}.mp4`;
        const persistedShotPath = path.resolve(resolvedVideosDir, persistedShotFilename);
        fs.copyFileSync(shotPath, persistedShotPath);
        const shotBuf = fs.readFileSync(persistedShotPath);

        shotFilePaths.push(persistedShotPath);
        shotResults = updateShotRenderState(shotResults, shot.shotNumber, {
          status: 'completed',
          providerUsed: 'ffmpeg_local',
          engineUsed: 'ffmpeg_motion_compositor',
          modelUsed: 'ffmpeg_motion_compositor',
          clipFileUrl: `/api/video/${persistedShotFilename}`,
          conformedFilePath: persistedShotPath,
          byteLength: shotBuf.byteLength,
          attempts: 1,
          latencyMs: Date.now() - shotStartMs,
        });
      }
    }

    checkAbort();

    // Concatenate all rendered shot MP4s into a continuous 9:16 video stream
    callbacks?.onProgress?.(
      78,
      'Stitching 9:16 storyboard shot clips and synchronizing timecodes...',
      { status: 'stitching', shotResults }
    );
    const concatListPath = path.join(tempDir, 'concat_shots.txt');
    const concatLines = shotFilePaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(concatListPath, concatLines, 'utf-8');

    const concatenatedVideoPath = path.join(tempDir, 'video_concat.mp4');
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatListPath,
        '-c',
        'copy',
        concatenatedVideoPath,
      ],
      { timeout: 30000 }
    );

    checkAbort();

    // Master final MP4 by mixing voiceover WAV + optional background music track
    callbacks?.onProgress?.(
      88,
      musicPath
        ? 'Mixing 24kHz voiceover WAV with ducked background music and encoding H.264/AAC MP4...'
        : 'Mastering 24kHz voiceover WAV audio track and encoding H.264/AAC 9:16 MP4...',
      { status: 'stitching', shotResults }
    );

    const outputFilename = `render_${campaign.id}_${jobId}.mp4`;
    const outputFilePath = path.resolve(resolvedVideosDir, outputFilename);
    if (!outputFilePath.startsWith(resolvedVideosDir + path.sep)) {
      throw new Error('Invalid output video file path.');
    }

    if (musicPath) {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i',
          concatenatedVideoPath,
          '-i',
          voiceoverPath,
          '-stream_loop',
          '-1',
          '-i',
          musicPath,
          '-filter_complex',
          `[1:a]aresample=44100,volume=1.0,apad=whole_dur=${totalTargetDuration}[vo];[2:a]aresample=44100,volume=0.18,atrim=0:${totalTargetDuration}[bgm];[vo][bgm]amix=inputs=2:duration=first:dropout_transition=2,atrim=0:${totalTargetDuration}[aout]`,
          '-map',
          '0:v:0',
          '-map',
          '[aout]',
          '-t',
          String(totalTargetDuration),
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-ar',
          '44100',
          '-ac',
          '2',
          '-movflags',
          '+faststart',
          outputFilePath,
        ],
        { timeout: 45000 }
      );
    } else {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i',
          concatenatedVideoPath,
          '-i',
          voiceoverPath,
          '-filter_complex',
          `[1:a]aresample=44100,apad=whole_dur=${totalTargetDuration},atrim=0:${totalTargetDuration}[aout]`,
          '-map',
          '0:v:0',
          '-map',
          '[aout]',
          '-t',
          String(totalTargetDuration),
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-ar',
          '44100',
          '-ac',
          '2',
          '-movflags',
          '+faststart',
          outputFilePath,
        ],
        { timeout: 45000 }
      );
    }

    callbacks?.onProgress?.(
      96,
      'Verifying playable MP4 container atoms and audio/video synchronization...',
      { status: 'stitching', shotResults }
    );

    const mp4Buffer = fs.readFileSync(outputFilePath);
    const atomCheck = verifyPlayableMp4Buffer(mp4Buffer);
    if (!atomCheck.valid) {
      throw new Error(atomCheck.error || 'Rendered MP4 failed container validation.');
    }

    const probedMetadata = await probeRenderedVideoFile(outputFilePath);
    if (probedMetadata.width !== width || probedMetadata.height !== height) {
      throw new Error(
        `Rendered video dimensions (${probedMetadata.width}×${probedMetadata.height}) did not match requested 9:16 resolution (${width}×${height}).`
      );
    }

    const syncCheck = verifyAudioVideoDurationSync({
      targetDurationSeconds: totalTargetDuration,
      videoDurationSeconds: probedMetadata.videoDurationSeconds,
      audioDurationSeconds: probedMetadata.audioDurationSeconds,
      toleranceSeconds: 1.0,
    });

    if (!syncCheck.synchronized) {
      throw new Error(syncCheck.error || 'Audio/video duration synchronization check failed.');
    }

    callbacks?.onProgress?.(
      100,
      isAiVideoGenerated
        ? 'Per-shot 9:16 AI video generation and audio mastering completed and verified.'
        : 'Basic Motion/Slideshow 9:16 MP4 render completed and verified.',
      { status: 'completed', shotResults }
    );

    return {
      outputFilePath,
      videoFileUrl: `/api/video/${outputFilename}`,
      byteLength: mp4Buffer.byteLength,
      width: probedMetadata.width,
      height: probedMetadata.height,
      durationSeconds: Math.round(probedMetadata.videoDurationSeconds * 10) / 10,
      providerUsed,
      modelUsed,
      engineUsed,
      engineLabel,
      isAiVideoGenerated,
      omniFallbackReason,
      shotResults,
      probedMetadata,
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

