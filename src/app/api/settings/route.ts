import { createClient } from "@/lib/supabase/server";
import { encrypt, decrypt } from "@/lib/encryption";
import { validateKeyAndGetModels, type Provider } from "@/lib/llm";
import { NextResponse } from "next/server";

// GET — load current settings (never returns raw keys)
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("user_settings")
    .select("writing_rules, ask_rules_every_time, onboarding_complete, groq_api_key_encrypted, openai_key_encrypted, gemini_key_encrypted")
    .eq("user_id", user.id)
    .single();

  return NextResponse.json({
    writingRules: data?.writing_rules ?? [],
    askRulesEveryTime: data?.ask_rules_every_time ?? false,
    onboardingComplete: data?.onboarding_complete ?? false,
    hasGroqKey: !!data?.groq_api_key_encrypted,
    hasOpenAIKey: !!data?.openai_key_encrypted,
    hasGeminiKey: !!data?.gemini_key_encrypted,
  });
}

// POST — save API key (validates first) or writing rules
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { action } = body;

  if (action === "save_api_key") {
    const { provider, apiKey }: { provider: Provider; apiKey: string } = body;

    try {
      // Validate key and get models (throws if invalid)
      await validateKeyAndGetModels(provider, apiKey);
    } catch (err) {
      return NextResponse.json({ error: `Invalid API key: ${(err as Error).message}` }, { status: 400 });
    }

    const encryptedKey = await encrypt(apiKey);
    const colMap: Record<Provider, string> = {
      groq: "groq_api_key_encrypted",
      openai: "openai_key_encrypted",
      gemini: "gemini_key_encrypted",
    };

    await supabase.from("user_settings").upsert({
      user_id: user.id,
      [colMap[provider]]: encryptedKey,
      updated_at: new Date().toISOString(),
    });

    return NextResponse.json({ success: true });
  }

  if (action === "save_writing_rules") {
    const { rules, askEveryTime }: { rules: string[]; askEveryTime: boolean } = body;
    await supabase.from("user_settings").upsert({
      user_id: user.id,
      writing_rules: rules,
      ask_rules_every_time: askEveryTime,
      updated_at: new Date().toISOString(),
    });
    return NextResponse.json({ success: true });
  }

  if (action === "complete_onboarding") {
    await supabase.from("user_settings").upsert({
      user_id: user.id,
      onboarding_complete: true,
      updated_at: new Date().toISOString(),
    });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

// Helper used server-side to decrypt a key
export async function getDecryptedKey(userId: string, provider: Provider): Promise<string> {
  const { createClient: createServerClient } = await import("@/lib/supabase/server");
  const supabase = await createServerClient();
  const colMap: Record<Provider, string> = {
    groq: "groq_api_key_encrypted",
    openai: "openai_key_encrypted",
    gemini: "gemini_key_encrypted",
  };
  const { data } = await supabase
    .from("user_settings")
    .select(colMap[provider])
    .eq("user_id", userId)
    .single();

  const encrypted = (data as Record<string, string> | null)?.[colMap[provider]];
  if (!encrypted) throw new Error(`No ${provider} API key saved`);
  return decrypt(encrypted);
}
