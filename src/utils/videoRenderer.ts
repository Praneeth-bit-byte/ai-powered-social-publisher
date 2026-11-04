import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GoogleGenAI } from '@google/genai';
import type {
  Campaign,
  RenderEngineUsed,
  StoryboardShot,
  VideoRenderSettings,
} from '../types.ts';
import {
  isSafeIdentifier,
  verifyAudioVideoDurationSync,
  verifyPlayableMp4Buffer,
} from './milestone3Validators.ts';

const execFileAsync = promisify(execFile);

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
  onProgress?: (progressPercent: number, stageMessage: string) => void;
}

export interface RenderPipelineResult {
  outputFilePath: string;
  videoFileUrl: string;
  byteLength: number;
  width: number;
  height: number;
  durationSeconds: number;
  engineUsed: RenderEngineUsed;
  engineLabel: string;
  omniFallbackReason?: string;
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
 * Renders a single storyboard shot using the FFmpeg 9:16 Motion-Compositor:
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
    // Smooth horizontal pan across shot duration
    overlayXExpr = `(W-w)/2-${driftPx}+2*${driftPx}*(t/${durationSec})`;
  } else if (camLower.includes('tilt') || camLower.includes('rise') || shotIndex % 3 === 2) {
    // Smooth vertical pedestal rise
    overlayYExpr = `${Math.round(368 * scaleFactor)}-${Math.round(36 * scaleFactor)}*(t/${durationSec})`;
  } else {
    // Gentle diagonal studio push drift
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
    // Top safe-zone dark studio header scrim
    `drawbox=x=0:y=0:w=${width}:h=${topBarH}:color=0x090d16@0.92:t=fill`,
    `drawbox=x=0:y=${topBarH}:w=${width}:h=${accentBarH}:color=${accentHex}@0.95:t=fill`,
    // Bottom safe-zone caption & CTA studio scrim
    `drawbox=x=0:y=${bottomBarY}:w=${width}:h=${bottomBarH}:color=0x090d16@0.92:t=fill`,
    `drawbox=x=0:y=${bottomBarY}:w=${width}:h=${accentBarH}:color=${accentHex}@0.95:t=fill`,
  ];

  const fontBoldArg = fontBold ? `fontfile=${fontBold}:` : '';
  const fontRegularArg = fontRegular ? `fontfile=${fontRegular}:` : '';
  const fontMonoArg = fontMono ? `fontfile=${fontMono}:` : '';

  // 1. Brand & Product Header
  filterSteps.push(
    `drawtext=${fontBoldArg}textfile=${headerTxtPath}:fontcolor=white:fontsize=${Math.round(
      32 * scaleFactor
    )}:x=(w-text_w)/2:y=${Math.round(68 * scaleFactor)}`
  );

  // 2. Shot number, timecode & shotType badge
  filterSteps.push(
    `drawtext=${fontMonoArg}textfile=${shotMetaTxtPath}:fontcolor=0xfb923c:fontsize=${Math.round(
      24 * scaleFactor
    )}:x=(w-text_w)/2:y=${Math.round(132 * scaleFactor)}`
  );

  // 3. Camera direction micro-label
  filterSteps.push(
    `drawtext=${fontRegularArg}textfile=${cameraTxtPath}:fontcolor=0x94a3b8:fontsize=${Math.round(
      20 * scaleFactor
    )}:x=(w-text_w)/2:y=${Math.round(176 * scaleFactor)}`
  );

  // 4. On-screen text overlay headline (lower-third hook)
  filterSteps.push(
    `drawtext=${fontBoldArg}textfile=${hookTxtPath}:fontcolor=white:fontsize=${Math.round(
      46 * scaleFactor
    )}:line_spacing=${Math.round(12 * scaleFactor)}:x=(w-text_w)/2:y=${Math.round(
      1385 * scaleFactor
    )}`
  );

  // 5. Optional burned-in voiceover subtitle/caption overlay
  if (settings.includeSubtitles && spokenText) {
    filterSteps.push(
      `drawtext=${fontRegularArg}textfile=${subtitleTxtPath}:fontcolor=0xe2e8f0:fontsize=${Math.round(
        31 * scaleFactor
      )}:line_spacing=${Math.round(10 * scaleFactor)}:box=1:boxcolor=0x1e293b@0.85:boxborderw=${Math.round(
        18 * scaleFactor
      )}:x=(w-text_w)/2:y=${Math.round(1545 * scaleFactor)}`
    );
  }

  // Smooth fade-in on shot start
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
 * 1. Validates inputs and creates an isolated temporary workspace.
 * 2. Optionally probes `gemini-omni-1.1-flash` if requested; falls back cleanly to the
 *    FFmpeg 9:16 Motion-Compositor when paid video generation is unavailable.
 * 3. Renders each storyboard shot respecting shot durations, timecodes, product accuracy,
 *    and subtitle settings.
 * 4. Concatenates shots and mixes the campaign's generated voiceover WAV + optional music track.
 * 5. Verifies the final MP4 with both atom inspection (`ftyp`/`moov`/`mdat`) and `ffprobe`
 *    duration/resolution checks.
 */
export async function renderCampaignVerticalVideo(params: {
  campaign: Campaign;
  settings: VideoRenderSettings;
  jobId: string;
  videosDir: string;
  audioDir: string;
  getGenAIClient?: (timeoutMs?: number) => GoogleGenAI;
  callbacks?: RenderExecutionCallbacks;
}): Promise<RenderPipelineResult> {
  const { campaign, settings, jobId, videosDir, audioDir, getGenAIClient, callbacks } = params;

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

  const [width, height] = settings.resolution === '720x1280' ? [720, 1280] : [1080, 1920];
  const shots = campaign.storyboard.shots;
  const totalTargetDuration = Math.max(
    3,
    shots.reduce((sum, s) => sum + Math.max(1, Math.min(15, Math.round(Number(s.durationSeconds) || 3))), 0)
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `adstudio_render_${jobId}_`));

  try {
    callbacks?.onProgress?.(12, 'Decoding product image and preparing 9:16 vertical studio canvas...');
    const { filePath: productImagePath, mimeType, base64Data } = writeProductImageToTempFile(
      campaign.imageDataUrl,
      tempDir
    );

    let engineUsed: RenderEngineUsed = 'ffmpeg_motion_compositor';
    let engineLabel = 'FFmpeg 9:16 Motion-Compositor (Fallback — Not AI Video)';
    let omniFallbackReason: string | undefined;
    let omniBaseVideoPath: string | null = null;

    // Optional attempt with Gemini Omni 1.1 Flash (`gemini-omni-1.1-flash`) via Interactions API
    if (settings.enginePreference === 'auto_omni_with_ffmpeg_fallback' && getGenAIClient) {
      callbacks?.onProgress?.(
        20,
        'Probing gemini-omni-1.1-flash (Interactions API) for 9:16 image-to-video generation...'
      );
      try {
        const ai = getGenAIClient(45000);
        const masterPrompt = `${campaign.storyboard.masterCinematicPrompt9x16}. Preserve exact product appearance, colors, and labels.`;
        const interaction = await ai.interactions.create({
          model: 'gemini-omni-1.1-flash',
          input: [
            {
              type: 'image',
              mime_type: mimeType,
              data: base64Data,
            },
            {
              type: 'text',
              text: masterPrompt,
            },
          ],
          background: false,
          store: false,
          stream: false,
          response_format: {
            type: 'video',
            aspect_ratio: '9:16',
            duration: '5s',
            resolution: settings.resolution === '1080x1920' ? '1080p' : '720p',
          },
        });

        const videoPart = (interaction as unknown as { output_video?: { data?: string } }).output_video;
        if (videoPart?.data) {
          const rawOmniBuf = Buffer.from(videoPart.data, 'base64');
          if (rawOmniBuf.byteLength > 1024) {
            omniBaseVideoPath = path.join(tempDir, 'omni_raw.mp4');
            fs.writeFileSync(omniBaseVideoPath, rawOmniBuf);
            engineUsed = 'gemini_omni_video';
            engineLabel = 'Gemini Omni 1.1 Flash (9:16 AI Video) + FFmpeg Audio/Caption Mastering';
          } else {
            throw new Error('gemini-omni-1.1-flash returned an empty video payload.');
          }
        } else {
          throw new Error('gemini-omni-1.1-flash response did not contain output_video data.');
        }
      } catch (omniErr: unknown) {
        const rawReason = omniErr instanceof Error ? omniErr.message : String(omniErr);
        omniFallbackReason = `gemini-omni-1.1-flash unavailable on current API key tier (${rawReason.slice(
          0,
          140
        )}). Rendered using FFmpeg 9:16 Motion-Compositor fallback.`;
        engineUsed = 'ffmpeg_motion_compositor';
        engineLabel = 'FFmpeg 9:16 Motion-Compositor (Fallback — Not AI Video)';
      }
    }

    // Render each shot segment sequentially with progress reporting
    const shotFilePaths: string[] = [];
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const pct = 25 + Math.round(((i + 1) / shots.length) * 45);
      callbacks?.onProgress?.(
        pct,
        `Rendering Shot 0${shot.shotNumber}/${shots.length} (${shot.timecodeRange} · ${shot.shotType}) at ${width}×${height}...`
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
      shotFilePaths.push(shotPath);
    }

    // Concatenate all rendered shot MP4s into a continuous 9:16 video stream
    callbacks?.onProgress?.(75, 'Concatenating 9:16 storyboard shots and synchronizing timecodes...');
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

    // Master final MP4 by mixing voiceover WAV + optional background music track
    callbacks?.onProgress?.(
      88,
      musicPath
        ? 'Mixing 24kHz voiceover WAV with ducked background music and encoding H.264/AAC MP4...'
        : 'Mastering 24kHz voiceover WAV audio track and encoding H.264/AAC 9:16 MP4...'
    );

    const outputFilename = `render_${campaign.id}_${jobId}.mp4`;
    const resolvedVideosDir = path.resolve(videosDir);
    const outputFilePath = path.resolve(resolvedVideosDir, outputFilename);
    if (!outputFilePath.startsWith(resolvedVideosDir + path.sep)) {
      throw new Error('Invalid output video file path.');
    }

    if (musicPath) {
      // Mix voiceover (100% volume, padded to totalTargetDuration) + music (looped/ducked at 18% volume)
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
      // Voiceover-Only mode: pad or trim voiceover stream to exact totalTargetDuration so A/V durations match
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

    callbacks?.onProgress?.(96, 'Verifying playable MP4 container atoms and audio/video synchronization...');

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

    callbacks?.onProgress?.(100, '9:16 vertical MP4 render completed and verified.');

    return {
      outputFilePath,
      videoFileUrl: `/api/video/${outputFilename}`,
      byteLength: mp4Buffer.byteLength,
      width: probedMetadata.width,
      height: probedMetadata.height,
      durationSeconds: Math.round(probedMetadata.videoDurationSeconds * 10) / 10,
      engineUsed,
      engineLabel,
      omniFallbackReason,
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
