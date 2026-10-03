import { createClient } from "@/lib/supabase/server";
import { exchangeCode } from "@/lib/gmail";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(`${origin}/dashboard?gmail_error=no_code`);
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);

  try {
    await exchangeCode(code, user.id);
    return NextResponse.redirect(`${origin}/dashboard?gmail_connected=1`);
  } catch {
    return NextResponse.redirect(`${origin}/dashboard?gmail_error=exchange_failed`);
  }
}
