import type {
  SupportedVoiceName,
  StoryboardShot,
  VideoConceptAndStoryboard,
  BackgroundMusicState,
} from '../types.ts';

export const SUPPORTED_VOICES: readonly SupportedVoiceName[] = [
  'Kore',
  'Puck',
  'Charon',
  'Fenrir',
  'Zephyr',
] as const;

export interface VoiceOptionMeta {
  name: SupportedVoiceName;
  label: string;
  toneSummary: string;
  defaultStylePrompt: string;
}

export const VOICE_OPTIONS_META: VoiceOptionMeta[] = [
  {
    name: 'Kore',
    label: 'Kore — Crisp & Editorial',
    toneSummary: 'Balanced, articulate studio narrator ideal for luxury, beauty, and D2C hero spots.',
    defaultStylePrompt: 'Polished, confident commercial narrator with warm studio clarity',
  },
  {
    name: 'Puck',
    label: 'Puck — Energetic & Social-Native',
    toneSummary: 'Upbeat, fast-paced creator voice suited for high-converting Reels and Shorts hooks.',
    defaultStylePrompt: 'Enthusiastic, upbeat short-form creator voice with punchy pacing',
  },
  {
    name: 'Charon',
    label: 'Charon — Deep & Authoritative',
    toneSummary: 'Rich, resonant low-register voice for hardware, coffee gear, and flagship launches.',
    defaultStylePrompt: 'Calm, authoritative cinematic narrator with rich resonance',
  },
  {
    name: 'Fenrir',
    label: 'Fenrir — Bold & Athletic',
    toneSummary: 'Dynamic, high-drive delivery built for endurance sports, outdoor gear, and action ads.',
    defaultStylePrompt: 'Focused, high-energy athletic commercial voiceover',
  },
  {
    name: 'Zephyr',
    label: 'Zephyr — Warm & Conversational',
    toneSummary: 'Natural, approachable founder-led tone for wellness, botanicals, and everyday lifestyle.',
    defaultStylePrompt: 'Warm, conversational, trustworthy founder storytelling tone',
  },
];

/**
 * Ensures a Buffer returned from Gemini TTS has a valid 44-byte RIFF WAVE header.
 * Unary `gemini-3.8-flash-lite-tts` returns a complete WAV file (RIFF header),
 * while streaming or fallback endpoints may return headerless 24kHz 16-bit mono PCM.
 */
export function ensureValidWavBuffer(
  inputBuffer: Buffer,
  sampleRate = 24000,
  numChannels = 1,
  bitsPerSample = 16
): Buffer {
  if (
    inputBuffer.length >= 44 &&
    inputBuffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    inputBuffer.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return inputBuffer;
  }

  const dataByteLength = inputBuffer.length;
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataByteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // AudioFormat 1 = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataByteLength, 40);

  return Buffer.concat([header, inputBuffer]);
}

/**
 * Verifies that a WAV Buffer is a valid 24,000 Hz, 16-bit, mono RIFF WAVE file
 * containing non-empty PCM audio samples.
 */
export function verifyWavFormat24kMono16Bit(wavBuffer: Buffer): {
  valid: boolean;
  error?: string;
  sampleRateHz?: number;
  numChannels?: number;
  bitsPerSample?: number;
  dataByteLength?: number;
} {
  if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length <= 44) {
    return {
      valid: false,
      error: 'WAV buffer is empty or missing PCM audio frames.',
    };
  }

  const riff = wavBuffer.subarray(0, 4).toString('ascii');
  const wave = wavBuffer.subarray(8, 12).toString('ascii');
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    return {
      valid: false,
      error: 'Invalid WAV container: missing RIFF/WAVE header.',
    };
  }

  const audioFormat = wavBuffer.readUInt16LE(20);
  const numChannels = wavBuffer.readUInt16LE(22);
  const sampleRateHz = wavBuffer.readUInt32LE(24);
  const bitsPerSample = wavBuffer.readUInt16LE(34);
  const dataByteLength = wavBuffer.length - 44;

  if (audioFormat !== 1) {
    return {
      valid: false,
      error: `Expected uncompressed PCM (format 1), received format ${audioFormat}.`,
    };
  }
  if (numChannels !== 1) {
    return {
      valid: false,
      error: `Expected mono (1 channel) WAV audio, received ${numChannels} channels.`,
    };
  }
  if (sampleRateHz !== 24000) {
    return {
      valid: false,
      error: `Expected 24000 Hz sample rate, received ${sampleRateHz} Hz.`,
    };
  }
  if (bitsPerSample !== 16) {
    return {
      valid: false,
      error: `Expected 16-bit PCM depth, received ${bitsPerSample}-bit.`,
    };
  }

  return {
    valid: true,
    sampleRateHz,
    numChannels,
    bitsPerSample,
    dataByteLength,
  };
}

export function estimateWavDurationSeconds(wavBuffer: Buffer, sampleRate = 24000): number {
  const payloadBytes = Math.max(0, wavBuffer.length - 44);
  const bytesPerSecond = sampleRate * 2; // 16-bit mono = 2 bytes/sample
  const seconds = payloadBytes / bytesPerSecond;
  return Math.max(0.5, Math.round(seconds * 10) / 10);
}

export function formatTimecodeRange(startSec: number, endSec: number): string {
  const fmt = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };
  return `${fmt(startSec)} - ${fmt(endSec)}`;
}

export function recomputeShotTimecodes(shots: StoryboardShot[]): {
  normalizedShots: StoryboardShot[];
  totalDurationSeconds: number;
} {
  let cursor = 0;
  const normalizedShots = shots.map((shot, idx) => {
    const dur = Math.max(1, Math.min(15, Math.round(Number(shot.durationSeconds) || 3)));
    const start = cursor;
    const end = cursor + dur;
    cursor = end;
    return {
      ...shot,
      shotNumber: idx + 1,
      durationSeconds: dur,
      timecodeRange: formatTimecodeRange(start, end),
    };
  });
  return {
    normalizedShots,
    totalDurationSeconds: cursor,
  };
}

/**
 * Pure helper to add a shot to an editable storyboard and recalculate all sequential timecodes.
 */
export function addShotToStoryboard(
  storyboard: VideoConceptAndStoryboard,
  productTitle = 'the product',
  price = ''
): VideoConceptAndStoryboard {
  const nextNum = storyboard.shots.length + 1;
  const newShot: StoryboardShot = {
    shotNumber: nextNum,
    durationSeconds: 3,
    timecodeRange: '00:00 - 00:03',
    shotType: `0${nextNum}. Feature Callout & CTA`,
    sceneDescription: `Vertical 9:16 close-up showcasing ${productTitle} with studio rim lighting.`,
    cameraMovement: 'Smooth vertical gimbal push-in',
    visualPrompt9x16: `9:16 vertical studio video of ${productTitle}, preserving exact silhouette, label, and material finish.`,
    onScreenTextOverlay: price ? `Order Now · ${price}` : 'Shop Now',
    spokenVoiceoverSegment: 'Experience the difference today.',
    productFidelityNote: 'Maintain exact product proportions and surface colors without warping.',
  };

  const { normalizedShots, totalDurationSeconds } = recomputeShotTimecodes([
    ...storyboard.shots,
    newShot,
  ]);

  return {
    ...storyboard,
    shots: normalizedShots,
    totalDurationSeconds,
  };
}

/**
 * Pure helper to remove a shot by index (while keeping at least 1 shot) and recalculate timecodes.
 */
export function removeShotFromStoryboard(
  storyboard: VideoConceptAndStoryboard,
  shotIndex: number
): VideoConceptAndStoryboard {
  if (storyboard.shots.length <= 1) {
    return storyboard;
  }
  const filtered = storyboard.shots.filter((_, idx) => idx !== shotIndex);
  const { normalizedShots, totalDurationSeconds } = recomputeShotTimecodes(filtered);
  return {
    ...storyboard,
    shots: normalizedShots,
    totalDurationSeconds,
  };
}

export function validateVoiceoverRequest(body: unknown): {
  valid: boolean;
  error?: string;
  voiceName?: SupportedVoiceName;
  voiceStyle?: string;
  scriptText?: string;
} {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object.' };
  }
  const { voiceName, voiceStyle = '', scriptText } = body as Record<string, unknown>;

  if (typeof voiceName !== 'string' || !SUPPORTED_VOICES.includes(voiceName as SupportedVoiceName)) {
    return {
      valid: false,
      error: `Unsupported voice "${String(voiceName)}". Supported voices: ${SUPPORTED_VOICES.join(', ')}.`,
    };
  }

  if (typeof scriptText !== 'string' || scriptText.trim().length < 5) {
    return {
      valid: false,
      error: 'Voiceover script must be at least 5 characters long.',
    };
  }

  if (scriptText.trim().length > 1500) {
    return {
      valid: false,
      error: 'Voiceover script exceeds maximum length of 1,500 characters for a short-form ad.',
    };
  }

  return {
    valid: true,
    voiceName: voiceName as SupportedVoiceName,
    voiceStyle: typeof voiceStyle === 'string' && voiceStyle.trim() ? voiceStyle.trim() : 'Confident commercial narrator',
    scriptText: scriptText.trim(),
  };
}

export function validateStoryboardUpdate(
  input: unknown,
  existingMetadata?: VideoConceptAndStoryboard['generationMetadata']
): {
  valid: boolean;
  error?: string;
  storyboard?: VideoConceptAndStoryboard;
} {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Storyboard payload must be an object.' };
  }

  const candidate = input as Partial<VideoConceptAndStoryboard>;

  if (!candidate.conceptTitle || typeof candidate.conceptTitle !== 'string' || !candidate.conceptTitle.trim()) {
    return { valid: false, error: 'Concept title is required.' };
  }

  if (
    !candidate.fullVoiceoverScript ||
    typeof candidate.fullVoiceoverScript !== 'string' ||
    candidate.fullVoiceoverScript.trim().length < 5
  ) {
    return { valid: false, error: 'Full voiceover script must be at least 5 characters.' };
  }

  if (!Array.isArray(candidate.shots) || candidate.shots.length === 0) {
    return { valid: false, error: 'Storyboard must include at least 1 shot.' };
  }

  for (let i = 0; i < candidate.shots.length; i++) {
    const s = candidate.shots[i];
    if (!s || typeof s.sceneDescription !== 'string' || !s.sceneDescription.trim()) {
      return { valid: false, error: `Shot #${i + 1} is missing a scene description.` };
    }
    if (typeof s.visualPrompt9x16 !== 'string' || !s.visualPrompt9x16.trim()) {
      return { valid: false, error: `Shot #${i + 1} is missing a 9:16 visual prompt.` };
    }
  }

  const { normalizedShots, totalDurationSeconds } = recomputeShotTimecodes(candidate.shots);
  const words = candidate.fullVoiceoverScript.trim().split(/\s+/).filter(Boolean).length;

  const validPlatforms = [
    'Instagram Reels (9:16)',
    'Instagram Stories (9:16)',
    'YouTube Shorts (9:16)',
  ] as const;
  const targetPlatformFormat = validPlatforms.includes(
    candidate.targetPlatformFormat as (typeof validPlatforms)[number]
  )
    ? (candidate.targetPlatformFormat as (typeof validPlatforms)[number])
    : 'Instagram Reels (9:16)';

  const storyboard: VideoConceptAndStoryboard = {
    conceptTitle: candidate.conceptTitle.trim(),
    targetPlatformFormat,
    totalDurationSeconds,
    openingHook3s: (candidate.openingHook3s || normalizedShots[0]?.spokenVoiceoverSegment || '').trim(),
    fullVoiceoverScript: candidate.fullVoiceoverScript.trim(),
    estimatedWordCount: words,
    brandSafetyVerification: Array.isArray(candidate.brandSafetyVerification)
      ? candidate.brandSafetyVerification.map((s) => String(s))
      : ['Verified product accuracy and brand-safe commercial claims'],
    masterCinematicPrompt9x16: (
      candidate.masterCinematicPrompt9x16 || normalizedShots[0]?.visualPrompt9x16 || ''
    ).trim(),
    musicDirectionPrompt: (
      candidate.musicDirectionPrompt || 'Upbeat modern commercial instrumental backing track'
    ).trim(),
    shots: normalizedShots,
    generationMetadata: candidate.generationMetadata ||
      existingMetadata || {
        requestedModel: 'gemini-3.1-flash-lite',
        resolvedModel: 'gemini-3.1-flash-lite',
        fallbackUsed: false,
        latencyMs: 0,
        generatedAt: new Date().toISOString(),
      },
  };

  return { valid: true, storyboard };
}

/**
 * Validates and constructs a truthful BackgroundMusicState for:
 * - Voiceover-Only mode ('placeholder')
 * - Custom MP3/WAV upload ('upload')
 * - Paid-tier unavailable Lyria fallback ('unavailable_paid_tier')
 * Never fabricates audio or claims AI music was generated when it was not.
 */
export function buildAndValidateMusicState(params: {
  mode: 'placeholder' | 'upload' | 'unavailable_paid_tier';
  musicPrompt?: string;
  customAudioDataUrl?: string;
  errorDetail?: string;
  nowIso?: string;
}): {
  valid: boolean;
  error?: string;
  musicState?: BackgroundMusicState;
  parsedUpload?: { ext: 'mp3' | 'wav'; mimeType: 'audio/mpeg' | 'audio/wav'; buffer: Buffer };
} {
  const now = params.nowIso || new Date().toISOString();
  const promptUsed = (params.musicPrompt || '').trim() || undefined;

  if (params.mode === 'placeholder') {
    return {
      valid: true,
      musicState: {
        status: 'not_requested',
        statusMessage:
          'Voiceover-Only mode active (optional background music skipped). No AI music was generated.',
        promptUsed,
        updatedAt: now,
      },
    };
  }

  if (params.mode === 'unavailable_paid_tier') {
    const reason = (params.errorDetail || 'Requires billing-enabled API key').slice(0, 140);
    return {
      valid: true,
      musicState: {
        status: 'unavailable_paid_tier',
        modelAttempted: 'lyria-3-clip-preview',
        statusMessage: `Lyria music model (lyria-3-clip-preview) is not available on the current API key tier (${reason}). No music was generated. You can attach a billing-enabled API key, upload a custom royalty-free MP3/WAV track, or proceed with Voiceover-Only mode.`,
        promptUsed,
        updatedAt: now,
      },
    };
  }

  if (params.mode === 'upload') {
    const rawUrl = String(params.customAudioDataUrl || '');
    const match = rawUrl.match(/^data:(audio\/(?:mpeg|mp3|wav|x-wav));base64,(.+)$/i);
    if (!match) {
      return {
        valid: false,
        error: 'Invalid audio file. Please upload a valid MP3 or WAV file.',
      };
    }
    const isMp3 = match[1].toLowerCase().includes('mp');
    const ext: 'mp3' | 'wav' = isMp3 ? 'mp3' : 'wav';
    const mimeType: 'audio/mpeg' | 'audio/wav' = isMp3 ? 'audio/mpeg' : 'audio/wav';
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length < 32) {
      return {
        valid: false,
        error: 'Uploaded audio file is empty or corrupted.',
      };
    }

    return {
      valid: true,
      parsedUpload: { ext, mimeType, buffer },
      musicState: {
        status: 'custom_uploaded',
        statusMessage: `Custom royalty-free backing track uploaded (${(buffer.length / 1024).toFixed(1)} KB).`,
        mimeType,
        promptUsed,
        updatedAt: now,
      },
    };
  }

  return { valid: false, error: 'Unsupported music action mode.' };
}
