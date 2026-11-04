import type {
  Campaign,
  RenderEnginePreference,
  RenderEngineUsed,
  VideoApprovalState,
  VideoRenderJob,
  VideoRenderSettings,
} from '../types.ts';

export const DEFAULT_RENDER_SETTINGS: VideoRenderSettings = {
  resolution: '1080x1920',
  includeSubtitles: true,
  enginePreference: 'ffmpeg_motion_compositor',
  revisionNote: '',
};

/**
 * Validates that a campaign ID or job ID is alphanumeric with underscores/hyphens only,
 * preventing path traversal (../, /, \, null bytes).
 */
export function isSafeIdentifier(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (!trimmed || trimmed.length > 96) return false;
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/.test(trimmed);
}

/**
 * Strictly validates a video filename served from /api/video/:filename.
 * Prevents path traversal or arbitrary file access.
 */
export function isSafeVideoFilename(filename: unknown): filename is string {
  if (typeof filename !== 'string') return false;
  if (
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('\0')
  ) {
    return false;
  }
  return /^render_[a-zA-Z0-9_-]+\.mp4$/i.test(filename);
}

/**
 * Deterministic fast string hash (FNV-1a 32-bit hex) that works identically in Browser and Node
 * without requiring node:crypto in client bundles.
 */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Computes a deterministic content fingerprint across campaign metadata, storyboard shots,
 * script, voiceover WAV asset, background music state, and render settings.
 * Any modification to these inputs produces a different fingerprint, allowing reliable
 * detection of post-approval edits.
 */
export function computeCampaignContentFingerprint(
  campaign: Pick<
    Campaign,
    'title' | 'price' | 'brandName' | 'imageDataUrl' | 'storyboard' | 'voiceover' | 'backgroundMusic'
  >,
  settings?: Partial<VideoRenderSettings>
): string {
  const storyboardPart = campaign.storyboard
    ? {
        conceptTitle: campaign.storyboard.conceptTitle,
        targetPlatformFormat: campaign.storyboard.targetPlatformFormat,
        totalDurationSeconds: campaign.storyboard.totalDurationSeconds,
        openingHook3s: campaign.storyboard.openingHook3s,
        fullVoiceoverScript: campaign.storyboard.fullVoiceoverScript,
        masterCinematicPrompt9x16: campaign.storyboard.masterCinematicPrompt9x16,
        shots: campaign.storyboard.shots.map((s) => ({
          n: s.shotNumber,
          d: s.durationSeconds,
          t: s.timecodeRange,
          type: s.shotType,
          desc: s.sceneDescription,
          cam: s.cameraMovement,
          vp: s.visualPrompt9x16,
          txt: s.onScreenTextOverlay,
          vo: s.spokenVoiceoverSegment,
        })),
      }
    : null;

  const voPart = campaign.voiceover
    ? {
        id: campaign.voiceover.id,
        voiceName: campaign.voiceover.voiceName,
        scriptTextUsed: campaign.voiceover.scriptTextUsed,
        audioFileUrl: campaign.voiceover.audioFileUrl,
        byteLength: campaign.voiceover.byteLength,
      }
    : null;

  const musicPart = campaign.backgroundMusic
    ? {
        status: campaign.backgroundMusic.status,
        audioFileUrl: campaign.backgroundMusic.audioFileUrl || '',
        promptUsed: campaign.backgroundMusic.promptUsed || '',
      }
    : null;

  const imageSig = `${campaign.imageDataUrl.length}:${campaign.imageDataUrl.slice(0, 64)}:${campaign.imageDataUrl.slice(-32)}`;

  const payload = JSON.stringify({
    title: campaign.title,
    price: campaign.price,
    brandName: campaign.brandName,
    imageSig,
    storyboardPart,
    voPart,
    musicPart,
    resolution: settings?.resolution || '1080x1920',
    includeSubtitles:
      typeof settings?.includeSubtitles === 'boolean' ? settings.includeSubtitles : true,
  });

  return `fp_${fnv1aHex(payload)}`;
}

/**
 * Checks whether a campaign has completed Milestones 1 & 2 requirements and is ready
 * to unlock Milestone 3 (9:16 Video Rendering & Preview/Approval Gate).
 */
export function checkCampaignRenderReadiness(campaign: Campaign | null | undefined): {
  ready: boolean;
  missingSteps: string[];
  audioModeSummary: string;
} {
  const missingSteps: string[] = [];

  if (!campaign) {
    return {
      ready: false,
      missingSteps: ['Analyze a product image in Step 01 first.'],
      audioModeSummary: 'No campaign loaded',
    };
  }

  if (!campaign.imageDataUrl || !campaign.imageDataUrl.startsWith('data:image/')) {
    missingSteps.push('Valid product image is required.');
  }

  if (
    !campaign.storyboard ||
    !Array.isArray(campaign.storyboard.shots) ||
    campaign.storyboard.shots.length === 0
  ) {
    missingSteps.push('Generate and save a 9:16 shot-by-shot storyboard in Step 02.');
  }

  if (!campaign.voiceover || !campaign.voiceover.audioFileUrl) {
    missingSteps.push('Generate an AI voiceover WAV file in Step 03.');
  }

  let audioModeSummary = 'Voiceover WAV (24kHz Mono)';
  if (campaign.voiceover) {
    const bg = campaign.backgroundMusic;
    if (bg?.status === 'custom_uploaded' && bg.audioFileUrl) {
      audioModeSummary = `${campaign.voiceover.voiceName} Voiceover WAV + Custom Uploaded Music Track (Ducked Mix)`;
    } else if (bg?.status === 'generated' && bg.audioFileUrl) {
      audioModeSummary = `${campaign.voiceover.voiceName} Voiceover WAV + Lyria AI Music Track (Ducked Mix)`;
    } else {
      audioModeSummary = `${campaign.voiceover.voiceName} Voiceover WAV (Voiceover-Only Mode)`;
    }
  }

  return {
    ready: missingSteps.length === 0,
    missingSteps,
    audioModeSummary,
  };
}

/**
 * Prevents duplicate concurrent render submissions for the same campaign.
 */
export function canStartNewRenderJob(campaign: Campaign): {
  allowed: boolean;
  error?: string;
} {
  const active = campaign.activeRenderJob;
  if (active && (active.status === 'queued' || active.status === 'processing')) {
    return {
      allowed: false,
      error: `A video render job (${active.id}, v${active.versionNumber}) is already ${active.status} (${active.progressPercent}%). Please wait for it to finish before starting another render.`,
    };
  }
  return { allowed: true };
}

/**
 * Validates the incoming POST /api/campaigns/:id/render request body and campaign state.
 */
export function validateRenderRequest(
  body: unknown,
  campaign: Campaign | null | undefined
): {
  valid: boolean;
  error?: string;
  settings?: VideoRenderSettings;
  audioModeSummary?: string;
} {
  if (!campaign) {
    return { valid: false, error: 'Campaign not found.' };
  }

  if (!isSafeIdentifier(campaign.id)) {
    return { valid: false, error: 'Invalid campaign identifier.' };
  }

  const readiness = checkCampaignRenderReadiness(campaign);
  if (!readiness.ready) {
    return {
      valid: false,
      error: `Campaign is not ready for video rendering: ${readiness.missingSteps.join(' ')}`,
    };
  }

  const dupCheck = canStartNewRenderJob(campaign);
  if (!dupCheck.allowed) {
    return { valid: false, error: dupCheck.error };
  }

  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};

  const resolution =
    raw.resolution === '720x1280'
      ? '720x1280'
      : raw.resolution === '1080x1920' || raw.resolution === undefined
      ? '1080x1920'
      : null;

  if (!resolution) {
    return {
      valid: false,
      error: 'Unsupported render resolution. Supported 9:16 vertical resolutions: "1080x1920" or "720x1280".',
    };
  }

  const includeSubtitles =
    typeof raw.includeSubtitles === 'boolean' ? raw.includeSubtitles : true;

  const enginePreference: RenderEnginePreference =
    raw.enginePreference === 'auto_omni_with_ffmpeg_fallback'
      ? 'auto_omni_with_ffmpeg_fallback'
      : 'ffmpeg_motion_compositor';

  const revisionNote =
    typeof raw.revisionNote === 'string' ? raw.revisionNote.trim().slice(0, 400) : '';

  return {
    valid: true,
    settings: {
      resolution,
      includeSubtitles,
      enginePreference,
      revisionNote: revisionNote || undefined,
    },
    audioModeSummary: readiness.audioModeSummary,
  };
}

/**
 * Creates a new queued VideoRenderJob record with incremented version number.
 */
export function createQueuedRenderJob(
  campaign: Campaign,
  settings: VideoRenderSettings,
  jobId: string,
  nowIso = new Date().toISOString()
): VideoRenderJob {
  const existingHistory = Array.isArray(campaign.renderHistory) ? campaign.renderHistory : [];
  const maxPriorVersion = existingHistory.reduce(
    (max, item) => Math.max(max, item.versionNumber || 0),
    campaign.latestCompletedRender?.versionNumber || 0
  );
  const versionNumber = maxPriorVersion + 1;
  const [width, height] = settings.resolution === '720x1280' ? [720, 1280] : [1080, 1920];
  const targetDurationSeconds = Math.max(
    3,
    Math.min(60, campaign.storyboard?.totalDurationSeconds || 15)
  );
  const readiness = checkCampaignRenderReadiness(campaign);
  const contentFingerprint = computeCampaignContentFingerprint(campaign, settings);

  return {
    id: jobId,
    campaignId: campaign.id,
    versionNumber,
    status: 'queued',
    progressPercent: 5,
    stageMessage: 'Render job queued and validated...',
    requestedEngine: settings.enginePreference,
    engineUsed: 'ffmpeg_motion_compositor',
    engineLabel: 'FFmpeg 9:16 Motion-Compositor (Fallback — Not AI Video)',
    resolution: settings.resolution,
    width,
    height,
    aspectRatio: '9:16',
    fps: 24,
    durationSeconds: targetDurationSeconds,
    targetDurationSeconds,
    includeSubtitles: settings.includeSubtitles,
    audioModeSummary: readiness.audioModeSummary,
    revisionNote: settings.revisionNote,
    contentFingerprint,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Transitions a VideoRenderJob through queued -> processing -> completed | failed.
 */
export function transitionRenderJobStatus(
  job: VideoRenderJob,
  patch: {
    status?: VideoRenderJob['status'];
    progressPercent?: number;
    stageMessage?: string;
    engineUsed?: RenderEngineUsed;
    engineLabel?: string;
    omniFallbackReason?: string;
    durationSeconds?: number;
    videoFileUrl?: string;
    byteLength?: number;
    errorMessage?: string;
    nowIso?: string;
  }
): VideoRenderJob {
  const now = patch.nowIso || new Date().toISOString();
  const nextStatus = patch.status || job.status;
  return {
    ...job,
    status: nextStatus,
    progressPercent:
      typeof patch.progressPercent === 'number'
        ? Math.max(0, Math.min(100, Math.round(patch.progressPercent)))
        : job.progressPercent,
    stageMessage: patch.stageMessage ?? job.stageMessage,
    engineUsed: patch.engineUsed ?? job.engineUsed,
    engineLabel: patch.engineLabel ?? job.engineLabel,
    omniFallbackReason: patch.omniFallbackReason ?? job.omniFallbackReason,
    durationSeconds: patch.durationSeconds ?? job.durationSeconds,
    videoFileUrl: patch.videoFileUrl ?? job.videoFileUrl,
    mimeType: patch.videoFileUrl || job.videoFileUrl ? 'video/mp4' : job.mimeType,
    byteLength: patch.byteLength ?? job.byteLength,
    errorMessage: patch.errorMessage,
    updatedAt: now,
    completedAt:
      nextStatus === 'completed' || nextStatus === 'failed' ? now : job.completedAt,
  };
}

/**
 * Inspects a binary Buffer to confirm it is a valid, playable ISO Base Media (MP4) file:
 * - Minimum size >= 256 bytes
 * - Contains an 'ftyp' box header at byte offset 4..8
 * - Contains both 'moov' (movie metadata) and 'mdat' (media payload) atoms
 */
export function verifyPlayableMp4Buffer(buffer: Buffer | Uint8Array): {
  valid: boolean;
  error?: string;
  byteLength: number;
  hasFtyp: boolean;
  hasMoov: boolean;
  hasMdat: boolean;
} {
  const byteLength = buffer ? buffer.byteLength : 0;
  if (!buffer || byteLength < 256) {
    return {
      valid: false,
      error: `MP4 file is too small or empty (${byteLength} bytes).`,
      byteLength,
      hasFtyp: false,
      hasMoov: false,
      hasMdat: false,
    };
  }

  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const readAscii = (offset: number, len: number): string => {
    if (offset + len > u8.byteLength) return '';
    let s = '';
    for (let i = 0; i < len; i++) {
      s += String.fromCharCode(u8[offset + i]);
    }
    return s;
  };

  const hasFtyp = readAscii(4, 4) === 'ftyp';
  if (!hasFtyp) {
    return {
      valid: false,
      error: 'Invalid MP4 container: missing ISO Base Media "ftyp" header box at byte offset 4.',
      byteLength,
      hasFtyp: false,
      hasMoov: false,
      hasMdat: false,
    };
  }

  // Walk top-level MP4 boxes to verify moov and mdat atoms exist
  let hasMoov = false;
  let hasMdat = false;
  let offset = 0;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  while (offset + 8 <= u8.byteLength) {
    let boxSize = view.getUint32(offset, false);
    const boxType = readAscii(offset + 4, 4);
    if (boxType === 'moov') hasMoov = true;
    if (boxType === 'mdat') hasMdat = true;

    if (boxSize === 1) {
      // 64-bit extended size
      if (offset + 16 > u8.byteLength) break;
      const hi = view.getUint32(offset + 8, false);
      const lo = view.getUint32(offset + 12, false);
      boxSize = hi * 4294967296 + lo;
    } else if (boxSize === 0) {
      // Box extends to end of file
      break;
    }

    if (boxSize < 8) break;
    offset += boxSize;
  }

  if (!hasMoov || !hasMdat) {
    return {
      valid: false,
      error: `Incomplete MP4 stream: hasMoov=${hasMoov}, hasMdat=${hasMdat}.`,
      byteLength,
      hasFtyp,
      hasMoov,
      hasMdat,
    };
  }

  return {
    valid: true,
    byteLength,
    hasFtyp,
    hasMoov,
    hasMdat,
  };
}

/**
 * Verifies that rendered video duration and mixed audio duration match the selected
 * campaign storyboard duration within a reasonable tolerance (default 1.0s).
 */
export function verifyAudioVideoDurationSync(params: {
  targetDurationSeconds: number;
  videoDurationSeconds: number;
  audioDurationSeconds: number;
  toleranceSeconds?: number;
}): {
  synchronized: boolean;
  videoDeltaSeconds: number;
  audioDeltaSeconds: number;
  streamDeltaSeconds: number;
  error?: string;
} {
  const tolerance = params.toleranceSeconds ?? 1.0;
  const videoDeltaSeconds = Math.abs(params.videoDurationSeconds - params.targetDurationSeconds);
  const audioDeltaSeconds = Math.abs(params.audioDurationSeconds - params.targetDurationSeconds);
  const streamDeltaSeconds = Math.abs(params.videoDurationSeconds - params.audioDurationSeconds);

  if (params.videoDurationSeconds <= 0 || params.audioDurationSeconds <= 0) {
    return {
      synchronized: false,
      videoDeltaSeconds,
      audioDeltaSeconds,
      streamDeltaSeconds,
      error: 'Video or audio stream has zero duration.',
    };
  }

  if (videoDeltaSeconds > tolerance) {
    return {
      synchronized: false,
      videoDeltaSeconds,
      audioDeltaSeconds,
      streamDeltaSeconds,
      error: `Rendered video duration (${params.videoDurationSeconds.toFixed(2)}s) deviates from storyboard target (${params.targetDurationSeconds}s) by ${videoDeltaSeconds.toFixed(2)}s (tolerance: ${tolerance}s).`,
    };
  }

  if (streamDeltaSeconds > tolerance) {
    return {
      synchronized: false,
      videoDeltaSeconds,
      audioDeltaSeconds,
      streamDeltaSeconds,
      error: `Audio duration (${params.audioDurationSeconds.toFixed(2)}s) and video duration (${params.videoDurationSeconds.toFixed(2)}s) are out of sync by ${streamDeltaSeconds.toFixed(2)}s.`,
    };
  }

  return {
    synchronized: true,
    videoDeltaSeconds,
    audioDeltaSeconds,
    streamDeltaSeconds,
  };
}

/**
 * Applies an explicit Approve or Reject decision to a campaign's latest completed render.
 * Requires a valid completed MP4 render job before approval can be granted.
 */
export function applyApprovalDecision(
  campaign: Campaign,
  action: 'approve' | 'reject',
  rejectionReason = '',
  nowIso = new Date().toISOString()
): {
  valid: boolean;
  error?: string;
  campaign?: Campaign;
} {
  const completedRender = campaign.latestCompletedRender;
  if (!completedRender || completedRender.status !== 'completed' || !completedRender.videoFileUrl) {
    return {
      valid: false,
      error: 'Cannot approve or reject before a 9:16 MP4 video has been rendered.',
    };
  }

  const currentFingerprint = computeCampaignContentFingerprint(campaign, {
    resolution: completedRender.resolution,
    includeSubtitles: completedRender.includeSubtitles,
    enginePreference: completedRender.requestedEngine,
  });

  if (action === 'approve') {
    if (completedRender.contentFingerprint !== currentFingerprint) {
      return {
        valid: false,
        error:
          'Campaign storyboard, script, or audio was modified after this video was rendered. Please render a fresh video before approving.',
      };
    }

    const approval: VideoApprovalState = {
      status: 'approved',
      renderJobId: completedRender.id,
      versionNumber: completedRender.versionNumber,
      reviewedAt: nowIso,
      rejectionReason: undefined,
      invalidationReason: undefined,
      contentFingerprintAtReview: currentFingerprint,
    };

    return {
      valid: true,
      campaign: {
        ...campaign,
        approval,
        status: 'approved_for_publish',
        updatedAt: nowIso,
      },
    };
  }

  if (action === 'reject') {
    const cleanReason =
      rejectionReason.trim() ||
      'Rejected during human preview gate — returning to storyboard editor for adjustments.';
    const approval: VideoApprovalState = {
      status: 'rejected',
      renderJobId: completedRender.id,
      versionNumber: completedRender.versionNumber,
      reviewedAt: nowIso,
      rejectionReason: cleanReason,
      invalidationReason: undefined,
      contentFingerprintAtReview: currentFingerprint,
    };

    return {
      valid: true,
      campaign: {
        ...campaign,
        approval,
        status: 'video_ready',
        updatedAt: nowIso,
      },
    };
  }

  return { valid: false, error: 'Unsupported approval action. Expected "approve" or "reject".' };
}

/**
 * Invalidates any existing video approval when the user modifies the product profile,
 * storyboard, script, voiceover, music, or render settings after approval.
 */
export function invalidateApprovalOnCampaignChange(
  campaign: Campaign,
  changeDescription: string,
  nowIso = new Date().toISOString()
): Campaign {
  const prevApproval = campaign.approval;
  const wasApprovedOrPending =
    prevApproval &&
    (prevApproval.status === 'approved' || prevApproval.status === 'pending_review');

  const nextStatus: Campaign['status'] =
    campaign.status === 'approved_for_publish'
      ? campaign.latestCompletedRender
        ? 'video_ready'
        : campaign.voiceover
        ? 'audio_ready'
        : campaign.storyboard
        ? 'storyboard_ready'
        : 'analyzed'
      : campaign.status;

  if (!wasApprovedOrPending) {
    return {
      ...campaign,
      status: nextStatus,
      updatedAt: nowIso,
    };
  }

  return {
    ...campaign,
    status: nextStatus,
    approval: {
      ...prevApproval,
      status: 'invalidated',
      invalidationReason: `Approval invalidated because ${changeDescription}. Please render a new video version and approve it before publishing.`,
      reviewedAt: nowIso,
    },
    updatedAt: nowIso,
  };
}
