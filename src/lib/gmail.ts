import { google } from "googleapis";
import { createClient } from "./supabase/server";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  // Lets us look up a sender's profile photo (via people.searchContacts) for senders
  // who are in the owner's Contacts or auto-saved "Other contacts" — covers real
  // correspondents, which Gravatar mostly misses since it only covers senders who've
  // personally registered a Gravatar account.
  "https://www.googleapis.com/auth/contacts.readonly",
];

export function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
}

export function getAuthUrl() {
  const oauth2 = getOAuthClient();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
}

export async function exchangeCode(code: string, userId: string) {
  const oauth2 = getOAuthClient();
  const { tokens } = await oauth2.getToken(code);
  const supabase = await createClient();

  await supabase.from("user_settings").upsert({
    user_id: userId,
    gmail_access_token: tokens.access_token,
    gmail_refresh_token: tokens.refresh_token ?? null,
    gmail_token_expiry: tokens.expiry_date
      ? new Date(tokens.expiry_date).toISOString()
      : null,
    updated_at: new Date().toISOString(),
  });
}

export async function getAuthedClient(userId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("user_settings")
    .select("gmail_access_token, gmail_refresh_token, gmail_token_expiry")
    .eq("user_id", userId)
    .single();

  if (!data?.gmail_access_token) throw new Error("Gmail not connected");

  const oauth2 = getOAuthClient();
  oauth2.setCredentials({
    access_token: data.gmail_access_token,
    refresh_token: data.gmail_refresh_token ?? undefined,
    expiry_date: data.gmail_token_expiry
      ? new Date(data.gmail_token_expiry).getTime()
      : undefined,
  });

  // Auto-refresh and persist new token if expired
  oauth2.on("tokens", async (tokens) => {
    if (tokens.access_token) {
      await supabase.from("user_settings").update({
        gmail_access_token: tokens.access_token,
        gmail_token_expiry: tokens.expiry_date
          ? new Date(tokens.expiry_date).toISOString()
          : null,
        updated_at: new Date().toISOString(),
      }).eq("user_id", userId);
    }
  });

  return oauth2;
}

export interface EmailSummary {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  unread: boolean;
}

export interface EmailMessage {
  id: string;
  from: string;
  to: string;
  date: string;
  subject: string;
  body: string;        // plain text — used for RAG context / draft generation
  bodyHtml?: string;    // raw (unstripped) HTML part, if present — used for display only
}

export interface Thread {
  threadId: string;
  subject: string;
  messages: EmailMessage[];
}

// Gmail's API returns several plain-text-ish fields (snippet, and occasionally header
// values) with HTML entities still encoded — e.g. "We&#39;re" or "Weights &amp; Biases".
// Decode these wherever they're displayed, not just in full HTML bodies.
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s{2,}/g, "\n")
    .trim();
}

function decodeBody(part: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }): string {
  // Prefer plain text
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64").toString("utf-8");
  }

  // Recurse into multipart — try to find text/plain first
  if (part.parts) {
    const subParts = part.parts as typeof part[];
    for (const p of subParts) {
      if (p.mimeType === "text/plain") {
        const text = decodeBody(p);
        if (text) return text;
      }
    }
    // Fallback: try html parts, strip tags
    for (const p of subParts) {
      if (p.mimeType === "text/html") {
        const raw = decodeBody(p);
        if (raw) return stripHtml(raw);
      }
    }
    // Recurse into nested multipart
    for (const p of subParts) {
      const text = decodeBody(p);
      if (text) return text;
    }
  }

  // HTML body with no plain text alternative
  if (part.mimeType === "text/html" && part.body?.data) {
    const raw = Buffer.from(part.body.data, "base64").toString("utf-8");
    return stripHtml(raw);
  }

  return "";
}

// Finds the raw (undecoded-to-text) HTML part, if present — used for display rendering
// in a sanitized iframe so formatting matches Gmail's own view.
function extractHtmlPart(part: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }): string | undefined {
  if (part.mimeType === "text/html" && part.body?.data) {
    return Buffer.from(part.body.data, "base64").toString("utf-8");
  }
  if (part.parts) {
    const subParts = part.parts as typeof part[];
    for (const p of subParts) {
      if (p.mimeType === "text/html") {
        const html = extractHtmlPart(p);
        if (html) return html;
      }
    }
    for (const p of subParts) {
      const html = extractHtmlPart(p);
      if (html) return html;
    }
  }
  return undefined;
}

type GmailHeader = { name?: string | null; value?: string | null };

function getHeader(headers: GmailHeader[], name: string): string {
  const value = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
  return decodeHtmlEntities(value);
}

export interface InboxPage {
  emails: EmailSummary[];
  nextPageToken?: string;
}

export async function fetchInbox(
  userId: string,
  maxResults = 25,
  pageToken?: string,
  query?: string
): Promise<InboxPage> {
  const auth = await getAuthedClient(userId);
  const gmail = google.gmail({ version: "v1", auth });

  // labelIds and q are ANDed by the Gmail API — a result must carry the INBOX label
  // regardless of what's in the search query, so search can't leak Spam/Trash in even
  // if someone types an "in:" operator.
  const list = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX", "CATEGORY_PERSONAL"],
    maxResults,
    pageToken,
    q: query || undefined,
  });

  const messages = list.data.messages ?? [];
  const summaries: EmailSummary[] = [];

  await Promise.all(
    messages.map(async (msg) => {
      const full = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date"],
      });

      const headers = full.data.payload?.headers ?? [];
      summaries.push({
        id: full.data.id!,
        threadId: full.data.threadId!,
        subject: getHeader(headers, "Subject") || "(no subject)",
        from: getHeader(headers, "From"),
        date: getHeader(headers, "Date"),
        snippet: decodeHtmlEntities(full.data.snippet ?? ""),
        unread: (full.data.labelIds ?? []).includes("UNREAD"),
      });
    })
  );

  // Sort newest first (Gmail's list order isn't always strictly chronological
  // once metadata is fetched in parallel)
  summaries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return {
    emails: summaries,
    nextPageToken: list.data.nextPageToken ?? undefined,
  };
}

export async function fetchThread(userId: string, threadId: string): Promise<Thread> {
  const auth = await getAuthedClient(userId);
  const gmail = google.gmail({ version: "v1", auth });

  const thread = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });

  const messages: EmailMessage[] = (thread.data.messages ?? []).map((msg) => {
    const headers = msg.payload?.headers ?? [];
    return {
      id: msg.id!,
      from: getHeader(headers, "From"),
      to: getHeader(headers, "To"),
      date: getHeader(headers, "Date"),
      subject: getHeader(headers, "Subject") || "(no subject)",
      body: decodeBody(msg.payload as Parameters<typeof decodeBody>[0]),
      bodyHtml: extractHtmlPart(msg.payload as Parameters<typeof extractHtmlPart>[0]),
    };
  });

  const subject = messages[0]?.subject ?? "(no subject)";
  return { threadId, subject, messages };
}

export async function sendReply(
  userId: string,
  threadId: string,
  toEmail: string,
  subject: string,
  body: string
) {
  const auth = await getAuthedClient(userId);
  const gmail = google.gmail({ version: "v1", auth });

  const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  const raw = [
    `To: ${toEmail}`,
    `Subject: ${replySubject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  const encoded = Buffer.from(raw).toString("base64url");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded, threadId },
  });
}

// Looks up a sender's profile photo via the People API — searches the owner's Contacts
// and auto-saved "Other contacts" (which Gmail populates for anyone you've corresponded
// with) by email. Requires the contacts.readonly scope, so this silently returns null
// for accounts that connected Gmail before that scope was added (until they reconnect).
export async function getSenderPhoto(userId: string, email: string): Promise<string | null> {
  try {
    const auth = await getAuthedClient(userId);
    const people = google.people({ version: "v1", auth });

    const res = await people.people.searchContacts({
      query: email,
      readMask: "photos,emailAddresses",
      pageSize: 3,
    });

    const results = res.data.results ?? [];
    for (const result of results) {
      const person = result.person;
      if (!person) continue;
      const matchesEmail = (person.emailAddresses ?? []).some(
        (e) => e.value?.toLowerCase() === email.toLowerCase()
      );
      if (!matchesEmail) continue;
      // `default: true` means a generic silhouette placeholder, not a real photo
      const photo = (person.photos ?? []).find((p) => !p.default && p.url);
      if (photo?.url) return photo.url;
    }
    return null;
  } catch {
    // Missing scope (not yet reconnected), API error, or no match — fall back silently
    return null;
  }
}
