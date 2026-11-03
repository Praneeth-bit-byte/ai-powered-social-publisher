# AI Ad Studio — Repository Audit & Implementation Plan

AI Ad Studio is an end-to-end AI video marketing studio and social publisher that transforms product photography into vertical 9:16 video advertisements, validates platform-specific SEO captions against a strict 90/100 rubric, and publishes or schedules approved creatives to Instagram Reels, Instagram Stories, and YouTube Shorts.

---

## Repository Audit: What Exists vs. What Is Missing

> [!NOTE]
> **Current Repository Inspection Summary**
> - **What Exists Today**: Only `/README.md` (146 lines, 5,660 bytes) is present in the workspace. There is no `.git` history, no `package.json`, no frontend or backend source code, and no installed dependencies.
> - **What Is Working**: Product specification, target platforms, 10-step workflow, and Demo vs. Client-Ready milestone requirements are documented in `README.md`.
> - **What Is Missing**:
>   1. **Full-Stack Application Scaffold**: React + TypeScript + Tailwind CSS v4 frontend and an Express/Node.js backend running on port 3000.
>   2. **Multimodal Product Analysis Engine**: Image upload handling and server-side `@google/genai` integration to extract structured product JSON profiles (category, color palette, materials, dimensions, selling points, brand voice).
>   3. **9:16 Video Ad & Audio Pipeline**: Storyboard & cinematic prompt generation, `gemini-omni-1.1-flash` image-to-video generation (with multi-turn conversational editing via `previous_interaction_id`), `gemini-3.8-flash-lite-tts` voiceovers, `lyria-3-clip-preview` background music, and FFmpeg compositing (subtitles, overlays, logo watermark).
>   4. **Preview, Versioning & Human Approval Gate**: Interactive 9:16 player, version timeline, conversational revision loop, and mandatory human sign-off state before any post can be scheduled or published.
>   5. **Six-Point SEO Caption Rubric & Auto-Regeneration**: Platform-tailored metadata generator with a deterministic + AI rubric evaluator (scoring Product Accuracy, Hook Strength, Brand Voice, Keyword Relevance, Claim Safety, and CTA Clarity out of 100) that automatically regenerates captions scoring below 90/100.
>   6. **Persistence, OAuth Publishing & Analytics**: Firebase Auth + Firestore persistence, real Google OAuth for YouTube Shorts/Videos (`youtube.upload`, `yt-analytics.readonly`) and popup-based OAuth for Instagram Graph API (`instagram_basic`, `instagram_content_publish`, ` instagram_manage_insights`), smart scheduling recommendations, and Web Speech API + toast notifications.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> Please review these core architectural choices before we begin Milestone 1:

- **Incremental Milestone Delivery (Recommended Default)**: We will build and verify the application in **6 small, testable milestones** (detailed in Section 5) so each stage can be inspected and tested independently without mocked claims.
- **Dual-Engine 9:16 Video Pipeline**: Uses `gemini-omni-1.1-flash` via the Gemini Interactions API (`ai.interactions.create`) for native AI image-to-video generation and conversational video editing, paired with a real server-side **FFmpeg 9:16 compositor** that mixes `gemini-3.8-flash-lite-tts` voiceover WAVs, `lyria-3-clip-preview` music tracks, burned-in SRT subtitles, and brand watermarks (and can also render deterministic 9:16 Ken Burns motion-canvas video ads directly from the product image if a paid video API key is not yet attached).
- **Honest OAuth & Publishing Posture**: In accordance with your requirement never to fake integrations, social publishing connectors will implement real OAuth 2.0 flows (Google OAuth for YouTube Data API v3; popup OAuth for Instagram Graph API). When credentials or tokens are not yet connected by the user, the UI will explicitly show an **"Account Not Connected — Configure OAuth"** state and allow exporting the ready-to-publish `.mp4` + SEO package locally rather than faking a published post.

---

## 1. Overview & Core Concept

- **What It Does**: Guides a marketer or creator through a 10-step production pipeline: **Upload Product Photo → AI Vision Profile → Script & 9:16 Video Generation → Conversational Preview & Approval → ≥90/100 SEO Rubric Optimization → Smart Scheduling & Authorized Social Publishing**.
- **Target Audience / Persona**: D2C founders, small businesses, local sellers, and social media managers who need high-converting vertical video ads without complex NLE software.
- **Key Value**: Enforces brand accuracy, visual product fidelity, and caption quality ($\ge 90/100$ rubric threshold) while keeping a human strictly in the loop before publishing.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Campaign Workspace & Upload**: User drops a product image and enters optional title, price, and brand tone preferences (voice, target audience, visual aesthetic).
  2. **AI Product Intelligence**: Multimodal analysis extracts a structured JSON profile (materials, dominant hex swatches, key features, value hooks) that the user can inspect and refine.
  3. **Creative Studio & Video Generation**: Generates a shot-by-shot storyboard, brand-safe video prompt, voiceover script, and 9:16 vertical video with optional voiceover (`Kore`, `Puck`, `Zephyr`), background music, and burned-in captions.
  4. **Preview, Conversational Edit & Approval Gate**: A dedicated 9:16 studio monitor displays the rendered video alongside version history (`v1`, `v2`, …). Users can type conversational edit instructions (e.g., *"Make the hook punchier and switch to a warm voiceover"*) or click **Approve Creative for Publishing** (unlocking downstream steps).
  5. **SEO Rubric & Caption Lab**: Generates tailored metadata for Instagram Reels, Instagram Stories, and YouTube Shorts, displaying the 6-point rubric breakdown in `tabular-nums`. Any draft scoring $< 90/100$ triggers an automatic refinement pass with full diff transparency.
  6. **Scheduler, OAuth Publishing & Analytics**: Connects YouTube and Instagram accounts, recommends optimal posting windows (with audience-activity or new-account fallback logic), executes real API uploads for connected accounts, and tracks reach, plays, saves, shares, and retention.

- **Visual Identity & Theme**:
  - *Aesthetic Direction*: Precision Editorial Broadcast Studio — high-craft dark/light dual-theme workspace designed for video creators and performance marketers.
  - *Color Palette & Mood* (60-30-10 discipline):
    - **60% Dominant Canvas**: Crisp Alabaster (`#F8FAFC`) in Light Mode / Deep Obsidian Slate (`#0B0F17`) in Dark Mode.
    - **30% Structural Surfaces**: Pure White (`#FFFFFF`) / Elevated Charcoal (`#111827`) with `1px solid` hairline borders (`border-slate-200 dark:border-slate-800`) and single-elevation depth.
    - **10% Accent Budget**: Electric Vermilion (`#EA580C`) for primary studio actions and active pipeline stages, paired with semantic status indicators (`#16A34A` Approved/Verified, `#D97706` Rubric Refining/Pending Approval, `#DC2626` Validation/API Error) always accompanied by explicit text labels.
  - *Typography & Hierarchy* (2+1 Font Rule):
    - **Display / Headings**: `Plus Jakarta Sans` (SemiBold/Bold 600–700, `text-wrap: balance`).
    - **Body & Controls**: `DM Sans` (Regular 400 / Medium 500, 14px–16px).
    - **Metrics, Timestamps, Timecodes & Rubric Scores**: `JetBrains Mono` with `font-variant-numeric: tabular-nums`.
  - *Layout & Top Bar Contract*:
    - 1440px desktop baseline with a `260px` left workflow sidebar, a strict 3-zone top bar (`AI Ad Studio` wordmark — 4 single-line workflow nav links — 1 primary `+ New Campaign` CTA), and a split main viewport pairing the active stage controls on the left with the persistent 9:16 vertical studio monitor on the right.
    - Zero-pill discipline for static metadata (rendered as clean inline text separated by `·`).

- **Interactive Feedback & Motion**:
  - Real-time step progress indicators during multimodal analysis, TTS synthesis, and FFmpeg/video rendering.
  - Web Speech API (`window.speechSynthesis`) voice notification + non-intrusive toast when a video preview finishes rendering.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Server-Side Gemini SDK + FFmpeg Compositing Pipeline**
  - *Chosen Approach*: All `@google/genai` calls execute strictly on the Express backend (`/api/*`) using `process.env.GEMINI_API_KEY`. Video generation supports both `gemini-omni-1.1-flash` (`ai.interactions.create` with `aspect_ratio: '9:16'`) and a local FFmpeg 9:16 compositor that combines product imagery, dynamic motion/zoom filters, `gemini-3.8-flash-lite-tts` WAV voiceovers, and burned-in subtitles into standard `.mp4` files.
  - *Why*: Guarantees API key security, produces real downloadable/publishable 9:16 `.mp4` files with synchronized audio and captions, and ensures the pipeline is testable at every step.
- **Decision 2: Six-Point SEO Caption Rubric with Automatic Self-Correction Loop**
  - *Chosen Approach*: Captions are evaluated across 6 weighted dimensions totaling 100 points: Product Accuracy (20), Hook Strength (20), Brand Voice Alignment (15), Keyword & Search Relevance (15), Claim Safety/Compliance (15), and Platform Formatting & CTA (15). If the score is $< 90$, the server automatically feeds the rubric critique back to `gemini-3.8-flash` (up to 3 attempts) and records each attempt in the audit trail.
  - *Why*: Directly fulfills the README's $\ge 90/100$ quality gate with transparent, inspectable scoring rather than arbitrary numbers.
- **Decision 3: Layered Persistence (File-Backed Store → Firebase Firestore)**
  - *Chosen Approach*: Implement a clean repository interface backed by a persistent local JSON store in Milestones 1–4 so every feature works immediately out-of-the-box, then provision Firebase Authentication & Firestore (`firebase-blueprint.json` + hardened `firestore.rules`) in Milestone 5.
  - *Why*: Keeps early milestones fast and independently testable while delivering full multi-user cloud persistence and security rules for the Client-Ready release.

---

## 4. Technical Architecture & Data Strategy

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        AI AD STUDIO — CLIENT (React 19)                      │
│  ┌────────────────────┐  ┌─────────────────────────┐  ┌───────────────────┐  │
│  │ 1. Product & Brand │  │ 2. Script, Storyboard & │  │ 3. 9:16 Preview & │  │
│  │    Intake Studio   │→ │    Video Generator      │→ │    Approval Gate  │  │
│  └────────────────────┘  └─────────────────────────┘  └─────────┬─────────┘  │
│                                                                 ↓            │
│  ┌────────────────────┐  ┌─────────────────────────┐  ┌───────────────────┐  │
│  │ 6. Performance     │← │ 5. Smart Scheduler &    │← │ 4. 90/100 SEO     │  │
│  │    Analytics       │  │    OAuth Publisher      │  │    Rubric Engine  │  │
│  └────────────────────┘  └─────────────────────────┘  └───────────────────┘  │
└───────────────┬───────────────────────┬─────────────────────────┬────────────┘
                │ REST / SSE (/api/*)   │ Firestore SDK           │ OAuth Popup
                ↓                       ↓                         ↓
┌──────────────────────────────────────────────────────────────────────────────┐
│                     EXPRESS BACKEND & AI PIPELINE (Port 3000)                │
│  ┌──────────────────────────┐  ┌──────────────────────┐  ┌────────────────┐  │
│  │ @google/genai Service    │  │ Media & FFmpeg       │  │ Social Publish │  │
│  │ • gemini-3.8-flash       │  │ Compositor           │  │ Connectors     │  │
│  │   (Vision, Storyboard,   │  │ • 9:16 MP4 Assembly  │  │ • YouTube Data │  │
│  │    6-Pt SEO Rubric)      │  │ • WAV Voiceover Mix  │  │   API v3       │  │
│  │ • gemini-omni-1.1-flash  │  │ • Subtitle & Logo    │  │ • Instagram    │  │
│  │   (9:16 Video & Edits)   │  │   Overlay Burn-In    │  │   Graph API    │  │
│  │ • gemini-3.8-flash-lite  │  └──────────────────────┘  └────────────────┘  │
│  │   -tts & lyria-3-clip    │                                                │
│  └──────────────────────────┘                                                │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Core Data Entities
- **`Campaign`**: `id`, `ownerId`, `title`, `price`, `brandName`, `brandVoice`, `targetAudience`, `visualStyle`, `productImageUrl`, `productProfile` (structured JSON), `status` (`draft` | `analyzed` | `video_ready` | `approved` | `seo_ready` | `scheduled` | `published`), `createdAt`, `updatedAt`.
- **`VideoVersion`**: `id`, `campaignId`, `versionNumber`, `interactionId` (for `gemini-omni-1.1-flash` multi-turn edits), `prompt`, `script`, `storyboard` (shots array), `voiceName`, `videoUrl`, `audioUrl`, `musicUrl`, `editInstruction`, `approvalStatus` (`pending` | `approved` | `rejected`), `approvedAt`.
- **`SeoPackage`**: `id`, `campaignId`, `videoVersionId`, `platform` (`instagram_reels` | `instagram_stories` | `youtube_shorts` | `youtube_video`), `title`, `caption`, `description`, `hashtags`, `keywords`, `rubricScore` (total + 6 sub-scores), `generationAttempts` (history of auto-regenerations), `validatedAt`.
- **`PublishSchedule`**: `id`, `campaignId`, `videoVersionId`, `seoPackageId`, `platform`, `scheduledFor`, `recommendationReason`, `status` (`scheduled` | `publishing` | `published` | `failed`), `externalPostId`, `externalUrl`, `metrics` (`reach`, `plays`, `saves`, `shares`, `retentionPct`).

---

## 5. Phased Implementation Milestones

Each milestone is small, self-contained, and verifiable before moving to the next:

### Milestone 1: Project Scaffold, Studio Layout & Multimodal Product Analysis
- **Scope**:
  - Initialize the React + TypeScript + Tailwind CSS v4 + Express (`server.ts`) full-stack project on port 3000 without modifying `README.md`.
  - Build the **Step 1: Product & Brand Intake Studio** UI with drag-and-drop image upload, product metadata inputs (title, price, brand voice, target audience, visual style), and sample D2C product presets for quick testing.
  - Implement `POST /api/campaigns/analyze` using `gemini-3.8-flash` with a strict `responseSchema` (`Type.OBJECT`) to analyze the uploaded product image and extract category, color palette hex codes, materials, dimensions, key features, and selling points.
- **Testable Deliverable**: Upload any product photo, run real Gemini multimodal analysis, and inspect/edit the resulting structured JSON Product Profile in the UI.

### Milestone 2: AI Script, Shot-by-Shot Storyboard & Voiceover/Music Synthesis
- **Scope**:
  - Implement `POST /api/campaigns/:id/storyboard` using `gemini-3.8-flash` to generate a brand-safe cinematic video prompt, a high-converting 15–30s hook & voiceover script, and a shot-by-shot 9:16 storyboard that preserves product appearance.
  - Implement `POST /api/campaigns/:id/audio` using `gemini-3.8-flash-lite-tts` (`Puck`, `Kore`, `Charon`, `Fenrir`, `Zephyr`) to synthesize a real 24kHz `.wav` voiceover and optional `lyria-3-clip-preview` background music track.
- **Testable Deliverable**: Generate and edit the script/storyboard for an analyzed product and listen to the synthesized AI voiceover and music directly in the studio.

### Milestone 3: 9:16 Video Ad Generation, Conversational Editing & Human Approval Gate
- **Scope**:
  - Implement `POST /api/campaigns/:id/video` supporting both `gemini-omni-1.1-flash` (`ai.interactions.create` image-to-video with `aspect_ratio: '9:16'`, `store: true`, and paid-key prompt flow when selected) and a real server-side **FFmpeg 9:16 video compositor** that renders a vertical `.mp4` combining the product visual, synchronized voiceover audio, subtitles/text overlays, and brand logo.
  - Build the **Preview & Human Approval** interface featuring a 9:16 studio video player, version history selector (`v1`, `v2`, …), conversational revision input (chaining edits via `previous_interaction_id` and re-compositing), Web Speech API voice alert when rendering completes, and an explicit **Approve Version** lock gate.
- **Testable Deliverable**: Render a playable 9:16 `.mp4` advertisement with audio and subtitles, request a conversational edit to produce `v2`, and explicitly approve a version to unlock SEO & publishing.

### Milestone 4: Six-Point SEO Caption Rubric & Auto-Regeneration ($\ge 90/100$)
- **Scope**:
  - Implement `POST /api/campaigns/:id/seo` using `gemini-3.8-flash` to generate platform-specific titles, captions, descriptions, keywords, and hashtags for **Instagram Reels**, **Instagram Stories**, **YouTube Shorts**, and **Standard YouTube Videos**.
  - Implement the **Six-Point Quality Rubric Evaluator** (Product Accuracy, Hook Strength, Brand Voice, Keyword Relevance, Claim Validation, CTA/Formatting). Automatically loop and regenerate any caption scoring below `90/100` (up to 3 iterations), displaying both the final breakdown and the regeneration history in the UI.
- **Testable Deliverable**: Generate platform captions for an approved video, inspect the 6-point score breakdown (`tabular-nums`), and verify automatic regeneration when a strict rubric threshold is triggered.

### Milestone 5: Firebase Persistence & Hardened Security Rules
- **Scope**:
  - Provision Firebase Authentication (Google Sign-In) and Cloud Firestore via the `firebase-integration-rpc` workflow (`firebase-blueprint.json`, `firestore.rules`, and `handleFirestoreError`).
  - Sync campaigns, video versions, approval history, and SEO packages to Firestore isolated per authenticated user.
- **Testable Deliverable**: Sign in with Google, persist campaigns and approval history across browser refreshes, and verify zero-trust Firestore rules.

### Milestone 6: Authorized Social Publishing (YouTube & Instagram OAuth), Smart Scheduler & Analytics
- **Scope**:
  - Configure Google OAuth (`youtube.upload`, `youtube.readonly`) and Instagram Graph API popup OAuth (`/api/auth/instagram/url` & `/auth/instagram/callback`).
  - Implement the **Smart Scheduler** (calculating optimal posting slots from connected channel activity or providing research-backed fallback windows for new accounts) and enforce the server-side check that blocks publishing unless `approvalStatus === 'approved'`.
  - Build the **Publishing & Analytics Dashboard** displaying real connection states, scheduled queue, live YouTube/Instagram upload execution when authorized, downloadable `.mp4` + SEO bundle export, and performance metrics (reach, plays, saves, shares, retention).
- **Testable Deliverable**: Schedule an approved campaign, verify that unapproved campaigns cannot be published, test OAuth connection/publishing flows, and inspect campaign status and analytics.
