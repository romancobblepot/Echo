import { createClient } from "@/lib/supabase/server";
import { retrieveContext, formatContextForPrompt } from "@/lib/retrieval";
import { streamReply, type Provider } from "@/lib/llm";
import { getDecryptedKey } from "@/app/api/settings/route";
import { NextResponse } from "next/server";

const THREAD_DELIMITER = "\n\n---\n\n";
const RECENT_MESSAGE_COUNT = 3;   // kept verbatim, regardless of length
const OLDER_SNIPPET_CHARS = 220;  // older messages condensed to this many chars
const MAX_THREAD_CHARS = 6000;    // ~1500 tokens — final safety net so small-context
                                   // models (e.g. 8192-token Groq models) always have
                                   // room left for the system prompt, RAG context, and
                                   // the completion itself

// Caps the annotated thread text sent to the LLM so long threads don't blow the
// model's context window. The most recent messages stay verbatim (what matters most
// for drafting a relevant reply); older ones get condensed to short snippets instead
// of being dropped outright, so the model still has some sense of earlier context.
function capThreadForPrompt(threadText: string): string {
  const messages = threadText.split(THREAD_DELIMITER);

  let combined: string;
  if (messages.length <= RECENT_MESSAGE_COUNT) {
    combined = threadText;
  } else {
    const older = messages.slice(0, -RECENT_MESSAGE_COUNT);
    const recent = messages.slice(-RECENT_MESSAGE_COUNT);
    const condensedOlder = older.map((m) =>
      m.length > OLDER_SNIPPET_CHARS ? m.slice(0, OLDER_SNIPPET_CHARS) + "…" : m
    );
    combined = [...condensedOlder, ...recent].join(THREAD_DELIMITER);
  }

  // Final safety net — even a handful of very long recent messages could still overflow.
  // Keep the tail, since the most recent content matters most for drafting a reply.
  if (combined.length > MAX_THREAD_CHARS) {
    combined = "…[earlier thread content truncated]…\n\n" + combined.slice(-MAX_THREAD_CHARS);
  }

  return combined;
}

export async function POST(request: Request) {
  try {
    return await handleDraft(request);
  } catch (err) {
    console.error("Draft route crashed:", err);
    return NextResponse.json({ error: (err as Error).message ?? "Unexpected server error" }, { status: 500 });
  }
}

async function handleDraft(request: Request): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const {
    threadText,      // full thread text for RAG query, annotated per-message with sender role
    emailBody,       // the specific email to reply to
    subject,
    userEmail,       // the account owner's own email — who the reply is drafted AS
    recipientEmail,  // raw "From" header of the external party being replied TO
    provider,
    modelId,
    writingRules,    // string[]
    fileIds,         // optional: scoped file ids
  }: {
    threadText: string;
    emailBody: string;
    subject: string;
    userEmail?: string;
    recipientEmail?: string;
    provider: Provider;
    modelId: string;
    writingRules: string[];
    fileIds?: string[];
  } = body;

  if (!threadText || !provider || !modelId) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Decrypt the provider key server-side
  let apiKey: string;
  try {
    apiKey = await getDecryptedKey(user.id, provider);
  } catch {
    return NextResponse.json({ error: `No ${provider} API key saved. Add it in Settings.` }, { status: 403 });
  }

  // Retrieve context from knowledge base — degrade to no-context on any failure
  // rather than crashing the whole request (RAG is an enhancement, not a hard dependency)
  let contextBlock = "";
  let retrievedContext: { file_name: string; chunk_text: string; score: number }[] = [];
  try {
    const chunks = await retrieveContext(threadText, user.id, 3, fileIds);
    contextBlock = formatContextForPrompt(chunks);
    retrievedContext = chunks.map((c) => ({
      file_name: c.file_name,
      chunk_text: c.chunk_text,
      score: c.score,
    }));
  } catch (err) {
    console.error("RAG retrieval failed, drafting without context:", err);
  }

  // Build system prompt — never include raw sources in reply
  const rulesText =
    writingRules && writingRules.length > 0
      ? `\n\nWriting rules you MUST follow:\n${writingRules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`
      : "";

  const contextSection =
    contextBlock
      ? `\n\nRelevant context from the user's knowledge base (use this to inform your reply, but do NOT mention these sources or quote them verbatim in your reply):\n\n${contextBlock}`
      : "";

  // Without this, the model has no way to tell who it's writing AS vs. who it's writing
  // TO — it only sees raw message bodies with no sender identity, which causes it to
  // hallucinate (e.g. addressing the owner as if they were the external sender, or
  // drafting a reply "to" the owner's own inbox).
  const identitySection =
    userEmail
      ? `\n\nIMPORTANT — perspective: You are drafting this reply AS the email account owner (${userEmail}). You are replying TO ${recipientEmail || "the external sender"}, who sent the message you're responding to. Write strictly from the owner's point of view, addressed to that external person. Never write as if you ARE the external sender, never address the owner by name as if someone is speaking to them, and never confuse who sent which message in the thread below (each message is labelled with who sent it).`
      : "";

  const systemPrompt =
    `You are a professional email assistant. Draft a concise, helpful reply to the email thread below.` +
    identitySection +
    rulesText +
    contextSection +
    `\n\nGuidelines:\n- Write only the reply body (no subject line, no "From:", no metadata)\n- Match the tone of the thread\n- Be concise and direct\n- Never mention internal sources or knowledge base documents`;

  const cappedThreadText = capThreadForPrompt(threadText);

  const userMessage =
    `Subject: ${subject}\n\nThread so far (each message labelled with who sent it; older messages may be condensed to save space):\n${cappedThreadText}` +
    `\n\n---\n\nMost recent message to reply to:\n${emailBody}`;

  // Stream via SSE
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };

      try {
        await streamReply(provider, apiKey, modelId, systemPrompt, userMessage, (chunk) => {
          send("chunk", JSON.stringify({ text: chunk }));
        });
        send("done", JSON.stringify({
          modelUsed: `${provider}:${modelId}`,
          retrievedContext,
        }));
      } catch (err) {
        send("error", JSON.stringify({ message: (err as Error).message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
