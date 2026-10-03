"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Settings, RefreshCw } from "lucide-react";
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
import { OnboardingModal } from "./onboarding-modal";
import { WritingRulesEditor } from "./writing-rules-editor";

export default function SettingsButton() {
  const [open, setOpen] = useState<null | "keys" | "rules">(null);
  const [showReconnectConfirm, setShowReconnectConfirm] = useState(false);

  async function handleReconnect() {
    const res = await fetch("/api/auth/gmail/connect");
    const data = await res.json();
    if (data.authUrl) window.location.href = data.authUrl;
  }

  return (
    <>
      <div className="flex gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen("keys")}
          title="API Keys"
          className="text-xs gap-1.5"
        >
          <Settings size={14} /> API Keys
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen("rules")}
          className="text-xs"
        >
          Writing Rules
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowReconnectConfirm(true)}
          title="Reconnect Gmail to enable contact photos"
          className="text-xs gap-1.5"
        >
          <RefreshCw size={14} /> Reconnect Gmail
        </Button>
      </div>

      <AlertDialog open={showReconnectConfirm} onOpenChange={setShowReconnectConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reconnect Gmail?</AlertDialogTitle>
            <AlertDialogDescription>
              This re-authorizes Gmail access, now including contact photo lookup so sender avatars can show real profile pictures. You'll be redirected to Google to approve the new permission.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleReconnect}>Reconnect</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {open === "keys" && (
        <OnboardingModal onComplete={() => setOpen(null)} closeable />
      )}

      {open === "rules" && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">Writing Rules</h2>
              <button onClick={() => setOpen(null)} className="text-zinc-400 hover:text-zinc-600 text-lg leading-none" title="Close">✕</button>
            </div>
            <WritingRulesEditor onClose={() => setOpen(null)} />
          </div>
        </div>
      )}
    </>
  );
}
