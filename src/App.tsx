import React, { useState, useEffect, useRef } from 'react';
import {
  Upload,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Code2,
  Sliders,
  Trash2,
  Download,
  Copy,
  Check,
  RefreshCw,
  Sun,
  Moon,
  Lock,
  Layers,
  Image as ImageIcon,
  Plus,
  Save,
  ChevronRight,
  Film,
  Volume2,
  VolumeX,
  Play,
  Pause,
  Music,
  Mic,
  ShieldCheck,
  RotateCcw,
} from 'lucide-react';
import type {
  Campaign,
  ProductProfile,
  StoryboardShot,
  ModelVerificationReport,
} from './types.ts';
import { SAMPLE_PRODUCT_PRESETS, type SampleProductPreset } from './utils/sampleProducts.ts';
import {
  VOICE_OPTIONS_META,
  recomputeShotTimecodes,
  addShotToStoryboard,
  removeShotFromStoryboard,
} from './utils/milestone2Validators.ts';
import {
  createBlankStudioState,
  resetToBlankProductState,
  applyPresetToStudioState,
  applyUploadedImageToStudioState,
  applyCampaignToStudioState,
  handleVoiceoverErrorState,
  applyVoiceoverOrMusicUpdatePreservingEdits,
  analyzeUploadedImageWithGemini,
  type StudioSessionState,
} from './utils/studioState.ts';

type ActiveSection = 'workspace' | 'storyboard' | 'audio' | 'campaigns' | 'models';
type ProfileTab = 'visual' | 'json';

const BRAND_VOICE_OPTIONS = [
  'Luxury & Editorial',
  'Bold & Direct-Response',
  'Warm & Founder-Led',
  'Technical & Performance',
  'Playful & Trend-Native',
];

const PLATFORM_FORMATS = [
  'Instagram Reels (9:16)',
  'Instagram Stories (9:16)',
  'YouTube Shorts (9:16)',
] as const;

const MILESTONE_ROADMAP = [
  {
    number: '01',
    title: 'Project Scaffold, Studio Layout & Multimodal Product Analysis',
    status: 'Completed & Verified',
    active: true,
    completed: true,
    summary:
      'Upload product photos or load studio presets, configure brand voice and audience, run server-side Gemini multimodal vision analysis, and inspect/edit the structured JSON Product Profile.',
    deliverables: [
      'Full-stack Express + Vite + React + TypeScript server on port 3000',
      'Server-side @google/genai multimodal vision extraction with strict JSON schema',
      'Live Gemini model availability & fallback verification probe',
      'Interactive Visual Profile Editor + Raw JSON Schema Inspector with persistent server storage',
    ],
  },
  {
    number: '02',
    title: 'AI Script, Shot-by-Shot Storyboard & Voiceover/Music Synthesis',
    status: 'Active · Ready for Testing',
    active: true,
    completed: false,
    summary:
      'Generate brand-safe cinematic 9:16 video concepts, 15–30s voiceover scripts, shot-by-shot storyboards with editable scenes/prompts, and real 24kHz WAV voiceovers using gemini-3.8-flash-lite-tts.',
    deliverables: [
      'Brand-safe 9:16 video concept, 3-second hook, and spoken voiceover script generator',
      'Editable shot-by-shot 9:16 storyboard with automatic timecode recalculation',
      'Real 24kHz WAV AI voiceover synthesis (Kore, Puck, Charon, Fenrir, Zephyr) + Studio Audio Player',
      'Honest Background Music workflow (live Lyria probe, custom MP3/WAV upload, or Voiceover-Only placeholder)',
    ],
  },
  {
    number: '03',
    title: '9:16 Video Ad Generation, Conversational Editing & Approval Gate',
    status: 'Awaiting Milestone 2 Approval',
    active: false,
    completed: false,
    summary:
      'Render vertical 9:16 MP4 ads with synchronized voiceover, burned-in subtitles, and brand watermark. Support conversational revisions (v1, v2...) and enforce human approval before publishing.',
    deliverables: [
      'gemini-omni-1.1-flash image-to-video + FFmpeg 9:16 dynamic motion-canvas compositor',
      'Version history timeline and conversational edit instruction loop',
      'Explicit human approval gate and Web Speech API completion alert',
    ],
  },
  {
    number: '04',
    title: 'Six-Point SEO Caption Rubric & Auto-Regeneration (>= 90/100)',
    status: 'Awaiting Milestone 2 Approval',
    active: false,
    completed: false,
    summary:
      'Generate platform-specific titles, captions, keywords, and hashtags for Reels, Stories, and Shorts. Automatically evaluate against the 6-point rubric and regenerate any draft scoring below 90/100.',
    deliverables: [
      'Platform-tailored metadata for Instagram Reels, Stories, and YouTube Shorts',
      'Six-dimension rubric scorer (Accuracy, Hook, Voice, Keywords, Claim Safety, CTA)',
      'Automatic self-correction loop with full attempt history',
    ],
  },
  {
    number: '05',
    title: 'Firebase Authentication, Cloud Firestore & Hardened Security Rules',
    status: 'Awaiting Milestone 2 Approval',
    active: false,
    completed: false,
    summary:
      'Provision Google Sign-In and Cloud Firestore with zero-trust security rules to isolate campaigns, video versions, and SEO packages per user.',
    deliverables: [
      'Firebase Auth Google Sign-In flow',
      'Cloud Firestore persistence synced with firebase-blueprint.json',
      'Hardened ABAC firestore.rules and permission error diagnostics',
    ],
  },
  {
    number: '06',
    title: 'Authorized Social Publishing (YouTube & Instagram OAuth) & Analytics',
    status: 'Awaiting Milestone 2 Approval',
    active: false,
    completed: false,
    summary:
      'Connect YouTube channels and Instagram Business/Creator accounts via official OAuth 2.0 flows, schedule approved videos for peak audience windows, and track post performance.',
    deliverables: [
      'Official Google OAuth (YouTube Data API v3) & Instagram Graph API popup OAuth',
      'Smart audience-activity scheduler with new-account fallback recommendations',
      'Publishing status tracker and reach/plays/saves/retention analytics',
    ],
  },
];

export default function App() {
  const [darkMode, setDarkMode] = useState<boolean>(true);
  const [activeSection, setActiveSection] = useState<ActiveSection>('workspace');
  const [profileTab, setProfileTab] = useState<ProfileTab>('visual');

  // Unified Studio Session State — starts completely blank with zero stale defaults
  const [studio, setStudio] = useState<StudioSessionState>(() => createBlankStudioState());

  // Saved Campaigns archive list (populated for Saved Campaigns tab only; never auto-loaded into active form on boot)
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [isLoadingCampaigns, setIsLoadingCampaigns] = useState<boolean>(true);
  const [copiedJson, setCopiedJson] = useState<boolean>(false);

  // Audio playback deck UI state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlayingVo, setIsPlayingVo] = useState<boolean>(false);
  const [voCurrentTime, setVoCurrentTime] = useState<number>(0);
  const [voDuration, setVoDuration] = useState<number>(0);
  const [voMuted, setVoMuted] = useState<boolean>(false);
  const [voPlaybackRate, setVoPlaybackRate] = useState<number>(1);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const musicFileInputRef = useRef<HTMLInputElement | null>(null);
  const analysisRequestIdRef = useRef<number>(0);

  // Live Gemini Model Readiness Verification state
  const [modelReport, setModelReport] = useState<ModelVerificationReport | null>(null);
  const [isVerifyingModels, setIsVerifyingModels] = useState<boolean>(false);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [darkMode]);

  useEffect(() => {
    // Load saved campaigns list for archive view & probe Gemini models,
    // while keeping the active Product Studio completely blank on initial load/reload.
    fetchCampaigns();
    runModelVerification();
  }, []);

  const resetAudioPlayer = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setIsPlayingVo(false);
    setVoCurrentTime(0);
    setVoDuration(0);
  };

  const clearFileInputs = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (musicFileInputRef.current) {
      musicFileInputRef.current.value = '';
    }
  };

  // Safe Tab Switch Handler: preserves all in-memory edits and warns if unsaved work exists
  const handleSwitchSection = (nextSection: ActiveSection) => {
    if (nextSection === activeSection) return;
    if (studio.hasUnsavedStoryboardEdits && activeSection === 'storyboard') {
      setStudio((prev) => ({
        ...prev,
        warningBanner:
          'You have unsaved Script & Storyboard edits. Your edits are kept in memory, and you can click "Save Unsaved Changes" to persist them to the server.',
      }));
    } else if (studio.hasUnsavedProfileEdits && activeSection === 'workspace') {
      setStudio((prev) => ({
        ...prev,
        warningBanner:
          'You have unsaved Product Profile edits. Your edits are kept in memory, and you can click "Save Unsaved Changes" to persist them to the server.',
      }));
    }
    setActiveSection(nextSection);
  };

  // Complete Reset Handler ("New Product Analysis")
  const handleNewProductAnalysis = () => {
    analysisRequestIdRef.current += 1;
    clearFileInputs();
    resetAudioPlayer();
    setProfileTab('visual');
    setActiveSection('workspace');
    setStudio(resetToBlankProductState());
  };

  // Explicit Demo Preset Selection Handler
  const handleSelectPreset = (preset: SampleProductPreset) => {
    analysisRequestIdRef.current += 1;
    clearFileInputs();
    resetAudioPlayer();
    setProfileTab('visual');
    setActiveSection('workspace');
    setStudio(applyPresetToStudioState(preset));
  };

  // Explicit Campaign Restore from "Saved Campaigns" Tab
  const handleOpenSavedCampaign = (
    campaign: Campaign,
    targetSection: ActiveSection = 'workspace'
  ) => {
    analysisRequestIdRef.current += 1;
    clearFileInputs();
    resetAudioPlayer();
    setProfileTab('visual');
    setStudio(applyCampaignToStudioState(campaign));
    setActiveSection(targetSection);
  };

  const updateFormField = (
    field: keyof StudioSessionState['form'],
    value: string
  ) => {
    setStudio((prev) => ({
      ...prev,
      hasUnsavedProfileEdits: Boolean(prev.activeCampaign),
      form: {
        ...prev.form,
        [field]: value,
      },
    }));
  };

  const fetchCampaigns = async () => {
    setIsLoadingCampaigns(true);
    try {
      const res = await fetch('/api/campaigns');
      if (!res.ok) throw new Error('Failed to load saved campaigns.');
      const data = await res.json();
      const list: Campaign[] = Array.isArray(data.campaigns) ? data.campaigns : [];
      setCampaigns(list);
    } catch (err: unknown) {
      console.error(err);
    } finally {
      setIsLoadingCampaigns(false);
    }
  };

  const runModelVerification = async () => {
    setIsVerifyingModels(true);
    try {
      const res = await fetch('/api/system/verify-models');
      if (!res.ok) throw new Error('Failed to verify Gemini models.');
      const report: ModelVerificationReport = await res.json();
      setModelReport(report);
    } catch (err: unknown) {
      console.error('Model verification error:', err);
    } finally {
      setIsVerifyingModels(false);
    }
  };

  const handleImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    processUploadedFile(file);
  };

  const processUploadedFile = (file: File) => {
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!validTypes.includes(file.type.toLowerCase())) {
      setStudio((prev) => ({
        ...prev,
        errorBanner: 'Unsupported file format. Please upload a PNG, JPEG, or WEBP product photo.',
        statusMessage: null,
      }));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setStudio((prev) => ({
        ...prev,
        errorBanner: 'Image file exceeds 10 MB limit. Please choose a smaller product image.',
        statusMessage: null,
      }));
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      if (typeof reader.result === 'string') {
        const newDataUrl = reader.result;
        const requestId = ++analysisRequestIdRef.current;
        resetAudioPlayer();
        setProfileTab('visual');
        setActiveSection('workspace');

        // 1. Immediately clear previous product metadata and invalidate old profile/storyboard/audio
        //    while showing a clear loading state for the newly uploaded image.
        setStudio((prev) => applyUploadedImageToStudioState(prev, newDataUrl, true));

        // 2. Automatically trigger server-side Gemini multimodal product identification
        const { state: analyzedState, campaign } = await analyzeUploadedImageWithGemini(
          newDataUrl,
          { selectedPresetId: 'custom-upload' }
        );

        // Guard against stale responses if the user reset or uploaded another image in the meantime
        if (analysisRequestIdRef.current !== requestId) {
          return;
        }

        if (campaign) {
          setCampaigns((prev) => [campaign, ...prev]);
        }
        setStudio(analyzedState);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processUploadedFile(file);
    }
  };

  const runAnalyzeProductFlow = async () => {
    if (!studio.form.imageDataUrl) {
      setStudio((prev) => ({
        ...prev,
        errorBanner: 'Please upload a product image or select a sample studio preset first.',
        statusMessage: null,
      }));
      return;
    }

    const requestId = ++analysisRequestIdRef.current;
    const currentFormSnapshot = { ...studio.form };

    setStudio((prev) => ({
      ...prev,
      isAnalyzing: true,
      lastRetryAction: null,
      errorBanner: null,
      statusMessage: 'Analyzing product image with Gemini Vision...',
    }));

    const { state: analyzedState, campaign } = await analyzeUploadedImageWithGemini(
      currentFormSnapshot.imageDataUrl,
      currentFormSnapshot
    );

    if (analysisRequestIdRef.current !== requestId) {
      return;
    }

    if (campaign) {
      setCampaigns((prev) => [campaign, ...prev]);
    }
    setStudio(analyzedState);
    setActiveSection('workspace');
  };

  const handleAnalyzeProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    await runAnalyzeProductFlow();
  };

  const handleSaveProfileChanges = async () => {
    const { activeCampaign, editableProfile, rawJsonText } = studio;
    if (!activeCampaign || !editableProfile) return;

    let profileToSave = editableProfile;
    if (profileTab === 'json') {
      try {
        profileToSave = JSON.parse(rawJsonText) as ProductProfile;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid JSON syntax';
        setStudio((prev) => ({
          ...prev,
          jsonParseError: `Cannot save invalid JSON: ${msg}`,
        }));
        return;
      }
    }

    setStudio((prev) => ({
      ...prev,
      isSavingProfile: true,
      errorBanner: null,
      warningBanner: null,
      statusMessage: null,
      jsonParseError: null,
    }));

    try {
      const res = await fetch(`/api/campaigns/${activeCampaign.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: studio.form.title || activeCampaign.title,
          price: studio.form.price,
          brandName: studio.form.brandName || activeCampaign.brandName,
          modelOrVariant: studio.form.modelOrVariant || activeCampaign.modelOrVariant,
          visiblePackagingText:
            studio.form.visiblePackagingText || activeCampaign.visiblePackagingText,
          brandVoice: studio.form.brandVoice || activeCampaign.brandVoice,
          targetAudience: studio.form.targetAudience || activeCampaign.targetAudience,
          visualStyle: studio.form.visualStyle || activeCampaign.visualStyle,
          productProfile: profileToSave,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save changes.');

      const updated: Campaign = data.campaign;
      setCampaigns((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setStudio((prev) => {
        const nextState = applyCampaignToStudioState(updated);
        // Preserve any unsaved storyboard edits if the user only saved the profile
        if (prev.hasUnsavedStoryboardEdits && prev.editableStoryboard) {
          nextState.editableStoryboard = prev.editableStoryboard;
          nextState.hasUnsavedStoryboardEdits = true;
          nextState.voiceScriptDraft = prev.voiceScriptDraft;
        }
        nextState.hasUnsavedProfileEdits = false;
        nextState.statusMessage = 'Product profile and brand specifications saved to server.';
        return nextState;
      });
    } catch (err: unknown) {
      setStudio((prev) => ({
        ...prev,
        isSavingProfile: false,
        errorBanner: err instanceof Error ? err.message : 'Failed to save profile.',
      }));
    }
  };

  // MILESTONE 2 HANDLER: Generate Video Concept, Script & 9:16 Storyboard
  const handleGenerateStoryboard = async () => {
    const {
      activeCampaign,
      editableProfile,
      form,
      targetFormat,
      desiredDuration,
      creativeAngleHint,
    } = studio;
    if (!activeCampaign) {
      setStudio((prev) => ({
        ...prev,
        errorBanner: 'Please analyze a product campaign first.',
      }));
      return;
    }

    setStudio((prev) => ({
      ...prev,
      isGeneratingStoryboard: true,
      lastRetryAction: null,
      errorBanner: null,
      warningBanner: null,
      statusMessage: null,
    }));

    try {
      const res = await fetch(`/api/campaigns/${activeCampaign.id}/storyboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetPlatformFormat: targetFormat,
          desiredDurationSeconds: desiredDuration,
          creativeAngleHint,
          title: form.title || activeCampaign.title,
          price: form.price,
          brandName: form.brandName || activeCampaign.brandName,
          modelOrVariant: form.modelOrVariant || activeCampaign.modelOrVariant,
          visiblePackagingText:
            form.visiblePackagingText || activeCampaign.visiblePackagingText,
          brandVoice: form.brandVoice || activeCampaign.brandVoice,
          targetAudience: form.targetAudience || activeCampaign.targetAudience,
          visualStyle: form.visualStyle || activeCampaign.visualStyle,
          productProfile: editableProfile || activeCampaign.productProfile,
        }),
      });

      let data: Record<string, unknown> = {};
      try {
        data = (await res.json()) as Record<string, unknown>;
      } catch {
        throw new Error('Server returned an unreadable response during storyboard generation.');
      }

      if (!res.ok) {
        const errMsg =
          typeof data.error === 'string' && data.error.trim()
            ? data.error.trim()
            : 'Failed to generate storyboard.';
        throw new Error(errMsg);
      }

      const updated = data.campaign as Campaign | undefined;
      if (!updated || !updated.storyboard) {
        throw new Error('Server did not return a valid generated storyboard.');
      }

      setCampaigns((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      const nextState = applyCampaignToStudioState(updated);
      nextState.targetFormat = targetFormat;
      nextState.desiredDuration = desiredDuration;
      nextState.creativeAngleHint = creativeAngleHint;
      nextState.hasUnsavedProfileEdits = false;
      nextState.hasUnsavedStoryboardEdits = false;
      const meta = updated.storyboard.generationMetadata;
      nextState.statusMessage = meta.fallbackUsed
        ? `Generated 9:16 concept & ${updated.storyboard.shots.length}-shot storyboard in ${meta.latencyMs} ms using verified fallback ${meta.resolvedModel} (primary ${meta.requestedModel} returned 503).`
        : `Generated 9:16 concept & ${updated.storyboard.shots.length}-shot storyboard in ${meta.latencyMs} ms (${meta.resolvedModel}).`;
      setStudio(nextState);
    } catch (err: unknown) {
      setStudio((prev) => ({
        ...prev,
        isGeneratingStoryboard: false,
        statusMessage: null,
        lastRetryAction: 'storyboard',
        errorBanner: err instanceof Error ? err.message : 'Storyboard generation failed.',
      }));
    }
  };

  // MILESTONE 2 HANDLER: Save User Edits to Script & Storyboard
  const handleSaveStoryboardEdits = async () => {
    const { activeCampaign, editableStoryboard } = studio;
    if (!activeCampaign || !editableStoryboard) return;

    setStudio((prev) => ({
      ...prev,
      isSavingStoryboard: true,
      errorBanner: null,
      warningBanner: null,
      statusMessage: null,
    }));

    try {
      const res = await fetch(`/api/campaigns/${activeCampaign.id}/storyboard`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyboard: editableStoryboard }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save storyboard edits.');
      }

      const updated: Campaign = data.campaign;
      setCampaigns((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setStudio((prev) => {
        const nextState = applyCampaignToStudioState(updated);
        if (prev.hasUnsavedProfileEdits && prev.editableProfile) {
          nextState.form = prev.form;
          nextState.editableProfile = prev.editableProfile;
          nextState.rawJsonText = prev.rawJsonText;
          nextState.hasUnsavedProfileEdits = true;
        }
        nextState.targetFormat = prev.targetFormat;
        nextState.desiredDuration = prev.desiredDuration;
        nextState.creativeAngleHint = prev.creativeAngleHint;
        nextState.hasUnsavedStoryboardEdits = false;
        nextState.statusMessage = 'Saved script and 9:16 shot-by-shot storyboard changes.';
        return nextState;
      });
    } catch (err: unknown) {
      setStudio((prev) => ({
        ...prev,
        isSavingStoryboard: false,
        errorBanner: err instanceof Error ? err.message : 'Failed to save storyboard edits.',
      }));
    }
  };

  const handleUpdateShotField = (
    shotIndex: number,
    field: keyof StoryboardShot,
    value: string | number
  ) => {
    setStudio((prev) => {
      if (!prev.editableStoryboard) return prev;
      const updatedShots = prev.editableStoryboard.shots.map((shot, idx) =>
        idx === shotIndex ? { ...shot, [field]: value } : shot
      );
      const { normalizedShots, totalDurationSeconds } =
        field === 'timecodeRange'
          ? {
              normalizedShots: updatedShots,
              totalDurationSeconds: prev.editableStoryboard.totalDurationSeconds,
            }
          : recomputeShotTimecodes(updatedShots);
      return {
        ...prev,
        hasUnsavedStoryboardEdits: true,
        editableStoryboard: {
          ...prev.editableStoryboard,
          shots: normalizedShots,
          totalDurationSeconds,
        },
      };
    });
  };

  const handleAddShot = () => {
    setStudio((prev) => {
      if (!prev.editableStoryboard) return prev;
      const nextStoryboard = addShotToStoryboard(
        prev.editableStoryboard,
        prev.form.title || prev.activeCampaign?.title || 'the product',
        prev.form.price || prev.activeCampaign?.price || ''
      );
      return {
        ...prev,
        hasUnsavedStoryboardEdits: true,
        editableStoryboard: nextStoryboard,
      };
    });
  };

  const handleRemoveShot = (shotIndex: number) => {
    setStudio((prev) => {
      if (!prev.editableStoryboard || prev.editableStoryboard.shots.length <= 1) return prev;
      const nextStoryboard = removeShotFromStoryboard(prev.editableStoryboard, shotIndex);
      return {
        ...prev,
        hasUnsavedStoryboardEdits: true,
        editableStoryboard: nextStoryboard,
      };
    });
  };

  const handleSyncScriptFromShots = () => {
    setStudio((prev) => {
      if (!prev.editableStoryboard) return prev;
      const combined = prev.editableStoryboard.shots
        .map((s) => s.spokenVoiceoverSegment.trim())
        .filter(Boolean)
        .join(' ');
      const words = combined.split(/\s+/).filter(Boolean).length;
      return {
        ...prev,
        hasUnsavedStoryboardEdits: true,
        editableStoryboard: {
          ...prev.editableStoryboard,
          fullVoiceoverScript: combined,
          estimatedWordCount: words,
        },
        voiceScriptDraft: combined,
        statusMessage: 'Full voiceover script synchronized from shot-by-shot spoken segments.',
      };
    });
  };

  // MILESTONE 2 HANDLER: Generate Real AI Voiceover WAV
  const handleGenerateVoiceover = async () => {
    const {
      activeCampaign,
      editableStoryboard,
      selectedVoice,
      voiceStylePrompt,
      voiceScriptDraft,
    } = studio;
    if (!activeCampaign) return;
    if (!voiceScriptDraft.trim() || voiceScriptDraft.trim().length < 5) {
      setStudio((prev) => ({
        ...prev,
        errorBanner: 'Please enter a voiceover script of at least 5 characters before synthesizing audio.',
      }));
      return;
    }

    setStudio((prev) => ({
      ...prev,
      isGeneratingVoiceover: true,
      lastRetryAction: null,
      errorBanner: null,
      statusMessage: null,
    }));

    try {
      const res = await fetch(`/api/campaigns/${activeCampaign.id}/voiceover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voiceName: selectedVoice,
          voiceStyle: voiceStylePrompt || VOICE_OPTIONS_META[0].defaultStylePrompt,
          scriptText: voiceScriptDraft,
          ...(editableStoryboard ? { storyboard: editableStoryboard } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Voiceover generation failed.');
      }

      const updated: Campaign = data.campaign;
      setCampaigns((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setStudio((prev) => {
        const nextState = applyVoiceoverOrMusicUpdatePreservingEdits(prev, updated);
        nextState.isGeneratingVoiceover = false;
        nextState.statusMessage = `Generated verified 24kHz 16-bit mono WAV voiceover (${updated.voiceover?.voiceName}) in ${updated.voiceover?.latencyMs} ms using ${updated.voiceover?.resolvedModel}.`;
        return nextState;
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to generate voiceover.';
      setStudio((prev) => handleVoiceoverErrorState(prev, message));
    }
  };

  // MILESTONE 2 HANDLER: Background Music (Lyria Probe / Upload / Placeholder)
  const handleMusicAction = async (mode: 'lyria' | 'placeholder', customAudioDataUrl?: string) => {
    const { activeCampaign, musicPromptDraft } = studio;
    if (!activeCampaign) return;

    setStudio((prev) => ({
      ...prev,
      isProcessingMusic: true,
      errorBanner: null,
      warningBanner: null,
      statusMessage: null,
    }));

    try {
      const res = await fetch(`/api/campaigns/${activeCampaign.id}/music`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: customAudioDataUrl ? 'upload' : mode,
          musicPrompt: musicPromptDraft,
          customAudioDataUrl,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Background music action failed.');
      }

      const updated: Campaign = data.campaign;
      setCampaigns((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setStudio((prev) => {
        const nextState = applyVoiceoverOrMusicUpdatePreservingEdits(prev, updated);
        nextState.isProcessingMusic = false;
        if (data.warning || updated.backgroundMusic?.status === 'unavailable_paid_tier') {
          nextState.warningBanner =
            data.warning ||
            updated.backgroundMusic?.statusMessage ||
            'Lyria music generation requires a paid API key tier.';
          nextState.statusMessage = null;
        } else {
          nextState.warningBanner = null;
          nextState.statusMessage =
            updated.backgroundMusic?.statusMessage || 'Updated background music status.';
        }
        return nextState;
      });
    } catch (err: unknown) {
      setStudio((prev) => ({
        ...prev,
        isProcessingMusic: false,
        errorBanner: err instanceof Error ? err.message : 'Music request failed.',
      }));
    }
  };

  const handleRetryLastAction = async () => {
    const action = studio.lastRetryAction;
    if (action === 'storyboard') {
      await handleGenerateStoryboard();
    } else if (action === 'voiceover') {
      await handleGenerateVoiceover();
    } else if (action === 'analyze') {
      await runAnalyzeProductFlow();
    }
  };

  const handleSaveAllUnsavedChanges = async () => {
    if (studio.hasUnsavedStoryboardEdits) {
      await handleSaveStoryboardEdits();
    }
    if (studio.hasUnsavedProfileEdits) {
      await handleSaveProfileChanges();
    }
  };

  const handleUploadCustomMusic = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      setStudio((prev) => ({
        ...prev,
        errorBanner: 'Audio file exceeds 15 MB limit.',
      }));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        handleMusicAction('placeholder', reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const toggleVoPlayback = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      el.play();
    } else {
      el.pause();
    }
  };

  const handleVoRateChange = (rate: number) => {
    setVoPlaybackRate(rate);
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  };

  const toggleVoMute = () => {
    const next = !voMuted;
    setVoMuted(next);
    if (audioRef.current) {
      audioRef.current.muted = next;
    }
  };

  const handleDeleteCampaign = async (id: string) => {
    try {
      const res = await fetch(`/api/campaigns/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete campaign.');
      const remaining = campaigns.filter((c) => c.id !== id);
      setCampaigns(remaining);
      if (studio.activeCampaign?.id === id) {
        handleNewProductAnalysis();
      } else {
        setStudio((prev) => ({ ...prev, statusMessage: 'Campaign removed.' }));
      }
    } catch (err: unknown) {
      setStudio((prev) => ({
        ...prev,
        errorBanner: err instanceof Error ? err.message : 'Could not delete campaign.',
      }));
    }
  };

  const handleCopyJson = async () => {
    if (!studio.editableProfile) return;
    const text =
      profileTab === 'json'
        ? studio.rawJsonText
        : JSON.stringify(studio.editableProfile, null, 2);
    await navigator.clipboard.writeText(text);
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 1800);
  };

  const handleDownloadJson = () => {
    const { activeCampaign, editableProfile, editableStoryboard } = studio;
    if (!activeCampaign || !editableProfile) return;
    const payload = {
      campaignId: activeCampaign.id,
      title: activeCampaign.title,
      brandName: activeCampaign.brandName,
      price: activeCampaign.price,
      brandVoice: activeCampaign.brandVoice,
      analysisMetadata: activeCampaign.analysisMetadata,
      productProfile: editableProfile,
      storyboard: editableStoryboard,
      voiceover: activeCampaign.voiceover,
      backgroundMusic: activeCampaign.backgroundMusic,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeCampaign.id}-campaign-bundle.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatAudioSec = (sec: number) => {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const {
    form,
    activeCampaign,
    editableProfile,
    rawJsonText,
    jsonParseError,
    editableStoryboard,
    creativeAngleHint,
    targetFormat,
    desiredDuration,
    selectedVoice,
    voiceStylePrompt,
    voiceScriptDraft,
    musicPromptDraft,
    isAnalyzing,
    isSavingProfile,
    isGeneratingStoryboard,
    isSavingStoryboard,
    isGeneratingVoiceover,
    isProcessingMusic,
    hasUnsavedProfileEdits,
    hasUnsavedStoryboardEdits,
    lastRetryAction,
    warningBanner,
    errorBanner,
    statusMessage,
  } = studio;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 sticky top-0 z-30">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#workspace"
          onClick={(e) => {
            e.preventDefault();
            handleSwitchSection('workspace');
          }}
          className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0"
        >
          AI Ad Studio
        </a>

        {/* Zone 2: 5 concise single-line navigation links */}
        <nav className="flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-400 overflow-x-auto">
          <button
            type="button"
            onClick={() => handleSwitchSection('workspace')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'workspace'
                ? 'border-orange-600 text-slate-900 dark:text-white'
                : 'border-transparent hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            01. Product Studio{hasUnsavedProfileEdits ? ' *' : ''}
          </button>
          <button
            type="button"
            onClick={() => handleSwitchSection('storyboard')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'storyboard'
                ? 'border-orange-600 text-slate-900 dark:text-white'
                : 'border-transparent hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            02. Script & Storyboard{hasUnsavedStoryboardEdits ? ' *' : ''}
          </button>
          <button
            type="button"
            onClick={() => handleSwitchSection('audio')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'audio'
                ? 'border-orange-600 text-slate-900 dark:text-white'
                : 'border-transparent hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            03. Voiceover & Music
          </button>
          <button
            type="button"
            onClick={() => handleSwitchSection('campaigns')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'campaigns'
                ? 'border-orange-600 text-slate-900 dark:text-white'
                : 'border-transparent hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            Saved Campaigns ({campaigns.length})
          </button>
          <button
            type="button"
            onClick={() => handleSwitchSection('models')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'models'
                ? 'border-orange-600 text-slate-900 dark:text-white'
                : 'border-transparent hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            API & Milestones
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleNewProductAnalysis}
            className="px-4 py-2 text-xs font-semibold text-white bg-orange-600 rounded-lg hover:bg-orange-500 transition-colors whitespace-nowrap shrink-0"
          >
            New Product Analysis
          </button>
        </div>
      </header>

      {/* Main Studio Shell: Left Workflow Sidebar + Content Viewport */}
      <div className="flex-1 flex flex-col lg:flex-row max-w-[1440px] w-full mx-auto">
        {/* Left Pipeline Stage Sidebar (265px on desktop) */}
        <aside className="w-full lg:w-[265px] shrink-0 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/50 p-5 flex flex-col justify-between gap-6">
          <div className="space-y-5">
            <div>
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-1.5">
                <span>Production Pipeline</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">Milestone 2 of 6</span>
              </div>
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                10-Step Workflow Gate
              </h2>
            </div>

            {activeCampaign ? (
              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-1">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  Active Campaign · <span className="font-mono">{activeCampaign.id}</span>
                </div>
                <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                  {activeCampaign.title}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  Stage: {activeCampaign.status.replace('_', ' ')}
                </div>
              </div>
            ) : (
              <div className="p-3 rounded-lg border border-dashed border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400">
                No active campaign loaded. Upload a product image or choose a preset to begin.
              </div>
            )}

            <ol className="space-y-2 text-xs">
              <li>
                <button
                  type="button"
                  onClick={() => handleSwitchSection('workspace')}
                  className={`w-full text-left p-2.5 rounded-lg border transition-colors ${
                    activeSection === 'workspace'
                      ? 'bg-orange-600/10 border-orange-600/40 text-slate-900 dark:text-slate-100'
                      : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span>01. Product & Brand Intake</span>
                    <span className="font-mono text-[11px] text-emerald-600 dark:text-emerald-400">M1</span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Multimodal Gemini vision profile
                  </p>
                </button>
              </li>

              <li>
                <button
                  type="button"
                  onClick={() => handleSwitchSection('storyboard')}
                  className={`w-full text-left p-2.5 rounded-lg border transition-colors ${
                    activeSection === 'storyboard'
                      ? 'bg-orange-600/10 border-orange-600/40 text-slate-900 dark:text-slate-100'
                      : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span>02. Script & 9:16 Storyboard</span>
                    <span className="font-mono text-[11px] text-orange-600 dark:text-orange-400">ACTIVE</span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Shot-by-shot 9:16 prompts & timing
                  </p>
                </button>
              </li>

              <li>
                <button
                  type="button"
                  onClick={() => handleSwitchSection('audio')}
                  className={`w-full text-left p-2.5 rounded-lg border transition-colors ${
                    activeSection === 'audio'
                      ? 'bg-orange-600/10 border-orange-600/40 text-slate-900 dark:text-slate-100'
                      : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span>03. Voiceover & Music Studio</span>
                    <span className="font-mono text-[11px] text-orange-600 dark:text-orange-400">ACTIVE</span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Real 24kHz WAV TTS & audio deck
                  </p>
                </button>
              </li>

              {[
                { step: '04. 9:16 Video Ad Render', milestone: 'M3' },
                { step: '05. Preview & Approval Gate', milestone: 'M3' },
                { step: '06. 90/100 SEO Caption Rubric', milestone: 'M4' },
                { step: '07. Cloud Persistence & Auth', milestone: 'M5' },
                { step: '08. Smart Audience Scheduler', milestone: 'M6' },
                { step: '09. OAuth Social Publishing', milestone: 'M6' },
                { step: '10. Reach & Retention Analytics', milestone: 'M6' },
              ].map((item) => (
                <li
                  key={item.step}
                  className="px-3 py-2 rounded-lg border border-slate-200/80 dark:border-slate-800/80 text-slate-500 dark:text-slate-400 flex items-center justify-between"
                >
                  <span className="flex items-center gap-2 truncate">
                    <Lock className="w-3.5 h-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
                    <span className="truncate">{item.step}</span>
                  </span>
                  <span className="font-mono text-[11px] tabular-nums shrink-0">{item.milestone}</span>
                </li>
              ))}
            </ol>

            {/* Quick Gemini Model Verification Summary */}
            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-1.5 text-xs">
              <div className="text-slate-500 dark:text-slate-400">
                Vision/JSON:{' '}
                <span className="font-mono text-slate-800 dark:text-slate-200">
                  {modelReport?.recommendedVisionModel || 'gemini-3.1-flash-lite'}
                </span>
              </div>
              <div className="text-slate-500 dark:text-slate-400">
                Voiceover TTS:{' '}
                <span className="font-mono text-slate-800 dark:text-slate-200">
                  {modelReport?.recommendedTtsModel || 'gemini-3.8-flash-lite-tts'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleSwitchSection('models')}
                className="text-xs font-medium text-orange-600 dark:text-orange-400 hover:underline inline-flex items-center gap-1 pt-1"
              >
                <span>Inspect live model probe</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Workspace Appearance Control */}
          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <span className="text-xs text-slate-500 dark:text-slate-400">Studio Theme</span>
            <button
              type="button"
              onClick={() => setDarkMode(!darkMode)}
              className="px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              {darkMode ? (
                <>
                  <Sun className="w-3.5 h-3.5 text-amber-400" />
                  <span>Light Canvas</span>
                </>
              ) : (
                <>
                  <Moon className="w-3.5 h-3.5 text-slate-700" />
                  <span>Dark Studio</span>
                </>
              )}
            </button>
          </div>
        </aside>

        {/* Main Viewport */}
        <main className="flex-1 p-6 lg:p-8 space-y-6 overflow-y-auto">
          {/* Status, Warning & Error Banners */}
          {errorBanner && (
            <div
              role="alert"
              className="p-4 rounded-lg border border-red-300 dark:border-red-900/70 bg-red-50/90 dark:bg-red-950/40 text-red-900 dark:text-red-200 flex flex-wrap items-center justify-between gap-4 text-sm"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Studio Alert: </span>
                  <span>{errorBanner}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {lastRetryAction && (
                  <button
                    type="button"
                    onClick={handleRetryLastAction}
                    disabled={isGeneratingStoryboard || isGeneratingVoiceover || isAnalyzing}
                    className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Retry Now</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setStudio((prev) => ({
                      ...prev,
                      errorBanner: null,
                      lastRetryAction: null,
                    }))
                  }
                  className="text-xs font-medium underline shrink-0"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {warningBanner && (
            <div
              role="status"
              className="p-3.5 rounded-lg border border-amber-300 dark:border-amber-900/70 bg-amber-50/90 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 flex flex-wrap items-center justify-between gap-4 text-sm"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Notice: </span>
                  <span>{warningBanner}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {(hasUnsavedStoryboardEdits || hasUnsavedProfileEdits) && (
                  <button
                    type="button"
                    onClick={handleSaveAllUnsavedChanges}
                    disabled={isSavingStoryboard || isSavingProfile}
                    className="px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>Save Unsaved Changes</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setStudio((prev) => ({ ...prev, warningBanner: null }))}
                  className="text-xs font-medium underline shrink-0"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {statusMessage && (
            <div className="p-3.5 rounded-lg border border-emerald-300 dark:border-emerald-900/70 bg-emerald-50/90 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200 flex items-center justify-between gap-4 text-sm">
              <div className="flex items-center gap-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span>{statusMessage}</span>
              </div>
              <button
                type="button"
                onClick={() => setStudio((prev) => ({ ...prev, statusMessage: null }))}
                className="text-xs font-medium underline shrink-0"
              >
                Close
              </button>
            </div>
          )}

          {/* ===================================================================
              SECTION 1: PRODUCT & BRAND INTAKE STUDIO
             =================================================================== */}
          {activeSection === 'workspace' && (
            <div className="space-y-8">
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-5 border-b border-slate-200 dark:border-slate-800">
                <div>
                  <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1.5">
                    <span>Step 01</span>
                    <span aria-hidden="true">·</span>
                    <span>Product Analysis & Brand Understanding</span>
                    <span aria-hidden="true">·</span>
                    <span>Server-Side Gemini Multimodal Vision</span>
                  </div>
                  <h1 className="font-display text-2xl lg:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                    Product Intelligence & Brand Profile Studio
                  </h1>
                </div>

                {/* Explicit Demo Preset Selector Bar */}
                <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-200/70 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800">
                  <span className="px-2.5 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    Optional Demo Presets:
                  </span>
                  {SAMPLE_PRODUCT_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => handleSelectPreset(preset)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        form.selectedPresetId === preset.id
                          ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      {preset.brandName}
                    </button>
                  ))}
                  {(form.imageDataUrl ||
                    form.title ||
                    form.price ||
                    form.brandName ||
                    form.brandVoice ||
                    form.targetAudience ||
                    form.visualStyle ||
                    activeCampaign) && (
                    <button
                      type="button"
                      onClick={handleNewProductAnalysis}
                      className="px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-red-600 dark:hover:text-red-400 transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                      title="Clear all product fields and reset studio"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Clear</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start">
                {/* Left Column: Upload & Brand Preferences Form */}
                <form
                  onSubmit={handleAnalyzeProduct}
                  className="xl:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5"
                >
                  <div className="flex items-center justify-between">
                    <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                      1. Product Image & Metadata
                    </h2>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      PNG · JPG · WEBP
                    </span>
                  </div>

                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleDrop}
                    className="border border-dashed border-slate-300 dark:border-slate-700 rounded-lg p-4 bg-slate-50/60 dark:bg-slate-950/50 space-y-3"
                  >
                    {form.imageDataUrl ? (
                      <div className="relative aspect-square max-h-[260px] mx-auto overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900 flex items-center justify-center">
                        <img
                          src={form.imageDataUrl}
                          alt={form.title || 'Uploaded product preview'}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-contain"
                        />
                        {isAnalyzing && (
                          <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-[2px] flex flex-col items-center justify-center gap-2 p-4 text-center text-white">
                            <RefreshCw className="w-6 h-6 animate-spin text-orange-400" />
                            <span className="text-xs font-semibold">
                              Extracting product metadata with Gemini Vision...
                            </span>
                            <span className="text-[11px] text-slate-300">
                              Identifying brand, model, labels, features & audience
                            </span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="py-12 text-center space-y-2">
                        <ImageIcon className="w-8 h-8 mx-auto text-slate-400" />
                        <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                          Drag and drop your product image here
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Uploading an image automatically runs Gemini Vision identification
                        </p>
                      </div>
                    )}

                    <div className="flex items-center justify-between gap-3 pt-1">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={handleImageFileChange}
                        className="hidden"
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isAnalyzing}
                        className="flex-1 py-2 px-4 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-60 transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        <span>
                          {form.imageDataUrl
                            ? 'Upload Different Product Image'
                            : 'Upload Product Image (Auto-Analyze)'}
                        </span>
                      </button>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Product Name <span className="text-slate-400">(extracted from image — editable)</span>
                      </label>
                      <input
                        type="text"
                        value={form.title}
                        onChange={(e) => updateFormField('title', e.target.value)}
                        placeholder="Auto-extracted on upload (or enter manually)"
                        className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-600"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Brand Name <span className="text-slate-400">(if visible, else Unknown)</span>
                        </label>
                        <input
                          type="text"
                          value={form.brandName}
                          onChange={(e) => updateFormField('brandName', e.target.value)}
                          placeholder="Visible brand or Unknown"
                          className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-600"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Visible Model / Variant <span className="text-slate-400">(or Unknown)</span>
                        </label>
                        <input
                          type="text"
                          value={form.modelOrVariant}
                          onChange={(e) => updateFormField('modelOrVariant', e.target.value)}
                          placeholder="Visible model/size or Unknown"
                          className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-600"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Price / Offer <span className="text-slate-400">(empty unless visible/entered)</span>
                        </label>
                        <input
                          type="text"
                          value={form.price}
                          onChange={(e) => updateFormField('price', e.target.value)}
                          placeholder="Leave blank or enter offer"
                          className="w-full px-3.5 py-2 text-sm font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-600"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Brand Voice Direction <span className="text-slate-400">(editable)</span>
                        </label>
                        <input
                          type="text"
                          list="brand-voice-suggestions"
                          value={form.brandVoice}
                          onChange={(e) => updateFormField('brandVoice', e.target.value)}
                          placeholder="Auto-inferred from product"
                          className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-600"
                        />
                        <datalist id="brand-voice-suggestions">
                          {BRAND_VOICE_OPTIONS.map((voice) => (
                            <option key={voice} value={voice} />
                          ))}
                        </datalist>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Visible Packaging Text, Label & Logo <span className="text-slate-400">(observed verbatim)</span>
                      </label>
                      <input
                        type="text"
                        value={form.visiblePackagingText}
                        onChange={(e) => updateFormField('visiblePackagingText', e.target.value)}
                        placeholder="Visible label text/logos or Unknown"
                        className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-600"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Likely Target Audience <span className="text-amber-600 dark:text-amber-400">(AI Inference — editable)</span>
                      </label>
                      <input
                        type="text"
                        value={form.targetAudience}
                        onChange={(e) => updateFormField('targetAudience', e.target.value)}
                        placeholder="Inferred buyer persona based on product"
                        className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-600"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Suggested Marketing Angle & Visual Direction <span className="text-slate-400">(editable)</span>
                      </label>
                      <textarea
                        rows={2}
                        value={form.visualStyle}
                        onChange={(e) => updateFormField('visualStyle', e.target.value)}
                        placeholder="Suggested lighting, camera movement, and marketing angle..."
                        className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-600"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={isAnalyzing}
                    className="w-full py-2.5 px-4 rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-60 text-white text-sm font-semibold transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap"
                  >
                    {isAnalyzing ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Analyzing Product Image with Gemini Vision...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4" />
                        <span>
                          {activeCampaign
                            ? 'Re-Analyze Image & Refresh Profile'
                            : 'Analyze Product & Generate Structured Profile'}
                        </span>
                      </>
                    )}
                  </button>
                </form>

                {/* Right Column: Structured Product Profile Inspector & Editor */}
                <div className="xl:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-6">
                  {isAnalyzing && (!activeCampaign || !editableProfile) ? (
                    <div className="py-20 text-center space-y-3" role="status" aria-live="polite">
                      <RefreshCw className="w-10 h-10 mx-auto text-orange-500 animate-spin" />
                      <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
                        Analyzing Product Image with Gemini Multimodal Vision...
                      </h3>
                      <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                        Inspecting visible brand markings, model/variant details, packaging text, physical features, and inferring target audience without fabricating missing attributes.
                      </p>
                    </div>
                  ) : !activeCampaign || !editableProfile ? (
                    <div className="py-20 text-center space-y-3">
                      <Layers className="w-10 h-10 mx-auto text-slate-400" />
                      <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
                        Ready for New Product Analysis
                      </h3>
                      <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                        Upload a product image on the left to automatically extract product metadata with Gemini Vision, or select an optional demo preset above.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
                        <div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                            <span className="font-mono">{activeCampaign.id}</span>
                            <span aria-hidden="true">·</span>
                            <span>Model: {activeCampaign.analysisMetadata.resolvedModel}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              {activeCampaign.analysisMetadata.latencyMs} ms
                            </span>
                            {editableProfile.identificationConfidence && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>
                                  Confidence: {editableProfile.identificationConfidence.toUpperCase()}
                                </span>
                              </>
                            )}
                          </div>
                          <h2 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100 mt-1">
                            {editableProfile.detectedProductName}
                          </h2>
                        </div>

                        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800 shrink-0">
                          <button
                            type="button"
                            onClick={() => setProfileTab('visual')}
                            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                              profileTab === 'visual'
                                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            <Sliders className="w-3.5 h-3.5" />
                            <span>Structured Inspector</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setStudio((prev) => ({
                                ...prev,
                                rawJsonText: JSON.stringify(prev.editableProfile, null, 2),
                              }));
                              setProfileTab('json');
                            }}
                            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                              profileTab === 'json'
                                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            <Code2 className="w-3.5 h-3.5" />
                            <span>Raw JSON Profile</span>
                          </button>
                        </div>
                      </div>

                      {profileTab === 'visual' ? (
                        <div className="space-y-6">
                          {editableProfile.uncertaintyNotes && (
                            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/60 text-xs text-slate-600 dark:text-slate-300 flex items-start justify-between gap-3">
                              <div>
                                <span className="font-semibold text-slate-900 dark:text-slate-100">
                                  Visual Verification Note:{' '}
                                </span>
                                <span>{editableProfile.uncertaintyNotes}</span>
                              </div>
                            </div>
                          )}

                          <div className="space-y-3">
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                              <div>
                                <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
                                  Primary Category
                                </label>
                                <input
                                  type="text"
                                  value={editableProfile.category}
                                  onChange={(e) =>
                                    setStudio((prev) =>
                                      prev.editableProfile
                                        ? {
                                            ...prev,
                                            hasUnsavedProfileEdits: true,
                                            editableProfile: {
                                              ...prev.editableProfile,
                                              category: e.target.value,
                                            },
                                          }
                                        : prev
                                    )
                                  }
                                  className="w-full px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
                                  Subcategory
                                </label>
                                <input
                                  type="text"
                                  value={editableProfile.subcategory}
                                  onChange={(e) =>
                                    setStudio((prev) =>
                                      prev.editableProfile
                                        ? {
                                            ...prev,
                                            hasUnsavedProfileEdits: true,
                                            editableProfile: {
                                              ...prev.editableProfile,
                                              subcategory: e.target.value,
                                            },
                                          }
                                        : prev
                                    )
                                  }
                                  className="w-full px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
                                  Estimated Form Factor
                                </label>
                                <input
                                  type="text"
                                  value={editableProfile.estimatedDimensions}
                                  onChange={(e) =>
                                    setStudio((prev) =>
                                      prev.editableProfile
                                        ? {
                                            ...prev,
                                            hasUnsavedProfileEdits: true,
                                            editableProfile: {
                                              ...prev.editableProfile,
                                              estimatedDimensions: e.target.value,
                                            },
                                          }
                                        : prev
                                    )
                                  }
                                  className="w-full px-3 py-1.5 text-xs font-mono tabular-nums rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                                />
                              </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
                                  Identified Brand (or Unknown)
                                </label>
                                <input
                                  type="text"
                                  value={editableProfile.identifiedBrandName || form.brandName || 'Unknown'}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setStudio((prev) =>
                                      prev.editableProfile
                                        ? {
                                            ...prev,
                                            hasUnsavedProfileEdits: true,
                                            form: { ...prev.form, brandName: val },
                                            editableProfile: {
                                              ...prev.editableProfile,
                                              identifiedBrandName: val,
                                            },
                                          }
                                        : prev
                                    );
                                  }}
                                  className="w-full px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
                                  Visible Model / Variant (or Unknown)
                                </label>
                                <input
                                  type="text"
                                  value={
                                    editableProfile.identifiedModelOrVariant ||
                                    form.modelOrVariant ||
                                    'Unknown'
                                  }
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setStudio((prev) =>
                                      prev.editableProfile
                                        ? {
                                            ...prev,
                                            hasUnsavedProfileEdits: true,
                                            form: { ...prev.form, modelOrVariant: val },
                                            editableProfile: {
                                              ...prev.editableProfile,
                                              identifiedModelOrVariant: val,
                                            },
                                          }
                                        : prev
                                    );
                                  }}
                                  className="w-full px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                                />
                              </div>
                            </div>

                            <div>
                              <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
                                AI Product Positioning Summary
                              </label>
                              <textarea
                                rows={2}
                                value={editableProfile.productSummary}
                                onChange={(e) =>
                                  setStudio((prev) =>
                                    prev.editableProfile
                                      ? {
                                          ...prev,
                                          hasUnsavedProfileEdits: true,
                                          editableProfile: {
                                            ...prev.editableProfile,
                                            productSummary: e.target.value,
                                          },
                                        }
                                      : prev
                                  )
                                }
                                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 leading-relaxed"
                              />
                            </div>
                          </div>

                          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
                            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                              Extracted Color Palette
                            </h3>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                              {editableProfile.dominantColors.map((swatch, idx) => (
                                <div
                                  key={`${swatch.hex}-${idx}`}
                                  className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 flex items-center gap-3"
                                >
                                  <div
                                    className="w-8 h-8 rounded-md border border-slate-300 dark:border-slate-700 shrink-0"
                                    style={{ backgroundColor: swatch.hex }}
                                  />
                                  <div className="min-w-0">
                                    <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                                      {swatch.name}
                                    </div>
                                    <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                                      {swatch.hex} · {swatch.usageRole}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 mb-2">
                                Materials & Surface Textures
                              </h3>
                              <ul className="space-y-1.5 text-xs text-slate-700 dark:text-slate-300">
                                {editableProfile.materialsAndTextures.map((mat, i) => (
                                  <li key={i} className="flex items-baseline gap-2">
                                    <span className="font-mono text-slate-400">0{i + 1}.</span>
                                    <span>{mat}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>

                            <div>
                              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 mb-2">
                                Detected Physical Features
                              </h3>
                              <ul className="space-y-1.5 text-xs text-slate-700 dark:text-slate-300">
                                {editableProfile.detectedFeatures.map((feat, i) => (
                                  <li key={i} className="flex items-baseline gap-2">
                                    <span className="font-mono text-slate-400">0{i + 1}.</span>
                                    <span>{feat}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </div>

                          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
                            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                              Core Video Selling Points & Hooks
                            </h3>
                            <div className="space-y-2.5">
                              {editableProfile.keySellingPoints.map((sp, idx) => (
                                <div
                                  key={idx}
                                  className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/50 space-y-1"
                                >
                                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                                    0{idx + 1}. {sp.headline}
                                  </div>
                                  <div className="text-xs text-slate-600 dark:text-slate-400">
                                    <span className="font-medium text-slate-700 dark:text-slate-300">Proof: </span>
                                    {sp.proofPoint}
                                  </div>
                                  <div className="text-xs text-slate-600 dark:text-slate-400">
                                    <span className="font-medium text-slate-700 dark:text-slate-300">
                                      Emotional Hook:{' '}
                                    </span>
                                    {sp.emotionalHook}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                            <span>Structured JSON Schema (Editable)</span>
                            <span>UTF-8 · application/json</span>
                          </div>
                          {jsonParseError && (
                            <div className="p-2.5 rounded-md bg-red-50 dark:bg-red-950/50 border border-red-300 dark:border-red-800 text-xs text-red-700 dark:text-red-300 font-mono">
                              {jsonParseError}
                            </div>
                          )}
                          <textarea
                            rows={20}
                            value={rawJsonText}
                            onChange={(e) => {
                              const nextRaw = e.target.value;
                              try {
                                const parsed = JSON.parse(nextRaw) as ProductProfile;
                                setStudio((prev) => ({
                                  ...prev,
                                  hasUnsavedProfileEdits: true,
                                  rawJsonText: nextRaw,
                                  editableProfile: parsed,
                                  jsonParseError: null,
                                }));
                              } catch (err: unknown) {
                                setStudio((prev) => ({
                                  ...prev,
                                  hasUnsavedProfileEdits: true,
                                  rawJsonText: nextRaw,
                                  jsonParseError:
                                    err instanceof Error ? err.message : 'Invalid JSON',
                                }));
                              }
                            }}
                            className="w-full p-4 font-mono text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-950 text-emerald-300 focus:outline-none focus:ring-2 focus:ring-orange-600 leading-relaxed"
                          />
                        </div>
                      )}

                      {/* Action Footer with Direct Step 2 Handoff */}
                      <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={handleCopyJson}
                            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
                          >
                            {copiedJson ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-emerald-500" />
                                <span>Copied JSON</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                <span>Copy JSON</span>
                              </>
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={handleDownloadJson}
                            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>Export Bundle (.json)</span>
                          </button>

                          <button
                            type="button"
                            onClick={handleSaveProfileChanges}
                            disabled={isSavingProfile}
                            className="px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
                          >
                            <Save className="w-3.5 h-3.5" />
                            <span>{isSavingProfile ? 'Saving...' : 'Save Profile'}</span>
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleSwitchSection('storyboard')}
                          className="px-4 py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
                        >
                          <span>Step 02: Script & 9:16 Storyboard</span>
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ===================================================================
              SECTION 2: MILESTONE 2 — AI SCRIPT & 9:16 SHOT-BY-SHOT STORYBOARD
             =================================================================== */}
          {activeSection === 'storyboard' && (
            <div className="space-y-6">
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-5 border-b border-slate-200 dark:border-slate-800">
                <div>
                  <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1.5">
                    <span>Step 02 · Milestone 2</span>
                    <span aria-hidden="true">·</span>
                    <span>Brand-Safe Video Concept, Script & Vertical 9:16 Storyboard</span>
                  </div>
                  <h1 className="font-display text-2xl lg:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                    Script & Shot-by-Shot 9:16 Storyboard Studio
                  </h1>
                </div>

                {activeCampaign && (
                  <button
                    type="button"
                    onClick={() => handleSwitchSection('audio')}
                    className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    <span>Step 03: Voiceover & Music Studio</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                )}
              </div>

              {!activeCampaign ? (
                <div className="p-12 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-center space-y-3">
                  <Film className="w-9 h-9 mx-auto text-slate-400" />
                  <h3 className="font-display text-base font-semibold">Analyze a Product First</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                    Storyboard generation requires an analyzed product profile from Step 01.
                  </p>
                  <button
                    type="button"
                    onClick={() => handleSwitchSection('workspace')}
                    className="px-4 py-2 rounded-lg bg-orange-600 text-white text-xs font-semibold"
                  >
                    Go to Step 01: Product Studio
                  </button>
                </div>
              ) : (
                <>
                  {/* Storyboard Generator Controls Bar */}
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
                      <div className="md:col-span-3">
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Target Vertical Platform
                        </label>
                        <select
                          value={targetFormat}
                          onChange={(e) =>
                            setStudio((prev) => ({
                              ...prev,
                              targetFormat: e.target.value as (typeof PLATFORM_FORMATS)[number],
                            }))
                          }
                          className="w-full px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        >
                          {PLATFORM_FORMATS.map((fmt) => (
                            <option key={fmt} value={fmt}>
                              {fmt}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="md:col-span-2">
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Target Duration
                        </label>
                        <select
                          value={desiredDuration}
                          onChange={(e) =>
                            setStudio((prev) => ({
                              ...prev,
                              desiredDuration: Number(e.target.value),
                            }))
                          }
                          className="w-full px-3 py-2 text-xs font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        >
                          <option value={15}>15 Seconds (4 Shots)</option>
                          <option value={20}>20 Seconds (5 Shots)</option>
                          <option value={30}>30 Seconds (6 Shots)</option>
                        </select>
                      </div>

                      <div className="md:col-span-4">
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Creative Angle Direction (Optional)
                        </label>
                        <input
                          type="text"
                          value={creativeAngleHint}
                          onChange={(e) =>
                            setStudio((prev) => ({
                              ...prev,
                              creativeAngleHint: e.target.value,
                            }))
                          }
                          placeholder="e.g., Focus on tactile craftsmanship & morning ritual"
                          className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                      </div>

                      <div className="md:col-span-3">
                        <button
                          type="button"
                          onClick={handleGenerateStoryboard}
                          disabled={isGeneratingStoryboard}
                          className="w-full py-2 px-4 rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-60 text-white text-xs font-semibold transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap"
                        >
                          {isGeneratingStoryboard ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              <span>Generating 9:16 Storyboard...</span>
                            </>
                          ) : (
                            <>
                              <Sparkles className="w-3.5 h-3.5" />
                              <span>
                                {editableStoryboard ? 'Regenerate Storyboard' : 'Generate 9:16 Storyboard'}
                              </span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    {activeCampaign.productProfile.recommendedAdAngles.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-200/80 dark:border-slate-800/80 text-xs">
                        <span className="text-slate-500 dark:text-slate-400">
                          Apply Recommended Angle:
                        </span>
                        {activeCampaign.productProfile.recommendedAdAngles.map((ang, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => {
                              setStudio((prev) => ({
                                ...prev,
                                creativeAngleHint: `${ang.angleName}: ${ang.hookIdea}`,
                              }));
                            }}
                            className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 hover:border-orange-600 text-slate-700 dark:text-slate-300 transition-colors"
                          >
                            {ang.angleName} ({ang.targetPlatform})
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Storyboard & Script Editor */}
                  {!editableStoryboard ? (
                    <div className="p-14 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-center space-y-3">
                      <Film className="w-10 h-10 mx-auto text-slate-400" />
                      <h3 className="font-display text-lg font-semibold">
                        Ready to Generate 9:16 Video Concept & Storyboard
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto leading-relaxed">
                        Click <strong>Generate 9:16 Storyboard</strong> above to create a brand-safe commercial script, 3-second hook, master visual prompt, and timed shot-by-shot breakdown for{' '}
                        <span className="font-semibold text-slate-800 dark:text-slate-200">
                          {activeCampaign.title}
                        </span>
                        .
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {/* Concept Overview & Master Voiceover Script Card */}
                      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-200 dark:border-slate-800">
                          <div>
                            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                              <span>{editableStoryboard.targetPlatformFormat}</span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums">
                                Total Duration: {editableStoryboard.totalDurationSeconds}s
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums">
                                {editableStoryboard.estimatedWordCount} words
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>
                                Model: {editableStoryboard.generationMetadata.resolvedModel}
                              </span>
                              {hasUnsavedStoryboardEdits && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="text-amber-600 dark:text-amber-400 font-semibold">
                                    Unsaved Edits
                                  </span>
                                </>
                              )}
                            </div>
                            <input
                              type="text"
                              value={editableStoryboard.conceptTitle}
                              onChange={(e) =>
                                setStudio((prev) =>
                                  prev.editableStoryboard
                                    ? {
                                        ...prev,
                                        hasUnsavedStoryboardEdits: true,
                                        editableStoryboard: {
                                          ...prev.editableStoryboard,
                                          conceptTitle: e.target.value,
                                        },
                                      }
                                    : prev
                                )
                              }
                              className="mt-1.5 w-full sm:w-[460px] font-display text-lg font-bold text-slate-900 dark:text-slate-100 bg-transparent border-b border-transparent hover:border-slate-300 dark:hover:border-slate-700 focus:border-orange-600 focus:outline-none"
                            />
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={handleSyncScriptFromShots}
                              className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                            >
                              Sync Script from Shots
                            </button>
                            <button
                              type="button"
                              onClick={handleSaveStoryboardEdits}
                              disabled={isSavingStoryboard}
                              className="px-4 py-1.5 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-semibold hover:opacity-90 transition-opacity inline-flex items-center gap-1.5 whitespace-nowrap"
                            >
                              <Save className="w-3.5 h-3.5" />
                              <span>{isSavingStoryboard ? 'Saving...' : 'Save Script & Storyboard'}</span>
                            </button>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                          <div className="lg:col-span-7 space-y-4">
                            <div>
                              <label className="block text-xs font-semibold text-slate-800 dark:text-slate-200 mb-1">
                                Opening 3-Second Scroll-Stopper Hook (Editable)
                              </label>
                              <input
                                type="text"
                                value={editableStoryboard.openingHook3s}
                                onChange={(e) =>
                                  setStudio((prev) =>
                                    prev.editableStoryboard
                                      ? {
                                          ...prev,
                                          hasUnsavedStoryboardEdits: true,
                                          editableStoryboard: {
                                            ...prev.editableStoryboard,
                                            openingHook3s: e.target.value,
                                          },
                                        }
                                      : prev
                                  )
                                }
                                className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                              />
                            </div>

                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <label className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                                  Full Voiceover Script (Review & Edit Before Audio Synthesis)
                                </label>
                                <span className="text-[11px] font-mono tabular-nums text-slate-500">
                                  {editableStoryboard.fullVoiceoverScript
                                    .trim()
                                    .split(/\s+/)
                                    .filter(Boolean).length}{' '}
                                  words
                                </span>
                              </div>
                              <textarea
                                rows={4}
                                value={editableStoryboard.fullVoiceoverScript}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  const words = val.trim().split(/\s+/).filter(Boolean).length;
                                  setStudio((prev) =>
                                    prev.editableStoryboard
                                      ? {
                                          ...prev,
                                          hasUnsavedStoryboardEdits: true,
                                          editableStoryboard: {
                                            ...prev.editableStoryboard,
                                            fullVoiceoverScript: val,
                                            estimatedWordCount: words,
                                          },
                                          voiceScriptDraft: val,
                                        }
                                      : prev
                                  );
                                }}
                                className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 leading-relaxed"
                              />
                            </div>
                          </div>

                          <div className="lg:col-span-5 space-y-4">
                            <div>
                              <label className="block text-xs font-semibold text-slate-800 dark:text-slate-200 mb-1">
                                Master 9:16 Cinematic Visual Prompt (Editable)
                              </label>
                              <textarea
                                rows={3}
                                value={editableStoryboard.masterCinematicPrompt9x16}
                                onChange={(e) =>
                                  setStudio((prev) =>
                                    prev.editableStoryboard
                                      ? {
                                          ...prev,
                                          hasUnsavedStoryboardEdits: true,
                                          editableStoryboard: {
                                            ...prev.editableStoryboard,
                                            masterCinematicPrompt9x16: e.target.value,
                                          },
                                        }
                                      : prev
                                  )
                                }
                                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 leading-relaxed"
                              />
                            </div>

                            <div>
                              <label className="block text-xs font-semibold text-slate-800 dark:text-slate-200 mb-1">
                                Instrumental Music Direction Prompt (Editable)
                              </label>
                              <input
                                type="text"
                                value={editableStoryboard.musicDirectionPrompt}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setStudio((prev) =>
                                    prev.editableStoryboard
                                      ? {
                                          ...prev,
                                          hasUnsavedStoryboardEdits: true,
                                          editableStoryboard: {
                                            ...prev.editableStoryboard,
                                            musicDirectionPrompt: val,
                                          },
                                          musicPromptDraft: val,
                                        }
                                      : prev
                                  );
                                }}
                                className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                              />
                            </div>

                            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 space-y-1.5">
                              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200">
                                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                                <span>Brand Safety & Product Accuracy Checks</span>
                              </div>
                              <div className="text-xs text-slate-600 dark:text-slate-400 space-y-1">
                                {editableStoryboard.brandSafetyVerification.map((check, i) => (
                                  <div key={i}>· {check}</div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Shot-by-Shot 9:16 Vertical Storyboard Cards */}
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <h2 className="font-display text-lg font-bold text-slate-900 dark:text-slate-100">
                              Shot-by-Shot Vertical 9:16 Storyboard ({editableStoryboard.shots.length} Shots ·{' '}
                              <span className="font-mono tabular-nums">
                                {editableStoryboard.totalDurationSeconds}s
                              </span>
                              )
                            </h2>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                              Edit any shot description, duration, timecode, spoken line, or 9:16 visual prompt below before generating audio.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={handleAddShot}
                            className="px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>Add 9:16 Shot</span>
                          </button>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                          {editableStoryboard.shots.map((shot, idx) => (
                            <div
                              key={idx}
                              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3.5"
                            >
                              <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-slate-200 dark:border-slate-800">
                                <div className="flex items-center gap-2 text-xs">
                                  <span className="font-mono font-bold text-orange-600 dark:text-orange-400">
                                    SHOT 0{shot.shotNumber}
                                  </span>
                                  <span aria-hidden="true">·</span>
                                  <input
                                    type="text"
                                    value={shot.timecodeRange}
                                    onChange={(e) =>
                                      handleUpdateShotField(idx, 'timecodeRange', e.target.value)
                                    }
                                    aria-label={`Shot ${shot.shotNumber} timecode`}
                                    className="w-28 px-1.5 py-0.5 font-mono tabular-nums text-xs text-slate-700 dark:text-slate-300 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                                  />
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono text-slate-500">9:16</span>
                                </div>

                                <div className="flex items-center gap-2">
                                  <label className="text-[11px] text-slate-500">Duration (s):</label>
                                  <input
                                    type="number"
                                    min={1}
                                    max={15}
                                    value={shot.durationSeconds}
                                    onChange={(e) =>
                                      handleUpdateShotField(idx, 'durationSeconds', Number(e.target.value))
                                    }
                                    className="w-14 px-2 py-1 text-xs font-mono tabular-nums rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-right"
                                  />
                                  {editableStoryboard.shots.length > 1 && (
                                    <button
                                      type="button"
                                      onClick={() => handleRemoveShot(idx)}
                                      className="p-1 text-slate-400 hover:text-red-600 transition-colors"
                                      title="Remove shot"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </div>
                              </div>

                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                  <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                                    Shot Framing / Role
                                  </label>
                                  <input
                                    type="text"
                                    value={shot.shotType}
                                    onChange={(e) =>
                                      handleUpdateShotField(idx, 'shotType', e.target.value)
                                    }
                                    className="w-full px-2.5 py-1.5 text-xs font-semibold rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                                    Camera Movement
                                  </label>
                                  <input
                                    type="text"
                                    value={shot.cameraMovement}
                                    onChange={(e) =>
                                      handleUpdateShotField(idx, 'cameraMovement', e.target.value)
                                    }
                                    className="w-full px-2.5 py-1.5 text-xs rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                                  />
                                </div>
                              </div>

                              <div>
                                <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                                  Scene Description (9:16 Frame Action)
                                </label>
                                <textarea
                                  rows={2}
                                  value={shot.sceneDescription}
                                  onChange={(e) =>
                                    handleUpdateShotField(idx, 'sceneDescription', e.target.value)
                                  }
                                  className="w-full px-2.5 py-1.5 text-xs rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 leading-relaxed"
                                />
                              </div>

                              <div>
                                <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                                  Spoken Voiceover Segment
                                </label>
                                <input
                                  type="text"
                                  value={shot.spokenVoiceoverSegment}
                                  onChange={(e) =>
                                    handleUpdateShotField(idx, 'spokenVoiceoverSegment', e.target.value)
                                  }
                                  className="w-full px-2.5 py-1.5 text-xs rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                                />
                              </div>

                              <div>
                                <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                                  On-Screen Subtitle / Text Overlay
                                </label>
                                <input
                                  type="text"
                                  value={shot.onScreenTextOverlay}
                                  onChange={(e) =>
                                    handleUpdateShotField(idx, 'onScreenTextOverlay', e.target.value)
                                  }
                                  className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                                />
                              </div>

                              <div>
                                <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                                  9:16 Visual Generation Prompt (Product-Accurate)
                                </label>
                                <textarea
                                  rows={2}
                                  value={shot.visualPrompt9x16}
                                  onChange={(e) =>
                                    handleUpdateShotField(idx, 'visualPrompt9x16', e.target.value)
                                  }
                                  className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 leading-relaxed"
                                />
                              </div>

                              <div>
                                <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
                                  Product Fidelity Guardrail (Editable)
                                </label>
                                <input
                                  type="text"
                                  value={shot.productFidelityNote}
                                  onChange={(e) =>
                                    handleUpdateShotField(idx, 'productFidelityNote', e.target.value)
                                  }
                                  className="w-full px-2.5 py-1.5 text-xs rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ===================================================================
              SECTION 3: MILESTONE 2 — AI VOICEOVER WAV & MUSIC AUDIO STUDIO
             =================================================================== */}
          {activeSection === 'audio' && (
            <div className="space-y-6">
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-5 border-b border-slate-200 dark:border-slate-800">
                <div>
                  <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1.5">
                    <span>Step 03 · Milestone 2</span>
                    <span aria-hidden="true">·</span>
                    <span>Server-Side Gemini TTS (24kHz WAV) & Audio Studio</span>
                  </div>
                  <h1 className="font-display text-2xl lg:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                    AI Voiceover Synthesis & Background Audio Studio
                  </h1>
                </div>

                <button
                  type="button"
                  onClick={() => handleSwitchSection('storyboard')}
                  className="px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                >
                  Back to Storyboard Editor
                </button>
              </div>

              {!activeCampaign ? (
                <div className="p-12 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-center space-y-3">
                  <Mic className="w-9 h-9 mx-auto text-slate-400" />
                  <h3 className="font-display text-base font-semibold">Select or Analyze a Product First</h3>
                  <button
                    type="button"
                    onClick={() => setActiveSection('workspace')}
                    className="px-4 py-2 rounded-lg bg-orange-600 text-white text-xs font-semibold"
                  >
                    Go to Step 01: Product Studio
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start">
                  {/* Left Column (7 cols): Voice Selection, Script Editor & WAV Generator */}
                  <div className="xl:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
                          1. AI Voiceover Configuration (gemini-3.8-flash-lite-tts)
                        </h2>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Select one of the 5 supported studio voices and review the spoken script before generating the 24kHz WAV file.
                        </p>
                      </div>
                      <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400 shrink-0">
                        audio/wav · 24kHz
                      </span>
                    </div>

                    {/* Supported Voices Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {VOICE_OPTIONS_META.map((v) => {
                        const isSelected = selectedVoice === v.name;
                        return (
                          <button
                            key={v.name}
                            type="button"
                            onClick={() =>
                              setStudio((prev) => ({
                                ...prev,
                                selectedVoice: v.name,
                                voiceStylePrompt: v.defaultStylePrompt,
                              }))
                            }
                            className={`text-left p-3.5 rounded-lg border transition-colors ${
                              isSelected
                                ? 'border-orange-600 bg-orange-600/10'
                                : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                            }`}
                          >
                            <div className="flex items-center justify-between text-xs font-semibold text-slate-900 dark:text-slate-100">
                              <span>{v.label}</span>
                              {isSelected && (
                                <span className="font-mono text-[11px] text-orange-600 dark:text-orange-400">
                                  SELECTED
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                              {v.toneSummary}
                            </p>
                          </button>
                        );
                      })}
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Vocal Delivery Direction (speechMetadata.style)
                      </label>
                      <input
                        type="text"
                        value={voiceStylePrompt}
                        onChange={(e) =>
                          setStudio((prev) => ({
                            ...prev,
                            voiceStylePrompt: e.target.value,
                          }))
                        }
                        placeholder="e.g., Polished, confident commercial narrator with warm clarity"
                        className="w-full px-3.5 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                      />
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                          Voiceover Script to Synthesize (Editable)
                        </label>
                        <span className="text-[11px] font-mono tabular-nums text-slate-500">
                          {voiceScriptDraft.trim().split(/\s+/).filter(Boolean).length} words ·{' '}
                          {voiceScriptDraft.length}/1500 chars
                        </span>
                      </div>
                      <textarea
                        rows={5}
                        value={voiceScriptDraft}
                        onChange={(e) =>
                          setStudio((prev) => ({
                            ...prev,
                            voiceScriptDraft: e.target.value,
                          }))
                        }
                        placeholder="Enter or refine the spoken voiceover script..."
                        className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 leading-relaxed"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={handleGenerateVoiceover}
                      disabled={isGeneratingVoiceover}
                      className="w-full py-2.5 px-4 rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-60 text-white text-sm font-semibold transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap"
                    >
                      {isGeneratingVoiceover ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          <span>Synthesizing 24kHz WAV Voiceover ({selectedVoice})...</span>
                        </>
                      ) : (
                        <>
                          <Mic className="w-4 h-4" />
                          <span>Generate Real AI Voiceover (.WAV) with {selectedVoice}</span>
                        </>
                      )}
                    </button>
                  </div>

                  {/* Right Column (5 cols): Studio Audio Player Deck & Background Music */}
                  <div className="xl:col-span-5 space-y-6">
                    {/* Voiceover Playback Deck */}
                    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
                      <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
                        <div>
                          <h3 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
                            2. Voiceover Master Playback Deck
                          </h3>
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            Uncompressed RIFF WAVE · 24,000 Hz · 16-bit Mono
                          </p>
                        </div>
                        {activeCampaign.voiceover && (
                          <a
                            href={activeCampaign.voiceover.audioFileUrl}
                            download={`${activeCampaign.id}-voiceover-${activeCampaign.voiceover.voiceName}.wav`}
                            className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>Download .WAV</span>
                          </a>
                        )}
                      </div>

                      {!activeCampaign.voiceover ? (
                        <div className="py-10 text-center space-y-2 text-xs text-slate-500 dark:text-slate-400">
                          <Volume2 className="w-8 h-8 mx-auto text-slate-400" />
                          <p>No voiceover WAV generated for this campaign yet.</p>
                          <p>Click <strong>Generate Real AI Voiceover (.WAV)</strong> on the left to synthesize speech.</p>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          <audio
                            ref={audioRef}
                            src={activeCampaign.voiceover.audioFileUrl}
                            onPlay={() => setIsPlayingVo(true)}
                            onPause={() => setIsPlayingVo(false)}
                            onEnded={() => setIsPlayingVo(false)}
                            onTimeUpdate={(e) => setVoCurrentTime(e.currentTarget.currentTime)}
                            onLoadedMetadata={(e) => setVoDuration(e.currentTarget.duration)}
                            className="hidden"
                          />

                          <div className="p-4 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3">
                            <div className="flex items-center justify-between gap-3">
                              <button
                                type="button"
                                onClick={toggleVoPlayback}
                                className="w-10 h-10 rounded-lg bg-orange-600 hover:bg-orange-500 text-white flex items-center justify-center shrink-0 transition-colors"
                                aria-label={isPlayingVo ? 'Pause voiceover' : 'Play voiceover'}
                              >
                                {isPlayingVo ? (
                                  <Pause className="w-4 h-4" />
                                ) : (
                                  <Play className="w-4 h-4 ml-0.5" />
                                )}
                              </button>

                              <div className="flex-1 space-y-1">
                                <input
                                  type="range"
                                  min={0}
                                  max={voDuration || activeCampaign.voiceover.durationEstimateSeconds || 10}
                                  step={0.1}
                                  value={voCurrentTime}
                                  onChange={(e) => {
                                    const nextTime = Number(e.target.value);
                                    setVoCurrentTime(nextTime);
                                    if (audioRef.current) {
                                      audioRef.current.currentTime = nextTime;
                                    }
                                  }}
                                  className="w-full accent-orange-600 cursor-pointer"
                                />
                                <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-500">
                                  <span>{formatAudioSec(voCurrentTime)}</span>
                                  <span>
                                    {formatAudioSec(
                                      voDuration || activeCampaign.voiceover.durationEstimateSeconds
                                    )}
                                  </span>
                                </div>
                              </div>

                              <button
                                type="button"
                                onClick={toggleVoMute}
                                className="p-2 rounded-md border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800"
                                title={voMuted ? 'Unmute' : 'Mute'}
                              >
                                {voMuted ? (
                                  <VolumeX className="w-4 h-4" />
                                ) : (
                                  <Volume2 className="w-4 h-4" />
                                )}
                              </button>

                              <div className="flex items-center gap-1">
                                {[1, 1.25].map((rate) => (
                                  <button
                                    key={rate}
                                    type="button"
                                    onClick={() => handleVoRateChange(rate)}
                                    className={`px-2 py-1 rounded text-[11px] font-mono tabular-nums ${
                                      voPlaybackRate === rate
                                        ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-semibold'
                                        : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
                                    }`}
                                  >
                                    {rate}x
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                            <span>Voice: {activeCampaign.voiceover.voiceName}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              {(activeCampaign.voiceover.byteLength / 1024).toFixed(1)} KB
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              ~{activeCampaign.voiceover.durationEstimateSeconds}s
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>Model: {activeCampaign.voiceover.resolvedModel}</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Honest Background Music Panel */}
                    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
                      <div>
                        <div className="flex items-center justify-between">
                          <h3 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
                            3. Background Music Track (Optional)
                          </h3>
                          <span className="text-xs text-slate-500">Lyria / Custom Audio</span>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                          AI music generation (<span className="font-mono">lyria-3-clip-preview</span>) requires a billing-enabled Gemini API key. You can test live Lyria generation, upload your own royalty-free MP3/WAV, or keep Voiceover-Only mode.
                        </p>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Instrumental Music Direction Prompt
                        </label>
                        <input
                          type="text"
                          value={musicPromptDraft}
                          onChange={(e) =>
                            setStudio((prev) => ({
                              ...prev,
                              musicPromptDraft: e.target.value,
                            }))
                          }
                          placeholder="e.g., Upbeat modern commercial instrumental track"
                          className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                        />
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleMusicAction('lyria')}
                          disabled={isProcessingMusic}
                          className="px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-semibold hover:opacity-90 disabled:opacity-60 inline-flex items-center gap-1.5 whitespace-nowrap"
                        >
                          <Music className="w-3.5 h-3.5" />
                          <span>
                            {isProcessingMusic ? 'Probing Lyria...' : 'Attempt Lyria Music Generation'}
                          </span>
                        </button>

                        <input
                          ref={musicFileInputRef}
                          type="file"
                          accept="audio/mpeg,audio/mp3,audio/wav"
                          onChange={handleUploadCustomMusic}
                          className="hidden"
                        />
                        <button
                          type="button"
                          onClick={() => musicFileInputRef.current?.click()}
                          className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
                        >
                          <Upload className="w-3.5 h-3.5" />
                          <span>Upload Custom MP3/WAV</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleMusicAction('placeholder')}
                          className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white whitespace-nowrap"
                        >
                          Skip Music (Voiceover Only)
                        </button>
                      </div>

                      {activeCampaign.backgroundMusic && (
                        <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 space-y-2 text-xs">
                          <div className="flex items-center justify-between font-semibold">
                            <span>
                              Music Status:{' '}
                              {activeCampaign.backgroundMusic.status === 'generated' &&
                                'AI Music Generated (Lyria)'}
                              {activeCampaign.backgroundMusic.status === 'custom_uploaded' &&
                                'Custom Audio Track Attached'}
                              {activeCampaign.backgroundMusic.status === 'unavailable_paid_tier' &&
                                'Not Generated (Paid Tier Required for Lyria)'}
                              {activeCampaign.backgroundMusic.status === 'not_requested' &&
                                'Optional Placeholder (Voiceover-Only Mode)'}
                            </span>
                          </div>
                          <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                            {activeCampaign.backgroundMusic.statusMessage}
                          </p>
                          {activeCampaign.backgroundMusic.audioFileUrl && (
                            <audio
                              controls
                              src={activeCampaign.backgroundMusic.audioFileUrl}
                              className="w-full h-9 mt-2"
                            />
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ===================================================================
              SECTION 4: SAVED CAMPAIGNS
             =================================================================== */}
          {activeSection === 'campaigns' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">
                    Server-Persisted Campaigns · /data/campaigns.json
                  </div>
                  <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
                    Saved Product & Storyboard Campaigns
                  </h1>
                </div>
                <button
                  type="button"
                  onClick={handleNewProductAnalysis}
                  className="px-4 py-2 rounded-lg bg-orange-600 text-white text-xs font-semibold hover:bg-orange-500 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New Blank Product Analysis</span>
                </button>
              </div>

              {isLoadingCampaigns ? (
                <div className="py-12 text-center text-sm text-slate-500">Loading saved campaigns...</div>
              ) : campaigns.length === 0 ? (
                <div className="p-12 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-center space-y-3">
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    No analyzed product campaigns saved yet.
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveSection('workspace')}
                    className="px-4 py-2 rounded-lg bg-orange-600 text-white text-xs font-semibold"
                  >
                    Go to Product Studio
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                  {campaigns.map((camp) => (
                    <div
                      key={camp.id}
                      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col justify-between gap-4"
                    >
                      <div className="space-y-3">
                        <div className="aspect-square max-h-44 w-full rounded-lg bg-slate-100 dark:bg-slate-950 overflow-hidden flex items-center justify-center border border-slate-200 dark:border-slate-800">
                          <img
                            src={camp.imageDataUrl}
                            alt={camp.title}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-contain"
                          />
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span>{camp.brandName}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">{camp.price}</span>
                          <span aria-hidden="true">·</span>
                          <span>{camp.status.replace('_', ' ')}</span>
                        </div>
                        <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                          {camp.title}
                        </h3>
                        <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed">
                          {camp.productProfile.productSummary}
                        </p>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          Storyboard: {camp.storyboard ? `${camp.storyboard.shots.length} shots` : 'None'} · Voiceover:{' '}
                          {camp.voiceover ? `${camp.voiceover.voiceName} (.wav)` : 'None'}
                        </div>
                      </div>

                      <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleOpenSavedCampaign(camp, 'workspace')}
                            className="px-2.5 py-1.5 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-semibold whitespace-nowrap"
                          >
                            Profile
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOpenSavedCampaign(camp, 'storyboard')}
                            className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold whitespace-nowrap"
                          >
                            Storyboard
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOpenSavedCampaign(camp, 'audio')}
                            className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold whitespace-nowrap"
                          >
                            Audio
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleDeleteCampaign(camp.id)}
                          className="p-1.5 text-slate-400 hover:text-red-600 transition-colors"
                          title="Delete campaign"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ===================================================================
              SECTION 5: GEMINI API STATUS & PHASED MILESTONE ROADMAP
             =================================================================== */}
          {activeSection === 'models' && (
            <div className="space-y-8">
              <div className="space-y-5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
                  <div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">
                      Server-Side SDK Probe · @google/genai · Zero Client Key Exposure
                    </div>
                    <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
                      Gemini Model Availability & Milestone Status
                    </h1>
                  </div>
                  <button
                    type="button"
                    onClick={runModelVerification}
                    disabled={isVerifyingModels}
                    className="px-4 py-2 rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-60 text-white text-xs font-semibold transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isVerifyingModels ? 'animate-spin' : ''}`} />
                    <span>{isVerifyingModels ? 'Probing Models...' : 'Re-Verify Models Now'}</span>
                  </button>
                </div>

                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-950/50">
                          <th className="py-3 px-4 font-medium">Model Identifier</th>
                          <th className="py-3 px-4 font-medium">Pipeline Role</th>
                          <th className="py-3 px-4 font-medium">Milestone</th>
                          <th className="py-3 px-4 font-medium">Live Key Status</th>
                          <th className="py-3 px-4 font-medium text-right">Latency</th>
                          <th className="py-3 px-4 font-medium">Supported Fallback / Explanation</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                        {modelReport?.models.map((entry) => (
                          <tr key={entry.modelId} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
                            <td className="py-3.5 px-4 font-mono font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                              {entry.modelId}
                            </td>
                            <td className="py-3.5 px-4 text-slate-700 dark:text-slate-300">
                              {entry.role}
                            </td>
                            <td className="py-3.5 px-4 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                              {entry.milestone}
                            </td>
                            <td className="py-3.5 px-4 whitespace-nowrap">
                              {entry.status === 'available' && (
                                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                                  Verified Available
                                </span>
                              )}
                              {entry.status === 'fallback_available' && (
                                <span className="font-semibold text-amber-600 dark:text-amber-400">
                                  Fallback Active
                                </span>
                              )}
                              {entry.status === 'paid_tier_required' && (
                                <span className="font-semibold text-amber-600 dark:text-amber-400">
                                  Paid Key / Alternative Ready
                                </span>
                              )}
                              {entry.status === 'unavailable' && (
                                <span className="font-semibold text-red-600 dark:text-red-400">
                                  Key Missing
                                </span>
                              )}
                            </td>
                            <td className="py-3.5 px-4 font-mono tabular-nums text-right text-slate-600 dark:text-slate-400 whitespace-nowrap">
                              {entry.latencyMs !== null ? `${entry.latencyMs} ms` : '—'}
                            </td>
                            <td className="py-3.5 px-4 text-slate-600 dark:text-slate-400 leading-relaxed">
                              <div>{entry.detailMessage}</div>
                              <div className="text-slate-500 mt-0.5">
                                Alternative: <span className="font-mono">{entry.supportedAlternative}</span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <h2 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100">
                  6-Milestone Delivery Gate
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {MILESTONE_ROADMAP.map((ms) => (
                    <div
                      key={ms.number}
                      className={`rounded-xl border p-5 space-y-3 ${
                        ms.active
                          ? 'border-orange-600 bg-white dark:bg-slate-900'
                          : 'border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/50 opacity-85'
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-mono font-semibold text-orange-600 dark:text-orange-400">
                          MILESTONE {ms.number}
                        </span>
                        <span className="text-slate-500 dark:text-slate-400">{ms.status}</span>
                      </div>
                      <h3 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
                        {ms.title}
                      </h3>
                      <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                        {ms.summary}
                      </p>
                      <ul className="pt-2 space-y-1 text-xs text-slate-700 dark:text-slate-300">
                        {ms.deliverables.map((d, i) => (
                          <li key={i}>· {d}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
