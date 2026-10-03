"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, X, Loader2, Pencil } from "lucide-react";

interface Props {
  /** When provided, this is a review-before-draft popup */
  onConfirm?: (rules: string[]) => void;
  onClose?: () => void;
}

export function WritingRulesEditor({ onConfirm, onClose }: Props = {}) {
  const [rules, setRules] = useState<string[]>([]);
  const [newRule, setNewRule] = useState("");
  const [askEveryTime, setAskEveryTime] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setRules(d.writingRules ?? []);
        setAskEveryTime(d.askRulesEveryTime ?? false);
      })
      .finally(() => setLoading(false));
  }, []);

  function addRule() {
    const trimmed = newRule.trim();
    if (trimmed && !rules.includes(trimmed)) setRules([...rules, trimmed]);
    setNewRule("");
  }

  async function handleSave() {
    setSaving(true);
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save_writing_rules", rules, askEveryTime }),
    });
    setSaving(false);
    if (onConfirm) onConfirm(rules);
    else if (onClose) onClose();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 size={20} className="animate-spin text-zinc-400" />
      </div>
    );
  }

  const isPopup = !!onConfirm;

  return (
    <div className={isPopup ? "fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" : ""}>
      <div className={isPopup ? "bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-md" : ""}>
        {isPopup && (
          <div className="px-6 pt-6 pb-4 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold flex items-center gap-2">
                <Pencil size={16} /> Review writing rules
              </h2>
              <p className="text-xs text-zinc-500 mt-0.5">These will guide how your reply is drafted.</p>
            </div>
            {onClose && (
              <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600" title="Close">
                <X size={18} />
              </button>
            )}
          </div>
        )}

        <div className={`space-y-3 ${isPopup ? "px-6 py-5" : ""}`}>
          {!isPopup && (
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Writing Rules</p>
          )}

          <div className="flex gap-2">
            <Input
              placeholder="e.g. Always start with 'Hi [name]'"
              value={newRule}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewRule(e.target.value)}
              onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && addRule()}
              className="text-sm"
            />
            <Button variant="outline" size="icon" onClick={addRule} disabled={!newRule.trim()} title="Add rule">
              <Plus size={15} />
            </Button>
          </div>

          <div className="space-y-2 min-h-[56px]">
            {rules.length === 0 && (
              <p className="text-xs text-zinc-400 italic">No rules defined yet.</p>
            )}
            {rules.map((rule, i) => (
              <div key={i} className="flex items-center gap-2 bg-zinc-50 dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm">
                <span className="flex-1">{rule}</span>
                <button onClick={() => setRules(rules.filter((_, j) => j !== i))} title="Remove rule">
                  <X size={13} className="text-zinc-400 hover:text-red-500" />
                </button>
              </div>
            ))}
          </div>

          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={askEveryTime}
              onChange={(e) => setAskEveryTime(e.target.checked)}
              className="w-4 h-4 rounded accent-primary"
            />
            <span className="text-sm text-zinc-600 dark:text-zinc-400">Review rules before every draft</span>
          </label>
        </div>

        {isPopup && (
          <div className="px-6 pb-6 flex justify-end gap-2">
            {onClose && <Button variant="ghost" onClick={onClose}>Cancel</Button>}
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 size={14} className="animate-spin mr-1" /> : null}
              {isPopup ? "Draft with these rules" : "Save"}
            </Button>
          </div>
        )}

        {!isPopup && (
          <Button onClick={handleSave} disabled={saving} className="mt-2">
            {saving ? <Loader2 size={14} className="animate-spin mr-1" /> : null}
            Save Rules
          </Button>
        )}
      </div>
    </div>
  );
}
