"use client";

import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, AlertTriangle, ChevronDown } from "lucide-react";

type Provider = "openai" | "groq" | "gemini";

interface ModelInfo {
  id: string;
  name: string;
  provider: Provider;
  tags: string[];
  contextWindow: number;
  supported: boolean;
}

interface Props {
  provider: Provider;
  onProviderChange: (p: Provider) => void;
  selectedModel: string;
  onModelChange: (id: string) => void;
  hasKeys: { openai: boolean; groq: boolean; gemini: boolean };
}

const TAG_COLORS: Record<string, string> = {
  "instruction-following": "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  reasoning:               "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  fast:                    "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  long:                    "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  business:                "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200",
  personal:                "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
  short:                   "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  general:                 "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

const PROVIDER_LABELS: Record<Provider, string> = { openai: "OpenAI", groq: "Groq", gemini: "Gemini" };

// Short explanations for the capability tags — "instruction-following" and "long"
// specifically aren't self-evident at a glance, so a hover hint helps.
const TAG_DESCRIPTIONS: Record<string, string> = {
  "instruction-following": "Reliably follows your writing rules, not just writes well",
  reasoning: "Better at multi-step or nuanced replies",
  fast: "Quick responses, good for short everyday replies",
  long: "Large context window — handles long threads well",
  business: "Well-suited to formal/professional tone",
  personal: "Well-suited to casual/personal tone",
  short: "Best for brief, concise replies",
  general: "No specific strength data available for this model",
};

export function ModelSelector({ provider, onProviderChange, selectedModel, onModelChange, hasKeys }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!hasKeys[provider]) {
      setModels([]);
      return;
    }
    setLoading(true);
    setError("");
    fetch(`/api/models?provider=${provider}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setModels(d.models ?? []);
        // auto-select first model if current selection doesn't match provider
        if (d.models?.length > 0 && !d.models.find((m: ModelInfo) => m.id === selectedModel)) {
          onModelChange(d.models[0].id);
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [provider, hasKeys]);

  const current = models.find((m) => m.id === selectedModel);

  return (
    <div className="space-y-2">
      {/* Provider tabs */}
      <div className="flex gap-1.5">
        {(["openai", "groq", "gemini"] as Provider[]).map((p) => (
          <button
            key={p}
            onClick={() => onProviderChange(p)}
            className={`flex-1 py-1 rounded-md text-xs font-medium border transition relative ${
              provider === p
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-primary/50"
            }`}
          >
            {PROVIDER_LABELS[p]}
            {!hasKeys[p] && (
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-400 rounded-full" title="No key saved" />
            )}
          </button>
        ))}
      </div>

      {/* Model dropdown */}
      {!hasKeys[provider] ? (
        <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2">
          <AlertTriangle size={13} />
          No API key for {PROVIDER_LABELS[provider]}. Add one in Settings.
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 text-xs text-zinc-500 px-1">
          <Loader2 size={13} className="animate-spin" /> Loading models...
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
          <AlertTriangle size={13} /> {error}
        </div>
      ) : (
        <div className="relative">
          <button
            onClick={() => setOpen(!open)}
            className="w-full flex items-center justify-between gap-2 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-zinc-800 hover:border-primary/50 transition"
          >
            <span className="truncate text-left">
              {current ? current.name : "Select a model"}
            </span>
            <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>

          {open && (
            <div className="absolute z-20 top-full mt-1 w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-lg max-h-64 overflow-y-auto">
              {models.map((m) => (
                <button
                  key={m.id}
                  onClick={() => { onModelChange(m.id); setOpen(false); }}
                  className={`w-full text-left px-3 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition flex flex-col gap-1 ${
                    m.id === selectedModel ? "bg-primary/10 dark:bg-primary/20" : ""
                  } ${!m.supported ? "opacity-50" : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{m.name}</span>
                    {!m.supported && (
                      <span className="text-xs text-amber-600 flex items-center gap-0.5">
                        <AlertTriangle size={11} /> unsupported
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {m.tags.map((tag) => (
                      <span
                        key={tag}
                        title={TAG_DESCRIPTIONS[tag] ?? undefined}
                        className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium cursor-help ${TAG_COLORS[tag] ?? TAG_COLORS.general}`}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
