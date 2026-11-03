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
} from 'lucide-react';
import type {
  Campaign,
  ProductProfile,
  ModelVerificationReport,
} from './types.ts';
import { SAMPLE_PRODUCT_PRESETS, type SampleProductPreset } from './utils/sampleProducts.ts';

type ActiveSection = 'workspace' | 'campaigns' | 'models' | 'roadmap';
type ProfileTab = 'visual' | 'json';

const BRAND_VOICE_OPTIONS = [
  'Luxury & Editorial',
  'Bold & Direct-Response',
  'Warm & Founder-Led',
  'Technical & Performance',
  'Playful & Trend-Native',
];

const MILESTONE_ROADMAP = [
  {
    number: '01',
    title: 'Project Scaffold, Studio Layout & Multimodal Product Analysis',
    status: 'Active · Ready for Testing',
    active: true,
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
    status: 'Awaiting Milestone 1 Approval',
    active: false,
    summary:
      'Generate brand-safe cinematic 9:16 video prompts, 15–30s scripts with hooks, shot-by-shot storyboards, and 24kHz WAV voiceovers using gemini-3.8-flash-lite-tts.',
    deliverables: [
      'Shot-by-shot 9:16 storyboard generator preserving product geometry',
      'Multi-voice AI voiceover synthesis (Kore, Puck, Charon, Fenrir, Zephyr)',
      'Background music generation and audio preview deck',
    ],
  },
  {
    number: '03',
    title: '9:16 Video Ad Generation, Conversational Editing & Approval Gate',
    status: 'Awaiting Milestone 1 Approval',
    active: false,
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
    status: 'Awaiting Milestone 1 Approval',
    active: false,
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
    status: 'Awaiting Milestone 1 Approval',
    active: false,
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
    status: 'Awaiting Milestone 1 Approval',
    active: false,
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

  // Form state for Step 1: Product & Brand Intake
  const [title, setTitle] = useState<string>('');
  const [price, setPrice] = useState<string>('');
  const [brandName, setBrandName] = useState<string>('');
  const [brandVoice, setBrandVoice] = useState<string>(BRAND_VOICE_OPTIONS[0]);
  const [targetAudience, setTargetAudience] = useState<string>('');
  const [visualStyle, setVisualStyle] = useState<string>('');
  const [imageDataUrl, setImageDataUrl] = useState<string>('');
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');

  // Campaigns & active campaign state
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [activeCampaign, setActiveCampaign] = useState<Campaign | null>(null);
  const [isLoadingCampaigns, setIsLoadingCampaigns] = useState<boolean>(true);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [isSavingProfile, setIsSavingProfile] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Editable profile & JSON editor state
  const [editableProfile, setEditableProfile] = useState<ProductProfile | null>(null);
  const [rawJsonText, setRawJsonText] = useState<string>('');
  const [jsonParseError, setJsonParseError] = useState<string | null>(null);
  const [copiedJson, setCopiedJson] = useState<boolean>(false);

  // Live Gemini Model Readiness Verification state
  const [modelReport, setModelReport] = useState<ModelVerificationReport | null>(null);
  const [isVerifyingModels, setIsVerifyingModels] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [darkMode]);

  useEffect(() => {
    // Load initial preset into intake form for immediate zero-friction testing
    const defaultPreset = SAMPLE_PRODUCT_PRESETS[0];
    if (defaultPreset) {
      applyPresetToForm(defaultPreset);
    }
    fetchCampaigns();
    runModelVerification();
  }, []);

  useEffect(() => {
    if (activeCampaign) {
      setEditableProfile(structuredClone(activeCampaign.productProfile));
      setRawJsonText(JSON.stringify(activeCampaign.productProfile, null, 2));
      setJsonParseError(null);
    } else {
      setEditableProfile(null);
      setRawJsonText('');
    }
  }, [activeCampaign]);

  const applyPresetToForm = (preset: SampleProductPreset) => {
    const dataUrl = preset.renderCanvasImage();
    setSelectedPresetId(preset.id);
    setTitle(preset.title);
    setPrice(preset.price);
    setBrandName(preset.brandName);
    setBrandVoice(preset.brandVoice);
    setTargetAudience(preset.targetAudience);
    setVisualStyle(preset.visualStyle);
    setImageDataUrl(dataUrl);
    setErrorBanner(null);
  };

  const fetchCampaigns = async () => {
    setIsLoadingCampaigns(true);
    try {
      const res = await fetch('/api/campaigns');
      if (!res.ok) throw new Error('Failed to load saved campaigns.');
      const data = await res.json();
      const list: Campaign[] = Array.isArray(data.campaigns) ? data.campaigns : [];
      setCampaigns(list);
      if (list.length > 0 && !activeCampaign) {
        setActiveCampaign(list[0]);
      }
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
    setErrorBanner(null);
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!validTypes.includes(file.type.toLowerCase())) {
      setErrorBanner('Unsupported file format. Please upload a PNG, JPEG, or WEBP product photo.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setErrorBanner('Image file exceeds 10 MB limit. Please choose a smaller product image.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setImageDataUrl(reader.result);
        setSelectedPresetId('custom-upload');
        if (!title) {
          const cleanName = file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
          setTitle(cleanName);
        }
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

  const handleAnalyzeProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!imageDataUrl) {
      setErrorBanner('Please upload a product image or select a sample studio product first.');
      return;
    }

    setIsAnalyzing(true);
    setErrorBanner(null);
    setStatusMessage(null);

    try {
      const res = await fetch('/api/campaigns/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          price,
          brandName,
          brandVoice,
          targetAudience,
          visualStyle,
          imageDataUrl,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Product analysis failed.');
      }

      const created: Campaign = data.campaign;
      setCampaigns((prev) => [created, ...prev]);
      setActiveCampaign(created);
      setActiveSection('workspace');
      setStatusMessage(
        `Multimodal analysis complete in ${created.analysisMetadata.latencyMs} ms using ${created.analysisMetadata.resolvedModel}.`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to analyze product.';
      setErrorBanner(msg);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleSaveProfileChanges = async () => {
    if (!activeCampaign || !editableProfile) return;

    let profileToSave = editableProfile;
    if (profileTab === 'json') {
      try {
        profileToSave = JSON.parse(rawJsonText) as ProductProfile;
        setJsonParseError(null);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid JSON syntax';
        setJsonParseError(`Cannot save invalid JSON: ${msg}`);
        return;
      }
    }

    setIsSavingProfile(true);
    setErrorBanner(null);
    setStatusMessage(null);

    try {
      const res = await fetch(`/api/campaigns/${activeCampaign.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: activeCampaign.title,
          price: activeCampaign.price,
          brandName: activeCampaign.brandName,
          brandVoice: activeCampaign.brandVoice,
          targetAudience: activeCampaign.targetAudience,
          visualStyle: activeCampaign.visualStyle,
          productProfile: profileToSave,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save changes.');

      const updated: Campaign = data.campaign;
      setActiveCampaign(updated);
      setCampaigns((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setStatusMessage('Product profile and brand specifications saved to server.');
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to save profile.');
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleDeleteCampaign = async (id: string) => {
    try {
      const res = await fetch(`/api/campaigns/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete campaign.');
      const remaining = campaigns.filter((c) => c.id !== id);
      setCampaigns(remaining);
      if (activeCampaign?.id === id) {
        setActiveCampaign(remaining[0] ?? null);
      }
      setStatusMessage('Campaign removed.');
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : 'Could not delete campaign.');
    }
  };

  const handleCopyJson = async () => {
    if (!editableProfile) return;
    const text = profileTab === 'json' ? rawJsonText : JSON.stringify(editableProfile, null, 2);
    await navigator.clipboard.writeText(text);
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 1800);
  };

  const handleDownloadJson = () => {
    if (!activeCampaign || !editableProfile) return;
    const payload = {
      campaignId: activeCampaign.id,
      title: activeCampaign.title,
      brandName: activeCampaign.brandName,
      price: activeCampaign.price,
      brandVoice: activeCampaign.brandVoice,
      analysisMetadata: activeCampaign.analysisMetadata,
      productProfile: editableProfile,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeCampaign.id}-product-profile.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startFreshCampaign = () => {
    setActiveSection('workspace');
    applyPresetToForm(SAMPLE_PRODUCT_PRESETS[0]);
    setStatusMessage('Loaded fresh campaign intake form.');
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 sticky top-0 z-30">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#workspace"
          onClick={(e) => {
            e.preventDefault();
            setActiveSection('workspace');
          }}
          className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0"
        >
          AI Ad Studio
        </a>

        {/* Zone 2: 4 concise single-line navigation links */}
        <nav className="flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-400 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveSection('workspace')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'workspace'
                ? 'border-orange-600 text-slate-900 dark:text-white'
                : 'border-transparent hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            Product Studio
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('campaigns')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'campaigns'
                ? 'border-orange-600 text-slate-900 dark:text-white'
                : 'border-transparent hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            Saved Profiles ({campaigns.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('models')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'models'
                ? 'border-orange-600 text-slate-900 dark:text-white'
                : 'border-transparent hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            Gemini API Status
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('roadmap')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeSection === 'roadmap'
                ? 'border-orange-600 text-slate-900 dark:text-white'
                : 'border-transparent hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            Milestones
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={startFreshCampaign}
            className="px-4 py-2 text-xs font-semibold text-white bg-orange-600 rounded-lg hover:bg-orange-500 transition-colors whitespace-nowrap shrink-0"
          >
            New Product Analysis
          </button>
        </div>
      </header>

      {/* Main Studio Shell: Left Workflow Sidebar + Content Viewport */}
      <div className="flex-1 flex flex-col lg:flex-row max-w-[1440px] w-full mx-auto">
        {/* Left Pipeline Stage Sidebar (260px on desktop) */}
        <aside className="w-full lg:w-[265px] shrink-0 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/50 p-5 flex flex-col justify-between gap-6">
          <div className="space-y-6">
            <div>
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
                <span>Production Pipeline</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">Milestone 1 of 6</span>
              </div>
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                10-Step Workflow Gate
              </h2>
            </div>

            <ol className="space-y-2.5 text-xs">
              <li className="p-3 rounded-lg bg-orange-600/10 border border-orange-600/30 text-slate-900 dark:text-slate-100">
                <div className="flex items-center justify-between font-semibold">
                  <span>01. Product & Brand Intake</span>
                  <span className="font-mono text-[11px] text-orange-600 dark:text-orange-400">ACTIVE</span>
                </div>
                <p className="text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">
                  Multimodal Gemini image analysis & structured JSON profile extraction.
                </p>
              </li>

              {[
                { step: '02. Script & Storyboard', milestone: 'M2' },
                { step: '03. Voiceover & Music TTS', milestone: 'M2' },
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
            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-700 dark:text-slate-300">Server Gemini Key</span>
                <span className="font-mono tabular-nums text-xs text-slate-600 dark:text-slate-400">
                  {modelReport?.apiKeyConfigured ? 'Configured' : 'Checking...'}
                </span>
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                Active Vision Model:{' '}
                <span className="font-mono text-slate-800 dark:text-slate-200">
                  {modelReport?.recommendedVisionModel || 'gemini-3.8-flash'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveSection('models')}
                className="text-xs font-medium text-orange-600 dark:text-orange-400 hover:underline inline-flex items-center gap-1"
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
          {/* Status & Error Banners */}
          {errorBanner && (
            <div
              role="alert"
              className="p-4 rounded-lg border border-red-300 dark:border-red-900/70 bg-red-50/90 dark:bg-red-950/40 text-red-900 dark:text-red-200 flex items-start justify-between gap-4 text-sm"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Analysis / Validation Error: </span>
                  <span>{errorBanner}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setErrorBanner(null)}
                className="text-xs font-medium underline shrink-0"
              >
                Dismiss
              </button>
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
                onClick={() => setStatusMessage(null)}
                className="text-xs font-medium underline shrink-0"
              >
                Close
              </button>
            </div>
          )}

          {/* SECTION 1: PRODUCT & BRAND INTAKE STUDIO */}
          {activeSection === 'workspace' && (
            <div className="space-y-8">
              {/* Studio Header */}
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-5 border-b border-slate-200 dark:border-slate-800">
                <div>
                  <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1.5">
                    <span>Milestone 1</span>
                    <span aria-hidden="true">·</span>
                    <span>Product Analysis & Brand Understanding</span>
                    <span aria-hidden="true">·</span>
                    <span>Server-Side Gemini Multimodal Vision</span>
                  </div>
                  <h1 className="font-display text-2xl lg:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                    Product Intelligence & Brand Profile Studio
                  </h1>
                </div>

                {/* Preset Selector Bar */}
                <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-200/70 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800">
                  <span className="px-2.5 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    Quick Test Presets:
                  </span>
                  {SAMPLE_PRODUCT_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => applyPresetToForm(preset)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        selectedPresetId === preset.id
                          ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      {preset.brandName}
                    </button>
                  ))}
                </div>
              </div>

              {/* 2-Column Split: Left Intake Form (5 cols) | Right Structured Profile Inspector (7 cols) */}
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

                  {/* Image Dropzone & Preview */}
                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleDrop}
                    className="border border-dashed border-slate-300 dark:border-slate-700 rounded-lg p-4 bg-slate-50/60 dark:bg-slate-950/50 space-y-3"
                  >
                    {imageDataUrl ? (
                      <div className="relative aspect-square max-h-[280px] mx-auto overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900 flex items-center justify-center">
                        <img
                          src={imageDataUrl}
                          alt={title || 'Uploaded product preview'}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-contain"
                        />
                      </div>
                    ) : (
                      <div className="py-12 text-center space-y-2">
                        <ImageIcon className="w-8 h-8 mx-auto text-slate-400" />
                        <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                          Drag and drop your product image here
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
                        className="flex-1 py-2 px-4 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        <span>Upload Custom Product Image</span>
                      </button>
                    </div>
                  </div>

                  {/* Product Metadata Fields */}
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Product Title <span className="text-slate-400">(optional — AI will refine)</span>
                      </label>
                      <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="e.g., Veloce Barista Pro Espresso Machine"
                        className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-600"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Price / Offer
                        </label>
                        <input
                          type="text"
                          value={price}
                          onChange={(e) => setPrice(e.target.value)}
                          placeholder="e.g., $849.00 or 20% Off"
                          className="w-full px-3.5 py-2 text-sm font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-600"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Brand Name
                        </label>
                        <input
                          type="text"
                          value={brandName}
                          onChange={(e) => setBrandName(e.target.value)}
                          placeholder="e.g., Veloce Milano"
                          className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-600"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Brand Voice Direction
                      </label>
                      <select
                        value={brandVoice}
                        onChange={(e) => setBrandVoice(e.target.value)}
                        className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-600"
                      >
                        {BRAND_VOICE_OPTIONS.map((voice) => (
                          <option key={voice} value={voice}>
                            {voice}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Target Audience Persona
                      </label>
                      <input
                        type="text"
                        value={targetAudience}
                        onChange={(e) => setTargetAudience(e.target.value)}
                        placeholder="Who is the primary buyer for this video ad?"
                        className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-600"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Visual Lighting & Camera Preferences
                      </label>
                      <textarea
                        rows={2}
                        value={visualStyle}
                        onChange={(e) => setVisualStyle(e.target.value)}
                        placeholder="Describe desired lighting, mood, and camera movement..."
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
                        <span>Analyze Product & Generate Structured Profile</span>
                      </>
                    )}
                  </button>
                </form>

                {/* Right Column: Structured Product Profile Inspector & Editor */}
                <div className="xl:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-6">
                  {!activeCampaign || !editableProfile ? (
                    <div className="py-20 text-center space-y-3">
                      <Layers className="w-10 h-10 mx-auto text-slate-400" />
                      <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
                        No Product Profile Analyzed Yet
                      </h3>
                      <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                        Select one of the studio product presets or upload your own product image on the left, then click{' '}
                        <span className="font-medium text-slate-800 dark:text-slate-200">
                          Analyze Product & Generate Structured Profile
                        </span>{' '}
                        to run real Gemini multimodal analysis.
                      </p>
                    </div>
                  ) : (
                    <>
                      {/* Profile Header & Mode Switcher */}
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
                          </div>
                          <h2 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100 mt-1">
                            {editableProfile.detectedProductName}
                          </h2>
                        </div>

                        {/* Interactive Segmented Tab Control */}
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
                              setRawJsonText(JSON.stringify(editableProfile, null, 2));
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

                      {activeCampaign.analysisMetadata.fallbackUsed &&
                        activeCampaign.analysisMetadata.fallbackReason && (
                          <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/70 text-xs text-amber-900 dark:text-amber-200">
                            <span className="font-semibold">Model Availability Note: </span>
                            {activeCampaign.analysisMetadata.fallbackReason}
                          </div>
                        )}

                      {/* TAB A: VISUAL STRUCTURED INSPECTOR */}
                      {profileTab === 'visual' ? (
                        <div className="space-y-6">
                          {/* Category, Dimensions & Positioning Summary */}
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
                                    setEditableProfile({ ...editableProfile, category: e.target.value })
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
                                    setEditableProfile({ ...editableProfile, subcategory: e.target.value })
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
                                    setEditableProfile({
                                      ...editableProfile,
                                      estimatedDimensions: e.target.value,
                                    })
                                  }
                                  className="w-full px-3 py-1.5 text-xs font-mono tabular-nums rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
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
                                  setEditableProfile({ ...editableProfile, productSummary: e.target.value })
                                }
                                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 leading-relaxed"
                              />
                            </div>
                          </div>

                          {/* Dominant Color Swatches */}
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

                          {/* Materials & Physical Features */}
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

                          {/* Key Selling Points for Short-Form Video */}
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

                          {/* Recommended 9:16 Platform Ad Angles */}
                          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
                            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                              Recommended 9:16 Ad Angles (Reels · Stories · Shorts)
                            </h3>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              {editableProfile.recommendedAdAngles.map((angle, idx) => (
                                <div
                                  key={idx}
                                  className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 space-y-1.5"
                                >
                                  <div className="text-[11px] font-mono text-orange-600 dark:text-orange-400">
                                    {angle.targetPlatform}
                                  </div>
                                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                                    {angle.angleName}
                                  </div>
                                  <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                                    <strong className="text-slate-700 dark:text-slate-300">3s Hook:</strong>{' '}
                                    {angle.hookIdea}
                                  </p>
                                  <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                                    {angle.visualDirection}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Visual Fidelity Constraints */}
                          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2">
                            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                              Visual Fidelity & Anti-Distortion Guardrails
                            </h3>
                            <div className="text-xs text-slate-600 dark:text-slate-400 space-y-1">
                              {editableProfile.visualFidelityConstraints.map((rule, idx) => (
                                <div key={idx}>
                                  · {rule}
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      ) : (
                        /* TAB B: RAW JSON PROFILE EDITOR */
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
                            rows={22}
                            value={rawJsonText}
                            onChange={(e) => {
                              setRawJsonText(e.target.value);
                              try {
                                const parsed = JSON.parse(e.target.value) as ProductProfile;
                                setEditableProfile(parsed);
                                setJsonParseError(null);
                              } catch (err: unknown) {
                                setJsonParseError(err instanceof Error ? err.message : 'Invalid JSON');
                              }
                            }}
                            className="w-full p-4 font-mono text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-950 text-emerald-300 focus:outline-none focus:ring-2 focus:ring-orange-600 leading-relaxed"
                          />
                        </div>
                      )}

                      {/* Action Footer */}
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
                            <span>Export Profile (.json)</span>
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={handleSaveProfileChanges}
                          disabled={isSavingProfile}
                          className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-semibold hover:opacity-90 transition-opacity inline-flex items-center gap-1.5 whitespace-nowrap"
                        >
                          <Save className="w-3.5 h-3.5" />
                          <span>{isSavingProfile ? 'Saving...' : 'Save Profile Changes'}</span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* SECTION 2: SAVED PRODUCT PROFILES */}
          {activeSection === 'campaigns' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">
                    Server-Persisted Product Profiles · /data/campaigns.json
                  </div>
                  <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
                    Saved Product Intelligence Profiles
                  </h1>
                </div>
                <button
                  type="button"
                  onClick={startFreshCampaign}
                  className="px-4 py-2 rounded-lg bg-orange-600 text-white text-xs font-semibold hover:bg-orange-500 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Analyze Another Product</span>
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
                        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span>{camp.brandName}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">{camp.price}</span>
                          <span aria-hidden="true">·</span>
                          <span>{camp.productProfile.category}</span>
                        </div>
                        <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                          {camp.title}
                        </h3>
                        <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-3 leading-relaxed">
                          {camp.productProfile.productSummary}
                        </p>
                      </div>

                      <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setActiveCampaign(camp);
                            setActiveSection('workspace');
                          }}
                          className="px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-semibold whitespace-nowrap"
                        >
                          Open in Inspector
                        </button>
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

          {/* SECTION 3: LIVE GEMINI API & MODEL AVAILABILITY VERIFICATION */}
          {activeSection === 'models' && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">
                    Server-Side SDK Probe · @google/genai · Zero Client Key Exposure
                  </div>
                  <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
                    Gemini Model Availability & Fallback Verification
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
                                Paid Key / Compositor Fallback
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
          )}

          {/* SECTION 4: PHASED MILESTONE ROADMAP */}
          {activeSection === 'roadmap' && (
            <div className="space-y-6">
              <div className="pb-4 border-b border-slate-200 dark:border-slate-800">
                <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">
                  Incremental Delivery Plan · Honest Integration Gate
                </div>
                <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
                  AI Ad Studio — 6-Milestone Implementation Status
                </h1>
              </div>

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
          )}
        </main>
      </div>
    </div>
  );
}
