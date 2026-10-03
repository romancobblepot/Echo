@AGENTS.md

# Email Reply Agent — CLAUDE.md

## Project Overview

An AI-powered Gmail reply assistant. The owner uploads their own documents/folders as a knowledge base, which gets converted into a vector database in Supabase. When an email arrives, the agent retrieves relevant context via Hybrid RAG, drafts a reply using the owner's chosen LLM provider (Groq / OpenAI / Gemini) following user-defined writing rules, and lets the owner review, edit, and send with one click. All interactions are logged in Supabase for quality tracking.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (deployed on Vercel) |
| Backend / API routes | Next.js API routes on Vercel; heavier jobs on Railway if needed |
| LLM inference | Multi-provider: Groq / OpenAI / Gemini — user supplies their own key per provider, validated + encrypted at rest, model list fetched live |
| Email | Gmail API (OAuth 2.0) |
| Database | Supabase (PostgreSQL + pgvector) |
| File storage | Supabase Storage |
| Auth | Supabase Auth with Google OAuth |
| Vector embeddings | HuggingFace `all-mpnet-base-v2` (768 dim) |
| Reranker | HuggingFace `cross-encoder/ms-marco-MiniLM-L-6-v2` |

---

## Knowledge Base — User-Managed File Uploads

The knowledge base is entirely driven by files the user uploads. No hardcoded dataset.

### Supported File Types
PDF, DOCX/DOC, JSON, TXT, HTML, MD

### Upload Behaviour
- User can upload **individual files** or **entire folders**, via three paths:
  1. **Drag-and-drop** — supports multiple files/folders and mixed selections in one drop (paginated `readEntries` so folders >100 entries aren't truncated).
  2. **"or choose a folder" button** — uses the **File System Access API** (`showDirectoryPicker()`) on supporting browsers (Chrome/Edge) for a real "select this folder" dialog with no navigate-vs-select ambiguity. Falls back to a `webkitdirectory` file input on browsers without that API (Safari/Firefox), with a platform-aware tooltip hint (ⓘ) since macOS's native folder dialog has a known UX quirk there.
  3. Regular multi-file picker (click the drop zone).
- Files with unsupported extensions are silently filtered client-side; if a selection/drop/folder yields **zero** supported files, a dismissible amber banner explains why (previously failed silently with no feedback).
- Uploaded files are stored in **Supabase Storage** (`knowledge-base` bucket).
- On upload, a **SSE progress bar** streams status back to the UI: uploading → parsing → chunking → embedding batch N/M → done.
- Each file is parsed → **recursively chunked** (max 256 chars, 64-char overlap) → batch-embedded → upserted into `doc_chunks`.
- PDF parsing (`pdf-parse`/`pdfjs-dist`) requires `serverExternalPackages` in `next.config.ts` — otherwise Next.js tries to bundle the PDF worker for the browser and crashes at parse time.

### File Management UI
- Always-visible file panel on the left of the dashboard.
- Folders are expandable to browse contents.
- Hover any file to reveal a remove button (with confirmation).
- On removal: file deleted from Storage + `uploaded_files`; `doc_chunks` cascade-deleted automatically.

### Per-Thread Context Scoping
- When a thread is open, each file/folder in the left panel gets a **checkbox** (all checked by default).
- User unchecks files/folders to narrow RAG retrieval scope for that specific draft only.
- Selection is **ephemeral** — resets to all-checked when switching threads.
- A counter at the bottom of the panel shows e.g. `Context: 3/5 files selected`.
- When no thread is open, checkboxes are hidden — panel behaves as normal.
- The `hybrid_search` query adds `WHERE file_id = ANY(selected_file_ids)` when a subset is chosen.

### Hybrid RAG Pipeline

**At upload:** recursive chunking with rich metadata (`file_name`, `file_type`, `source_file_id`, `chunk_index`).

**At retrieval:**
1. Embed the incoming email via HF `all-mpnet-base-v2`
2. Run in parallel:
   - **Semantic search** — HNSW cosine similarity (`pgvector`) → top 5
   - **Keyword search** — PostgreSQL full-text search (GIN index on `chunk_tsv`) → top 5
3. Merge & deduplicate candidates
4. **Cross-encoder rerank** (`ms-marco-MiniLM-L-6-v2`) → score all candidates
5. Take **top 3** as final context, labelled with source filename

**Resilience:** RAG is an enhancement, not a hard dependency — embedding/reranker calls are wrapped so a HF outage degrades to "draft without context" (or semantic-only ranking if just the reranker fails) instead of crashing the draft request. HF's Inference API endpoint is `router.huggingface.co/hf-inference/models/...` (the older `api-inference.huggingface.co` host was retired).

---

## Core Features

### 1. Gmail Integration
- Gmail API with OAuth 2.0 — **Primary inbox only**.
- Inbox list (left panel) with unread count badge.
- **Pagination:** Gmail's API is cursor-based (no random-access/offset pages), so the inbox is paged 25 at a time with Previous/Next controls. Each fetched page is cached client-side by index so "Previous" never re-fetches — only advancing into unvisited pages hits the API. Refresh resets to page 1 and clears the cache.
- **Search:** a debounced (400ms) search box passes the query straight through as Gmail's `q` search parameter (`from:`, `subject:`, free text, etc. — same syntax as Gmail's own search bar), run server-side alongside `labelIds`. Since the two are ANDed by the API, results still can't leak outside Primary inbox even if the query contains an `in:` operator. Changing the query resets pagination to page 1.
- Full thread preview panel (right) — renders each message's original HTML (sanitized via DOMPurify, displayed in a sandboxed `<iframe srcDoc>` with no `allow-scripts`) so formatting matches Gmail's own rendering, with a plain-text fallback for messages with no HTML part. The plain-text extraction (with entity decoding) is still used for RAG/draft context, since LLM prompts don't need markup.
- Gmail tokens stored in `user_settings`, auto-refreshed on expiry.
- **Sender avatars** resolve through a 5-source fallback chain, each tried only if the previous found nothing: (1) Google People API (`contacts.readonly` scope — covers real correspondents via Contacts + Gmail's auto-saved "Other contacts"), (2) the domain's **declared** `<link rel="icon">` via a server-side HTML crawl (`GET /api/favicon?domain=...`, root domain extracted via a compound-TLD-aware heuristic, picks the largest declared `sizes=`) — many sites (e.g. Reddit) don't serve their real logo at the conventional path at all, only via this tag pointing elsewhere (often a CDN), (3) the domain's raw `favicon.ico` as a fallback guess, (4) Google's `s2/favicons` service as a last resort (frequently serves a generic placeholder instead of the real logo — confirmed via testing — so deliberately low priority), (5) Gravatar (SHA-256 of the email, `d=404`), (6) initials. A real `Image()` preload check gates each candidate before committing to it. Results are cached per-sender in memory for the session; the favicon route itself caches per-domain server-side for the process lifetime. `domain` is attacker-controlled (derived from email sender addresses), so the route validates it (`isSafeDomain` — rejects IP literals and internal/loopback hostnames) to prevent SSRF, in addition to the standard auth check. Sites with aggressive bot protection (eBay, OpenAI — both confirmed via testing to return 403 to non-browser server-side requests) can't be crawled for a declared icon and fall through to the `favicon.ico`/Google's-service/Gravatar steps instead — not a bug, just a ceiling on what's reachable without full browser automation.

### 2. Model Selection
- Live model list fetched server-side per provider after key validation.
- Each model shows capability tags: `short` `long` `business` `personal` `fast` `reasoning` `instruction-following`
- `instruction-following` is a first-class tag — the best model for rule-heavy drafting is the one that reliably follows instructions, not just writes well.
- Tags are derived **heuristically** from the model id (parameter count like `70b`/`8b`, speed hints like `instant`/`flash`/`turbo`, reasoning hints like `r1`/`deepseek`/`o1`) and context window, rather than a static exact-id lookup table — provider catalogs (esp. Groq) change too often for a hardcoded list to stay accurate.
- Non-chat models (audio/transcription, TTS, translation, safety/guard classifiers, embeddings) are filtered out of the dropdown via a keyword denylist (`whisper`, `tts`, `translat`, `guard`, etc.) since they can't draft replies.
- Groq's model list is sorted by context window descending (largest first, ties broken alphabetically) — e.g. `openai/gpt-oss-*` and `qwen/qwen3-*` sort above the older `llama3-*-8192` models, since Groq's catalog mixes wildly different context sizes under no consistent naming order.
- If a model is unsupported by the key's tier → ⚠ warning badge on that model in the dropdown.
- Selected model persists in `localStorage` as a convenience default.

### 3. Multi-Provider API Key Management
- Support **Groq, Gemini (Google), and OpenAI** — user picks a provider and enters their key.
- On save, key is **validated** by a lightweight test API call:
  - Valid → fetch that provider's live model list and store key encrypted (AES-256-GCM).
  - Invalid → inline error shown immediately, key not saved.
- Keys stored per-provider in `user_settings`, encrypted at rest, never returned to client.
- All LLM calls are server-side only.
- Keys updatable from a settings screen at any time.
- The key modal fetches `/api/settings` on open and reflects which providers already have a key saved (✓ badge on the provider tab, "already saved — enter a new one to replace it" banner) — it no longer forces re-entering/re-validating a key that's already on file to proceed past step 1.

### 4. Writing Rules
- **One-time onboarding** on first sign-in: a modal asks the user to define broad writing rules (tone, style, length, sign-off, etc.).
- Rules stored as `text[]` in `user_settings.writing_rules`.
- **"Ask me every time" toggle** — a checkbox on the dashboard. When ON, a rules review popup appears every time "Draft Reply with AI" is clicked.
- The popup shows current rules as **editable bullet points** — user can tweak before drafting.
- Rules are injected into the system prompt on every draft, regardless of provider.

### 5. AI Reply Drafting
When user clicks "Draft Reply with AI ✨" on a thread:
1. (If toggle ON) Rules review popup appears — user confirms or edits rules.
2. Latest email embedded → Hybrid RAG retrieval → top 3 chunks.
3. Selected provider's API (Groq / OpenAI / Gemini) called server-side with:
   - **Sender/recipient identity**: each message in the thread is labelled with who sent it (`You (the account owner)` vs `External sender`), determined by matching the message's `From` header against the signed-in user's own email. The system prompt explicitly states who the reply is drafted AS (the owner) and TO (the external party — the most recent non-owner message). Without this the model has no way to tell the two apart from body text alone and will hallucinate perspective (e.g. address the owner as if they sent the original email).
   - **Thread-length capping**: the last 3 messages are kept verbatim; older messages are condensed to ~220 chars each rather than dropped outright; the whole assembled thread text is hard-capped at ~6000 chars (trimming oldest-first) as a final safety net. Prevents `400 reduce the length of messages` errors on long threads with small-context models, while preserving some sense of earlier context.
   - Writing rules in the system prompt
   - RAG context labelled by source file
4. Reply **streamed back via SSE** into an editable textarea in real time.
5. Model selector dropdown + "Regenerate" button available.

### 6. Human-in-the-Loop Send
- **Never send automatically.** Single **"Send"** button is the only trigger.
- User can freely edit the draft before sending — the draft panel tracks the AI-generated text and the user-edited version as separate state, so edits never overwrite what the model actually produced.
- On click: sends via Gmail API, shows a "Sending…" state, then opens the post-send feedback modal (see §8). If logging the reply failed server-side (no row to attach feedback to), falls back to a brief inline "✓ Sent" confirmation that auto-clears after ~1.8s instead.

### 7. Supabase Logging
Every reply stored in `email_replies` on successful send:
`id`, `created_at`, `user_id`, `original_email_id`, `original_email_snippet`, `ai_draft` (pre-edit), `sent_reply` (what was actually sent), `model_used` (`provider:modelId`), `retrieved_context` (RAG chunks used — file name, text, score), `star_rating`, `textual_feedback`.
A logging failure never blocks the send response — the email has already gone out via Gmail by the time the DB insert runs, so insert errors are only logged server-side. `/api/gmail/send` returns the inserted row's `id` so the client can attach feedback to it.

### 8. Feedback System
- A **modal popup** (must be explicitly dismissed via Submit or Skip — not a passive toast) appears immediately after a successful send.
- **1–5 clickable stars** + optional free-text comment; either can be submitted alone, or skipped entirely.
- `POST /api/feedback` updates `star_rating`/`textual_feedback` on the specific `email_replies` row from that send (ownership-checked against the authenticated user).

### 9. Authentication
- Google OAuth via Supabase Auth — **multi-tenant**: any Google account can sign in and gets its own isolated inbox, knowledge base, settings, and drafts. (Originally single-owner-only via an `OWNER_EMAIL` env var gate in `proxy.ts`; removed once the product opened up to multiple users. The data layer never needed to change for this — every table was already scoped per-`user_id` with RLS policies keyed on `auth.uid() = user_id`, and no route uses the service-role key to bypass that, so isolation was correct from day one.)
- All API routes return 401 for unauthenticated requests.
- Public, unauthenticated routes (for Google OAuth verification and general access): `/login`, `/privacy`, `/terms`, `/auth/callback`, `/api/auth/*`.
- Gmail OAuth scopes: `gmail.readonly`, `gmail.send`, `contacts.readonly` (the last one added for sender-avatar lookups — requires the **People API** to be enabled separately in Google Cloud Console, distinct from the Gmail API). `prompt: "consent"` is always forced on the auth URL so adding a new scope later just requires the user to click through a "Reconnect Gmail" flow (in the settings bar) rather than needing a fresh OAuth client.

---

## Supabase Schema

```sql
-- User settings
create table user_settings (
  user_id uuid primary key references auth.users on delete cascade,
  groq_api_key_encrypted text,        -- AES-256-GCM encrypted, per-provider
  openai_key_encrypted text,
  gemini_key_encrypted text,
  gmail_access_token text,
  gmail_refresh_token text,
  gmail_token_expiry timestamptz,
  writing_rules text[],               -- bullet-point rules array
  ask_rules_every_time boolean default false,
  onboarding_complete boolean default false,
  updated_at timestamptz default now()
);

-- Uploaded file registry
create table uploaded_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  file_name text not null,
  file_path text not null,
  file_type text not null,
  file_size bigint,
  parent_folder text,
  uploaded_at timestamptz default now()
);

-- Vector knowledge base (768 dim — all-mpnet-base-v2)
create table doc_chunks (
  id uuid primary key default gen_random_uuid(),
  file_id uuid references uploaded_files on delete cascade,
  user_id uuid references auth.users on delete cascade,
  chunk_text text not null,
  embedding vector(768),
  chunk_index integer,
  chunk_tsv tsvector generated always as (to_tsvector('english', chunk_text)) stored,
  metadata jsonb
);

-- indexes
create index doc_chunks_embedding_hnsw_idx on doc_chunks
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index doc_chunks_tsv_idx on doc_chunks using gin (chunk_tsv);

-- Email reply log
create table email_replies (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  user_id uuid references auth.users on delete cascade,
  original_email_id text,
  original_email_snippet text,
  ai_draft text,
  sent_reply text,
  model_used text,
  retrieved_context jsonb,
  star_rating smallint check (star_rating between 1 and 5),
  textual_feedback text
);
```

---

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REDIRECT_URI=http://localhost:3000/api/auth/gmail/callback
HF_TOKEN=
ENCRYPTION_SECRET=        # 32-char random string for AES-256 key encryption
```

---

## Deployment

- **Frontend + API routes:** Vercel (Next.js 16)
- **Long-running / background jobs:** Railway
- **Proxy file** (`src/proxy.ts`) replaces `middleware.ts` — Next.js 16 convention
- `next.config.ts` sets `serverExternalPackages: ["pdf-parse", "pdfjs-dist"]` so the PDF worker isn't bundled for the browser

---

## Phased Implementation Plan

### Phase 1 — Foundation & Auth ✅
- Next.js 16 + Tailwind + shadcn/ui scaffolded at the repo root (originally scaffolded in `/frontend`, later flattened — the app lives at the project root, not a nested subfolder)
- Google OAuth via Supabase Auth
- Originally owner-only (single `OWNER_EMAIL` gate in `proxy.ts`); opened up to multi-tenant sign-in post-launch — see Phase 8

### Phase 2 — File Upload & Vector DB ✅
- Drag-and-drop file/folder upload with SSE progress bar
- Recursive chunker (256 char, 64 overlap)
- HF embeddings → pgvector (HNSW index)
- Full-text GIN index + `hybrid_search` SQL function
- Cross-encoder reranker, top-3 final context
- File panel UI with folder expand/collapse and remove

### Phase 3 — Gmail Integration ✅
- Gmail OAuth flow + token storage/refresh
- Inbox list with unread badge
- Full thread preview with plain text rendering + HTML entity decoding

### Phase 4 — AI Reply Drafting ✅
- Multi-provider API key onboarding (Groq / Gemini / OpenAI) with live validation
- AES-256-GCM encrypted key storage per provider
- Live model list per provider with capability tags (`short` `long` `business` `personal` `fast` `reasoning` `instruction-following`), heuristically derived
- ⚠ warning badge for unsupported models
- Writing rules onboarding modal + "ask every time" toggle
- Rules review popup (editable bullet points) before drafting
- Per-thread context scoping via left sidebar checkboxes (all selected by default, ephemeral)
- Hybrid RAG with optional file_id filter → cross-encoder rerank → top 3, resilient to HF outages
- LLM streaming reply via SSE → editable textarea
- Sources never shown in the reply body unless rules say so
- Regenerate button
- Post-testing fixes: multi-folder/mixed drag-drop, File System Access API folder picker, PDF worker bundling, HF endpoint migration, model tag/filter overhaul, skipped-file upload feedback, settings modal close button

### Phase 5 — Send & Logging ✅
- One-click Send via Gmail API, with Sending/Sent UI states
- Original AI draft tracked separately from user-edited text sent
- Log `ai_draft`, `sent_reply`, `model_used`, `retrieved_context`, `original_email_id`, `original_email_snippet` to `email_replies` on successful send (non-blocking on log failure)
- Post-testing fixes: inbox pagination (Previous/Next, cursor-based with client-side page cache), HTML email rendering via sanitized sandboxed iframe (replacing the flattened plain-text view for formatting-heavy emails)

### Phase 6 — Feedback & Polish ✅
- Star rating + text feedback modal post-send (required dismissal, 1–5 stars + optional comment), wired to `email_replies` via the reply id returned from send
- UI polish: skeleton loaders + error states with Retry for inbox list, thread panel, and file panel (previously failed/loaded silently with no feedback)
- Mobile responsiveness explicitly deprioritized — single-owner desktop tool, polish budget spent on error/loading states instead
- Post-testing fixes: sender/recipient identity injection into the draft prompt (model no longer confuses the owner with the external sender), thread-length capping to prevent context-overflow errors on long threads, API key modal now reflects already-saved keys instead of always prompting as if empty, Groq model list sorted by context window descending

### Phase 7 — UI/UX Overhaul ✅
Driven by `CHANGELOG.md`. Sub-phases, each confirmed with the user before starting:
- **Sub-phase 1** ✅ — confirmation dialogs for Sign Out and API key overwrite (shadcn `AlertDialog`); folder removal in the knowledge base panel (new `/api/files/delete-folder` route, batched storage + cascading DB delete); drag-resizable 3-panel layout (file panel / inbox list / thread view) via `react-resizable-panels`; custom styled tooltip component (shadcn `Tooltip`) replacing native `title` attributes.
- **Sub-phase 2** ✅ — unified upload picker: the drop zone is now a single click target that opens a small "Upload files" / "Upload folder" menu (shadcn `DropdownMenu`) instead of a separate link below it; drag-and-drop for mixed files/folders unchanged.
- **Sub-phase 3** ✅ — sender avatars via the 5-source fallback chain described in §1 above, including the declared-`<link rel="icon">` crawl that fixed the Reddit/eBay generic-icon issue (root cause: Reddit's real logo isn't served at the conventional `/favicon.ico` path at all; eBay's `/favicon.ico` is real but a tiny legacy 16x16 icon, and its homepage blocks server-side crawling with bot-protection).
- **Sub-phase 4** ✅ — dark/light mode via `next-themes` (`attribute="class"`, `defaultTheme="system"`, `enableSystem`), toggling the `.dark` class already wired into `globals.css`'s `@custom-variant dark`. Theme dropdown (Light/Dark/System) in the dashboard header and login page; choice persists in `localStorage`, overriding system until reset. Notably, most components already had `dark:` Tailwind classes written in from earlier phases with nothing ever toggling `.dark` — this activated all of that previously-dormant styling in one shot.
- **Sub-phase 5** ✅ — visual design pass. The shadcn theme's `--primary` token was actually neutral gray/black while blue had organically become the de facto accent everywhere via scattered hardcoded `bg-blue-600` overrides — meaning plain default buttons looked dull while "important" actions were manually forced blue, the root of the incoherence. Fixed by making blue the real theme primary (`blue-600` light / `blue-500` dark, in `globals.css`), so every default `Button`/`Badge` is consistently blue with zero per-component overrides. Swept remaining hardcoded "selected state" blues (provider tabs, filter badge, selected-model highlight) to the theme token so they correctly adapt per-theme instead of staying a flat color in both. Destructive (red, subtle by default) and success (green — Send/Sent) colors were already consistent and left untouched; categorical model-tag colors are intentionally multi-color, not meant to track primary.

Also fixed during this phase: two `globals.css`/dependency regressions from the shadcn CLI silently rewriting the file when installing new components (`--font-sans: var(--font-sans)` self-reference breaking the whole app's font; `react-resizable-panels` treating numeric `defaultSize`/`minSize`/`maxSize` as **pixels** not percentages, requiring string values); raw HTML entities (`&amp;`, `&#39;`) appearing in inbox subject/snippet text and sender names breaking display and avatar-initials parsing (quoted-string display names like `"Weights & Biases"` need quote-stripping, not just entity decoding).

**Sub-phase 6** ✅ — follow-up UI/UX round (`CHANGELOG.md`): refresh/filter buttons enlarged (36x36px icon buttons, up from a bare text glyph and 32px respectively); fixed the API-key modal's close button visually overlapping the step-indicator row (`pr-8` reserved when the modal is closeable). Bigger change — **drafting is no longer hidden behind a toggle**: the thread view and draft assistant are now a permanent resizable split (not a `showDraft`-gated sidebar) the moment a thread is open, since drafting is the app's core action and shouldn't require an extra click to discover. "Draft Reply with AI ✨" is now a large primary button at the very top of the draft panel, with **"Sources"** (renamed from "Scope Context" for clarity) paired directly beside it at matching visual weight.

**Sub-phase 7** ✅ — second follow-up round after live testing (`CHANGELOG.md`): narrowed the email-list column (28%→22% default) to give the thread+draft area more room, without touching the thread:draft split ratio itself; fixed a placeholder-text mismatch in the draft panel (now reads 'Click "Draft Reply with AI ✨" above...', matching the actual button).

**Sub-phase 8** ✅ — tooltips & discoverability pass (`CHANGELOG.md`): "Draft" panel renamed to **"Smart Reply"**, with a one-line description under the heading explaining the flow (pick a model → optionally scope sources → generate → edit → send) instead of per-button tooltips, since the buttons are already clearly labeled. Added an ⓘ tooltip to the "Knowledge Base" heading explaining what it does; the drop zone now lists accepted file extensions; model capability tags (`long`, `instruction-following`, etc.) got hover explanations since those abbreviations aren't self-evident. Swept every icon-only button across the app (modal close buttons, show/hide-key, add/remove-rule, feedback star rating, file dismiss/remove) for a hover title, scoped deliberately to icon-only/non-obvious controls — text-labeled buttons like "Send"/"Cancel" were left alone to avoid redundant tooltips. Also caught and fixed several leftover hardcoded `blue-600` accents (checkboxes, a text link) missed by the sub-phase 5 color-coherence sweep.

**Sub-phase 9** ✅ — writing-rules discoverability inside Smart Reply: previously only reachable via the header Settings button, with zero indication it was even being used. Added a visible (not small, per explicit instruction) indicator row in the Smart Reply panel showing "N writing rules active" / "No writing rules set" with an ⓘ tooltip and a direct "Edit" link that opens the rules editor in-place (no need to leave the thread view), refreshing the count live on close. Hit a real bug during this: nesting the ⓘ tooltip's own `<button>` trigger inside the indicator row's `<button>` wrapper produced invalid "`<button>` in `<button>`" HTML and a hydration error — fixed by making the row a `<div role="button" tabIndex={0}>` instead of a literal `<button>`, with `stopPropagation` on the tooltip so hovering it doesn't also trigger the row's click.

**Sub-phase 10** ✅ — bulk select/delete in the Knowledge Base panel (`file-panel.tsx`): a "Select" toggle in the panel header (hidden while context-scoping mode is active — the two checkbox modes are mutually exclusive) switches every file row and folder row into checkbox mode, replacing the per-folder "✕ remove all" / per-file hover-✕ controls with a small action bar ("Select all"/"Deselect all" + a destructive "Remove (N)" button, same `AlertDialog` confirmation pattern used elsewhere). Checking a folder's own checkbox selects/deselects every file inside it as a unit (completes a partial selection rather than strictly toggling, which reads more predictably). Confirmed deletion fires all selected `/api/files/delete` calls in parallel via `Promise.all`, then reloads the file list. `FileRow`'s props were generalized from a single `scopingMode` flag to `showCheckbox`/`hideRemove`/`checked`/`onToggle` so the same row component serves both the context-scoping checkboxes and the new bulk-delete checkboxes without duplicating markup.

**Sub-phase 11** ✅ — one-button minimize for the Smart Reply panel (`inbox.tsx`, `ThreadPanel`): the nested `ResizablePanel` holding the draft assistant is now `collapsible` with `collapsedSize="0"`, driven by `react-resizable-panels`' imperative `usePanelRef()`/`panelRef` API. A `PanelRightClose`/`PanelRightOpen` icon button in the thread header calls `.collapse()`/`.expand()` directly — previously the only way to shrink it was dragging the resize handle all the way down, which was fiddly and didn't fully hide it. `onResize` tracks collapsed state (`asPercentage === 0`) to flip the icon; the panel's content is deliberately kept mounted (not conditionally unmounted) while collapsed so in-progress drafting state isn't lost on restore.

### Phase 8 — Public Launch & Multi-Tenant Access ✅
- Removed the `OWNER_EMAIL` single-user gate from `proxy.ts` — any authenticated Google account can now sign in and use Echo. No data-layer changes were needed: every table (`user_settings`, `uploaded_files`, `doc_chunks`, `email_replies`) already carries its own RLS policy scoped to `auth.uid() = user_id`, and no API route uses the service-role key to bypass it, so per-user isolation (own inbox, own knowledge base, own settings) was already correct.
- Added public `/privacy` and `/terms` pages (exempted from the auth gate in `proxy.ts`, alongside `/login`), linked from the login page footer. Required for Google's OAuth consent screen, and specifically for verifying the `gmail.send`/`gmail.readonly`/`contacts.readonly` scopes.
- **Still outstanding (external, not a code task):** the Google Cloud OAuth consent screen likely needs to move from "Testing" (capped at 100 allowlisted test-user emails, with an "unverified app" warning) to a fully verified "In production" state before truly arbitrary strangers can sign in. Because `gmail.send` is a sensitive/restricted scope — and because Echo forwards email content and document context to third-party LLM providers — this will likely require Google's verification process: a filled-out OAuth consent screen (app name, logo, support email, the `/privacy` and `/terms` URLs above, authorized domain), a scope-justification write-up and demo video, and possibly a CASA security assessment. This is a multi-week external review process owned by whoever controls the Google Cloud project, not something that can be completed from the codebase.

---

## Known Issues / Future Work

See `CHANGELOG.md`'s "Known Issues / Accepted Limitations" section (eBay avatar ceiling, deprioritized mobile responsiveness, etc.) — kept there rather than duplicated here.

- **Google OAuth verification pending** — see Phase 8 above. Until the consent screen is verified (or test users are added), only allowlisted Google accounts can complete sign-in, regardless of the app's own access logic.

## Key Constraints & Rules

- **Never auto-send email.** Send button is the only trigger.
- **Always ask for user preferences before starting each phase.**
- Primary inbox only — no Promotions, Social, or Spam.
- RAG retrieval on every draft — never rely on LLM general knowledge.
- Writing rules always injected into the system prompt.
- File removal must synchronously clean up all vector chunks — no orphaned data.
- Store AI draft and sent reply separately — never overwrite the original draft.
- All LLM provider calls and sensitive key access happen server-side only.
