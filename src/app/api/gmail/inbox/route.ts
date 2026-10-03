import { createClient } from "@/lib/supabase/server";
import { fetchInbox } from "@/lib/gmail";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const pageToken = searchParams.get("pageToken") ?? undefined;
  const q = searchParams.get("q") ?? undefined;

  try {
    const { emails, nextPageToken } = await fetchInbox(user.id, 25, pageToken, q);
    return NextResponse.json({ emails, nextPageToken });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "Gmail not connected") {
      return NextResponse.json({ error: "gmail_not_connected" }, { status: 403 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
