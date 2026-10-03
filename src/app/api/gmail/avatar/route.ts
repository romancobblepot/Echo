import { createClient } from "@/lib/supabase/server";
import { getSenderPhoto } from "@/lib/gmail";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const email = searchParams.get("email");
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const photoUrl = await getSenderPhoto(user.id, email);
  return NextResponse.json({ photoUrl });
}
