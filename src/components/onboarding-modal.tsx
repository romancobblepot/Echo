"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CheckCircle, AlertTriangle, Plus, X, Loader2, Eye, EyeOff } from "lucide-react";

type Provider = "openai" | "groq" | "gemini";

interface Props {
  onComplete: () => void;
  /** When true, show an X close button (settings re-open, not first-time) */
  closeable?: boolean;
}

const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  groq: "Groq",
  gemini: "Gemini",
};

export function OnboardingModal({ onComplete, closeable = false }: Props) {
  const [step, setStep] = useState<1 | 2>(1);

  // Step 1 state
  const [provider, setProvider] = useState<Provider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keyStatus, setKeyStatus] = useState<"idle" | "ok" | "error">("idle");
  const [keyError, setKeyError] = useState("");
  const [existingKeys, setExistingKeys] = useState<Record<Provider, boolean>>({
    openai: false,
    groq: false,
    gemini: false,
  });
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [showOverwriteConfirm, setShowOverwriteConfirm] = useState(false);

  // Step 2 state
  const [rules, setRules] = useState<string[]>([]);
  const [newRule, setNewRule] = useState("");
  const [askEveryTime, setAskEveryTime] = useState(false);
  const [savingRules, setSavingRules] = useState(false);

  // Reflect keys already saved from a previous session — previously this always showed
  // a blank "enter your key" field even when one was already on file.
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setExistingKeys({
          openai: !!d.hasOpenAIKey,
          groq: !!d.hasGroqKey,
          gemini: !!d.hasGeminiKey,
        });
        // Jump to whichever provider already has a key, if any, so it's visible immediately
        const withKey = (["openai", "groq", "gemini"] as Provider[]).find(
          (p) => !!d[`has${p.charAt(0).toUpperCase() + p.slice(1)}Key`]
        );
        if (withKey) setProvider(withKey);
      })
      .catch(() => { /* stay with defaults if settings unavailable */ })
      .finally(() => setLoadingExisting(false));
  }, []);

  async function handleSaveKey() {
    if (!apiKey.trim()) return;
    setSaving(true);
    setKeyStatus("idle");
    setKeyError("");
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_api_key", provider, apiKey: apiKey.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to save key");
      setKeyStatus("ok");
      setExistingKeys((prev) => ({ ...prev, [provider]: true }));
    } catch (err) {
      setKeyStatus("error");
      setKeyError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function handleSaveKeyClick() {
    if (!apiKey.trim()) return;
    if (existingKeys[provider]) {
      setShowOverwriteConfirm(true);
    } else {
      handleSaveKey();
    }
  }

  function addRule() {
    const trimmed = newRule.trim();
    if (trimmed && !rules.includes(trimmed)) {
      setRules([...rules, trimmed]);
    }
    setNewRule("");
  }

  async function handleFinish() {
    setSavingRules(true);
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save_writing_rules", rules, askEveryTime }),
    });
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete_onboarding" }),
    });
    setSavingRules(false);
    onComplete();
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="relative bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-md">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-zinc-200 dark:border-zinc-700">
          {closeable && (
            <button
              onClick={onComplete}
              className="absolute top-4 right-4 text-zinc-400 hover:text-zinc-600"
              aria-label="Close"
              title="Close"
            >
              <X size={18} />
            </button>
          )}
          <div className={`flex items-center gap-2 mb-1 ${closeable ? "pr-8" : ""}`}>
            <span className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center ${step >= 1 ? "bg-primary text-primary-foreground" : "bg-zinc-200 dark:bg-zinc-700 text-zinc-500"}`}>1</span>
            <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
            <span className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center ${step >= 2 ? "bg-primary text-primary-foreground" : "bg-zinc-200 dark:bg-zinc-700 text-zinc-500"}`}>2</span>
          </div>
          <h2 className="text-lg font-semibold mt-3">
            {step === 1 ? "Connect your AI provider" : "Set writing rules"}
          </h2>
          <p className="text-sm text-zinc-500 mt-0.5">
            {step === 1
              ? "Add an API key to enable AI-powered draft generation."
              : "Define how your replies should be written. You can change these anytime."}
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {step === 1 && (
            <>
              {/* Provider tabs */}
              <div className="flex gap-2">
                {(["openai", "groq", "gemini"] as Provider[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => { setProvider(p); setKeyStatus("idle"); setApiKey(""); }}
                    className={`relative flex-1 py-1.5 rounded-lg text-sm font-medium border transition ${
                      provider === p
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:border-primary/50"
                    }`}
                  >
                    {PROVIDER_LABELS[p]}
                    {existingKeys[p] && (
                      <span
                        className={`absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center text-[10px] ${
                          provider === p ? "bg-white text-primary" : "bg-green-500 text-white"
                        }`}
                        title="Key saved"
                      >
                        ✓
                      </span>
                    )}
                  </button>
                ))}
              </div>

              {existingKeys[provider] && keyStatus !== "ok" && (
                <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 dark:bg-green-900/20 rounded-lg px-3 py-2">
                  <CheckCircle size={16} className="shrink-0" />
                  A {PROVIDER_LABELS[provider]} key is already saved. Enter a new one below only if you want to replace it.
                </div>
              )}

              {/* Key input */}
              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  placeholder={
                    existingKeys[provider]
                      ? "Enter a new key to replace the saved one (optional)"
                      : `${PROVIDER_LABELS[provider]} API key`
                  }
                  value={apiKey}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setApiKey(e.target.value); setKeyStatus("idle"); }}
                  className="pr-10 font-mono text-sm"
                />
                <button
                  type="button"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
                  onClick={() => setShowKey(!showKey)}
                  title={showKey ? "Hide API key" : "Show API key"}
                >
                  {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>

              {keyStatus === "ok" && (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <CheckCircle size={16} /> Key validated and saved securely
                </div>
              )}
              {keyStatus === "error" && (
                <div className="flex items-center gap-2 text-sm text-red-600">
                  <AlertTriangle size={16} /> {keyError}
                </div>
              )}

              <Button
                onClick={handleSaveKeyClick}
                disabled={!apiKey.trim() || saving}
                className="w-full"
              >
                {saving ? <Loader2 size={16} className="animate-spin mr-2" /> : null}
                {saving ? "Validating..." : existingKeys[provider] ? "Replace Key" : "Validate & Save Key"}
              </Button>

              <AlertDialog open={showOverwriteConfirm} onOpenChange={setShowOverwriteConfirm}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Replace {PROVIDER_LABELS[provider]} key?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently overwrite your saved {PROVIDER_LABELS[provider]} API key. This can't be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => { setShowOverwriteConfirm(false); handleSaveKey(); }}
                    >
                      Replace Key
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}

          {step === 2 && (
            <>
              <div className="flex gap-2">
                <Input
                  placeholder="e.g. Keep replies under 3 sentences"
                  value={newRule}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewRule(e.target.value)}
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && addRule()}
                />
                <Button variant="outline" size="icon" onClick={addRule} disabled={!newRule.trim()} title="Add rule">
                  <Plus size={16} />
                </Button>
              </div>

              <div className="space-y-2 min-h-[60px]">
                {rules.length === 0 && (
                  <p className="text-sm text-zinc-400 italic">No rules yet — you can skip this step.</p>
                )}
                {rules.map((rule, i) => (
                  <div key={i} className="flex items-center gap-2 bg-zinc-50 dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm">
                    <span className="flex-1">{rule}</span>
                    <button onClick={() => setRules(rules.filter((_, j) => j !== i))} title="Remove rule">
                      <X size={14} className="text-zinc-400 hover:text-red-500" />
                    </button>
                  </div>
                ))}
              </div>

              <label className="flex items-center gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={askEveryTime}
                  onChange={(e) => setAskEveryTime(e.target.checked)}
                  className="w-4 h-4 rounded accent-primary"
                />
                <span className="text-sm">Review rules before every draft</span>
              </label>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex justify-between gap-3">
          {step === 1 ? (
            <>
              <Button variant="ghost" onClick={() => setStep(2)}>Skip for now</Button>
              <Button
                onClick={() => setStep(2)}
                disabled={keyStatus !== "ok" && !existingKeys[provider]}
              >
                Continue
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
              <Button onClick={handleFinish} disabled={savingRules}>
                {savingRules ? <Loader2 size={16} className="animate-spin mr-2" /> : null}
                Finish Setup
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
