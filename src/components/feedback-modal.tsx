"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Star, X, Loader2, CheckCircle } from "lucide-react";

interface Props {
  replyId: string;
  onClose: () => void;
}

export function FeedbackModal({ replyId, onClose }: Props) {
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit() {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          replyId,
          starRating: rating > 0 ? rating : null,
          textualFeedback: comment.trim() || null,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? "Failed to save feedback");
      }
      setSubmitted(true);
      setTimeout(onClose, 1200);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="relative bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-sm">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-zinc-400 hover:text-zinc-600"
          aria-label="Close"
          title="Close"
        >
          <X size={18} />
        </button>

        {submitted ? (
          <div className="px-6 py-10 flex flex-col items-center gap-2 text-center">
            <CheckCircle size={28} className="text-green-600" />
            <p className="text-sm font-medium">Thanks for the feedback!</p>
          </div>
        ) : (
          <>
            <div className="px-6 pt-6 pb-2">
              <h2 className="text-base font-semibold">Reply sent ✓</h2>
              <p className="text-xs text-zinc-500 mt-0.5">How was this AI draft?</p>
            </div>

            <div className="px-6 py-4 space-y-4">
              <div className="flex items-center justify-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => setRating(n)}
                    onMouseEnter={() => setHoverRating(n)}
                    onMouseLeave={() => setHoverRating(0)}
                    className="p-0.5"
                    aria-label={`${n} star${n !== 1 ? "s" : ""}`}
                    title={`Rate ${n} star${n !== 1 ? "s" : ""}`}
                  >
                    <Star
                      size={26}
                      className={
                        n <= (hoverRating || rating)
                          ? "fill-amber-400 text-amber-400"
                          : "fill-none text-zinc-300 dark:text-zinc-600"
                      }
                    />
                  </button>
                ))}
              </div>

              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Optional comment — what worked or didn't?"
                className="w-full min-h-[70px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
              />

              {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            </div>

            <div className="px-6 pb-6 flex justify-between gap-2">
              <Button variant="ghost" onClick={onClose} disabled={submitting}>
                Skip
              </Button>
              <Button onClick={handleSubmit} disabled={submitting || (rating === 0 && !comment.trim())}>
                {submitting ? <Loader2 size={14} className="animate-spin mr-1.5" /> : null}
                Submit Feedback
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
