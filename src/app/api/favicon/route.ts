import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

// Process-lifetime cache — single-owner tool, repeat lookups for the same sender
// domain are common and the result almost never changes.
const faviconCache = new Map<string, string | null>();

// `domain` is derived from email SENDER addresses — attacker-controlled input, since
// anyone can email the owner with a crafted From header. Without this check, a malicious
// sender could make our server fetch internal/cloud-metadata hosts (classic SSRF) just by
// having their email land in the owner's inbox. Blocks IP literals and obvious
// internal/loopback hostnames; not a full DNS-rebinding-proof check, but closes the
// easy attack surface for what's otherwise a low-stakes avatar lookup.
function isSafeDomain(domain: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(domain)) return false; // IPv4 literal
  if (domain.includes(":")) return false; // IPv6 literal or host:port
  if (domain === "localhost" || domain.endsWith(".local") || domain.endsWith(".internal")) return false;
  if (!domain.includes(".")) return false; // real public domains have a TLD
  return true;
}

function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

// Many sites (e.g. Reddit) don't actually serve their real icon at the conventional
// /favicon.ico path — they declare it via <link rel="icon"> pointing somewhere else
// entirely (often a CDN). Crawling the declared tag gives the real logo instead of
// whatever legacy fallback file happens to live at /favicon.ico.
async function findDeclaredIcon(domain: string): Promise<string | null> {
  const baseUrl = `https://${domain}/`;
  try {
    const res = await fetch(baseUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; EmailReplyAgent/1.0; +avatar-lookup)" },
      signal: AbortSignal.timeout(4000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();

    const linkTags = html.match(/<link\s[^>]*rel=["'][^"']*icon[^"']*["'][^>]*>/gi) ?? [];

    let best: { href: string; size: number } | null = null;
    for (const tag of linkTags) {
      const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
      if (!hrefMatch) continue;
      const sizesMatch = tag.match(/sizes=["'](\d+)x\d+["']/i);
      // No sizes attribute is common and shouldn't auto-lose to a tagged-but-tiny icon
      const size = sizesMatch ? parseInt(sizesMatch[1], 10) : 48;
      const resolved = resolveUrl(hrefMatch[1], res.url || baseUrl);
      if (!resolved) continue;
      if (!best || size > best.size) best = { href: resolved, size };
    }
    return best?.href ?? null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const domain = searchParams.get("domain")?.toLowerCase().trim();
  if (!domain) return NextResponse.json({ error: "domain required" }, { status: 400 });
  if (!isSafeDomain(domain)) return NextResponse.json({ iconUrl: null });

  if (faviconCache.has(domain)) {
    return NextResponse.json({ iconUrl: faviconCache.get(domain) });
  }

  const iconUrl = await findDeclaredIcon(domain);
  faviconCache.set(domain, iconUrl);
  return NextResponse.json({ iconUrl });
}
