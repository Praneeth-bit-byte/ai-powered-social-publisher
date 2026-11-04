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
          requestedModel: 'gemini-3.1-flash-lite',
          resolvedModel: 'gemini-3.1-flash-lite',
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

  it('uses verified available model (gemini-3.1-flash-lite) first for storyboard generation and preserves user selections', async () => {
    const preferredPrimary = getPreferredStoryboardModel();
    assert.equal(PRIMARY_STORYBOARD_MODEL, 'gemini-3.1-flash-lite');
    assert.equal(VERIFIED_FALLBACK_STORYBOARD_MODEL, 'gemini-3.8-flash');
    assert.equal(preferredPrimary, 'gemini-3.1-flash-lite');

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

    assert.deepEqual(calledModels, ['gemini-3.1-flash-lite']);
    assert.deepEqual(sleepDelays, []);
    assert.equal(execution.requestedModel, 'gemini-3.1-flash-lite');
    assert.equal(execution.resolvedModel, 'gemini-3.1-flash-lite');
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
        if (modelId === 'gemini-3.1-flash-lite' && attempt === 1) {
          throw new Error('503 UNAVAILABLE: Transient spike on gemini-3.1-flash-lite.');
        }
        return validRawStoryboardJson;
      },
      {
        primaryModel: 'gemini-3.1-flash-lite',
        verifiedFallbackModels: ['gemini-3.8-flash'],
        maxRetriesPerModel: 2,
        baseDelayMs: 250,
        maxDelayMs: 1000,
        sleepFn: async (ms) => {
          backoffLog.push(ms);
        },
      }
    );

    assert.deepEqual(attemptLog, [
      { modelId: 'gemini-3.1-flash-lite', attempt: 1 },
      { modelId: 'gemini-3.1-flash-lite', attempt: 2 },
    ]);
    assert.deepEqual(backoffLog, [250]);
    assert.equal(execution.requestedModel, 'gemini-3.1-flash-lite');
    assert.equal(execution.resolvedModel, 'gemini-3.1-flash-lite');
    assert.equal(execution.fallbackUsed, false);
  });

  it('retries transient 503/UNAVAILABLE with bounded exponential backoff and falls back only to verified supported model', async () => {
    // Ensure unverified or unsupported models are filtered out of the chain
    const chain = buildVerifiedStoryboardModelChain('gemini-3.1-flash-lite', [
      'unverified-experimental-model',
      'gemini-flash-latest',
      'gemini-3.8-flash',
    ]);
    assert.deepEqual(chain, ['gemini-3.1-flash-lite', 'gemini-3.8-flash']);

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
        if (modelId === 'gemini-3.1-flash-lite') {
          throw new Error('503 UNAVAILABLE: Primary model experiencing high demand.');
        }
        return validRawStoryboardJson;
      },
      {
        primaryModel: 'gemini-3.1-flash-lite',
        verifiedFallbackModels: ['unverified-model', 'gemini-3.8-flash'],
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
      { modelId: 'gemini-3.1-flash-lite', attempt: 1 },
      { modelId: 'gemini-3.1-flash-lite', attempt: 2 },
      { modelId: 'gemini-3.1-flash-lite', attempt: 3 },
      { modelId: 'gemini-3.8-flash', attempt: 1 },
    ]);
    assert.deepEqual(backoffLog, [250, 500]);
    assert.equal(execution.requestedModel, 'gemini-3.1-flash-lite');
    assert.equal(execution.resolvedModel, 'gemini-3.8-flash');
    assert.equal(execution.fallbackUsed, true);
    assert.match(execution.fallbackReason || '', /gemini-3\.8-flash/);
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
            primaryModel: 'gemini-3.1-flash-lite',
            verifiedFallbackModels: ['gemini-3.8-flash'],
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
        assert.match(allFailed.message, /Generation failed after trying all verified Gemini models/);
        assert.match(allFailed.message, /gemini-3\.1-flash-lite \(2 attempts\)/);
        assert.match(allFailed.message, /gemini-3\.8-flash \(2 attempts\)/);
        assert.equal(allFailed.attempts.length, 4);
        return true;
      }
    );

    // 1 retry on primary (200ms) + 1 retry on fallback (200ms)
    assert.deepEqual(backoffLog, [200, 200]);

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


