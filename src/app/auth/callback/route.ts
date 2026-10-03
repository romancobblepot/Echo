import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const response = NextResponse.redirect(`${origin}${next}`);

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, options)
            );
          },
        },
      }
    );

    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Google was asked for Gmail/Contacts scopes alongside identity (see login/page.tsx),
      // so the provider's access/refresh tokens come back on the session here — persist them
      // now so the dashboard never needs a second, separate "Connect Gmail" consent screen.
      const providerToken = data.session?.provider_token;
      const providerRefreshToken = data.session?.provider_refresh_token;
      if (providerToken && data.user) {
        await supabase.from("user_settings").upsert({
          user_id: data.user.id,
          gmail_access_token: providerToken,
          gmail_refresh_token: providerRefreshToken ?? null,
          // Supabase doesn't surface the Google token's own expiry, so approximate Google's
          // standard 1-hour access token lifetime; getAuthedClient() refreshes from here on.
          gmail_token_expiry: new Date(Date.now() + 3500 * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      return response;
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
