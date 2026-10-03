import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { replyId, starRating, textualFeedback } = await request.json();

  if (!replyId) {
    return NextResponse.json({ error: "Missing replyId" }, { status: 400 });
  }
  if (starRating !== undefined && starRating !== null && (starRating < 1 || starRating > 5)) {
    return NextResponse.json({ error: "starRating must be between 1 and 5" }, { status: 400 });
  }

  const { error } = await supabase
    .from("email_replies")
    .update({
      star_rating: starRating ?? null,
      textual_feedback: textualFeedback ?? null,
    })
    .eq("id", replyId)
    .eq("user_id", user.id); // ownership check — RLS also enforces this, belt and suspenders

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
