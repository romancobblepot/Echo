"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ModelSelector } from "./model-selector";
import { WritingRulesEditor } from "./writing-rules-editor";
import { FeedbackModal } from "./feedback-modal";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { Loader2, RefreshCw, Send, Pencil, Check, ListFilter, ScrollText } from "lucide-react";

type Provider = "openai" | "groq" | "gemini";

export interface RetrievedChunk {
  file_name: string;
  chunk_text: string;
  score: number;
}

export interface SendPayload {
  draftBody: string;      // final, possibly user-edited text actually sent
  originalDraft: string;  // AI-generated text before any edits
  modelUsed: string;      // "provider:modelId"
  retrievedContext: RetrievedChunk[];
}

interface Props {
  threadText: string;
  emailBody: string;
  subject: string;
  /** The account owner's own email — lets the model distinguish "you" from the external sender */
  userEmail: string;
  /** Raw "From" header of the external party being replied to */
  recipientEmail: string;
  scopedFileIds?: string[];
  scopingMode: boolean;
  selectedFileCount: number;
  onToggleScopingMode: () => void;
  /** Returns the created email_replies row id (for feedback), or null if logging failed */
  onSend: (payload: SendPayload) => Promise<string | null>;
}

export function DraftPanel({
  threadText,
  emailBody,
  subject,
  userEmail,
  recipientEmail,
  scopedFileIds,
  scopingMode,
  selectedFileCount,
  onToggleScopingMode,
  onSend,
}: Props) {
  const [provider, setProvider] = useState<Provider>("openai");
  const [modelId, setModelId] = useState("");
  const [hasKeys, setHasKeys] = useState({ openai: false, groq: false, gemini: false });
  const [writingRules, setWritingRules] = useState<string[]>([]);
  const [askEveryTime, setAskEveryTime] = useState(false);
  const [showRulesPopup, setShowRulesPopup] = useState(false);
  const [showRulesEditor, setShowRulesEditor] = useState(false);
  const [draft, setDraft] = useState("");
  const [originalDraft, setOriginalDraft] = useState("");
  const [modelUsed, setModelUsed] = useState("");
  const [retrievedContext, setRetrievedContext] = useState<RetrievedChunk[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [feedbackReplyId, setFeedbackReplyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  function loadSettings() {
    return fetch("/api/settings")
      .then((r) => {
        if (!r.ok) throw new Error(`Settings fetch failed: ${r.status}`);
        return r.json();
      })
      .then((d) => {
        setHasKeys({ openai: !!d.hasOpenAIKey, groq: !!d.hasGroqKey, gemini: !!d.hasGeminiKey });
        setWritingRules(d.writingRules ?? []);
        setAskEveryTime(d.askRulesEveryTime ?? false);
        const withKey = (["openai", "groq", "gemini"] as Provider[]).find(
          (p) => !!d[`has${p.charAt(0).toUpperCase() + p.slice(1)}Key`]
        );
        if (withKey) setProvider(withKey);
      })
      .catch(() => { /* stay with defaults if settings unavailable */ });
  }

  // Load settings on mount
  useEffect(() => {
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startDraft(rules: string[]) {
    if (!modelId) return;
    setError("");
    setDraft("");
    setOriginalDraft("");
    setModelUsed("");
    setRetrievedContext([]);
    setSent(false);
    setStreaming(true);

    let fullText = "";
    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/reply/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadText,
          emailBody,
          subject,
          userEmail,
          recipientEmail,
          provider,
          modelId,
          writingRules: rules,
          fileIds: scopedFileIds,
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        let msg = `Draft failed (${res.status})`;
        try {
          const d = await res.json();
          msg = d.error ?? msg;
        } catch { /* non-JSON error body */ }
        throw new Error(msg);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const lines = part.split("\n");
          const eventLine = lines.find((l) => l.startsWith("event:"));
          const dataLine = lines.find((l) => l.startsWith("data:"));
          if (!eventLine || !dataLine) continue;
          const event = eventLine.replace("event:", "").trim();
          const data = JSON.parse(dataLine.replace("data:", "").trim());
          if (event === "chunk") {
            fullText += data.text;
            setDraft((prev) => prev + data.text);
          }
          if (event === "error") throw new Error(data.message);
          if (event === "done") {
            setOriginalDraft(fullText);
            setModelUsed(data.modelUsed ?? `${provider}:${modelId}`);
            setRetrievedContext(data.retrievedContext ?? []);
            break;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError((err as Error).message);
      }
    } finally {
      setStreaming(false);
    }
  }

  function handleDraftClick() {
    if (askEveryTime) {
      setShowRulesPopup(true);
    } else {
      startDraft(writingRules);
    }
  }

  function clearDraft() {
    setDraft("");
    setOriginalDraft("");
    setModelUsed("");
    setRetrievedContext([]);
    setSent(false);
    setFeedbackReplyId(null);
  }

  async function handleSend() {
    setSending(true);
    setError("");
    try {
      const replyId = await onSend({
        draftBody: draft,
        originalDraft,
        modelUsed,
        retrievedContext,
      });

      if (replyId) {
        // Feedback modal handles clearing the draft once it's dismissed
        setFeedbackReplyId(replyId);
      } else {
        // Logging failed server-side, so there's no row to attach feedback to —
        // fall back to a brief inline confirmation instead.
        setSent(true);
        setTimeout(clearDraft, 1800);
      }
    } catch (err) {
      setError((err as Error).message ?? "Failed to send");
    } finally {
      setSending(false);
    }
  }

  const canDraft = modelId && (hasKeys[provider]);

  return (
    <div className="flex flex-col gap-4">
      {/* Primary actions — this is the app's main action, so it leads, with Sources
          paired right beside it at matching visual weight rather than buried
          in the thread header. */}
      <div className="flex gap-2">
        <Button
          size="lg"
          variant={scopingMode ? "default" : "outline"}
          className="shrink-0 gap-1.5"
          onClick={onToggleScopingMode}
          title="Select which knowledge base files to use for this draft"
        >
          <ListFilter size={15} />
          {scopingMode
            ? (selectedFileCount > 0 ? `${selectedFileCount} file${selectedFileCount !== 1 ? "s" : ""}` : "All files")
            : "Sources"}
        </Button>
        <Button
          size="lg"
          onClick={handleDraftClick}
          disabled={!canDraft || streaming}
          className="flex-1 gap-1.5 font-semibold"
        >
          {streaming ? (
            <><Loader2 size={16} className="animate-spin" /> Drafting...</>
          ) : (
            <><Pencil size={16} /> Draft Reply with AI ✨</>
          )}
        </Button>
      </div>

      {/* Writing rules indicator — surfaces a feature that was previously only
          discoverable via the header Settings button, with a direct way to edit it
          without leaving this panel. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setShowRulesEditor(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setShowRulesEditor(true); } }}
        className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-3 py-2.5 text-sm hover:border-primary/50 transition cursor-pointer"
      >
        <span className="flex items-center gap-2 min-w-0">
          <ScrollText size={16} className="text-muted-foreground shrink-0" />
          <span className="font-medium truncate">
            {writingRules.length > 0
              ? `${writingRules.length} writing rule${writingRules.length !== 1 ? "s" : ""} active`
              : "No writing rules set"}
          </span>
          {/* Tooltip trigger is its own button internally — must not nest inside the
              row's own clickable element, or React throws a <button> in <button>
              hydration error. The outer row uses role="button" on a <div> instead,
              not a literal <button>, specifically to allow this safely. */}
          <span onClick={(e) => e.stopPropagation()}>
            <InfoTooltip text="Writing rules are instructions the AI must follow on every draft — tone, length, sign-off, formatting, etc. Set them once here, or turn on 'review before every draft' to tweak them each time you draft." />
          </span>
        </span>
        <span className="text-primary font-medium flex items-center gap-1 shrink-0">
          Edit <Pencil size={13} />
        </span>
      </div>

      <ModelSelector
        provider={provider}
        onProviderChange={setProvider}
        selectedModel={modelId}
        onModelChange={setModelId}
        hasKeys={hasKeys}
      />

      {/* Draft area */}
      <div className="flex flex-col gap-2">
        {draft || streaming ? (
          <>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full min-h-[180px] rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-4 py-3 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Draft will appear here..."
            />
            {streaming && (
              <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                <Loader2 size={12} className="animate-spin" /> Drafting...
              </div>
            )}
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 px-4 py-8 text-center text-sm text-zinc-400">
            Click "Draft Reply with AI ✨" above to generate a reply.
          </div>
        )}

        {error && (
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>

      {/* Secondary actions — only once a draft exists */}
      {(draft || sent) && !streaming && !feedbackReplyId && (
        <div className="flex gap-2 flex-wrap">
          {!sent && (
            <>
              <Button
                variant="outline"
                onClick={handleDraftClick}
                disabled={!canDraft || sending}
              >
                <RefreshCw size={14} className="mr-1.5" /> Regenerate
              </Button>
              <Button
                variant="default"
                className="bg-green-600 hover:bg-green-700"
                onClick={handleSend}
                disabled={sending}
              >
                {sending ? (
                  <><Loader2 size={14} className="animate-spin mr-1.5" /> Sending...</>
                ) : (
                  <><Send size={14} className="mr-1.5" /> Send</>
                )}
              </Button>
            </>
          )}

          {sent && (
            <div className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-sm font-medium py-2">
              <Check size={15} /> Sent
            </div>
          )}
        </div>
      )}

      {/* Rules popup */}
      {showRulesPopup && (
        <WritingRulesEditor
          onConfirm={(rules) => {
            setShowRulesPopup(false);
            setWritingRules(rules);
            startDraft(rules);
          }}
          onClose={() => setShowRulesPopup(false)}
        />
      )}

      {/* Post-send feedback */}
      {feedbackReplyId && (
        <FeedbackModal replyId={feedbackReplyId} onClose={clearDraft} />
      )}

      {/* Standalone writing-rules editor, opened from the indicator above */}
      {showRulesEditor && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">Writing Rules</h2>
              <button
                onClick={() => { setShowRulesEditor(false); loadSettings(); }}
                className="text-zinc-400 hover:text-zinc-600 text-lg leading-none"
                title="Close"
              >
                ✕
              </button>
            </div>
            <WritingRulesEditor onClose={() => { setShowRulesEditor(false); loadSettings(); }} />
          </div>
        </div>
      )}
    </div>
  );
}
