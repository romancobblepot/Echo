# Changelog

Consolidated history of every feedback round and the resolution for each item. Replaces the
previously scattered `Ideas*.md` files (merged and archived out of the repo on 2026-10-03).
New feedback goes in `FEEDBACK.md` instead of a new dated file.

---

## Original Spec

The initial ask that kicked off the project (Gmail primary-inbox fetch, Groq-drafted replies
with a live model list, Supabase knowledge base with file/folder upload and removal, editable
AI drafts with human-in-the-loop send, star rating + text feedback, Google-OAuth owner-only
auth, phased delivery with a check-in before each phase) — captured in full in `CLAUDE.md`'s
Project Overview and Core Features sections rather than repeated here.

---

## RAG Pipeline Design Round

Suggestions made before Phase 2 build, all adopted into the implemented pipeline:

- Switched from fixed-size chunking to **recursive chunking** (max 256 chars, 64-char overlap).
- Rich metadata on each chunk for citation (`file_name`, `file_type`, `source_file_id`, `chunk_index`).
- SSE progress bar streamed to the frontend during upload/indexing.
- **Hybrid RAG**: semantic (pgvector) + keyword (Postgres full-text) retrieval in parallel.
- Semantic index built on **HNSW**, not IVFFlat (chosen over IVFFlat for better recall without
  needing to pre-tune a cluster count as the corpus grows).
- Top 5 candidates from each retrieval path, merged and deduplicated, then reranked with a
  cross-encoder (`ms-marco-MiniLM-L-6-v2`); final top 3 used as context.

---

## Drafting Phase Design Round

Suggestions made before Phase 4 build, all adopted:

- Multi-provider API keys (Groq / Gemini / OpenAI), validated on save.
- Live per-tier model list once a key validates.
- Capability tags per model (short/long/personal/business/fast/reasoning), with
  `instruction-following` as a first-class tag — the best model for rule-heavy drafting follows
  instructions reliably, not just writes well.
- ⚠ warning badge for a model unsupported by the key's tier.
- RAG context used silently — never surfaced in the drafted reply body.
- Per-thread context scoping via sidebar checkboxes (all checked by default, ephemeral per thread,
  live `N/M selected` counter, hidden when no thread is open).

---

## Post-Phase-4 Testing Round

1. **Couldn't select more than one folder at a time.** Root cause: the legacy `webkitdirectory`
   input combined with a macOS Finder column-view quirk (single-click navigates into a folder
   instead of selecting it, so Open never finalizes a directory choice). Fixed by switching to
   the File System Access API (`showDirectoryPicker()`) on Chrome/Edge for a real "select this
   folder" dialog; browsers without that API fall back to `webkitdirectory` with a ⓘ tooltip
   explaining the macOS workaround.
2. **Mixed file+folder drag-drop was buggy.** `DataTransferItems` were going stale after an
   `await`; fixed by snapshotting them synchronously first. `collectFolder` was also only calling
   `readEntries()` once, silently truncating folders with 100+ entries — fixed by calling it
   repeatedly until empty.
3. **"Setting up fake worker failed..." on upload.** Next.js was trying to bundle `pdfjs-dist`'s
   worker for the browser. Fixed with `serverExternalPackages: ["pdf-parse", "pdfjs-dist"]` in
   `next.config.ts`.
4. **Had to open a folder and select files manually instead of uploading the whole folder.**
   Same fix as #1. Separately, a folder containing only unsupported file types was being skipped
   with zero feedback — added a dismissible amber banner reporting how many files were skipped
   and why.
5. **API key modal had no close button at all.** Added a `closeable` prop to `OnboardingModal`;
   the settings entry point passes it so an X appears (first-time onboarding intentionally still
   has no close button, since it's required setup).
6. **Whisper/speech models tagged "General" and selectable; translation models also showing up
   in the model list.** Replaced the static exact-id tag lookup (which only covered a handful of
   known ids) with a heuristic tagger reading parameter count, speed/reasoning keywords, and
   context window from the model id itself. Broadened the non-text-model filter (whisper,
   distil-whisper, tts, playai, translat*, guard, embedding, moderation, etc.) to exclude audio,
   translation, and safety-classifier models from the dropdown entirely.
7. **"Draft Reply with AI" threw `Unexpected end of JSON input`.** Two causes: (a) HuggingFace
   retired `api-inference.huggingface.co` in favor of `router.huggingface.co/hf-inference`,
   breaking both embedding and reranker calls; (b) the RAG retrieval call wasn't wrapped in
   try/catch, so any failure crashed the whole request before it returned a body. Fixed the HF
   endpoint URLs and made RAG retrieval degrade gracefully (draft without context, or
   semantic-only ranking if just the reranker fails) instead of crashing.

---

## Post-Phase-5 Testing Round

1. **Only ~15 emails loading; no way to page through hundreds/thousands.** Gmail's API is
   cursor-based with no offset/random-access paging, only a "next page" token — true numbered
   pages aren't something the API supports. Implemented Previous/Next controls on top of that:
   25 emails per page, each fetched page cached client-side by index so "Previous" never
   re-fetches. Refresh resets to page 1 and clears the cache.
2. **Email body formatting didn't match Gmail's own rendering** (table/div-heavy HTML emails like
   newsletters were flattened into unreadable fragments). Switched to rendering each message's
   original HTML directly (`lib/gmail.ts` now extracts a raw `bodyHtml` alongside the existing
   plain-text extraction used for RAG/draft context), sanitized with DOMPurify and rendered in a
   sandboxed `<iframe srcDoc>` with auto-resize. Messages with no HTML part still fall back to
   plain text.
3. **Needed a Gmail-style filter button** for easy filtering. Added one (unread-only, has
   attachment, from, subject, newer-than), combined with a debounced free-text search box that
   passes straight through as Gmail's own `q` search syntax.
   - Follow-up: filtered results appeared stuck on one page. Investigated with temporary
     diagnostic logging of the raw Gmail API response — pagination itself was confirmed working
     correctly end-to-end (e.g. a `newer_than:1y` filter paginated across 2 pages and stopped
     correctly once exhausted). The specific report turned out to be "Unread only" *combined
     with* "Past year", which legitimately has far fewer matches than either filter alone —
     correct behavior, not a bug. Diagnostic logging removed; no code change needed.
4. **Dates on email list had no year** ("8 Sep" instead of "8 Sep 2025"). Fixed — `formatDate()`
   now always includes the year for any date that isn't today.

---

## Post-Phase-6 Testing Round

1. **The model drafted as if it were the external sender**, hallucinating perspective and
   addressing the owner on the owner's own behalf. Root cause: neither the thread text nor the
   single "email to reply to" sent to the LLM carried any sender/recipient identity, just raw
   message bodies. Fixed by labelling each thread message as "You (the account owner)" or
   "External sender" (matched against the signed-in user's own email), determining the actual
   recipient as the most recent non-owner message, and adding an explicit perspective section to
   the system prompt naming both parties. Also fixed a related bug: the user message sent to the
   LLM only ever included the raw last message body, never the (now-labelled) thread text.
2. **Long threads threw `Please reduce the length of the messages`**, partly made worse by the
   identity-labelling fix above duplicating the full thread text into the prompt. Implemented
   `capThreadForPrompt()`: the last 3 messages are kept verbatim; older messages are condensed to
   ~220 chars each instead of dropped entirely; the whole assembled thread text is hard-capped at
   ~6000 chars (~1500 tokens), trimming oldest-first. Leaves headroom for the system prompt, RAG
   context, writing rules, and the completion itself even on the smallest-context Groq models.
   Only applied to what's sent to the chat completion — the RAG embedding query still uses the
   full thread text.
3. **The API key settings didn't reflect a key already saved** — the modal always asked for a
   Groq key as if nothing was on file, even after sign-in. `OnboardingModal` now fetches
   `/api/settings` on mount, shows a ✓ badge on provider tabs with a saved key, displays an
   "already saved — enter a new one to replace it" banner, and no longer forces re-entering a key
   that's already on file to continue.
4. **Groq's model dropdown should sort larger-context models to the top** instead of alphabetical.
   Sorted by context window descending, ties broken alphabetically.

---

## Phase 7 — UI/UX Overhaul, Round 1

1. Confirmation dialogs added before Sign Out and before overwriting an existing API key
   (shadcn `AlertDialog`); new keys with no prior value for that provider still save immediately.
2. Folder removal added to the knowledge base panel (new `/api/files/delete-folder` route,
   batched storage delete + cascading DB delete for every file and its vector chunks).
3. Drag-resizable 3-panel layout (file panel / inbox list / thread view) via
   `react-resizable-panels`, replacing fixed-width columns.
4. Unified upload picker: the drop zone is a single click target opening an "Upload files" /
   "Upload folder" menu, instead of a separate link below it; mixed drag-and-drop unchanged.
5. Dark/light mode via `next-themes` (`attribute="class"`, `defaultTheme="system"`,
   `enableSystem`) — a Light/Dark/System dropdown in the header and login page, persisted in
   `localStorage`. Most components already had unused `dark:` Tailwind classes from earlier
   phases; this activated all of that previously-dormant styling in one shot.
6. Visual design pass: the shadcn theme's `--primary` token was neutral gray/black while blue had
   organically become the de facto accent via scattered hardcoded `bg-blue-600` overrides. Made
   blue the real theme primary (`blue-600` light / `blue-500` dark) so every default
   `Button`/`Badge` is consistently blue with zero per-component overrides, and swept the
   remaining hardcoded "selected state" blues to the theme token so they adapt per-theme.
7. Custom styled tooltip component (shadcn `Tooltip`) replacing native `title`-attribute
   tooltips, which only showed a plain gray browser tooltip with a delay.
8. **Sender avatars** — built a 5-source fallback chain: (1) Google People API (Contacts +
   "Other contacts" — required a new `contacts.readonly` OAuth scope, a Gmail reconnect flow, and
   enabling the People API separately in Google Cloud Console), (2) the sender domain's declared
   `<link rel="icon">` crawled server-side (new `/api/favicon` route, SSRF-guarded since the
   domain is derived from attacker-controlled sender addresses) and resolved to the largest
   declared size, (3) the domain's raw `/favicon.ico` as a fallback guess, (4) Google's `s2`
   favicon service as a last resort (confirmed via testing to often serve a generic placeholder,
   so deliberately low-priority), (5) Gravatar (SHA-256 hash), then (6) initials. Each candidate
   is validated with a real image preload check before use.
   - Resolved a specific Reddit/eBay gap: downloading and inspecting the actual favicon bytes
     showed Reddit's real logo isn't served at the conventional `/favicon.ico` path at all, only
     via a declared `<link rel="icon">` pointing to a different CDN — caught by source (2) above.
     eBay's `/favicon.ico` is real but a tiny legacy 16x16 icon, and its homepage actively blocks
     server-side crawling with bot protection (confirmed 403 via testing) — not a bug, just a
     ceiling on what's reachable without full browser automation.
   - Two unrelated regressions caught and fixed while in this area: `globals.css` had a
     self-referential `--font-sans: var(--font-sans)` left by a shadcn CLI component install,
     breaking the whole app's font to browser-default serif; and `react-resizable-panels`
     interprets numeric `defaultSize`/`minSize`/`maxSize` as **pixels**, not percentages — fixed
     by switching all size props to percentage strings (`"18"` not `18`).
   - Raw HTML entities (`&amp;`, `&#39;`) were leaking into inbox subjects/snippets/sender names,
     and quoted display names like `"Weights & Biases"` were producing garbage avatar initials —
     fixed with entity decoding plus quote-stripping/symbol-filtering in the sender-name parser.

---

## Phase 7 — UI/UX Overhaul, Round 2+

1. Refresh and filter buttons enlarged to proper 36x36px icon buttons (lucide `RefreshCw`, up
   from a bare "↻" glyph and a smaller filter button).
2. API-key modal's close button no longer overlaps the step-indicator row (`pr-8` reserved when
   the modal is closeable).
3. **"Draft Reply with AI" is no longer hidden behind a toggle** — the thread view and draft
   assistant are a permanent resizable split the instant a thread is open, since drafting is the
   app's core action. "Draft Reply with AI ✨" is a large primary button at the top of the draft
   panel, paired directly beside a **"Sources"** button (renamed from "Scope Context") at matching
   visual weight.
4. Narrowed the email-list column (28%→22% default) to give the thread+draft area more room,
   without touching the thread:draft split ratio itself.
5. Fixed a placeholder-text mismatch in the draft panel (now reads 'Click "Draft Reply with AI
   ✨" above...', matching the actual button text).
6. Tooltips & discoverability pass: the draft panel renamed to **"Smart Reply"** with a one-line
   description of the flow (pick a model → optionally scope sources → generate → edit → send)
   instead of per-button tooltips, since the buttons are already clearly labeled. Added an ⓘ
   tooltip to "Knowledge Base" explaining what it does; the drop zone now lists accepted file
   extensions; model capability tags got hover explanations. Every icon-only button across the
   app (modal close buttons, show/hide-key, add/remove-rule, feedback star rating, file
   dismiss/remove) got a hover title — deliberately scoped to icon-only/non-obvious controls, not
   already-labeled buttons like "Send"/"Cancel". Caught and fixed several leftover hardcoded
   `blue-600` accents missed by the earlier color-coherence sweep.
7. **Writing Rules discoverability inside Smart Reply** — previously only reachable via the
   header Settings button with zero indication it was being used. Added a visible indicator row
   ("N writing rules active" / "No writing rules set") with an ⓘ tooltip and a direct "Edit" link
   that opens the rules editor in-place. Hit and fixed a real bug along the way: nesting the
   tooltip's own `<button>` inside the row's `<button>` wrapper produced invalid HTML and a
   hydration error — fixed by making the row a `<div role="button" tabIndex={0}>` instead of a
   literal `<button>`, with `stopPropagation` on the tooltip.
8. **Bulk select/delete in the Knowledge Base panel** — a "Select" toggle in the panel header
   (hidden during context-scoping mode) switches every file/folder row into checkbox mode, with
   a "Select all"/"Deselect all" shortcut and a destructive "Remove (N)" button (same
   `AlertDialog` confirmation pattern used elsewhere). Checking a folder's checkbox
   selects/deselects every file inside it as a unit. Deletion fires all selected removals in
   parallel, then refreshes the file list.
9. **One-button minimize for the Smart Reply panel** — a `PanelRightClose`/`PanelRightOpen` icon
   button in the thread header fully collapses the panel to 0 width via `react-resizable-panels`'
   imperative `panelRef` API, instead of relying on dragging the resize handle all the way down.
   Dragging still works as an alternative. The panel's content stays mounted while collapsed so
   an in-progress draft, model choice, or scoping selection isn't lost on restore.

---

## Known Issues / Accepted Limitations

- **eBay avatars** will likely keep showing their small legacy 16x16 `/favicon.ico` rather than a
  nicer logo — eBay's homepage blocks server-side crawling with bot protection (confirmed 403),
  so the declared-icon lookup can't reach it. Would need full browser automation to work around;
  disproportionate for an avatar nice-to-have.
- Mobile responsiveness was explicitly deprioritized in Phase 6 — this is a single-owner desktop
  tool, and the polish budget went to error/loading states instead.
- "Use a less bland web template / inspiration from Lovable templates" (Phase 7 round 1, item 1)
  was superseded by the incremental visual-design passes (theme color coherence, dark/light mode,
  tooltips) rather than a from-scratch template swap — considered addressed in spirit, not a full
  redesign.
