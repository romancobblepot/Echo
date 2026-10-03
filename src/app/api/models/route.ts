import { createClient } from "@/lib/supabase/server";
import { validateKeyAndGetModels, type Provider } from "@/lib/llm";
import { decrypt } from "@/lib/encryption";
import { NextResponse } from "next/server";

const COL_MAP: Record<Provider, string> = {
  groq: "groq_api_key_encrypted",
  openai: "openai_key_encrypted",
  gemini: "gemini_key_encrypted",
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const provider = searchParams.get("provider") as Provider | null;

  if (!provider || !["openai", "groq", "gemini"].includes(provider)) {
    return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("user_settings")
    .select(COL_MAP[provider])
    .eq("user_id", user.id)
    .single();

  const encrypted = (data as Record<string, string> | null)?.[COL_MAP[provider]];
  if (!encrypted) return NextResponse.json({ error: "No API key saved for this provider" }, { status: 403 });

  try {
    const apiKey = await decrypt(encrypted);
    const models = await validateKeyAndGetModels(provider, apiKey);
    return NextResponse.json({ models });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
