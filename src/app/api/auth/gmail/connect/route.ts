import { createClient } from "@/lib/supabase/server";
import { getAuthUrl } from "@/lib/gmail";
import { NextResponse } from "next/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Check if already connected
  const { data } = await supabase
    .from("user_settings")
    .select("gmail_access_token")
    .eq("user_id", user.id)
    .single();

  const connected = !!data?.gmail_access_token;
  // Always provide authUrl, even when already connected — needed for "Reconnect Gmail"
  // (e.g. after adding a new OAuth scope, which requires re-consenting).
  const authUrl = getAuthUrl();

  return NextResponse.json({ connected, authUrl });
}
