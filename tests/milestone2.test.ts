import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_VOICES,
  ensureValidWavBuffer,
  verifyWavFormat24kMono16Bit,
  estimateWavDurationSeconds,
  recomputeShotTimecodes,
  addShotToStoryboard,
  removeShotFromStoryboard,
  validateVoiceoverRequest,
  validateStoryboardUpdate,
  buildAndValidateMusicState,
} from '../src/utils/milestone2Validators.ts';
import {
  createBlankStudioState,
  resetToBlankProductState,
  applyPresetToStudioState,
  applyUploadedImageToStudioState,
  applyCampaignToStudioState,
  handleVoiceoverErrorState,
  applyVoiceoverOrMusicUpdatePreservingEdits,
  validateAndNormalizeProductProfile,
  mapExtractedProfileToForm,
  analyzeUploadedImageWithGemini,
} from '../src/utils/studioState.ts';
import { SAMPLE_PRODUCT_PRESETS } from '../src/utils/sampleProducts.ts';
import {
  PRIMARY_STORYBOARD_MODEL,
  VERIFIED_FALLBACK_STORYBOARD_MODEL,
  PRIMARY_TTS_MODEL,
  FALLBACK_TTS_MODEL,
  AllModelsFailedError,
  getPreferredStoryboardModel,
  buildVerifiedStoryboardModelChain,
  computeExponentialBackoffMs,
  executeWithVerifiedModelFallback,
  parseAndValidateGeneratedStoryboard,
} from '../src/utils/modelRouter.ts';
import {
  getNvidiaApiKey,
  getNvidiaBaseUrl,
  getNvidiaVisionModel,
  getNvidiaTextModel,
  DEFAULT_NVIDIA_VISION_MODEL,
  DEFAULT_NVIDIA_TEXT_MODEL,
  FALLBACK_NVIDIA_TEXT_MODEL,
  extractJsonFromText,
  isTransientNemotronStatus,
  callNemotronChatCompletion,
  executeWithNemotronFallback,
  NemotronError,
} from '../src/utils/nemotronClient.ts';
import type {
  Campaign,
  ProductProfile,
  VideoConceptAndStoryboard,
  StoryboardShot,
} from '../src/types.ts';

describe('Milestone 2 — Voiceover & WAV Audio Validators', () => {
  it('supports all 5 verified Gemini TTS voices (Kore, Puck, Charon, Fenrir, Zephyr)', () => {
    for (const voice of SUPPORTED_VOICES) {
      const result = validateVoiceoverRequest({
        voiceName: voice,
        voiceStyle: 'Warm studio narrator',
        scriptText: 'Experience cafe-grade espresso at home every single morning.',
      });
      assert.equal(result.valid, true);
      assert.equal(result.voiceName, voice);
    }
  });

  it('rejects unsupported voice names and invalid script lengths', () => {
    const badVoice = validateVoiceoverRequest({
      voiceName: 'UnsupportedVoice',
      scriptText: 'Valid script text here.',
    });
    assert.equal(badVoice.valid, false);
    assert.match(badVoice.error || '', /Unsupported voice/);

    const shortScript = validateVoiceoverRequest({
      voiceName: 'Kore',
      scriptText: 'Hi',
    });
    assert.equal(shortScript.valid, false);
    assert.match(shortScript.error || '', /at least 5 characters/);
  });

  it('constructs and verifies a valid 44-byte RIFF WAVE header for 24kHz, 16-bit, mono audio', () => {
    const rawPcm = Buffer.alloc(48000, 0);
    const wav = ensureValidWavBuffer(rawPcm, 24000, 1, 16);

    assert.equal(wav.length, 48044);
    const formatCheck = verifyWavFormat24kMono16Bit(wav);
    assert.equal(formatCheck.valid, true);
    assert.equal(formatCheck.sampleRateHz, 24000);
    assert.equal(formatCheck.numChannels, 1);
    assert.equal(formatCheck.bitsPerSample, 16);
    assert.equal(formatCheck.dataByteLength, 48000);

    const wavAgain = ensureValidWavBuffer(wav, 24000, 1, 16);
    assert.equal(wavAgain.length, 48044);

    const duration = estimateWavDurationSeconds(wav, 24000);
    assert.equal(duration, 1.0);

    // Rejects invalid headers or wrong sample rate
    const wrongRateWav = Buffer.from(wav);
    wrongRateWav.writeUInt32LE(44100, 24);
    const badCheck = verifyWavFormat24kMono16Bit(wrongRateWav);
    assert.equal(badCheck.valid, false);
    assert.match(badCheck.error || '', /Expected 24000 Hz sample rate/);
  });
});

describe('Milestone 2 — 9:16 Storyboard Editing, Shot Timing & Persistence Validators', () => {
  const sampleShots: StoryboardShot[] = [
    {
      shotNumber: 1,
      durationSeconds: 3,
      timecodeRange: '',
      shotType: '01. Macro Hook',
      sceneDescription: 'Close-up of brass pressure gauge reaching 9 bar.',
      cameraMovement: 'Slow push-in',
      visualPrompt9x16: 'Vertical 9:16 macro shot of matte obsidian espresso machine brass gauge.',
      onScreenTextOverlay: '9-Bar Precision',
      spokenVoiceoverSegment: 'Stop settling for bitter morning coffee.',
      productFidelityNote: 'Preserve brass dial and obsidian chassis.',
    },
    {
      shotNumber: 2,
      durationSeconds: 4,
      timecodeRange: '',
      shotType: '02. Extraction Detail',
      sceneDescription: 'Rich tiger-striped crema pouring into warm ceramic cup.',
      cameraMovement: 'Low-angle tracking shot',
      visualPrompt9x16: 'Vertical 9:16 slow-motion espresso extraction from walnut portafilter.',
      onScreenTextOverlay: 'Dual-Boiler Steam',
      spokenVoiceoverSegment: 'Veloce Barista Pro extracts rich cafe crema in seconds.',
      productFidelityNote: 'Maintain walnut handle grain and cup geometry.',
    },
  ];

  it('recomputes sequential shot timecodes and total duration accurately when adding or removing shots', () => {
    const { normalizedShots, totalDurationSeconds } = recomputeShotTimecodes(sampleShots);
    assert.equal(totalDurationSeconds, 7);
    assert.equal(normalizedShots[0].timecodeRange, '00:00 - 00:03');
    assert.equal(normalizedShots[1].timecodeRange, '00:03 - 00:07');

    const initialPlan: VideoConceptAndStoryboard = {
      conceptTitle: 'Veloce Morning Ritual — 9:16 Launch',
      targetPlatformFormat: 'Instagram Reels (9:16)',
      totalDurationSeconds,
      openingHook3s: 'Stop settling for bitter morning coffee.',
      fullVoiceoverScript:
        'Stop settling for bitter morning coffee. Veloce Barista Pro extracts rich cafe crema in seconds.',
      estimatedWordCount: 16,
      brandSafetyVerification: ['Verified 9-bar pressure gauge'],
      masterCinematicPrompt9x16: '9:16 studio commercial of Veloce Barista Pro.',
      musicDirectionPrompt: 'Warm acoustic jazz espresso bar groove',
      shots: normalizedShots,
      generationMetadata: {
        requestedModel: 'gemini-3.1-flash-lite',
        resolvedModel: 'gemini-3.1-flash-lite',
        fallbackUsed: false,
        latencyMs: 500,
        generatedAt: '2026-11-04T00:00:00.000Z',
      },
    };

    // Adding a 3-second shot recalculates totalDurationSeconds to 10s and updates timecodes
    const withAddedShot = addShotToStoryboard(
      initialPlan,
      'Veloce Barista Pro',
      'Warm sunlight on travertine countertop'
    );
    assert.equal(withAddedShot.shots.length, 3);
    assert.equal(withAddedShot.totalDurationSeconds, 10);
    assert.equal(withAddedShot.shots[2].shotNumber, 3);
    assert.equal(withAddedShot.shots[2].timecodeRange, '00:07 - 00:10');

    // Removing the first shot (3s) re-indexes shots 1..2 and recalculates timecodes to 00:00 - 00:04 and 00:04 - 00:07
    const afterRemoveFirst = removeShotFromStoryboard(withAddedShot, 0);
    assert.equal(afterRemoveFirst.shots.length, 2);
    assert.equal(afterRemoveFirst.totalDurationSeconds, 7);
    assert.equal(afterRemoveFirst.shots[0].shotNumber, 1);
    assert.equal(afterRemoveFirst.shots[0].timecodeRange, '00:00 - 00:04');
    assert.equal(afterRemoveFirst.shots[1].shotNumber, 2);
    assert.equal(afterRemoveFirst.shots[1].timecodeRange, '00:04 - 00:07');
  });

  it('validates complete storyboard edits and preserves custom hook, script, master prompt, shots, and timecodes on save', () => {
    const editedShots: StoryboardShot[] = [
      {
        ...sampleShots[0],
        durationSeconds: 5,
        sceneDescription: 'Edited macro gauge sweep to 9 bar.',
        visualPrompt9x16: 'Edited 9:16 macro prompt preserving brass gauge.',
        productFidelityNote: 'Edited fidelity constraint for obsidian chassis.',
      },
      {
        ...sampleShots[1],
        durationSeconds: 6,
      },
    ];

    const validResult = validateStoryboardUpdate({
      conceptTitle: 'Edited Veloce Morning Ritual — 9:16',
      targetPlatformFormat: 'YouTube Shorts (9:16)',
      openingHook3s: 'Edited 3s hook: Never drink bitter pod coffee again.',
      fullVoiceoverScript:
        'Edited 3s hook: Never drink bitter pod coffee again. Veloce Barista Pro extracts rich cafe crema in seconds.',
      masterCinematicPrompt9x16: 'Edited master 9:16 studio commercial prompt.',
      musicDirectionPrompt: 'Edited warm upright bass espresso bar groove',
      shots: editedShots,
    });

    assert.equal(validResult.valid, true);
    assert.equal(validResult.storyboard?.conceptTitle, 'Edited Veloce Morning Ritual — 9:16');
    assert.equal(validResult.storyboard?.openingHook3s, 'Edited 3s hook: Never drink bitter pod coffee again.');
    assert.equal(validResult.storyboard?.masterCinematicPrompt9x16, 'Edited master 9:16 studio commercial prompt.');
    assert.equal(validResult.storyboard?.musicDirectionPrompt, 'Edited warm upright bass espresso bar groove');
    assert.equal(validResult.storyboard?.totalDurationSeconds, 11);
    assert.equal(validResult.storyboard?.shots.length, 2);
    assert.equal(validResult.storyboard?.shots[0].timecodeRange, '00:00 - 00:05');
    assert.equal(validResult.storyboard?.shots[1].timecodeRange, '00:05 - 00:11');
    assert.equal(
      validResult.storyboard?.shots[0].productFidelityNote,
      'Edited fidelity constraint for obsidian chassis.'
    );

    const invalidResult = validateStoryboardUpdate({
      conceptTitle: 'Broken Storyboard',
      fullVoiceoverScript: 'Valid voiceover script here.',
      shots: [
        {
          ...sampleShots[0],
          visualPrompt9x16: '   ',
        },
      ],
    });
    assert.equal(invalidResult.valid, false);
    assert.match(invalidResult.error || '', /missing a 9:16 visual prompt/);
  });
});

describe('Milestone 2 — Music Modes & TTS Error Preservation Suite', () => {
  it('validates music unavailable_paid_tier, custom MP3/WAV upload, and voiceover-only modes without fake success', () => {
    // 1. Lyria paid-tier unavailable state
    const unavailableResult = buildAndValidateMusicState({
      mode: 'unavailable_paid_tier',
      musicPrompt: 'Warm acoustic guitar groove, 100 BPM',
      errorDetail: 'Lyria requires paid billing tier',
    });
    assert.equal(unavailableResult.valid, true);
    assert.equal(unavailableResult.musicState?.status, 'unavailable_paid_tier');
    assert.equal(unavailableResult.musicState?.audioFileUrl, undefined);
    assert.match(unavailableResult.musicState?.statusMessage || '', /Lyria music model/);

    // 2. Custom MP3 or WAV upload (at least 32 bytes payload)
    const sampleMp3Base64 = Buffer.alloc(64, 1).toString('base64');
    const customMp3Result = buildAndValidateMusicState({
      mode: 'upload',
      musicPrompt: 'Custom uploaded track',
      customAudioDataUrl: `data:audio/mpeg;base64,${sampleMp3Base64}`,
    });
    assert.equal(customMp3Result.valid, true);
    assert.equal(customMp3Result.musicState?.status, 'custom_uploaded');
    assert.equal(customMp3Result.parsedUpload?.ext, 'mp3');
    assert.equal(customMp3Result.parsedUpload?.mimeType, 'audio/mpeg');

    // Rejects invalid audio data URL on custom upload
    const invalidUpload = buildAndValidateMusicState({
      mode: 'upload',
      customAudioDataUrl: 'data:image/png;base64,NOT_AUDIO',
    });
    assert.equal(invalidUpload.valid, false);
    assert.match(invalidUpload.error || '', /valid MP3 or WAV/);

    // 3. Voiceover-only mode
    const voOnlyResult = buildAndValidateMusicState({
      mode: 'placeholder',
      musicPrompt: 'Warm acoustic groove',
    });
    assert.equal(voOnlyResult.valid, true);
    assert.equal(voOnlyResult.musicState?.status, 'not_requested');
    assert.match(voOnlyResult.musicState?.statusMessage || '', /Voiceover-Only mode active/);
  });

  it('preserves user-edited script and storyboard when TTS errors occur or when audio updates return', () => {
    const baseState = createBlankStudioState();
    baseState.voiceScriptDraft = 'Unsaved custom voiceover script with special tagline.';
    baseState.hasUnsavedStoryboardEdits = true;
    baseState.editableStoryboard = {
      conceptTitle: 'Unsaved Edited Concept Title',
      targetPlatformFormat: 'Instagram Reels (9:16)',
      totalDurationSeconds: 15,
      openingHook3s: 'Unsaved edited 3s hook',
      fullVoiceoverScript: 'Unsaved custom voiceover script with special tagline.',
      estimatedWordCount: 8,
      brandSafetyVerification: ['Verified'],
      masterCinematicPrompt9x16: 'Unsaved master 9:16 visual prompt',
      musicDirectionPrompt: 'Unsaved music prompt',
      shots: [
        {
          shotNumber: 1,
          durationSeconds: 15,
          timecodeRange: '00:00 - 00:15',
          shotType: '01. Hero',
          sceneDescription: 'Unsaved scene edit',
          cameraMovement: 'Static',
          visualPrompt9x16: 'Unsaved 9:16 shot prompt',
          onScreenTextOverlay: 'Hook',
          spokenVoiceoverSegment: 'Unsaved custom voiceover script with special tagline.',
          productFidelityNote: 'Preserve geometry',
        },
      ],
      generationMetadata: {
        requestedModel: 'gemini-3.1-flash-lite',
        resolvedModel: 'gemini-3.1-flash-lite',
        fallbackUsed: false,
        latencyMs: 420,
        generatedAt: '2026-11-04T00:02:00.000Z',
      },
    };

    const afterTtsError = handleVoiceoverErrorState(
      baseState,
      'Voiceover synthesis failed after trying all verified TTS models.'
    );
    assert.equal(afterTtsError.isGeneratingVoiceover, false);
    assert.equal(afterTtsError.lastRetryAction, 'voiceover');
    assert.equal(afterTtsError.voiceScriptDraft, 'Unsaved custom voiceover script with special tagline.');
    assert.equal(afterTtsError.editableStoryboard?.conceptTitle, 'Unsaved Edited Concept Title');
    assert.equal(afterTtsError.hasUnsavedStoryboardEdits, true);

    // Also verify that a successful voiceover update preserves unsaved storyboard edits in memory
    const updatedServerCampaign: Campaign = {
      id: 'cmp_vo_test',
      createdAt: '2026-11-04T00:00:00.000Z',
      updatedAt: '2026-11-04T00:05:00.000Z',
      status: 'audio_ready',
      title: 'Test Product',
      price: '$99',
      brandName: 'Test Brand',
      modelOrVariant: 'Pro',
      visiblePackagingText: 'TEST',
      brandVoice: 'Bold',
      targetAudience: 'Inferred: Test audience',
      visualStyle: 'Studio lighting',
      imageDataUrl: 'data:image/png;base64,TEST',
      analysisMetadata: {
        requestedModel: 'gemini-3.1-flash-lite',
        resolvedModel: 'gemini-3.1-flash-lite',
        fallbackUsed: false,
        latencyMs: 380,
        analyzedAt: '2026-11-04T00:01:00.000Z',
      },
      productProfile: {
        detectedProductName: 'Test Product',
        category: 'Test',
        subcategory: 'Sub',
        productSummary: 'Summary',
        dominantColors: [],
        materialsAndTextures: [],
        estimatedDimensions: '10cm',
        detectedFeatures: [],
        keySellingPoints: [],
        brandVoiceGuidelines: {
          toneDescriptors: [],
          wordsToUse: [],
          wordsToAvoid: [],
          targetPersonaSummary: 'Inferred: Test audience',
        },
        recommendedAdAngles: [],
        visualFidelityConstraints: [],
      },
      voiceover: {
        id: 'vo_123',
        voiceName: 'Zephyr',
        voiceStyle: 'Warm narrator',
        scriptTextUsed: 'Unsaved custom voiceover script with special tagline.',
        audioFileUrl: '/generated-audio/voiceover-cmp_vo_test.wav',
        mimeType: 'audio/wav',
        byteLength: 48044,
        sampleRateHz: 24000,
        durationEstimateSeconds: 1.0,
        resolvedModel: PRIMARY_TTS_MODEL,
        latencyMs: 900,
        generatedAt: '2026-11-04T00:05:00.000Z',
      },
    };

    const preservedState = applyVoiceoverOrMusicUpdatePreservingEdits(baseState, updatedServerCampaign);
    assert.equal(preservedState.activeCampaign?.voiceover?.voiceName, 'Zephyr');
    assert.equal(preservedState.editableStoryboard?.conceptTitle, 'Unsaved Edited Concept Title');
    assert.equal(preservedState.voiceScriptDraft, 'Unsaved custom voiceover script with special tagline.');
  });
});

describe('Product Studio Reset & Metadata Isolation Regression Suite', () => {
  const mockEspressoCampaign: Campaign = {
    id: 'camp_espresso_01',
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:05:00.000Z',
    status: 'audio_ready',
    title: 'Veloce Barista Pro Espresso Machine',
    price: '$649',
    brandName: 'Veloce Milano',
    modelOrVariant: 'Barista Pro 9-Bar',
    visiblePackagingText: 'VELOCE BARISTA PRO · 9 BAR DUAL BOILER',
    brandVoice: 'Luxury & Editorial',
    targetAudience: 'Inferred: Home specialty coffee enthusiasts and design-conscious morning commuters',
    visualStyle: 'Warm architectural morning sunlight, travertine stone countertop, rich crema macro shots',
    imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    analysisMetadata: {
      requestedModel: 'gemini-3.1-flash-lite',
      resolvedModel: 'gemini-3.1-flash-lite',
      fallbackUsed: false,
      latencyMs: 620,
      analyzedAt: '2026-11-04T00:01:00.000Z',
    },
    productProfile: {
      detectedProductName: 'Veloce Barista Pro Espresso Machine',
      category: 'Home Kitchen Appliances',
      subcategory: 'Espresso Machines',
      identifiedBrandName: 'Veloce Milano',
      identifiedModelOrVariant: 'Barista Pro 9-Bar',
      visiblePriceOrOffer: '$649',
      visiblePackagingTextAndLogos: ['VELOCE BARISTA PRO', '9 BAR DUAL BOILER'],
      identificationConfidence: 'high',
      uncertaintyNotes: 'Primary visual product attributes clearly observed.',
      suggestedVisualDirection: 'Warm architectural morning sunlight, travertine stone countertop, rich crema macro shots',
      productSummary: 'Dual-boiler espresso maker with brass gauge and walnut portafilter.',
      dominantColors: [
        { name: 'Matte Obsidian', hex: '#1C1917', usageRole: 'Chassis' },
        { name: 'Warm Brass', hex: '#D97706', usageRole: 'Pressure Gauge Accent' },
      ],
      materialsAndTextures: ['Matte obsidian steel', 'Brushed brass', 'Walnut wood'],
      estimatedDimensions: '32cm x 28cm x 38cm',
      detectedFeatures: ['9-bar brass pressure gauge', 'Walnut bottomless portafilter'],
      keySellingPoints: [
        {
          headline: '9-Bar Commercial Extraction',
          proofPoint: 'Dual-boiler PID temperature control',
          emotionalHook: 'Rich cafe crema every morning in 25 seconds.',
        },
      ],
      brandVoiceGuidelines: {
        toneDescriptors: ['Warm', 'Architectural', 'Refined'],
        wordsToUse: ['craft', 'crema', 'ritual'],
        wordsToAvoid: ['cheap', 'instant'],
        targetPersonaSummary: 'Inferred: Design-conscious home baristas',
      },
      recommendedAdAngles: [
        {
          angleName: '9-Bar Morning Ritual',
          targetPlatform: 'Instagram Reels',
          hookIdea: 'Stop settling for bitter Pod coffee.',
          visualDirection: 'Macro gauge sweep + tiger-stripe crema pour',
        },
      ],
      visualFidelityConstraints: ['Preserve brass pressure dial', 'Keep walnut handle geometry intact'],
    },
    storyboard: {
      conceptTitle: 'Morning Ritual in 9 Bars',
      targetPlatformFormat: 'Instagram Reels (9:16)',
      totalDurationSeconds: 15,
      openingHook3s: 'Stop settling for bitter morning coffee.',
      fullVoiceoverScript: 'Stop settling for bitter morning coffee. Meet Veloce Barista Pro.',
      estimatedWordCount: 10,
      brandSafetyVerification: ['Verified product claims', 'No exaggerated guarantees'],
      masterCinematicPrompt9x16: 'Vertical 9:16 commercial of obsidian espresso machine.',
      musicDirectionPrompt: 'Warm Italian espresso bar acoustic groove',
      shots: [
        {
          shotNumber: 1,
          durationSeconds: 3,
          timecodeRange: '00:00 - 00:03',
          shotType: '01. Macro Hook',
          sceneDescription: 'Pressure gauge needle rising to 9 bar.',
          cameraMovement: 'Slow push-in',
          visualPrompt9x16: '9:16 macro shot of brass pressure dial.',
          onScreenTextOverlay: '9-Bar Precision',
          spokenVoiceoverSegment: 'Stop settling for bitter morning coffee.',
          productFidelityNote: 'Keep brass gauge markings sharp.',
        },
      ],
      generationMetadata: {
        requestedModel: 'gemini-3.1-flash-lite',
        resolvedModel: 'gemini-3.1-flash-lite',
        fallbackUsed: false,
        latencyMs: 1450,
        generatedAt: '2026-11-04T00:03:00.000Z',
      },
    },
    voiceover: {
      id: 'vo_01',
      voiceName: 'Kore',
      voiceStyle: 'Warm, confident studio narrator',
      scriptTextUsed: 'Stop settling for bitter morning coffee. Meet Veloce Barista Pro.',
      audioFileUrl: '/generated-audio/voiceover-camp_espresso_01.wav',
      mimeType: 'audio/wav',
      byteLength: 48044,
      sampleRateHz: 24000,
      durationEstimateSeconds: 4.5,
      resolvedModel: PRIMARY_TTS_MODEL,
      latencyMs: 2100,
      generatedAt: '2026-11-04T00:04:00.000Z',
    },
    backgroundMusic: {
      status: 'unavailable_paid_tier',
      modelAttempted: 'lyria-realtime-exp',
      statusMessage: 'Lyria RealTime requires a paid billing project.',
      promptUsed: 'Warm Italian espresso bar acoustic groove',
      updatedAt: '2026-11-04T00:05:00.000Z',
    },
  };

  it('starts with a completely blank initial state (no preset or previous product values)', () => {
    const initial = createBlankStudioState();

    assert.equal(initial.form.title, '');
    assert.equal(initial.form.price, '');
    assert.equal(initial.form.brandName, '');
    assert.equal(initial.form.modelOrVariant, '');
    assert.equal(initial.form.visiblePackagingText, '');
    assert.equal(initial.form.brandVoice, '');
    assert.equal(initial.form.targetAudience, '');
    assert.equal(initial.form.visualStyle, '');
    assert.equal(initial.form.imageDataUrl, '');
    assert.equal(initial.form.selectedPresetId, '');

    assert.equal(initial.activeCampaign, null);
    assert.equal(initial.editableProfile, null);
    assert.equal(initial.editableStoryboard, null);
    assert.equal(initial.rawJsonText, '');
    assert.equal(initial.voiceScriptDraft, '');
    assert.equal(initial.musicPromptDraft, '');
    assert.equal(initial.errorBanner, null);
    assert.equal(initial.warningBanner, null);
    assert.equal(initial.statusMessage, null);
  });

  it('New Product Analysis clears every product-specific field, profile, storyboard, voiceover, and music state', () => {
    const populatedState = applyCampaignToStudioState(mockEspressoCampaign);
    populatedState.statusMessage = 'Generated Kore WAV voiceover.';
    populatedState.errorBanner = 'Some previous warning';
    populatedState.creativeAngleHint = 'Focus on latte art';

    assert.equal(populatedState.form.title, 'Veloce Barista Pro Espresso Machine');
    assert.notEqual(populatedState.activeCampaign, null);
    assert.notEqual(populatedState.editableProfile, null);
    assert.notEqual(populatedState.editableStoryboard, null);

    const resetState = resetToBlankProductState();

    assert.equal(resetState.form.title, '');
    assert.equal(resetState.form.price, '');
    assert.equal(resetState.form.brandName, '');
    assert.equal(resetState.form.modelOrVariant, '');
    assert.equal(resetState.form.visiblePackagingText, '');
    assert.equal(resetState.form.brandVoice, '');
    assert.equal(resetState.form.targetAudience, '');
    assert.equal(resetState.form.visualStyle, '');
    assert.equal(resetState.form.imageDataUrl, '');
    assert.equal(resetState.form.selectedPresetId, '');

    assert.equal(resetState.activeCampaign, null);
    assert.equal(resetState.editableProfile, null);
    assert.equal(resetState.editableStoryboard, null);
    assert.equal(resetState.rawJsonText, '');
    assert.equal(resetState.voiceScriptDraft, '');
    assert.equal(resetState.musicPromptDraft, '');
    assert.equal(resetState.creativeAngleHint, '');
    assert.equal(resetState.statusMessage, null);
    assert.equal(resetState.errorBanner, null);
    assert.equal(resetState.warningBanner, null);
  });

  it('selecting a preset fills only that preset metadata and invalidates prior product artifacts', () => {
    const populatedEspresso = applyCampaignToStudioState(mockEspressoCampaign);
    assert.equal(populatedEspresso.form.title, 'Veloce Barista Pro Espresso Machine');

    const serumPreset = SAMPLE_PRODUCT_PRESETS[1];
    const fakeSerumImage = 'data:image/png;base64,SERUM_IMAGE_DATA';
    const nextState = applyPresetToStudioState(serumPreset, fakeSerumImage);

    assert.equal(nextState.form.selectedPresetId, serumPreset.id);
    assert.equal(nextState.form.title, serumPreset.title);
    assert.equal(nextState.form.price, serumPreset.price);
    assert.equal(nextState.form.brandName, serumPreset.brandName);
    assert.equal(nextState.form.modelOrVariant, serumPreset.modelOrVariant);
    assert.equal(nextState.form.visiblePackagingText, serumPreset.visiblePackagingText);
    assert.equal(nextState.form.brandVoice, serumPreset.brandVoice);
    assert.equal(nextState.form.targetAudience, serumPreset.targetAudience);
    assert.equal(nextState.form.visualStyle, serumPreset.visualStyle);
    assert.equal(nextState.form.imageDataUrl, fakeSerumImage);

    assert.equal(nextState.activeCampaign, null);
    assert.equal(nextState.editableProfile, null);
    assert.equal(nextState.editableStoryboard, null);
    assert.equal(nextState.voiceScriptDraft, '');
    assert.equal(nextState.musicPromptDraft, '');
  });

  it('uploading a different product image clears previous product metadata and invalidates old profile and generated content', () => {
    const populatedEspresso = applyCampaignToStudioState(mockEspressoCampaign);
    assert.equal(populatedEspresso.form.title, 'Veloce Barista Pro Espresso Machine');
    assert.equal(populatedEspresso.form.price, '$649');
    assert.equal(populatedEspresso.form.brandName, 'Veloce Milano');
    assert.notEqual(populatedEspresso.editableProfile, null);
    assert.notEqual(populatedEspresso.editableStoryboard, null);
    assert.notEqual(populatedEspresso.activeCampaign?.voiceover, undefined);

    const uploadedSneakerDataUrl = 'data:image/png;base64,NEW_UPLOADED_PRODUCT_IMAGE';
    const afterUpload = applyUploadedImageToStudioState(populatedEspresso, uploadedSneakerDataUrl, true);

    assert.equal(afterUpload.form.imageDataUrl, uploadedSneakerDataUrl);
    assert.equal(afterUpload.form.selectedPresetId, 'custom-upload');
    assert.equal(afterUpload.isAnalyzing, true);

    assert.equal(afterUpload.form.title, '');
    assert.equal(afterUpload.form.price, '');
    assert.equal(afterUpload.form.brandName, '');
    assert.equal(afterUpload.form.modelOrVariant, '');
    assert.equal(afterUpload.form.visiblePackagingText, '');
    assert.equal(afterUpload.form.brandVoice, '');
    assert.equal(afterUpload.form.targetAudience, '');
    assert.equal(afterUpload.form.visualStyle, '');

    assert.equal(afterUpload.activeCampaign, null);
    assert.equal(afterUpload.editableProfile, null);
    assert.equal(afterUpload.editableStoryboard, null);
    assert.equal(afterUpload.rawJsonText, '');
    assert.equal(afterUpload.voiceScriptDraft, '');
    assert.equal(afterUpload.musicPromptDraft, '');
  });
});

describe('Image-Based Product Identification & Non-Fabrication Extraction Suite', () => {
  it('automatically triggers Gemini product analysis on image upload and populates extracted details into UI fields', async () => {
    const uploadedSerumImage = 'data:image/png;base64,UPLOADED_SERUM_IMAGE_BYTES';
    let analyzeEndpointCalled = false;
    let postedImageDataUrl = '';

    const mockExtractedProfile: ProductProfile = {
      detectedProductName: 'Solaris 20% Vitamin C + Ferulic Radiance Elixir',
      category: 'Beauty & Skincare',
      subcategory: 'Facial Serums',
      identifiedBrandName: 'Solaris Botanica',
      identifiedModelOrVariant: '30 ML / 1.0 FL OZ Dropper',
      visiblePriceOrOffer: '',
      visiblePackagingTextAndLogos: [
        'SOLARIS BOTANICA',
        '20% VITAMIN C + FERULIC',
        'Cold-Pressed Sea Buckthorn',
        '30 ML / 1.0 FL OZ',
      ],
      identificationConfidence: 'high',
      uncertaintyNotes: 'All front label text and bottle features are clearly legible.',
      suggestedVisualDirection: 'Warm golden-hour lighting on travertine stone with macro glass dropper shots',
      productSummary: 'Amber frosted glass dropper bottle containing 20% Vitamin C + Ferulic botanical serum.',
      dominantColors: [{ name: 'Amber Glass', hex: '#B85D19', usageRole: 'Bottle' }],
      materialsAndTextures: ['Frosted amber glass', 'Brushed gold collar', 'Matte cream dropper bulb'],
      estimatedDimensions: '30 ml (1.0 fl oz) apothecary dropper bottle',
      detectedFeatures: ['Glass pipette dropper', 'Minimalist cream front label', 'Gold neck collar'],
      keySellingPoints: [
        {
          headline: '20% Vitamin C + Ferulic Complex',
          proofPoint: 'Printed directly on apothecary front label',
          emotionalHook: 'Brighter, firmer skin tone with daily morning application.',
        },
      ],
      brandVoiceGuidelines: {
        toneDescriptors: ['Clinical', 'Botanical', 'Serene'],
        wordsToUse: ['radiance', 'elixir', 'cold-pressed'],
        wordsToAvoid: ['miracle', 'instant cure'],
        targetPersonaSummary: 'Skincare enthusiasts seeking clean clinical vitamin C serums',
      },
      recommendedAdAngles: [
        {
          angleName: 'Golden Hour Dropper Ritual',
          targetPlatform: 'Instagram Reels',
          hookIdea: 'Three drops to glass-skin morning radiance.',
          visualDirection: '9:16 macro slow-motion serum drop catching warm sunlight',
        },
      ],
      visualFidelityConstraints: ['Preserve amber bottle tint and cream label typography'],
    };

    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      analyzeEndpointCalled = true;
      assert.equal(String(input), '/api/campaigns/analyze');
      const body = JSON.parse(String(init?.body || '{}'));
      postedImageDataUrl = body.imageDataUrl;

      const responseCampaign: Campaign = {
        id: 'cmp_serum_auto',
        title: mockExtractedProfile.detectedProductName,
        price: '',
        brandName: mockExtractedProfile.identifiedBrandName!,
        modelOrVariant: mockExtractedProfile.identifiedModelOrVariant!,
        visiblePackagingText: mockExtractedProfile.visiblePackagingTextAndLogos!.join(' · '),
        brandVoice: 'Clinical & Botanical',
        targetAudience: 'Inferred: Skincare enthusiasts seeking clean clinical vitamin C serums',
        visualStyle: mockExtractedProfile.suggestedVisualDirection!,
        imageDataUrl: uploadedSerumImage,
        productProfile: mockExtractedProfile,
        analysisMetadata: {
          requestedModel: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
          resolvedModel: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
          fallbackUsed: false,
          latencyMs: 580,
          analyzedAt: '2026-11-04T01:00:00.000Z',
        },
        status: 'analyzed',
        createdAt: '2026-11-04T01:00:00.000Z',
        updatedAt: '2026-11-04T01:00:00.000Z',
      };

      return new Response(JSON.stringify({ campaign: responseCampaign }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const { state, campaign } = await analyzeUploadedImageWithGemini(
      uploadedSerumImage,
      { selectedPresetId: 'custom-upload' },
      mockFetch
    );

    assert.equal(analyzeEndpointCalled, true);
    assert.equal(postedImageDataUrl, uploadedSerumImage);
    assert.notEqual(campaign, null);
    assert.equal(state.isAnalyzing, false);
    assert.equal(state.errorBanner, null);

    // Verify extracted fields populate the UI form inputs accurately
    assert.equal(state.form.imageDataUrl, uploadedSerumImage);
    assert.equal(state.form.title, 'Solaris 20% Vitamin C + Ferulic Radiance Elixir');
    assert.equal(state.form.brandName, 'Solaris Botanica');
    assert.equal(state.form.modelOrVariant, '30 ML / 1.0 FL OZ Dropper');
    assert.equal(
      state.form.visiblePackagingText,
      'SOLARIS BOTANICA · 20% VITAMIN C + FERULIC · Cold-Pressed Sea Buckthorn · 30 ML / 1.0 FL OZ'
    );
    // Price must remain empty since no price was supplied or visible in the image
    assert.equal(state.form.price, '');
    // Target audience must be clearly marked as an inference
    assert.match(state.form.targetAudience, /^Inferred:/);
    assert.equal(
      state.form.visualStyle,
      'Warm golden-hour lighting on travertine stone with macro glass dropper shots'
    );
    assert.equal(state.editableProfile?.category, 'Beauty & Skincare');
  });

  it('does not fabricate unknown brand, model, packaging text, or price when not visible in the image', () => {
    const rawUnbrandedResponse = {
      detectedProductName: 'Handcrafted Ceramic Pour-Over Coffee Dripper',
      category: 'Kitchen & Dining',
      subcategory: 'Coffee Brewers',
      identifiedBrandName: 'Independent Brand', // Should be sanitized to "Unknown"
      identifiedModelOrVariant: 'Not visible', // Should be sanitized to "Unknown"
      visiblePriceOrOffer: 'Price on request', // Should be sanitized to "" (empty)
      visiblePackagingTextAndLogos: ['None visible', 'N/A'], // Should be sanitized to []
      identificationConfidence: 'medium',
      uncertaintyNotes: 'Unbranded artisan ceramic piece with no printed logo or packaging.',
      suggestedVisualDirection: 'Soft natural window light highlighting ribbed ceramic glaze',
      productSummary: 'Matte speckled stoneware pour-over coffee dripper with spiral interior ribs.',
      dominantColors: [{ name: 'Speckled Oat', hex: '#D6CFC2', usageRole: 'Ceramic body' }],
      materialsAndTextures: ['Speckled stoneware ceramic'],
      estimatedDimensions: 'Unknown',
      detectedFeatures: ['Spiral extraction ribs', 'Single-cup flared base'],
      keySellingPoints: [
        {
          headline: 'Artisan Spiral Ribbed Extraction',
          proofPoint: 'Visible interior ceramic ridging',
          emotionalHook: 'Clean, balanced pour-over coffee every morning.',
        },
      ],
      brandVoiceGuidelines: {
        toneDescriptors: ['Artisanal', 'Calm'],
        wordsToUse: ['handcrafted', 'ritual'],
        wordsToAvoid: ['industrial'],
        targetPersonaSummary: 'Home slow-coffee enthusiasts and ceramic collectors',
      },
      recommendedAdAngles: [
        {
          angleName: 'Slow Morning Pour',
          targetPlatform: 'Instagram Reels',
          hookIdea: 'Elevate your morning pour-over ritual.',
          visualDirection: 'Overhead macro steam and water bloom shot',
        },
      ],
      visualFidelityConstraints: ['Preserve speckled stoneware texture'],
    };

    const validation = validateAndNormalizeProductProfile(rawUnbrandedResponse);
    assert.equal(validation.valid, true);
    const profile = validation.profile!;

    // Unknown details must be marked "Unknown" or empty—never fabricated placeholders
    assert.equal(profile.identifiedBrandName, 'Unknown');
    assert.equal(profile.identifiedModelOrVariant, 'Unknown');
    assert.equal(profile.visiblePriceOrOffer, '');
    assert.deepEqual(profile.visiblePackagingTextAndLogos, []);
    assert.match(profile.brandVoiceGuidelines.targetPersonaSummary, /^Inferred:/);

    const blankForm = createBlankStudioState().form;
    const mappedForm = mapExtractedProfileToForm(blankForm, profile);

    assert.equal(mappedForm.title, 'Handcrafted Ceramic Pour-Over Coffee Dripper');
    assert.equal(mappedForm.brandName, 'Unknown');
    assert.equal(mappedForm.modelOrVariant, 'Unknown');
    assert.equal(mappedForm.visiblePackagingText, 'Unknown');
    assert.equal(mappedForm.price, '');
    assert.equal(
      mappedForm.targetAudience,
      'Inferred: Home slow-coffee enthusiasts and ceramic collectors'
    );
  });

  it('handles malformed responses and API errors gracefully without leaving stale data', async () => {
    const malformedCheck = validateAndNormalizeProductProfile('not-an-object');
    assert.equal(malformedCheck.valid, false);

    const incompleteCheck = validateAndNormalizeProductProfile({
      detectedProductName: '',
      category: '',
    });
    assert.equal(incompleteCheck.valid, false);

    const failingFetch = (async () =>
      new Response(JSON.stringify({ error: 'Unable to read product image.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    const uploadedUrl = 'data:image/png;base64,TEST_IMAGE';
    const { state, campaign } = await analyzeUploadedImageWithGemini(
      uploadedUrl,
      {},
      failingFetch
    );

    assert.equal(campaign, null);
    assert.equal(state.isAnalyzing, false);
    assert.equal(state.errorBanner, 'Unable to read product image.');
    assert.equal(state.form.imageDataUrl, uploadedUrl);
    assert.equal(state.form.title, '');
    assert.equal(state.form.brandName, '');
    assert.equal(state.form.price, '');
    assert.equal(state.editableProfile, null);
  });
});

describe('Storyboard Model Routing, Bounded Backoff & Verified Fallback Suite', () => {
  const validRawStoryboardJson = JSON.stringify({
    conceptTitle: 'Veloce 9-Bar Morning Ritual',
    openingHook3s: 'Stop settling for bitter morning coffee.',
    fullVoiceoverScript:
      'Stop settling for bitter morning coffee. Veloce Barista Pro extracts rich cafe crema in twenty-five seconds.',
    brandSafetyVerification: [
      'Verified 9-bar pressure gauge and walnut portafilter from product profile.',
    ],
    masterCinematicPrompt9x16:
      'Vertical 9:16 studio commercial of matte obsidian Veloce Barista Pro with brass accents.',
    musicDirectionPrompt: 'Warm acoustic espresso bar groove, 98 BPM',
    shots: [
      {
        shotNumber: 1,
        durationSeconds: 4,
        shotType: '01. Macro Hero Hook',
        sceneDescription: 'Brass pressure gauge rising smoothly to 9 bar.',
        cameraMovement: 'Slow macro push-in',
        visualPrompt9x16: 'Vertical 9:16 close-up of matte obsidian espresso machine brass dial.',
        onScreenTextOverlay: '9-Bar Precision',
        spokenVoiceoverSegment: 'Stop settling for bitter morning coffee.',
        productFidelityNote: 'Preserve brass dial typography and matte obsidian finish.',
      },
      {
        shotNumber: 2,
        durationSeconds: 11,
        shotType: '02. Extraction & CTA',
        sceneDescription: 'Rich crema pouring from walnut bottomless portafilter into ceramic cup.',
        cameraMovement: 'Low-angle tracking shot',
        visualPrompt9x16:
          'Vertical 9:16 slow-motion espresso extraction from walnut handle portafilter.',
        onScreenTextOverlay: 'Veloce Barista Pro',
        spokenVoiceoverSegment:
          'Veloce Barista Pro extracts rich cafe crema in twenty-five seconds.',
        productFidelityNote: 'Maintain walnut wood grain and ceramic cup proportions.',
      },
    ],
  });

  it('uses verified available model (nvidia/llama-3.1-nemotron-70b-instruct) first for storyboard generation and preserves user selections', async () => {
    const preferredPrimary = getPreferredStoryboardModel();
    assert.equal(PRIMARY_STORYBOARD_MODEL, DEFAULT_NVIDIA_TEXT_MODEL);
    assert.equal(VERIFIED_FALLBACK_STORYBOARD_MODEL, FALLBACK_NVIDIA_TEXT_MODEL);
    assert.equal(preferredPrimary, DEFAULT_NVIDIA_TEXT_MODEL);

    const calledModels: string[] = [];
    const sleepDelays: number[] = [];

    const execution = await executeWithVerifiedModelFallback(
      async (modelId) => {
        calledModels.push(modelId);
        return validRawStoryboardJson;
      },
      {
        primaryModel: preferredPrimary,
        verifiedFallbackModels: [VERIFIED_FALLBACK_STORYBOARD_MODEL],
        maxRetriesPerModel: 2,
        sleepFn: async (ms) => {
          sleepDelays.push(ms);
        },
      }
    );

    assert.deepEqual(calledModels, [DEFAULT_NVIDIA_TEXT_MODEL]);
    assert.deepEqual(sleepDelays, []);
    assert.equal(execution.requestedModel, DEFAULT_NVIDIA_TEXT_MODEL);
    assert.equal(execution.resolvedModel, DEFAULT_NVIDIA_TEXT_MODEL);
    assert.equal(execution.fallbackUsed, false);
    assert.equal(execution.fallbackReason, undefined);

    const storyboard = parseAndValidateGeneratedStoryboard(
      execution.result,
      'YouTube Shorts (9:16)',
      {
        requestedModel: execution.requestedModel,
        resolvedModel: execution.resolvedModel,
        fallbackUsed: execution.fallbackUsed,
        fallbackReason: execution.fallbackReason,
        latencyMs: execution.latencyMs,
        generatedAt: '2026-11-04T01:20:00.000Z',
      }
    );

    assert.equal(storyboard.targetPlatformFormat, 'YouTube Shorts (9:16)');
    assert.equal(storyboard.totalDurationSeconds, 15);
    assert.equal(storyboard.shots.length, 2);
    assert.equal(storyboard.shots[0].timecodeRange, '00:00 - 00:04');
    assert.equal(storyboard.shots[1].timecodeRange, '00:04 - 00:15');
  });

  it('recovers from transient 503/UNAVAILABLE on the primary model via bounded exponential backoff without needing fallback', async () => {
    const attemptLog: Array<{ modelId: string; attempt: number }> = [];
    const backoffLog: number[] = [];

    const execution = await executeWithVerifiedModelFallback(
      async (modelId, attempt) => {
        attemptLog.push({ modelId, attempt });
        if (modelId === DEFAULT_NVIDIA_TEXT_MODEL && attempt === 1) {
          throw new Error(`503 UNAVAILABLE: Transient spike on ${DEFAULT_NVIDIA_TEXT_MODEL}.`);
        }
        return validRawStoryboardJson;
      },
      {
        primaryModel: DEFAULT_NVIDIA_TEXT_MODEL,
        verifiedFallbackModels: [FALLBACK_NVIDIA_TEXT_MODEL],
        maxRetriesPerModel: 2,
        baseDelayMs: 250,
        maxDelayMs: 1000,
        sleepFn: async (ms) => {
          backoffLog.push(ms);
        },
      }
    );

    assert.deepEqual(attemptLog, [
      { modelId: DEFAULT_NVIDIA_TEXT_MODEL, attempt: 1 },
      { modelId: DEFAULT_NVIDIA_TEXT_MODEL, attempt: 2 },
    ]);
    assert.deepEqual(backoffLog, [250]);
    assert.equal(execution.requestedModel, DEFAULT_NVIDIA_TEXT_MODEL);
    assert.equal(execution.resolvedModel, DEFAULT_NVIDIA_TEXT_MODEL);
    assert.equal(execution.fallbackUsed, false);
  });

  it('retries transient 503/UNAVAILABLE with bounded exponential backoff and falls back only to verified supported model', async () => {
    // Ensure unverified or unsupported models are filtered out of the chain
    const chain = buildVerifiedStoryboardModelChain(DEFAULT_NVIDIA_TEXT_MODEL, [
      'unverified-experimental-model',
      FALLBACK_NVIDIA_TEXT_MODEL,
    ]);
    assert.deepEqual(chain, [DEFAULT_NVIDIA_TEXT_MODEL, FALLBACK_NVIDIA_TEXT_MODEL]);

    // Verify bounded exponential backoff calculation
    assert.equal(computeExponentialBackoffMs(0, 250, 1000), 250);
    assert.equal(computeExponentialBackoffMs(1, 250, 1000), 500);
    assert.equal(computeExponentialBackoffMs(2, 250, 1000), 1000);
    assert.equal(computeExponentialBackoffMs(5, 250, 1000), 1000);

    const attemptLog: Array<{ modelId: string; attempt: number }> = [];
    const backoffLog: number[] = [];

    const execution = await executeWithVerifiedModelFallback(
      async (modelId, attempt) => {
        attemptLog.push({ modelId, attempt });
        if (modelId === DEFAULT_NVIDIA_TEXT_MODEL) {
          throw new Error('503 UNAVAILABLE: Primary model experiencing high demand.');
        }
        return validRawStoryboardJson;
      },
      {
        primaryModel: DEFAULT_NVIDIA_TEXT_MODEL,
        verifiedFallbackModels: [FALLBACK_NVIDIA_TEXT_MODEL],
        maxRetriesPerModel: 2,
        baseDelayMs: 250,
        maxDelayMs: 1000,
        sleepFn: async (ms) => {
          backoffLog.push(ms);
        },
      }
    );

    // Primary tried 3 times (initial + 2 bounded retries with 250ms, 500ms backoff), then verified fallback succeeded on attempt 1
    assert.deepEqual(attemptLog, [
      { modelId: DEFAULT_NVIDIA_TEXT_MODEL, attempt: 1 },
      { modelId: DEFAULT_NVIDIA_TEXT_MODEL, attempt: 2 },
      { modelId: DEFAULT_NVIDIA_TEXT_MODEL, attempt: 3 },
      { modelId: FALLBACK_NVIDIA_TEXT_MODEL, attempt: 1 },
    ]);
    assert.deepEqual(backoffLog, [250, 500]);
    assert.equal(execution.requestedModel, DEFAULT_NVIDIA_TEXT_MODEL);
    assert.equal(execution.resolvedModel, FALLBACK_NVIDIA_TEXT_MODEL);
    assert.equal(execution.fallbackUsed, true);
    assert.match(execution.fallbackReason || '', new RegExp(FALLBACK_NVIDIA_TEXT_MODEL));
  });

  it('throws a clear AllModelsFailedError and never fabricates a storyboard when all configured models fail', async () => {
    const backoffLog: number[] = [];

    await assert.rejects(
      async () => {
        await executeWithVerifiedModelFallback(
          async (modelId) => {
            throw new Error(`503 UNAVAILABLE on ${modelId}: service overloaded`);
          },
          {
            primaryModel: DEFAULT_NVIDIA_TEXT_MODEL,
            verifiedFallbackModels: [FALLBACK_NVIDIA_TEXT_MODEL],
            maxRetriesPerModel: 1,
            baseDelayMs: 200,
            maxDelayMs: 800,
            sleepFn: async (ms) => {
              backoffLog.push(ms);
            },
          }
        );
      },
      (err: unknown) => {
        assert.equal(err instanceof AllModelsFailedError, true);
        const allFailed = err as AllModelsFailedError;
        assert.match(allFailed.message, /Generation failed after trying all verified models/);
        assert.match(allFailed.message, /2 attempts/);
        assert.equal(allFailed.attempts.length, 4);
        return true;
      }
    );

    // 1 retry on primary (200ms) + 1 retry on fallback (200ms)
    assert.deepEqual(backoffLog, [200, 200]);
  });
});

describe('NVIDIA Nemotron Integration & Error Handling Suite', () => {
  it('throws a clean NemotronError when NVIDIA_API_KEY is not configured', () => {
    assert.throws(
      () => getNvidiaApiKey({}),
      (err: unknown) => {
        assert.equal(err instanceof NemotronError, true);
        const nemError = err as NemotronError;
        assert.equal(nemError.category, 'missing_key');
        assert.equal(nemError.statusCode, 401);
        assert.equal(nemError.isTransient, false);
        assert.match(nemError.message, /NVIDIA_API_KEY/);
        return true;
      }
    );

    // Returns key when set
    assert.equal(getNvidiaApiKey({ NVIDIA_API_KEY: 'nvapi-test-key-123' }), 'nvapi-test-key-123');
  });

  it('extracts raw JSON cleanly from markdown code blocks or plain JSON text', () => {
    const rawPlain = '{"detectedProductName": "Espresso Pro"}';
    assert.equal(extractJsonFromText(rawPlain), rawPlain);

    const markdownFence = '```json\n{"detectedProductName": "Espresso Pro"}\n```';
    assert.equal(extractJsonFromText(markdownFence), '{"detectedProductName": "Espresso Pro"}');

    const surroundingText = 'Here is the JSON:\n```json\n{"key": "value"}\n```\nHope this helps!';
    assert.equal(extractJsonFromText(surroundingText), '{"key": "value"}');
  });

  it('correctly categorizes transient vs non-transient status codes and network errors', () => {
    assert.equal(isTransientNemotronStatus(429), true);
    assert.equal(isTransientNemotronStatus(503), true);
    assert.equal(isTransientNemotronStatus(504), true);
    assert.equal(isTransientNemotronStatus(401), false);
    assert.equal(isTransientNemotronStatus(404), false);
    assert.equal(isTransientNemotronStatus(undefined, 'rate limit exceeded'), true);
    assert.equal(isTransientNemotronStatus(undefined, 'ECONNRESET'), true);
    assert.equal(isTransientNemotronStatus(undefined, 'fetch failed'), true);
  });

  it('performs OpenAI-compatible chat completions using mock fetch and handles 401, 429, and timeouts cleanly', async () => {
    // 1. Successful chat completion
    const mockSuccessFetch = (async () => {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-123',
          model: DEFAULT_NVIDIA_TEXT_MODEL,
          choices: [
            {
              message: {
                role: 'assistant',
                content: '{"conceptTitle": "Nemotron Ad"}',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const successResult = await callNemotronChatCompletion(
      [{ role: 'user', content: 'Create ad' }],
      {},
      { NVIDIA_API_KEY: 'nvapi-valid-test' },
      mockSuccessFetch
    );
    assert.equal(successResult.text, '{"conceptTitle": "Nemotron Ad"}');
    assert.equal(successResult.modelUsed, DEFAULT_NVIDIA_TEXT_MODEL);

    // 2. 401 Auth error
    const mockAuthErrorFetch = (async () => {
      return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await assert.rejects(
      async () => {
        await callNemotronChatCompletion(
          [{ role: 'user', content: 'Create ad' }],
          {},
          { NVIDIA_API_KEY: 'nvapi-invalid' },
          mockAuthErrorFetch
        );
      },
      (err: unknown) => {
        assert.equal(err instanceof NemotronError, true);
        const nemError = err as NemotronError;
        assert.equal(nemError.category, 'auth_error');
        assert.equal(nemError.statusCode, 401);
        assert.equal(nemError.isTransient, false);
        return true;
      }
    );

    // 3. 429 Rate limit error
    const mockRateLimitFetch = (async () => {
      return new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await assert.rejects(
      async () => {
        await callNemotronChatCompletion(
          [{ role: 'user', content: 'Create ad' }],
          {},
          { NVIDIA_API_KEY: 'nvapi-valid' },
          mockRateLimitFetch
        );
      },
      (err: unknown) => {
        assert.equal(err instanceof NemotronError, true);
        const nemError = err as NemotronError;
        assert.equal(nemError.category, 'rate_limited');
        assert.equal(nemError.statusCode, 429);
        assert.equal(nemError.isTransient, true);
        return true;
      }
    );


    // Also verify parseAndValidateGeneratedStoryboard rejects empty or incomplete payloads instead of fabricating
    assert.throws(
      () =>
        parseAndValidateGeneratedStoryboard(
          JSON.stringify({ conceptTitle: 'Empty Shots', fullVoiceoverScript: 'Script', shots: [] }),
          'Instagram Reels (9:16)',
          {
            requestedModel: 'gemini-3.1-flash-lite',
            resolvedModel: 'gemini-3.1-flash-lite',
            fallbackUsed: false,
            latencyMs: 100,
            generatedAt: '2026-11-04T01:20:00.000Z',
          }
        ),
      /Incomplete storyboard generated/
    );
  });
});

describe('Milestone 3 — 9:16 Video Rendering, MP4 Verification, Sync & Approval Gate Suite', () => {
  it('validates render requests, prevents path traversal, and blocks duplicate concurrent render jobs', async () => {
    const {
      isSafeIdentifier,
      isSafeVideoFilename,
      validateRenderRequest,
      canStartNewRenderJob,
      createQueuedRenderJob,
    } = await import('../src/utils/milestone3Validators.ts');

    // Path traversal & identifier checks
    assert.equal(isSafeIdentifier('camp_espresso_01'), true);
    assert.equal(isSafeIdentifier('../etc/passwd'), false);
    assert.equal(isSafeIdentifier('camp/../../secret'), false);
    assert.equal(isSafeVideoFilename('render_camp_01_job_01.mp4'), true);
    assert.equal(isSafeVideoFilename('../render_camp_01_job_01.mp4'), false);
    assert.equal(isSafeVideoFilename('render_camp_01_job_01.avi'), false);

    const readyCampaign: Campaign = {
      id: 'camp_m3_ready',
      createdAt: '2026-11-04T00:00:00.000Z',
      updatedAt: '2026-11-04T00:05:00.000Z',
      status: 'audio_ready',
      title: 'Veloce Barista Pro',
      price: '$649',
      brandName: 'Veloce Milano',
      modelOrVariant: 'Pro 9-Bar',
      visiblePackagingText: 'VELOCE',
      brandVoice: 'Luxury',
      targetAudience: 'Inferred: Home baristas',
      visualStyle: 'Warm studio light',
      imageDataUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      analysisMetadata: {
        requestedModel: 'gemini-3.1-flash-lite',
        resolvedModel: 'gemini-3.1-flash-lite',
        fallbackUsed: false,
        latencyMs: 400,
        analyzedAt: '2026-11-04T00:00:00.000Z',
      },
      productProfile: {
        detectedProductName: 'Veloce Barista Pro',
        category: 'Appliances',
        subcategory: 'Espresso',
        productSummary: 'Dual boiler espresso maker.',
        dominantColors: [{ name: 'Obsidian', hex: '#1C1917', usageRole: 'Chassis' }],
        materialsAndTextures: ['Steel'],
        estimatedDimensions: '30cm',
        detectedFeatures: ['9-bar gauge'],
        keySellingPoints: [
          { headline: '9-Bar Extraction', proofPoint: 'Brass gauge', emotionalHook: 'Cafe crema' },
        ],
        brandVoiceGuidelines: {
          toneDescriptors: ['Warm'],
          wordsToUse: ['crema'],
          wordsToAvoid: ['cheap'],
          targetPersonaSummary: 'Inferred: Home baristas',
        },
        recommendedAdAngles: [],
        visualFidelityConstraints: ['Preserve brass gauge'],
      },
      storyboard: {
        conceptTitle: '9-Bar Morning Ritual',
        targetPlatformFormat: 'Instagram Reels (9:16)',
        totalDurationSeconds: 4,
        openingHook3s: 'Stop settling for bitter coffee.',
        fullVoiceoverScript: 'Stop settling for bitter coffee. Meet Veloce Barista Pro.',
        estimatedWordCount: 9,
        brandSafetyVerification: ['Verified'],
        masterCinematicPrompt9x16: 'Vertical 9:16 shot.',
        musicDirectionPrompt: 'Warm acoustic',
        shots: [
          {
            shotNumber: 1,
            durationSeconds: 2,
            timecodeRange: '00:00 - 00:02',
            shotType: '01. Hook',
            sceneDescription: 'Brass pressure gauge rising to 9 bar.',
            cameraMovement: 'Push-in',
            visualPrompt9x16: '9:16 macro gauge.',
            onScreenTextOverlay: '9-Bar Precision',
            spokenVoiceoverSegment: 'Stop settling for bitter coffee.',
            productFidelityNote: 'Preserve brass dial.',
          },
          {
            shotNumber: 2,
            durationSeconds: 2,
            timecodeRange: '00:02 - 00:04',
            shotType: '02. Hero',
            sceneDescription: 'Espresso pouring into cup.',
            cameraMovement: 'Tracking',
            visualPrompt9x16: '9:16 crema pour.',
            onScreenTextOverlay: 'Veloce Barista Pro',
            spokenVoiceoverSegment: 'Meet Veloce Barista Pro.',
            productFidelityNote: 'Preserve walnut portafilter.',
          },
        ],
        generationMetadata: {
          requestedModel: 'gemini-3.1-flash-lite',
          resolvedModel: 'gemini-3.1-flash-lite',
          fallbackUsed: false,
          latencyMs: 500,
          generatedAt: '2026-11-04T00:02:00.000Z',
        },
      },
      voiceover: {
        id: 'vo_m3_01',
        voiceName: 'Kore',
        voiceStyle: 'Warm narrator',
        scriptTextUsed: 'Stop settling for bitter coffee. Meet Veloce Barista Pro.',
        audioFileUrl: '/api/audio/voiceover-camp_m3_ready.wav',
        mimeType: 'audio/wav',
        byteLength: 192044,
        sampleRateHz: 24000,
        durationEstimateSeconds: 4.0,
        resolvedModel: PRIMARY_TTS_MODEL,
        latencyMs: 800,
        generatedAt: '2026-11-04T00:03:00.000Z',
      },
    };

    const validReq = validateRenderRequest(
      {
        resolution: '1080x1920',
        includeSubtitles: true,
        enginePreference: 'ffmpeg_motion_compositor',
      },
      readyCampaign
    );
    assert.equal(validReq.valid, true);
    assert.equal(validReq.settings?.resolution, '1080x1920');

    // Duplicate concurrent job guard
    const queuedJob = createQueuedRenderJob(readyCampaign, validReq.settings!, 'job_m3_01');
    const campaignWithActiveJob: Campaign = {
      ...readyCampaign,
      activeRenderJob: queuedJob,
    };
    const duplicateCheck = canStartNewRenderJob(campaignWithActiveJob);
    assert.equal(duplicateCheck.allowed, false);
    assert.match(duplicateCheck.error || '', /already queued/);

    const duplicateReq = validateRenderRequest({}, campaignWithActiveJob);
    assert.equal(duplicateReq.valid, false);
    assert.match(duplicateReq.error || '', /already queued/);
  });

  it('transitions render job states (queued -> processing -> completed / failed) and preserves campaign edits on failure', async () => {
    const {
      DEFAULT_RENDER_SETTINGS,
      createQueuedRenderJob,
      transitionRenderJobStatus,
    } = await import('../src/utils/milestone3Validators.ts');
    const { handleRenderErrorState } = await import('../src/utils/studioState.ts');

    const mockPreset = applyPresetToStudioState(
      SAMPLE_PRODUCT_PRESETS[0],
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    );
    const dummyCampaign: Campaign = {
      id: 'camp_lifecycle',
      createdAt: '2026-11-04T00:00:00.000Z',
      updatedAt: '2026-11-04T00:00:00.000Z',
      status: 'audio_ready',
      title: mockPreset.form.title,
      price: mockPreset.form.price,
      brandName: mockPreset.form.brandName,
      modelOrVariant: mockPreset.form.modelOrVariant,
      visiblePackagingText: mockPreset.form.visiblePackagingText,
      brandVoice: mockPreset.form.brandVoice,
      targetAudience: mockPreset.form.targetAudience,
      visualStyle: mockPreset.form.visualStyle,
      imageDataUrl: mockPreset.form.imageDataUrl,
      analysisMetadata: {
        requestedModel: 'gemini-3.1-flash-lite',
        resolvedModel: 'gemini-3.1-flash-lite',
        fallbackUsed: false,
        latencyMs: 300,
        analyzedAt: '2026-11-04T00:00:00.000Z',
      },
      productProfile: {
        detectedProductName: mockPreset.form.title,
        category: 'Appliances',
        subcategory: 'Espresso',
        productSummary: 'Summary',
        dominantColors: [],
        materialsAndTextures: [],
        estimatedDimensions: '30cm',
        detectedFeatures: [],
        keySellingPoints: [],
        brandVoiceGuidelines: {
          toneDescriptors: [],
          wordsToUse: [],
          wordsToAvoid: [],
          targetPersonaSummary: 'Inferred: Coffee lovers',
        },
        recommendedAdAngles: [],
        visualFidelityConstraints: [],
      },
    };

    const queued = createQueuedRenderJob(dummyCampaign, DEFAULT_RENDER_SETTINGS, 'job_lifecycle_1');
    assert.equal(queued.status, 'queued');
    assert.equal(queued.progressPercent, 5);

    const processing = transitionRenderJobStatus(queued, {
      status: 'processing',
      progressPercent: 45,
      stageMessage: 'Compositing Shot 2...',
    });
    assert.equal(processing.status, 'processing');
    assert.equal(processing.progressPercent, 45);
    assert.ok(processing.updatedAt);

    const completed = transitionRenderJobStatus(processing, {
      status: 'completed',
      progressPercent: 100,
      videoFileUrl: '/api/video/render_camp_lifecycle_job_lifecycle_1.mp4',
      byteLength: 250000,
      durationSeconds: 15,
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.progressPercent, 100);
    assert.ok(completed.completedAt);

    const failed = transitionRenderJobStatus(processing, {
      status: 'failed',
      errorMessage: 'FFmpeg exited with code 1',
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorMessage, 'FFmpeg exited with code 1');

    // Verify studio state preserves unsaved storyboard & profile edits when render fails
    const stateBeforeRender = createBlankStudioState();
    stateBeforeRender.form.title = 'Unsaved Custom Product Title';
    stateBeforeRender.hasUnsavedProfileEdits = true;
    stateBeforeRender.hasUnsavedStoryboardEdits = true;
    stateBeforeRender.isRenderingVideo = true;

    const stateAfterRenderError = handleRenderErrorState(
      stateBeforeRender,
      'Video rendering failed due to corrupted audio track.'
    );
    assert.equal(stateAfterRenderError.isRenderingVideo, false);
    assert.equal(stateAfterRenderError.lastRetryAction, 'render');
    assert.equal(stateAfterRenderError.form.title, 'Unsaved Custom Product Title');
    assert.equal(stateAfterRenderError.hasUnsavedProfileEdits, true);
    assert.equal(stateAfterRenderError.hasUnsavedStoryboardEdits, true);
  });

  it('renders a genuine 9:16 vertical H.264/AAC MP4 file from product image, storyboard shots, and 24kHz WAV voiceover and verifies A/V sync', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const {
      DEFAULT_RENDER_SETTINGS,
      verifyPlayableMp4Buffer,
      verifyAudioVideoDurationSync,
    } = await import('../src/utils/milestone3Validators.ts');
    const { renderCampaignVerticalVideo, probeRenderedVideoFile } = await import(
      '../src/utils/videoRenderer.ts'
    );

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ad-studio-m3-test-'));
    const audioDir = path.join(tmpRoot, 'audio');
    const videosDir = path.join(tmpRoot, 'videos');
    fs.mkdirSync(audioDir, { recursive: true });
    fs.mkdirSync(videosDir, { recursive: true });

    try {
      // Create a real 3.0-second 24kHz 16-bit mono WAV file (24000 * 2 * 3 = 144000 bytes PCM)
      const pcm3s = Buffer.alloc(24000 * 2 * 3, 0);
      const wav3s = ensureValidWavBuffer(pcm3s, 24000, 1, 16);
      const voFilename = 'voiceover-camp_real_mp4.wav';
      fs.writeFileSync(path.join(audioDir, voFilename), wav3s);

      const testCampaign: Campaign = {
        id: 'camp_real_mp4',
        createdAt: '2026-11-04T00:00:00.000Z',
        updatedAt: '2026-11-04T00:05:00.000Z',
        status: 'audio_ready',
        title: 'Veloce Barista Pro Espresso',
        price: '$649',
        brandName: 'Veloce Milano',
        modelOrVariant: '9-Bar Dual Boiler',
        visiblePackagingText: 'VELOCE MILANO',
        brandVoice: 'Luxury & Editorial',
        targetAudience: 'Inferred: Specialty coffee lovers',
        visualStyle: 'Warm studio lighting',
        imageDataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        analysisMetadata: {
          requestedModel: 'gemini-3.1-flash-lite',
          resolvedModel: 'gemini-3.1-flash-lite',
          fallbackUsed: false,
          latencyMs: 320,
          analyzedAt: '2026-11-04T00:00:00.000Z',
        },
        productProfile: {
          detectedProductName: 'Veloce Barista Pro Espresso',
          category: 'Kitchen Appliances',
          subcategory: 'Espresso Makers',
          productSummary: 'Matte obsidian dual-boiler espresso machine.',
          dominantColors: [
            { name: 'Matte Obsidian', hex: '#1C1917', usageRole: 'Body' },
            { name: 'Warm Brass', hex: '#D97706', usageRole: 'Gauge' },
          ],
          materialsAndTextures: ['Brushed steel', 'Walnut wood'],
          estimatedDimensions: '32cm x 28cm',
          detectedFeatures: ['9-bar brass gauge'],
          keySellingPoints: [],
          brandVoiceGuidelines: {
            toneDescriptors: ['Refined'],
            wordsToUse: ['crema'],
            wordsToAvoid: ['instant'],
            targetPersonaSummary: 'Inferred: Coffee enthusiasts',
          },
          recommendedAdAngles: [],
          visualFidelityConstraints: ['Preserve matte obsidian finish and brass gauge'],
        },
        storyboard: {
          conceptTitle: '9-Bar Morning Ritual',
          targetPlatformFormat: 'Instagram Reels (9:16)',
          totalDurationSeconds: 3,
          openingHook3s: 'Stop settling for bitter morning coffee.',
          fullVoiceoverScript: 'Stop settling for bitter morning coffee. Experience 9-bar crema.',
          estimatedWordCount: 9,
          brandSafetyVerification: ['Verified'],
          masterCinematicPrompt9x16: 'Vertical 9:16 commercial.',
          musicDirectionPrompt: 'Acoustic groove',
          shots: [
            {
              shotNumber: 1,
              durationSeconds: 1,
              timecodeRange: '00:00 - 00:01',
              shotType: '01. Macro Hook',
              sceneDescription: 'Brass pressure gauge rising to 9 bar.',
              cameraMovement: 'Slow push-in',
              visualPrompt9x16: '9:16 macro gauge.',
              onScreenTextOverlay: '9-Bar Precision',
              spokenVoiceoverSegment: 'Stop settling for bitter morning coffee.',
              productFidelityNote: 'Preserve brass dial.',
            },
            {
              shotNumber: 2,
              durationSeconds: 2,
              timecodeRange: '00:01 - 00:03',
              shotType: '02. Crema Pour',
              sceneDescription: 'Rich tiger-stripe espresso extraction.',
              cameraMovement: 'Low angle',
              visualPrompt9x16: '9:16 crema extraction.',
              onScreenTextOverlay: 'Veloce Barista Pro · $649',
              spokenVoiceoverSegment: 'Experience 9-bar crema.',
              productFidelityNote: 'Preserve walnut portafilter.',
            },
          ],
          generationMetadata: {
            requestedModel: 'gemini-3.1-flash-lite',
            resolvedModel: 'gemini-3.1-flash-lite',
            fallbackUsed: false,
            latencyMs: 410,
            generatedAt: '2026-11-04T00:02:00.000Z',
          },
        },
        voiceover: {
          id: 'vo_real_mp4',
          voiceName: 'Kore',
          voiceStyle: 'Warm narrator',
          scriptTextUsed: 'Stop settling for bitter morning coffee. Experience 9-bar crema.',
          audioFileUrl: `/api/audio/${voFilename}`,
          mimeType: 'audio/wav',
          byteLength: wav3s.length,
          sampleRateHz: 24000,
          durationEstimateSeconds: 3.0,
          resolvedModel: PRIMARY_TTS_MODEL,
          latencyMs: 700,
          generatedAt: '2026-11-04T00:03:00.000Z',
        },
      };

      const renderResult = await renderCampaignVerticalVideo({
        campaign: testCampaign,
        settings: {
          ...DEFAULT_RENDER_SETTINGS,
          enginePreference: 'ffmpeg_motion_compositor',
          resolution: '1080x1920',
          includeSubtitles: true,
        },
        jobId: 'job_real_mp4_v1',
        audioDir,
        videosDir,
      });

      assert.equal(renderResult.engineUsed, 'ffmpeg_motion_compositor');
      assert.match(renderResult.engineLabel, /FFmpeg 9:16 Motion-Compositor/);
      assert.equal(renderResult.width, 1080);
      assert.equal(renderResult.height, 1920);
      assert.ok(fs.existsSync(renderResult.outputFilePath));

      const mp4Buffer = fs.readFileSync(renderResult.outputFilePath);
      const mp4Check = verifyPlayableMp4Buffer(mp4Buffer);
      assert.equal(mp4Check.valid, true);

      const probe = await probeRenderedVideoFile(renderResult.outputFilePath);
      assert.equal(probe.width, 1080);
      assert.equal(probe.height, 1920);
      assert.equal(probe.videoCodec, 'h264');
      assert.equal(probe.audioCodec, 'aac');

      const syncCheck = verifyAudioVideoDurationSync({
        targetDurationSeconds: 3,
        videoDurationSeconds: probe.videoDurationSeconds,
        audioDurationSeconds: probe.audioDurationSeconds,
        toleranceSeconds: 1.0,
      });
      assert.equal(syncCheck.synchronized, true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('approves and rejects rendered videos and automatically invalidates approval when campaign content or settings change', async () => {
    const {
      DEFAULT_RENDER_SETTINGS,
      computeCampaignContentFingerprint,
      createQueuedRenderJob,
      transitionRenderJobStatus,
      applyApprovalDecision,
      invalidateApprovalOnCampaignChange,
    } = await import('../src/utils/milestone3Validators.ts');

    const baseCampaign: Campaign = {
      id: 'camp_approval_test',
      createdAt: '2026-11-04T00:00:00.000Z',
      updatedAt: '2026-11-04T00:05:00.000Z',
      status: 'video_ready',
      title: 'Solaris Radiance Elixir',
      price: '$58',
      brandName: 'Solaris Botanica',
      modelOrVariant: '30 ML',
      visiblePackagingText: 'SOLARIS',
      brandVoice: 'Clinical',
      targetAudience: 'Inferred: Skincare enthusiasts',
      visualStyle: 'Golden hour',
      imageDataUrl: 'data:image/png;base64,TEST',
      analysisMetadata: {
        requestedModel: 'gemini-3.1-flash-lite',
        resolvedModel: 'gemini-3.1-flash-lite',
        fallbackUsed: false,
        latencyMs: 300,
        analyzedAt: '2026-11-04T00:00:00.000Z',
      },
      productProfile: {
        detectedProductName: 'Solaris Radiance Elixir',
        category: 'Skincare',
        subcategory: 'Serum',
        productSummary: 'Vitamin C serum.',
        dominantColors: [],
        materialsAndTextures: [],
        estimatedDimensions: '30ml',
        detectedFeatures: [],
        keySellingPoints: [],
        brandVoiceGuidelines: {
          toneDescriptors: [],
          wordsToUse: [],
          wordsToAvoid: [],
          targetPersonaSummary: 'Inferred: Skincare users',
        },
        recommendedAdAngles: [],
        visualFidelityConstraints: [],
      },
      storyboard: {
        conceptTitle: 'Golden Hour Radiance',
        targetPlatformFormat: 'Instagram Reels (9:16)',
        totalDurationSeconds: 15,
        openingHook3s: 'Three drops to morning radiance.',
        fullVoiceoverScript: 'Three drops to morning radiance with Solaris.',
        estimatedWordCount: 7,
        brandSafetyVerification: ['Verified'],
        masterCinematicPrompt9x16: '9:16 serum shot',
        musicDirectionPrompt: 'Ambient',
        shots: [
          {
            shotNumber: 1,
            durationSeconds: 15,
            timecodeRange: '00:00 - 00:15',
            shotType: '01. Hero',
            sceneDescription: 'Amber dropper bottle.',
            cameraMovement: 'Push-in',
            visualPrompt9x16: '9:16 dropper.',
            onScreenTextOverlay: 'Solaris Elixir',
            spokenVoiceoverSegment: 'Three drops to morning radiance with Solaris.',
            productFidelityNote: 'Preserve amber glass.',
          },
        ],
        generationMetadata: {
          requestedModel: 'gemini-3.1-flash-lite',
          resolvedModel: 'gemini-3.1-flash-lite',
          fallbackUsed: false,
          latencyMs: 400,
          generatedAt: '2026-11-04T00:01:00.000Z',
        },
      },
      voiceover: {
        id: 'vo_solaris',
        voiceName: 'Kore',
        voiceStyle: 'Calm',
        scriptTextUsed: 'Three drops to morning radiance with Solaris.',
        audioFileUrl: '/api/audio/voiceover-camp_approval_test.wav',
        mimeType: 'audio/wav',
        byteLength: 48044,
        sampleRateHz: 24000,
        durationEstimateSeconds: 3.0,
        resolvedModel: PRIMARY_TTS_MODEL,
        latencyMs: 500,
        generatedAt: '2026-11-04T00:02:00.000Z',
      },
    };

    const queued = createQueuedRenderJob(
      baseCampaign,
      DEFAULT_RENDER_SETTINGS,
      'job_approval_v1'
    );
    const completedRender = transitionRenderJobStatus(queued, {
      status: 'completed',
      progressPercent: 100,
      videoFileUrl: '/api/video/render_camp_approval_test_job_approval_v1.mp4',
      byteLength: 180000,
      durationSeconds: 15,
    });
    baseCampaign.latestCompletedRender = completedRender;

    // 1. Approve rendered video
    const approveResult = applyApprovalDecision(baseCampaign, 'approve');
    assert.equal(approveResult.valid, true);
    assert.equal(approveResult.campaign?.approval?.status, 'approved');
    assert.equal(approveResult.campaign?.approval?.renderJobId, completedRender.id);
    assert.ok(approveResult.campaign?.approval?.reviewedAt);

    const approvedCampaign = approveResult.campaign!;

    // 2. Reject rendered video
    const rejectResult = applyApprovalDecision(approvedCampaign, 'reject', 'Make Shot 1 faster');
    assert.equal(rejectResult.valid, true);
    assert.equal(rejectResult.campaign?.approval?.status, 'rejected');
    assert.equal(rejectResult.campaign?.approval?.rejectionReason, 'Make Shot 1 faster');
    assert.ok(rejectResult.campaign?.approval?.reviewedAt);

    // 3. Re-approve, then edit storyboard/product/audio and verify automatic invalidation
    const reApprovedCampaign = approveResult.campaign!;

    const invalidated = invalidateApprovalOnCampaignChange(
      reApprovedCampaign,
      'Storyboard or script was edited after video approval.'
    );
    assert.equal(invalidated.status, 'video_ready');
    assert.equal(invalidated.approval?.status, 'invalidated');
    assert.match(invalidated.approval?.invalidationReason || '', /edited after video approval/);

    // Also verify content fingerprint changes when storyboard script is edited
    const fpBefore = computeCampaignContentFingerprint(reApprovedCampaign, DEFAULT_RENDER_SETTINGS);
    const editedCampaign: Campaign = {
      ...reApprovedCampaign,
      storyboard: {
        ...reApprovedCampaign.storyboard!,
        openingHook3s: 'Updated 3-second hook text!',
      },
    };
    const fpAfter = computeCampaignContentFingerprint(editedCampaign, DEFAULT_RENDER_SETTINGS);
    assert.notEqual(fpBefore, fpAfter);
  });

  it('generates per-shot 9:16 AI video clips in ai_video_google_veo mode, tracks per-shot progress, supports retryFailedShotsOnly, cancels active jobs, and never silently substitutes the FFmpeg slideshow on unconfigured or failing server', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const {
      verifyPlayableMp4Buffer,
      verifyAudioVideoDurationSync,
      buildCommercialShotVideoPrompt,
    } = await import('../src/utils/milestone3Validators.ts');
    const {
      renderCampaignVerticalVideo,
      probeRenderedVideoFile,
      VideoRenderError,
    } = await import('../src/utils/videoRenderer.ts');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ad-studio-veo-test-'));
    const audioDir = path.join(tmpRoot, 'audio');
    const videosDir = path.join(tmpRoot, 'videos');
    fs.mkdirSync(audioDir, { recursive: true });
    fs.mkdirSync(videosDir, { recursive: true });

    try {
      // Create a 3.0s 24kHz 16-bit mono WAV voiceover
      const pcm3s = Buffer.alloc(24000 * 2 * 3, 0);
      const wav3s = ensureValidWavBuffer(pcm3s, 24000, 1, 16);
      const voFilename = 'voiceover-camp_veo_test.wav';
      fs.writeFileSync(path.join(audioDir, voFilename), wav3s);

      // Generate a real 2s 720x1280 animated test MP4 buffer to simulate Google Veo 2.0 MP4 output
      const rawVeoSamplePath = path.join(tmpRoot, 'sample_veo_raw.mp4');
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=720x1280:rate=24',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        rawVeoSamplePath,
      ]);
      const sampleVeoMp4Buffer = fs.readFileSync(rawVeoSamplePath);
      assert.equal(verifyPlayableMp4Buffer(sampleVeoMp4Buffer).valid, true);

      const testCampaign: Campaign = {
        id: 'camp_veo_test',
        createdAt: '2026-11-04T00:00:00.000Z',
        updatedAt: '2026-11-04T00:05:00.000Z',
        status: 'audio_ready',
        title: 'Veloce Barista Pro Espresso',
        price: '$649',
        brandName: 'Veloce Milano',
        modelOrVariant: '9-Bar Dual Boiler',
        visiblePackagingText: 'VELOCE MILANO',
        brandVoice: 'Luxury & Editorial',
        targetAudience: 'Inferred: Specialty coffee lovers',
        visualStyle: 'Warm studio lighting',
        imageDataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        analysisMetadata: {
          requestedModel: 'gemini-3.1-flash-lite',
          resolvedModel: 'gemini-3.1-flash-lite',
          fallbackUsed: false,
          latencyMs: 320,
          analyzedAt: '2026-11-04T00:00:00.000Z',
        },
        productProfile: {
          detectedProductName: 'Veloce Barista Pro Espresso',
          category: 'Kitchen Appliances',
          subcategory: 'Espresso Makers',
          productSummary: 'Matte obsidian dual-boiler espresso machine.',
          dominantColors: [
            { name: 'Matte Obsidian', hex: '#1C1917', usageRole: 'Body' },
            { name: 'Warm Brass', hex: '#D97706', usageRole: 'Gauge' },
          ],
          materialsAndTextures: ['Brushed steel', 'Walnut wood'],
          estimatedDimensions: '32cm x 28cm',
          detectedFeatures: ['9-bar brass gauge'],
          keySellingPoints: [],
          brandVoiceGuidelines: {
            toneDescriptors: ['Refined'],
            wordsToUse: ['crema'],
            wordsToAvoid: ['instant'],
            targetPersonaSummary: 'Inferred: Coffee enthusiasts',
          },
          recommendedAdAngles: [],
          visualFidelityConstraints: ['Preserve matte obsidian finish and brass gauge'],
        },
        storyboard: {
          conceptTitle: '9-Bar Morning Ritual',
          targetPlatformFormat: 'Instagram Reels (9:16)',
          totalDurationSeconds: 3,
          openingHook3s: 'Stop settling for bitter morning coffee.',
          fullVoiceoverScript: 'Stop settling for bitter morning coffee. Experience 9-bar crema.',
          estimatedWordCount: 9,
          brandSafetyVerification: ['Verified'],
          masterCinematicPrompt9x16: 'Vertical 9:16 commercial.',
          musicDirectionPrompt: 'Acoustic groove',
          shots: [
            {
              shotNumber: 1,
              durationSeconds: 1,
              timecodeRange: '00:00 - 00:01',
              shotType: '01. Macro Hook',
              sceneDescription: 'Brass pressure gauge rising to 9 bar.',
              cameraMovement: '3D product orbit & slow push-in',
              visualPrompt9x16: '9:16 macro gauge.',
              onScreenTextOverlay: '9-Bar Precision',
              spokenVoiceoverSegment: 'Stop settling for bitter morning coffee.',
              productFidelityNote: 'Preserve brass dial.',
            },
            {
              shotNumber: 2,
              durationSeconds: 2,
              timecodeRange: '00:01 - 00:03',
              shotType: '02. Crema Pour',
              sceneDescription: 'Rich tiger-stripe espresso extraction.',
              cameraMovement: 'Low angle crane reveal',
              visualPrompt9x16: '9:16 crema extraction.',
              onScreenTextOverlay: 'Veloce Barista Pro · $649',
              spokenVoiceoverSegment: 'Experience 9-bar crema.',
              productFidelityNote: 'Preserve walnut portafilter.',
            },
          ],
          generationMetadata: {
            requestedModel: 'gemini-3.1-flash-lite',
            resolvedModel: 'gemini-3.1-flash-lite',
            fallbackUsed: false,
            latencyMs: 410,
            generatedAt: '2026-11-04T00:02:00.000Z',
          },
        },
        voiceover: {
          id: 'vo_veo_test',
          voiceName: 'Kore',
          voiceStyle: 'Warm narrator',
          scriptTextUsed: 'Stop settling for bitter morning coffee. Experience 9-bar crema.',
          audioFileUrl: `/api/audio/${voFilename}`,
          mimeType: 'audio/wav',
          byteLength: wav3s.length,
          sampleRateHz: 24000,
          durationEstimateSeconds: 3.0,
          resolvedModel: PRIMARY_TTS_MODEL,
          latencyMs: 700,
          generatedAt: '2026-11-04T00:03:00.000Z',
        },
      };

      // Verify commercial prompt builder includes product identity, camera motion, and fidelity constraints
      const promptShot1 = buildCommercialShotVideoPrompt(
        testCampaign,
        testCampaign.storyboard!.shots[0]
      );
      assert.match(promptShot1, /Veloce Barista Pro Espresso/);
      assert.match(promptShot1, /3D product orbit/);
      assert.match(promptShot1, /Preserve brass dial/);

      // 1. Verify unconfigured server error in ai_video_google_veo mode NEVER silently falls back to static slideshow
      let unconfiguredErr: unknown = null;
      try {
        await renderCampaignVerticalVideo({
          campaign: testCampaign,
          settings: {
            resolution: '720x1280',
            includeSubtitles: true,
            enginePreference: 'ai_video_google_veo',
          },
          jobId: 'job_veo_unconfigured',
          audioDir,
          videosDir,
          omniShotGenerator: async () => {
            throw new Error(
              'Google AI API key (GEMINI_API_KEY or GOOGLE_API_KEY) is not set on the server.'
            );
          },
        });
      } catch (err) {
        unconfiguredErr = err;
      }

      assert.ok(unconfiguredErr instanceof VideoRenderError);
      assert.equal(
        (unconfiguredErr as InstanceType<typeof VideoRenderError>).failureCategory,
        'auth_or_missing_key'
      );
      assert.equal(
        (unconfiguredErr as InstanceType<typeof VideoRenderError>).isAiVideoGenerated,
        false
      );
      assert.equal(
        (unconfiguredErr as InstanceType<typeof VideoRenderError>).shotResults[0].status,
        'failed'
      );
      assert.equal(
        (unconfiguredErr as InstanceType<typeof VideoRenderError>).shotResults[1].status,
        'queued'
      );

      // 2. Verify partial shot failure (Shot 1 succeeds, Shot 2 fails) followed by retryFailedShotsOnly reusing Shot 1
      const generatedShotsLog: number[] = [];
      let partialErr: unknown = null;
      try {
        await renderCampaignVerticalVideo({
          campaign: testCampaign,
          settings: {
            resolution: '720x1280',
            includeSubtitles: true,
            enginePreference: 'ai_video_google_veo',
          },
          jobId: 'job_veo_partial',
          audioDir,
          videosDir,
          omniShotGenerator: async ({ shot }) => {
            generatedShotsLog.push(shot.shotNumber);
            if (shot.shotNumber === 2) {
              throw new Error('429 rate_limit_exceeded on shot 2');
            }
            return {
              videoBuffer: sampleVeoMp4Buffer,
              modelUsed: 'veo-2.0-generate-001',
            };
          },
        });
      } catch (err) {
        partialErr = err;
      }

      assert.ok(partialErr instanceof VideoRenderError);
      const partialShots = (partialErr as InstanceType<typeof VideoRenderError>).shotResults;
      assert.equal(partialShots[0].status, 'completed');
      assert.equal(partialShots[1].status, 'failed');

      // Now retry failed shots only — Shot 1 must be reused from disk, only Shot 2 generated
      const retryShotsLog: number[] = [];
      const progressEvents: number[] = [];
      const retrySuccess = await renderCampaignVerticalVideo({
        campaign: testCampaign,
        settings: {
          resolution: '720x1280',
          includeSubtitles: true,
          enginePreference: 'ai_video_google_veo',
          retryFailedShotsOnly: true,
        },
        jobId: 'job_veo_retry_ok',
        audioDir,
        videosDir,
        previousShotResults: partialShots,
        callbacks: {
          onProgress: (pct) => progressEvents.push(pct),
        },
        omniShotGenerator: async ({ shot }) => {
          retryShotsLog.push(shot.shotNumber);
          return {
            videoBuffer: sampleVeoMp4Buffer,
            modelUsed: 'veo-2.0-generate-001',
          };
        },
      });

      assert.deepEqual(retryShotsLog, [2], 'Should reuse Shot 1 and only generate Shot 2');
      assert.ok(progressEvents.length >= 2, 'Should emit per-shot progress updates');
      assert.equal(retrySuccess.isAiVideoGenerated, true);
      assert.equal(retrySuccess.providerUsed, 'google_veo');
      assert.equal(retrySuccess.modelUsed, 'veo-2.0-generate-001');
      assert.equal(retrySuccess.engineUsed, 'google_veo_video');
      assert.equal(retrySuccess.shotResults.length, 2);
      assert.equal(retrySuccess.shotResults[0].status, 'completed');
      assert.equal(retrySuccess.shotResults[1].status, 'completed');

      const finalMp4Buf = fs.readFileSync(retrySuccess.outputFilePath);
      assert.equal(verifyPlayableMp4Buffer(finalMp4Buf).valid, true);
      const probe = await probeRenderedVideoFile(retrySuccess.outputFilePath);
      assert.equal(probe.width, 720);
      assert.equal(probe.height, 1280);
      assert.equal(
        verifyAudioVideoDurationSync({
          targetDurationSeconds: 3,
          videoDurationSeconds: probe.videoDurationSeconds,
          audioDurationSeconds: probe.audioDurationSeconds,
          toleranceSeconds: 1.0,
        }).synchronized,
        true
      );

      // 3. Verify job cancellation via AbortController
      const abortController = new AbortController();
      abortController.abort();
      let cancelErr: unknown = null;
      try {
        await renderCampaignVerticalVideo({
          campaign: testCampaign,
          settings: {
            resolution: '720x1280',
            includeSubtitles: true,
            enginePreference: 'ai_video_google_veo',
          },
          jobId: 'job_veo_cancel',
          audioDir,
          videosDir,
          abortSignal: abortController.signal,
          omniShotGenerator: async () => ({
            videoBuffer: sampleVeoMp4Buffer,
            modelUsed: 'veo-2.0-generate-001',
          }),
        });
      } catch (err) {
        cancelErr = err;
      }
      assert.ok(cancelErr instanceof VideoRenderError);
      assert.equal((cancelErr as InstanceType<typeof VideoRenderError>).failureCategory, 'cancelled');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('integrates GoogleVeoVideoProviderAdapter (@google/genai SDK, polling, cancellation, legacy campaign normalization) and Nano Banana visual generation', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const {
      GoogleVeoVideoProviderAdapter,
      resolveAiVideoProviderAdapter,
      executeProviderShotGeneration,
      getVideoProvidersSummary,
      generateNanoBananaVisualAsset,
      DEFAULT_GOOGLE_VEO_MODEL_ID,
      DEFAULT_GOOGLE_IMAGE_MODEL_ID,
    } = await import('../src/utils/videoProviders.ts');
    const {
      normalizeLegacyCampaignVideoFields,
      normalizeRenderEnginePreference,
      verifyPlayableMp4Buffer,
    } = await import('../src/utils/milestone3Validators.ts');
    const {
      renderCampaignVerticalVideo,
      probeRenderedVideoFile,
      VideoRenderError,
    } = await import('../src/utils/videoRenderer.ts');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ad-studio-veo-provider-test-'));
    const audioDir = path.join(tmpRoot, 'audio');
    const videosDir = path.join(tmpRoot, 'videos');
    fs.mkdirSync(audioDir, { recursive: true });
    fs.mkdirSync(videosDir, { recursive: true });

    try {
      // Create a 3.0s 24kHz 16-bit mono WAV voiceover
      const pcm3s = Buffer.alloc(24000 * 2 * 3, 0);
      const wav3s = ensureValidWavBuffer(pcm3s, 24000, 1, 16);
      const voFilename = 'voiceover-camp_veo_provider_test.wav';
      fs.writeFileSync(path.join(audioDir, voFilename), wav3s);

      // Create a genuine 2s 720x1280 MP4 clip to simulate Veo 2.0 output
      const sampleProviderClipPath = path.join(tmpRoot, 'veo_sample.mp4');
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=720x1280:rate=24',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        sampleProviderClipPath,
      ]);
      const sampleProviderMp4Buffer = fs.readFileSync(sampleProviderClipPath);

      // 1. Verify unconfigured & configured summary
      const unconfiguredSummary = getVideoProvidersSummary({ NODE_ENV: 'test' });
      assert.equal(unconfiguredSummary.length, 1);
      assert.equal(unconfiguredSummary[0].providerId, 'google_veo');
      assert.equal(unconfiguredSummary[0].configured, false);
      assert.equal(unconfiguredSummary[0].defaultModelId, DEFAULT_GOOGLE_VEO_MODEL_ID);

      const configuredSummary = getVideoProvidersSummary({
        NODE_ENV: 'test',
        GEMINI_API_KEY: 'test_key_123',
      });
      assert.equal(configuredSummary[0].configured, true);
      assert.equal(configuredSummary[0].modelAvailable, true);

      // 2. Verify adapter initialization & resolver
      const veoAdapter = new GoogleVeoVideoProviderAdapter();
      assert.equal(veoAdapter.providerId, 'google_veo');
      assert.equal(veoAdapter.enginePreference, 'ai_video_google_veo');
      assert.equal(veoAdapter.engineUsed, 'google_veo_video');
      assert.equal(veoAdapter.defaultModelId, 'veo-2.0-generate-001');

      const resolved = resolveAiVideoProviderAdapter('ai_video_google_veo');
      assert.equal(resolved.providerId, 'google_veo');

      // 3. Verify operation polling and base64 video extraction
      let pollCount = 0;
      const fakeGenAIClient: any = {
        models: {
          generateVideos: async (params: any) => {
            assert.equal(params.model, 'veo-2.0-generate-001');
            assert.equal(params.config?.aspectRatio, '9:16');
            return {
              name: 'operations/veo_mock_op_42',
              done: false,
            };
          },
        },
        operations: {
          getVideosOperation: async () => {
            pollCount += 1;
            if (pollCount === 1) {
              return { done: false };
            }
            return {
              done: true,
              response: {
                generatedVideos: [
                  {
                    video: {
                      videoBytes: sampleProviderMp4Buffer.toString('base64'),
                      mimeType: 'video/mp4',
                    },
                  },
                ],
              },
            };
          },
        },
      };

      const progressPcts: number[] = [];
      const execResult = await executeProviderShotGeneration(veoAdapter, {
        shot: {
          shotNumber: 1,
          durationSeconds: 4,
          timecodeRange: '00:00 - 00:04',
          shotType: '01. Hero',
          sceneDescription: 'Orbit around espresso machine',
          cameraMovement: 'Orbit',
          visualPrompt9x16: '9:16 orbit',
          onScreenTextOverlay: 'Veloce',
          spokenVoiceoverSegment: 'Hello',
          productFidelityNote: 'Preserve logo',
        },
        shotIndex: 0,
        prompt: 'Vertical 9:16 commercial shot',
        mimeType: 'image/png',
        base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        aspectRatio: '9:16',
        durationSeconds: 4,
        resolution: '720p',
        client: fakeGenAIClient,
        pollIntervalMs: 10,
        onProgressUpdate: (_msg, pct) => {
          if (typeof pct === 'number') progressPcts.push(pct);
        },
      });

      assert.equal(execResult.providerId, 'google_veo');
      assert.equal(execResult.modelUsed, 'veo-2.0-generate-001');
      assert.equal(execResult.remoteJobId, 'operations/veo_mock_op_42');
      assert.equal(execResult.videoBuffer.byteLength, sampleProviderMp4Buffer.byteLength);

      // 4. Verify cancellation tracking
      const cancelResult = await veoAdapter.cancelJob('operations/veo_mock_op_42');
      assert.equal(cancelResult.cancelled, true);

      // 5. Verify error classification
      const authErr = veoAdapter.normalizeProviderError(new Error('401 Unauthorized API key'));
      assert.equal(authErr.category, 'auth_or_missing_key');

      const quotaErr = veoAdapter.normalizeProviderError(new Error('429 RESOURCE_EXHAUSTED quota exceeded'));
      assert.equal(quotaErr.category, 'quota_exceeded');
      assert.equal(quotaErr.retryable, true);

      const notFoundErr = veoAdapter.normalizeProviderError(new Error('404 model not found'));
      assert.equal(notFoundErr.category, 'model_unavailable');

      const billingErr = veoAdapter.normalizeProviderError(new Error('403 billing not enabled'));
      assert.equal(billingErr.category, 'paid_tier_required');

      // 6. Verify Nano Banana marketing visual asset generation
      const fakeImageClient: any = {
        models: {
          generateContent: async (params: any) => {
            assert.equal(params.model, DEFAULT_GOOGLE_IMAGE_MODEL_ID);
            assert.equal(params.config?.imageConfig?.aspectRatio, '9:16');
            return {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: 'image/png',
                          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                        },
                      },
                    ],
                  },
                },
              ],
            };
          },
        },
      };

      const visualAsset = await generateNanoBananaVisualAsset({
        prompt: '9:16 cinematic product hero frame with dramatic rim light',
        aspectRatio: '9:16',
        client: fakeImageClient,
      });

      assert.equal(visualAsset.aspectRatio, '9:16');
      assert.equal(visualAsset.modelUsed, DEFAULT_GOOGLE_IMAGE_MODEL_ID);
      assert.match(visualAsset.imageDataUrl, /^data:image\/png;base64,/);

      // 7. Verify legacy campaign backward compatibility normalization
      assert.equal(normalizeRenderEnginePreference('ai_video_cosmos_nano'), 'ai_video_google_veo');
      assert.equal(normalizeRenderEnginePreference('ai_video_omni'), 'ai_video_google_veo');
      assert.equal(normalizeRenderEnginePreference('ai_video_runway'), 'ai_video_google_veo');
      assert.equal(normalizeRenderEnginePreference('basic_slideshow_ffmpeg'), 'basic_slideshow_ffmpeg');

      const testCampaign: Campaign = {
        id: 'camp_veo_provider_test',
        createdAt: '2026-11-04T00:00:00.000Z',
        updatedAt: '2026-11-04T00:05:00.000Z',
        status: 'audio_ready',
        title: 'Veloce Barista Pro',
        price: '$649',
        brandName: 'Veloce Milano',
        brandVoice: 'Luxury',
        targetAudience: 'Inferred: Coffee lovers',
        visualStyle: 'Studio lighting',
        imageDataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        analysisMetadata: {
          requestedModel: 'gemini-3.1-flash-lite',
          resolvedModel: 'gemini-3.1-flash-lite',
          fallbackUsed: false,
          latencyMs: 200,
          analyzedAt: '2026-11-04T00:00:00.000Z',
        },
        productProfile: {
          detectedProductName: 'Veloce Barista Pro',
          category: 'Appliances',
          subcategory: 'Espresso',
          productSummary: 'Espresso machine.',
          dominantColors: [{ name: 'Obsidian', hex: '#1C1917', usageRole: 'Body' }],
          materialsAndTextures: ['Steel'],
          estimatedDimensions: '30cm',
          detectedFeatures: ['9-bar gauge'],
          keySellingPoints: [],
          brandVoiceGuidelines: {
            toneDescriptors: ['Refined'],
            wordsToUse: ['crema'],
            wordsToAvoid: ['cheap'],
            targetPersonaSummary: 'Inferred: Coffee lovers',
          },
          recommendedAdAngles: [],
          visualFidelityConstraints: ['Preserve gauge'],
        },
        storyboard: {
          conceptTitle: '9-Bar Ritual',
          targetPlatformFormat: 'Instagram Reels (9:16)',
          totalDurationSeconds: 3,
          openingHook3s: 'Stop settling for bitter coffee.',
          fullVoiceoverScript: 'Stop settling for bitter coffee. Experience Veloce.',
          estimatedWordCount: 7,
          brandSafetyVerification: ['Verified'],
          masterCinematicPrompt9x16: 'Vertical 9:16 commercial.',
          musicDirectionPrompt: 'Acoustic',
          shots: [
            {
              shotNumber: 1,
              durationSeconds: 3,
              timecodeRange: '00:00 - 00:03',
              shotType: '01. Hero',
              sceneDescription: 'Brass gauge rising.',
              cameraMovement: 'Orbit',
              visualPrompt9x16: '9:16 orbit',
              onScreenTextOverlay: 'Veloce Barista Pro',
              spokenVoiceoverSegment: 'Stop settling for bitter coffee. Experience Veloce.',
              productFidelityNote: 'Preserve brass dial.',
            },
          ],
          generationMetadata: {
            requestedModel: 'gemini-3.1-flash-lite',
            resolvedModel: 'gemini-3.1-flash-lite',
            fallbackUsed: false,
            latencyMs: 300,
            generatedAt: '2026-11-04T00:02:00.000Z',
          },
        },
        voiceover: {
          id: 'vo_veo_provider_test',
          voiceName: 'Kore',
          voiceStyle: 'Warm',
          scriptTextUsed: 'Stop settling for bitter coffee. Experience Veloce.',
          audioFileUrl: `/api/audio/${voFilename}`,
          mimeType: 'audio/wav',
          byteLength: wav3s.length,
          sampleRateHz: 24000,
          durationEstimateSeconds: 3.0,
          resolvedModel: PRIMARY_TTS_MODEL,
          latencyMs: 400,
          generatedAt: '2026-11-04T00:03:00.000Z',
        },
      };

      const legacyCampaignWithCosmos = {
        ...testCampaign,
        latestCompletedRender: {
          id: 'job_legacy_cosmos',
          campaignId: testCampaign.id,
          versionNumber: 1,
          status: 'completed' as const,
          progressPercent: 100,
          stageMessage: 'Done',
          aspectRatio: '9:16' as const,
          resolution: '1080x1920' as const,
          width: 1080,
          height: 1920,
          fps: 24,
          targetDurationSeconds: 3,
          durationSeconds: 3,
          requestedEngine: 'ai_video_cosmos_nano' as unknown as import('../src/types.ts').RenderEnginePreference,
          providerUsed: 'cosmos_nano' as unknown as import('../src/types.ts').AiVideoProviderId,
          engineUsed: 'cosmos_nano_video' as unknown as import('../src/types.ts').RenderEngineUsed,
          engineLabel: 'NVIDIA Cosmos 3 Nano',
          isAiVideoGenerated: true,
          includeSubtitles: true,
          audioModeSummary: 'WAV',
          contentFingerprint: 'fp_123',
          createdAt: '2026-11-04T00:00:00.000Z',
          updatedAt: '2026-11-04T00:01:00.000Z',
        },
      };

      const normalizedLegacy = normalizeLegacyCampaignVideoFields(legacyCampaignWithCosmos);
      assert.equal(
        normalizedLegacy.latestCompletedRender?.requestedEngine,
        'ai_video_google_veo'
      );
      assert.equal(normalizedLegacy.latestCompletedRender?.providerUsed, 'google_veo');
      assert.equal(normalizedLegacy.latestCompletedRender?.engineUsed, 'google_veo_video');

      // 8. Verify invalid/non-video provider response (PNG instead of MP4) is rejected with invalid_video_output
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      );
      let invalidPayloadErr: unknown = null;
      try {
        await renderCampaignVerticalVideo({
          campaign: testCampaign,
          settings: {
            resolution: '720x1280',
            includeSubtitles: true,
            enginePreference: 'ai_video_google_veo',
          },
          jobId: 'job_invalid_png',
          audioDir,
          videosDir,
          omniShotGenerator: async () => ({
            videoBuffer: pngBytes,
            modelUsed: 'veo-2.0-generate-001',
          }),
        });
      } catch (err) {
        invalidPayloadErr = err;
      }

      assert.ok(invalidPayloadErr instanceof VideoRenderError);
      const vErr = invalidPayloadErr as InstanceType<typeof VideoRenderError>;
      assert.equal(vErr.failureCategory, 'invalid_video_output');
      assert.equal(vErr.providerUsed, 'google_veo');
      assert.equal(vErr.isAiVideoGenerated, false);

      // 9. Verify full end-to-end Google Veo 2.0 render pipeline produces a 1080x1920 9:16 MP4 with providerUsed='google_veo'
      const fullVeoRender = await renderCampaignVerticalVideo({
        campaign: testCampaign,
        settings: {
          resolution: '1080x1920',
          includeSubtitles: true,
          enginePreference: 'ai_video_google_veo',
        },
        jobId: 'job_veo_ok',
        audioDir,
        videosDir,
        omniShotGenerator: async () => ({
          videoBuffer: sampleProviderMp4Buffer,
          modelUsed: 'veo-2.0-generate-001',
        }),
      });

      assert.equal(fullVeoRender.isAiVideoGenerated, true);
      assert.equal(fullVeoRender.providerUsed, 'google_veo');
      assert.equal(fullVeoRender.modelUsed, 'veo-2.0-generate-001');
      assert.equal(fullVeoRender.engineUsed, 'google_veo_video');
      assert.equal(fullVeoRender.width, 1080);
      assert.equal(fullVeoRender.height, 1920);
      const probed = await probeRenderedVideoFile(fullVeoRender.outputFilePath);
      assert.equal(probed.width, 1080);
      assert.equal(probed.height, 1920);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});







