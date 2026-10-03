import { createClient } from "@/lib/supabase/server";
import { sendReply } from "@/lib/gmail";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const {
    threadId,
    to,
    subject,
    body,
    originalEmailId,
    originalEmailSnippet,
    aiDraft,
    modelUsed,
    retrievedContext,
  } = await request.json();

  if (!threadId || !to || !body) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  try {
    await sendReply(user.id, threadId, to, subject ?? "", body);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  // The email already went out — a logging failure shouldn't surface as a send failure.
  let replyId: string | null = null;
  try {
    const { data: inserted, error } = await supabase
      .from("email_replies")
      .insert({
        user_id: user.id,
        original_email_id: originalEmailId ?? null,
        original_email_snippet: originalEmailSnippet ?? null,
        ai_draft: aiDraft ?? null,
        sent_reply: body,
        model_used: modelUsed ?? null,
        retrieved_context: retrievedContext ?? null,
      })
      .select("id")
      .single();

    if (error) throw error;
    replyId = inserted.id;
  } catch (err) {
    console.error("Failed to log sent reply:", err);
  }

  return NextResponse.json({ success: true, replyId });
}
