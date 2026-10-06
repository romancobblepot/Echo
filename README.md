Hello everyone, i built this project as a part of my context engineering and agentic engineering learning. The UI/UX and all didn't matter for me here in this. What honestly mattered was implementing something that atleast as a nano-product seems like a scalable engineering prototype. I completely own the high-level design features, Memory Architecure, Context Management, RAG pipeline and feedback loop system (per user).

I want to work more on it and iteratively make it better as i read and learn things along the way.


# Echo

**Replies drafted for you, but sent by you.**

Echo is an AI-powered Gmail reply assistant. It reads your primary inbox, retrieves relevant
context from a knowledge base of your own documents, drafts a reply with the LLM provider of
your choice, and lets you review, edit, and send with one click — it never sends anything on
its own.

**Live app:** https://email-reply-agent-tau.vercel.app

---

## Agentic Architecture

Echo follows a retrieval-augmented, human-in-the-loop agent loop rather than a fully autonomous
one — by design, the agent's authority stops at producing a draft:

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐     ┌──────────────┐
│   Trigger   │ --> │   Retrieve   │ --> │    Reason /    │ --> │  Human-in-   │
│ (open email │     │ (Hybrid RAG  │     │    Generate    │     │  the-loop    │
│   thread)   │     │ over your    │     │ (chosen LLM    │     │ (review/edit │
│             │     │ knowledge    │     │ drafts a reply)│     │  the draft)  │
│             │     │ base)        │     │                │     │              │
└─────────────┘     └──────────────┘     └───────────────┘     └──────┬───────┘
                                                                        │
                                                                        v
                                                                 ┌──────────────┐
                                                                 │    Act       │
                                                                 │ (Send via    │
                                                                 │  Gmail API,  │
                                                                 │  only on     │
                                                                 │  explicit    │
                                                                 │  click)      │
                                                                 └──────┬───────┘
                                                                        │
                                                                        v
                                                                 ┌──────────────┐
                                                                 │   Memory /   │
                                                                 │   Feedback   │
                                                                 │ (log draft,  │
                                                                 │ sent reply,  │
                                                                 │ star rating) │
                                                                 └──────────────┘
```

1. **Trigger** — the user opens an email thread in the dashboard and clicks "Draft Reply with AI".
2. **Retrieve** — the latest email is embedded and run through a **Hybrid RAG** pipeline: semantic
   search (pgvector, HNSW cosine similarity) and keyword search (Postgres full-text, GIN index)
   run in parallel, their candidates are merged and deduplicated, then reranked with a
   cross-encoder; the top 3 chunks become the final context, labelled by source file. Retrieval
   can be optionally scoped to a subset of uploaded files/folders per thread.
3. **Reason / Generate** — the selected LLM provider (Groq, OpenAI, or Gemini — the user's own API
   key) is called server-side with: the user's writing rules, the labelled RAG context, the full
   thread with each message tagged by sender identity (owner vs. external party) so the model
   never confuses who it's writing as, and a length-capped version of the thread to stay within
   context limits. The reply streams back token-by-token via SSE.
4. **Human-in-the-loop checkpoint** — the draft lands in an editable textarea. The user can
   regenerate, switch models, or edit the text freely. **This is a hard constraint, not a
   convenience**: nothing is ever sent without this step.
5. **Act** — only on explicit "Send" does the agent call the Gmail API to actually deliver the
   reply.
6. **Memory / Feedback** — the original AI draft, the final sent text (tracked separately — edits
   never overwrite what the model produced), the model used, and the retrieved context are logged
   to Supabase, along with an optional post-send star rating and text feedback, closing the loop
   for future quality tracking.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router, Turbopack), React, Tailwind CSS, shadcn/ui (base-ui) |
| Hosting | Vercel (frontend + API routes, serverless) |
| LLM inference | Multi-provider — Groq, OpenAI, Google Gemini — user supplies and owns the API key per provider |
| Email | Gmail API via OAuth 2.0 (readonly + send + contacts scopes) |
| Auth | Supabase Auth (Google OAuth), multi-tenant with per-user Row Level Security |
| Database | Supabase Postgres + `pgvector` |
| File storage | Supabase Storage |
| Vector embeddings | Hugging Face `all-mpnet-base-v2` (768-dim) |
| Reranker | Hugging Face `cross-encoder/ms-marco-MiniLM-L-6-v2` |
| File parsing | `pdf-parse`, `mammoth` (DOCX), `cheerio` (HTML) |
| Panels / layout | `react-resizable-panels` |
| Theming | `next-themes` (light/dark/system) |

---

## Key Architectural Decisions

- **Human-in-the-loop send, non-negotiable.** The agent has no code path that calls the Gmail
  send API without a direct user click. This is enforced at the UI level (one Send button) and
  treated as a hard product constraint, not just a default.
- **Bring-your-own LLM key, multi-provider.** Rather than a single baked-in model, users
  configure their own Groq/OpenAI/Gemini key. Keys are validated against a live API call on save,
  then encrypted at rest (AES-256-GCM) and never returned to the client; all LLM calls happen
  server-side only.
- **Hybrid retrieval over pure vector search.** Semantic-only search misses exact keyword/name
  matches that full-text search catches (and vice versa), so both run in parallel and get merged
  before reranking — the cross-encoder rerank step then resolves the combined candidate pool down
  to the top 3, trading a little extra latency for materially better relevance.
- **HNSW over IVFFlat for the vector index.** Chosen for better recall without needing to
  pre-tune a cluster count as the knowledge base grows — IVFFlat's accuracy depends on picking a
  cluster count upfront that's hard to get right for a corpus of unknown/variable size.
- **Recursive chunking (256 chars, 64 overlap), not fixed-size.** Keeps chunks small enough for
  precise retrieval while the overlap prevents context from being severed at an arbitrary
  boundary.
- **Sender/recipient identity injected into every prompt.** Each message in a thread is labelled
  as "You (the account owner)" or "External sender" before it reaches the LLM — without this the
  model has no way to know who it's drafting a reply *as* versus *to*, and will hallucinate
  perspective.
- **Thread-length capping, not truncation.** Long threads keep the last 3 messages verbatim and
  condense older ones to ~220 characters each (rather than dropping them), with a hard ~6000-char
  ceiling — preserves some sense of history instead of just cutting it off, while avoiding
  context-window overflow errors on smaller models.
- **RAG is resilient, not a hard dependency.** Embedding/reranker calls are wrapped so a Hugging
  Face outage degrades to "draft without context" (or semantic-only ranking if just the reranker
  fails) instead of crashing the whole draft request.
- **Multi-tenant from the data layer up.** Every table (`user_settings`, `uploaded_files`,
  `doc_chunks`, `email_replies`) carries Row Level Security scoped to `auth.uid() = user_id`, and
  no API route uses the Supabase service-role key to bypass it — each signed-in user only ever
  sees their own inbox, files, and drafts. Opening the app from single-owner to public multi-user
  sign-in required no database changes as a result.
- **Sources are retrieved silently.** RAG context informs the draft but is never surfaced in the
  reply body unless the user's own writing rules say otherwise — the agent is meant to sound like
  the user, not cite its homework.
- **Draft and sent text are stored separately.** The original AI draft is never overwritten by
  user edits in the log — both are kept, so draft quality can be evaluated independently of what
  a human changed before sending.

---

## Repository Structure

```
src/
  app/
    api/              API routes (Gmail, files, drafting, settings, auth)
    dashboard/         Main authenticated dashboard
    login/              Sign-in page
    privacy/, terms/    Public pages (required for Google OAuth verification)
  components/           React components (inbox, draft panel, file panel, settings, etc.)
  lib/                   Core logic: gmail.ts, retrieval.ts, embeddings.ts, llm.ts, encryption.ts
  proxy.ts               Auth gate (replaces middleware.ts — Next.js 16 convention)
supabase/
  migrations*.sql        Database schema, RLS policies, indexes
CLAUDE.md                 Full living project documentation (schema, env vars, phase history)
CHANGELOG.md               Consolidated history of every feedback round and its resolution
```

See `CLAUDE.md` for the full Supabase schema, environment variable reference, and detailed
phase-by-phase build history; see `CHANGELOG.md` for a chronological log of bug fixes and
UI/UX iterations.

---

## Local Development

```bash
npm install
cp .env.example .env.local   # fill in your own values
npm run dev
```

Required environment variables (see `.env.example`):

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

You'll also need a Supabase project (run `supabase/migrations*.sql` in order) and a Google Cloud
OAuth client with the Gmail API, People API, and Google OAuth consent screen configured.

---

## Deployment

- **Frontend + API routes:** [Vercel](https://vercel.com) (Next.js 16, serverless functions)
- **Database/Auth/Storage:** [Supabase](https://supabase.com)
- **Live URL:** https://email-reply-agent-tau.vercel.app

Sign-in is open to any Google account (multi-tenant). Note: because Echo requests sensitive
Gmail scopes (`gmail.send`, `gmail.readonly`), broad public access depends on the Google OAuth
consent screen completing Google's verification review — see `CLAUDE.md`'s Phase 8 notes for
details.
