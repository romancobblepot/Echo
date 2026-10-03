"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { Search, X, Filter, AlertTriangle, RefreshCw, PanelRightClose, PanelRightOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { usePanelRef } from "react-resizable-panels";
import { DraftPanel, type SendPayload } from "./draft-panel";
import FilePanel from "./file-panel";
import { OnboardingModal } from "./onboarding-modal";
import type { EmailSummary, Thread } from "@/lib/gmail";

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  return isToday
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function senderName(from: string) {
  const match = from.match(/^(.+?)\s*</);
  const raw = (match ? match[1] : from).trim();
  // Strip RFC 2822 quoted-string display names, e.g. `"Weights & Biases" <...>`
  return raw.replace(/^"(.*)"$/, "$1").trim();
}

function senderInitials(from: string) {
  const name = senderName(from);
  const letters = name
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")) // drop stray symbols like "&" so they're never picked as an "initial"
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]);
  return letters.join("").toUpperCase() || "?";
}

function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim();
}

// SHA-256 (Web Crypto, no extra dependency) of the lowercased/trimmed email — the hash
// format Gravatar's current API expects. `d=404` makes it return a real 404 instead of a
// default placeholder image when no Gravatar is registered, so we can detect "no photo"
// and fall back to initials cleanly via Avatar's built-in image-error fallback behavior.
async function gravatarUrl(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const data = new TextEncoder().encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `https://www.gravatar.com/avatar/${hash}?d=404&s=64`;
}

// Compound TLDs where the registrable domain is 3 labels, not 2 (e.g. "example.co.uk",
// not "co.uk"). Not exhaustive (that requires the full Public Suffix List), but covers
// the common cases well enough for a sender-logo heuristic.
const COMPOUND_TLDS = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au",
  "co.in", "co.jp", "co.nz", "co.za",
  "com.br", "com.mx", "com.sg",
]);

// Email senders almost always send from a mail-specific subdomain (e.g.
// "mail.instagram.com", "email.openai.com") that has no favicon of its own — only the
// root/registrable domain ("instagram.com", "openai.com") does. Strip down to that.
function rootDomain(domain: string): string {
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  const lastTwo = parts.slice(-2).join(".");
  if (COMPOUND_TLDS.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

// Google's s2 favicon service redirects through its own fallback chain and frequently
// serves a generic placeholder icon instead of the real logo (confirmed by testing —
// e.g. ebay.com), even when the domain serves a perfectly good /favicon.ico directly.
// Used only as a last-resort source, after trying the domain's own favicon.
function googleFaviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

function directFaviconUrl(domain: string): string {
  return `https://${domain}/favicon.ico`;
}

// Tests whether an image URL actually loads before committing to it as the avatar —
// needed because unlike Gravatar's `d=404` trick, a plain favicon.ico request doesn't
// give us a clean "not found" signal any other way, and we want to try multiple
// candidate sources in priority order rather than locking onto whichever loads last.
function preloadImage(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

function isFromUser(headerValue: string, userEmail: string): boolean {
  if (!userEmail) return false;
  return headerValue.toLowerCase().includes(userEmail.toLowerCase());
}

// Simple module-level cache — the same sender appears across many rows/messages,
// no need to re-resolve for each occurrence. `null` is a valid cached value (no photo
// found anywhere), distinct from "not yet looked up".
const avatarCache = new Map<string, string | null>();

function SenderAvatar({ from, className }: { from: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const email = extractEmail(from);
    if (!email) return;

    const cached = avatarCache.get(email);
    if (cached !== undefined) {
      setSrc(cached);
      return;
    }

    let cancelled = false;
    (async () => {
      // 1. Google People API — covers real correspondents (Contacts + Gmail's
      //    auto-saved "Other contacts"), the right source for individual people.
      let resolved: string | null = null;
      try {
        const res = await fetch(`/api/gmail/avatar?email=${encodeURIComponent(email)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.photoUrl) resolved = data.photoUrl;
        }
      } catch { /* fall through */ }

      // 2. Domain favicon — covers companies/automated senders (OpenAI, Brave,
      //    FanCode, etc.), which People API and Gravatar can never cover since
      //    those only track individual people, not organizations.
      //    a) Declared <link rel="icon"> from the site's own HTML — many sites
      //       (e.g. Reddit) don't serve their real logo at /favicon.ico at all,
      //       only via a declared tag pointing elsewhere (often a CDN).
      //    b) Direct /favicon.ico guess as a fallback.
      //    c) Google's s2 service as a last resort (often generic, kept low-priority).
      const domain = email.split("@")[1]?.toLowerCase().trim();
      if (!resolved && domain) {
        const root = rootDomain(domain);

        try {
          const res = await fetch(`/api/favicon?domain=${encodeURIComponent(root)}`);
          if (res.ok) {
            const data = await res.json();
            if (data.iconUrl && (await preloadImage(data.iconUrl))) {
              resolved = data.iconUrl;
            }
          }
        } catch { /* fall through */ }

        if (!resolved) {
          const direct = directFaviconUrl(root);
          if (await preloadImage(direct)) {
            resolved = direct;
          } else {
            resolved = googleFaviconUrl(root);
          }
        }
      }

      // 3. Gravatar as a last resort — catches remaining personal accounts not
      //    in contacts (favicon almost always succeeds, so this rarely triggers).
      if (!resolved) resolved = await gravatarUrl(email);

      if (!cancelled) {
        avatarCache.set(email, resolved);
        setSrc(resolved);
      }
    })();
    return () => { cancelled = true; };
  }, [from]);

  return (
    <Avatar className={className}>
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback className="text-xs">{senderInitials(from)}</AvatarFallback>
    </Avatar>
  );
}

interface MailFilters {
  unreadOnly: boolean;
  hasAttachment: boolean;
  from: string;
  subject: string;
  newerThan: "" | "1d" | "7d" | "1m" | "1y";
}

const DEFAULT_FILTERS: MailFilters = {
  unreadOnly: false,
  hasAttachment: false,
  from: "",
  subject: "",
  newerThan: "",
};

function buildFilterQuery(f: MailFilters): string {
  const parts: string[] = [];
  if (f.unreadOnly) parts.push("is:unread");
  if (f.hasAttachment) parts.push("has:attachment");
  if (f.from.trim()) parts.push(`from:${f.from.trim()}`);
  if (f.subject.trim()) parts.push(`subject:(${f.subject.trim()})`);
  if (f.newerThan) parts.push(`newer_than:${f.newerThan}`);
  return parts.join(" ");
}

function countActiveFilters(f: MailFilters): number {
  let n = 0;
  if (f.unreadOnly) n++;
  if (f.hasAttachment) n++;
  if (f.from.trim()) n++;
  if (f.subject.trim()) n++;
  if (f.newerThan) n++;
  return n;
}

export default function Inbox({ userEmail }: { userEmail: string }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [inboxError, setInboxError] = useState("");
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState("");
  const [lastOpenedEmail, setLastOpenedEmail] = useState<EmailSummary | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // Inbox pagination — Gmail's API is cursor-based (no random-access pages), so we cache
  // each fetched page client-side by index and walk pageTokens forward/backward through it.
  const [pageIndex, setPageIndex] = useState(0);
  const [pageTokens, setPageTokens] = useState<(string | undefined)[]>([undefined]);
  const [pagesCache, setPagesCache] = useState<Record<number, EmailSummary[]>>({});
  const [hasNextPage, setHasNextPage] = useState(false);

  // Search — debounced, uses Gmail's own search syntax (from:, subject:, etc.) server-side
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [filters, setFilters] = useState<MailFilters>(DEFAULT_FILTERS);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const isFirstSearchRun = useRef(true);

  // Per-thread context scoping state
  const [scopingMode, setScopingMode] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());

  const unreadCount = emails.filter((e) => e.unread).length;

  // Debounce search input + filters → active query. Filters are structured criteria
  // (is:unread, from:, etc.) combined with whatever free text is typed, rather than
  // overwriting it — so toggling a filter never clobbers a typed search and vice versa.
  useEffect(() => {
    const handle = setTimeout(() => {
      const filterQuery = buildFilterQuery(filters);
      const combined = [filterQuery, searchInput.trim()].filter(Boolean).join(" ");
      setSearchQuery(combined);
    }, 400);
    return () => clearTimeout(handle);
  }, [searchInput, filters]);

  // Re-fetch page 1 whenever the active search query changes (skip the initial mount —
  // the connect effect below already loads page 1 once)
  useEffect(() => {
    if (isFirstSearchRun.current) {
      isFirstSearchRun.current = false;
      return;
    }
    if (connected) loadPage(0, { reset: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  useEffect(() => {
    async function init() {
      // Check onboarding
      const settingsRes = await fetch("/api/settings");
      const settings = await settingsRes.json();
      if (!settings.onboardingComplete) setShowOnboarding(true);

      const res = await fetch("/api/auth/gmail/connect");
      const data = await res.json();
      setConnected(data.connected);
      setAuthUrl(data.authUrl);

      if (data.connected) {
        await loadPage(0, { reset: true });
      } else {
        setLoading(false);
      }
    }
    init();
  }, []);

  async function loadPage(index: number, opts: { reset?: boolean } = {}) {
    setLoading(true);
    setInboxError("");

    if (!opts.reset && pagesCache[index]) {
      setEmails(pagesCache[index]);
      setPageIndex(index);
      setHasNextPage(pageTokens[index + 1] !== undefined);
      setLoading(false);
      return;
    }

    const tokens = opts.reset ? [undefined] : pageTokens;
    const token = opts.reset ? undefined : tokens[index];
    const params = new URLSearchParams();
    if (token) params.set("pageToken", token);
    if (searchQuery) params.set("q", searchQuery);
    const qs = params.toString();
    const url = `/api/gmail/inbox${qs ? `?${qs}` : ""}`;

    try {
      const res = await fetch(url);
      const data = await res.json();

      if (!res.ok || !data.emails) {
        throw new Error(data.error === "gmail_not_connected" ? "Gmail connection lost" : (data.error ?? "Failed to load inbox"));
      }

      if (opts.reset) {
        setPagesCache({ 0: data.emails });
        setPageTokens(data.nextPageToken ? [undefined, data.nextPageToken] : [undefined]);
      } else {
        setPagesCache((prev) => ({ ...prev, [index]: data.emails }));
        setPageTokens((prev) => {
          const next = [...prev];
          if (data.nextPageToken) next[index + 1] = data.nextPageToken;
          return next;
        });
      }
      setEmails(data.emails);
      setPageIndex(index);
      setHasNextPage(!!data.nextPageToken);
    } catch (err) {
      setInboxError((err as Error).message || "Failed to load inbox");
    } finally {
      setLoading(false);
    }
  }

  async function refreshInbox() {
    await loadPage(0, { reset: true });
  }

  async function openThread(email: EmailSummary) {
    setThreadLoading(true);
    setThreadError("");
    setSelectedThread(null);
    setLastOpenedEmail(email);
    setScopingMode(false);
    setSelectedFileIds(new Set());
    try {
      const res = await fetch(`/api/gmail/thread?threadId=${email.threadId}`);
      const data = await res.json();
      if (!res.ok || !data.thread) throw new Error(data.error ?? "Failed to load thread");
      setSelectedThread(data.thread);
    } catch (err) {
      setThreadError((err as Error).message || "Failed to load thread");
    } finally {
      setThreadLoading(false);
    }
  }

  async function sendReply(threadId: string, payload: SendPayload): Promise<string | null> {
    if (!selectedThread) return null;
    const lastMsg = selectedThread.messages[selectedThread.messages.length - 1];

    const res = await fetch("/api/gmail/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        to: lastMsg.from,
        subject: selectedThread.subject,
        body: payload.draftBody,
        originalEmailId: lastMsg.id,
        originalEmailSnippet: lastMsg.body.slice(0, 500),
        aiDraft: payload.originalDraft,
        modelUsed: payload.modelUsed,
        retrievedContext: payload.retrievedContext,
      }),
    });

    if (!res.ok) {
      let msg = `Send failed (${res.status})`;
      try {
        const d = await res.json();
        msg = d.error ?? msg;
      } catch { /* non-JSON error body */ }
      throw new Error(msg);
    }

    const result = await res.json();

    // Reload thread after send
    const threadRes = await fetch(`/api/gmail/thread?threadId=${threadId}`);
    const data = await threadRes.json();
    if (data.thread) setSelectedThread(data.thread);

    return result.replyId ?? null;
  }

  if (connected === null) {
    return <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  if (!connected) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <p className="text-sm text-muted-foreground">Connect your Gmail to get started</p>
        {authUrl && (
          <Button onClick={() => window.location.href = authUrl}>Connect Gmail</Button>
        )}
      </div>
    );
  }

  return (
    <>
      {showOnboarding && (
        <OnboardingModal onComplete={() => setShowOnboarding(false)} />
      )}

      <ResizablePanelGroup className="flex-1 overflow-hidden">
        {/* Left sidebar: file panel (context scoping when thread open) */}
        <ResizablePanel defaultSize="18" minSize="12" maxSize="35" className="overflow-hidden">
          <FilePanel
            scopingMode={scopingMode}
            selectedFileIds={selectedFileIds}
            onSelectionChange={setSelectedFileIds}
          />
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Email list — kept narrower by default so the open thread (which matters more
            once you're reading/drafting) gets the bulk of the remaining width */}
        <ResizablePanel defaultSize="22" minSize="16" maxSize="40" className="border-x flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">Inbox</span>
              {unreadCount > 0 && (
                <Badge className="h-5 px-1.5 text-xs">{unreadCount}</Badge>
              )}
            </div>
            <button
              onClick={refreshInbox}
              className="h-9 w-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Refresh"
            >
              <RefreshCw size={16} />
            </button>
          </div>

          <div className="px-3 py-2 border-b flex items-center gap-1.5">
            <div className="relative flex-1">
              <Search size={13} className="absolute left-[10px] top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search mail (from:, subject:, ...)"
                className="h-8 pl-7 pr-7 text-xs"
              />
              {searchInput && (
                <button
                  onClick={() => setSearchInput("")}
                  className="absolute right-[10px] top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  title="Clear search"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            <div className="relative shrink-0">
              <button
                onClick={() => setShowFilterPanel((v) => !v)}
                className={`h-9 w-9 flex items-center justify-center rounded-md border relative transition-colors ${
                  showFilterPanel ? "border-primary text-primary bg-primary/5" : "border-input text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
                title="Filters"
              >
                <Filter size={16} />
                {countActiveFilters(filters) > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 w-[18px] h-[18px] bg-primary text-primary-foreground rounded-full text-[10px] font-bold flex items-center justify-center">
                    {countActiveFilters(filters)}
                  </span>
                )}
              </button>

              {showFilterPanel && (
                <div className="absolute z-20 top-full mt-1 right-0 w-64 bg-white dark:bg-zinc-900 border rounded-xl shadow-lg p-3 space-y-3">
                  <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={filters.unreadOnly}
                      onChange={(e) => setFilters((f) => ({ ...f, unreadOnly: e.target.checked }))}
                      className="w-3.5 h-3.5 accent-primary"
                    />
                    Unread only
                  </label>
                  <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={filters.hasAttachment}
                      onChange={(e) => setFilters((f) => ({ ...f, hasAttachment: e.target.checked }))}
                      className="w-3.5 h-3.5 accent-primary"
                    />
                    Has attachment
                  </label>

                  <div>
                    <label className="text-xs text-muted-foreground">From</label>
                    <Input
                      value={filters.from}
                      onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
                      placeholder="name or email"
                      className="h-7 text-xs mt-1"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground">Subject contains</label>
                    <Input
                      value={filters.subject}
                      onChange={(e) => setFilters((f) => ({ ...f, subject: e.target.value }))}
                      placeholder="keyword"
                      className="h-7 text-xs mt-1"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground">Date</label>
                    <select
                      value={filters.newerThan}
                      onChange={(e) => setFilters((f) => ({ ...f, newerThan: e.target.value as MailFilters["newerThan"] }))}
                      className="w-full h-7 text-xs mt-1 border rounded-md px-2 bg-white dark:bg-zinc-800"
                    >
                      <option value="">Any time</option>
                      <option value="1d">Past 24 hours</option>
                      <option value="7d">Past week</option>
                      <option value="1m">Past month</option>
                      <option value="1y">Past year</option>
                    </select>
                  </div>

                  <div className="flex justify-between items-center pt-1 border-t">
                    <button
                      onClick={() => setFilters(DEFAULT_FILTERS)}
                      className="text-xs text-muted-foreground hover:text-foreground pt-2"
                    >
                      Clear filters
                    </button>
                    <button
                      onClick={() => setShowFilterPanel(false)}
                      className="text-xs text-primary hover:underline pt-2"
                    >
                      Done
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <ScrollArea className="flex-1">
            {loading ? (
              <div className="p-4 flex flex-col gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex gap-3 items-start">
                    <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                    <div className="flex-1 flex flex-col gap-1.5">
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="h-3 w-40" />
                      <Skeleton className="h-3 w-full" />
                    </div>
                  </div>
                ))}
              </div>
            ) : inboxError ? (
              <div className="p-4 flex flex-col items-center gap-2 text-center">
                <AlertTriangle size={18} className="text-amber-500" />
                <p className="text-xs text-muted-foreground">{inboxError}</p>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={refreshInbox}>
                  Retry
                </Button>
              </div>
            ) : emails.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                {searchQuery ? `No results for "${searchQuery}"` : "No emails found"}
              </div>
            ) : (
              emails.map((email, i) => (
                <div key={email.id}>
                  <button
                    onClick={() => openThread(email)}
                    className={`w-full text-left px-4 py-3 hover:bg-muted transition-colors flex gap-3 items-start
                      ${selectedThread?.threadId === email.threadId ? "bg-muted" : ""}
                      ${email.unread ? "bg-primary/5" : ""}`}
                  >
                    <SenderAvatar from={email.from} className="h-8 w-8 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1 mb-0.5">
                        <span className={`text-xs truncate ${email.unread ? "font-semibold" : ""}`}>
                          {senderName(email.from)}
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0">{formatDate(email.date)}</span>
                      </div>
                      <p className={`text-xs truncate ${email.unread ? "font-medium" : "text-muted-foreground"}`}>
                        {email.subject}
                      </p>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{email.snippet}</p>
                    </div>
                  </button>
                  {i < emails.length - 1 && <Separator />}
                </div>
              ))
            )}
          </ScrollArea>

          {/* Pagination — Gmail's API is cursor-based, so Previous walks back through cached pages */}
          <div className="border-t px-3 py-2 flex items-center justify-between gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => loadPage(pageIndex - 1)}
              disabled={pageIndex === 0 || loading}
            >
              ← Previous
            </Button>
            <span className="text-xs text-muted-foreground">Page {pageIndex + 1}</span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => loadPage(pageIndex + 1)}
              disabled={!hasNextPage || loading}
            >
              Next →
            </Button>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Thread + draft panel */}
        <ResizablePanel defaultSize="60" minSize="25" className="flex flex-col overflow-hidden">
          {threadLoading ? (
            <div className="flex-1 p-6 flex flex-col gap-4">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-3 w-24" />
              <div className="flex gap-3 items-start mt-4">
                <Skeleton className="h-7 w-7 rounded-full shrink-0" />
                <div className="flex-1 flex flex-col gap-2">
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </div>
            </div>
          ) : threadError ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center">
              <AlertTriangle size={20} className="text-amber-500" />
              <p className="text-sm text-muted-foreground">{threadError}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => lastOpenedEmail && openThread(lastOpenedEmail)}
              >
                Retry
              </Button>
            </div>
          ) : selectedThread ? (
            <ThreadPanel
              thread={selectedThread}
              userEmail={userEmail}
              scopingMode={scopingMode}
              selectedFileIds={selectedFileIds}
              onToggleScopingMode={() => {
                setScopingMode((v) => !v);
                if (scopingMode) setSelectedFileIds(new Set());
              }}
              onSend={(payload) => sendReply(selectedThread.threadId, payload)}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              Select an email to read
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}

function ThreadPanel({
  thread,
  userEmail,
  scopingMode,
  selectedFileIds,
  onToggleScopingMode,
  onSend,
}: {
  thread: Thread;
  userEmail: string;
  scopingMode: boolean;
  selectedFileIds: Set<string>;
  onToggleScopingMode: () => void;
  onSend: (payload: SendPayload) => Promise<string | null>;
}) {
  const lastMsg = thread.messages[thread.messages.length - 1];
  const draftPanelRef = usePanelRef();
  const [draftCollapsed, setDraftCollapsed] = useState(false);

  function toggleDraftCollapsed() {
    if (draftPanelRef.current?.isCollapsed()) {
      draftPanelRef.current?.expand();
    } else {
      draftPanelRef.current?.collapse();
    }
  }

  // Annotate each message with who sent it (the owner vs. the external party) so the
  // LLM doesn't hallucinate perspective — without this it has no way to tell who it's
  // drafting the reply FROM and TO, since body text alone carries no sender identity.
  const threadText = thread.messages
    .map((m) => {
      const role = isFromUser(m.from, userEmail) ? "You (the account owner, drafting this reply)" : "External sender (who you are replying to)";
      return `[${role} — ${m.from} — ${m.date}]\n${m.body}`;
    })
    .join("\n\n---\n\n");

  // Who we're actually replying to: the most recent message NOT from the owner.
  // Falls back to the last message if, unusually, every message is from the owner.
  const recipientMsg = [...thread.messages].reverse().find((m) => !isFromUser(m.from, userEmail)) ?? lastMsg;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 py-4 border-b shrink-0 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{thread.subject}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {thread.messages.length} message{thread.messages.length !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={toggleDraftCollapsed}
          className="shrink-0 h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title={draftCollapsed ? "Show Smart Reply panel" : "Hide Smart Reply panel"}
        >
          {draftCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
        </button>
      </div>

      {/* Drafting is this app's main action, so it's a permanent split view rather than
          something hidden behind a toggle — the assistant is visible the moment a
          thread is open, not an extra click away. */}
      <ResizablePanelGroup className="flex-1 overflow-hidden">
        <ResizablePanel defaultSize="55" minSize="30">
          <ScrollArea className="h-full px-6 py-4">
            <div className="flex flex-col gap-6">
              {thread.messages.map((msg, i) => (
                <div key={msg.id} className="flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <SenderAvatar from={msg.from} className="h-7 w-7" />
                      <div>
                        <p className="text-xs font-medium">{senderName(msg.from)}</p>
                        <p className="text-xs text-muted-foreground">{msg.from.match(/<(.+)>/)?.[1] ?? msg.from}</p>
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">{formatDate(msg.date)}</span>
                  </div>
                  <div className="pl-9">
                    {msg.bodyHtml ? (
                      <HtmlEmailBody html={msg.bodyHtml} />
                    ) : (
                      <pre className="text-xs text-foreground whitespace-pre-wrap font-sans leading-relaxed">
                        {msg.body.trim()}
                      </pre>
                    )}
                  </div>
                  {i < thread.messages.length - 1 && <Separator />}
                </div>
              ))}
            </div>
          </ScrollArea>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel
          defaultSize="45"
          minSize="28"
          collapsedSize="0"
          collapsible
          panelRef={draftPanelRef}
          onResize={(size) => setDraftCollapsed(size.asPercentage === 0)}
          className="flex flex-col overflow-hidden"
        >
          {/* Stays mounted (not conditionally removed) while collapsed so a draft in
              progress — model choice, streamed text, scoping — survives minimize/restore. */}
          <div className="px-4 py-3 border-b shrink-0">
            <p className="text-sm font-semibold">Smart Reply</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Pick a model, optionally scope which files inform it, then generate a reply you can edit before sending.
            </p>
            {scopingMode && selectedFileIds.size > 0 && (
              <p className="text-xs text-primary mt-1">Using {selectedFileIds.size} selected file{selectedFileIds.size !== 1 ? "s" : ""} for context</p>
            )}
            {scopingMode && selectedFileIds.size === 0 && (
              <p className="text-xs text-zinc-400 mt-1">Using all files for context</p>
            )}
          </div>
          <ScrollArea className="flex-1">
            <div className="p-4">
              <DraftPanel
                threadText={threadText}
                emailBody={lastMsg.body}
                subject={thread.subject}
                userEmail={userEmail}
                recipientEmail={recipientMsg.from}
                scopedFileIds={selectedFileIds.size > 0 ? Array.from(selectedFileIds) : undefined}
                scopingMode={scopingMode}
                selectedFileCount={selectedFileIds.size}
                onToggleScopingMode={onToggleScopingMode}
                onSend={onSend}
              />
            </div>
          </ScrollArea>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

// Renders an email's original HTML in a sandboxed iframe so formatting (tables, spacing,
// newsletter layouts) matches Gmail's own view instead of a flattened plain-text dump.
// DOMPurify strips scripts/handlers client-side; the iframe sandbox (no allow-scripts)
// additionally guarantees nothing in the email can execute, even if sanitization were bypassed.
function HtmlEmailBody({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  const sanitized = useMemo(() => DOMPurify.sanitize(html), [html]);

  const srcDoc = useMemo(
    () => `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
      body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;line-height:1.5;color:#18181b;word-wrap:break-word;overflow-wrap:break-word;}
      img{max-width:100%;height:auto;}
      table{max-width:100%;}
      a{color:#2563eb;}
    </style></head><body>${sanitized}</body></html>`,
    [sanitized]
  );

  function handleLoad() {
    try {
      const doc = iframeRef.current?.contentDocument;
      if (doc?.body) setHeight(doc.body.scrollHeight + 16);
    } catch {
      /* cross-origin or unavailable — keep default height */
    }
  }

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups"
      onLoad={handleLoad}
      style={{ width: "100%", height, border: "none", display: "block" }}
      title="Email content"
    />
  );
}
