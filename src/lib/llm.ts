import OpenAI from "openai";
import Groq from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

export type Provider = "openai" | "groq" | "gemini";

export interface ModelInfo {
  id: string;
  name: string;
  provider: Provider;
  tags: string[];
  contextWindow: number;
  supported: boolean; // false if key tier doesn't support it
}

// Models that are NOT general-purpose chat/text-generation models — filter these out.
// Provider catalogs (esp. Groq) change constantly, so this list is deliberately broad
// and keyword-based rather than an exact-id allowlist that goes stale.
const NON_TEXT_MODEL_PATTERNS = [
  "whisper", "distil-whisper", "tts", "playai", "dall-e", "dalle",
  "embedding", "embed", "moderation", "moderat", "babbage", "davinci",
  "text-embedding", "code-search", "similarity", "translat", "guard", "safety",
  "clip", "image", "vision-safety",
];

function isTextModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return !NON_TEXT_MODEL_PATTERNS.some((p) => id.includes(p));
}

// Heuristic capability tagging — reads size/speed/reasoning signals out of the model id
// and context window instead of matching a fixed list of known ids. New models (new Groq
// releases, renamed OpenAI/Gemini snapshots, provider-prefixed ids like "meta-llama/...")
// still get sensible tags instead of falling through to "general" every time.
function tagsFor(modelId: string, contextWindow?: number): string[] {
  const id = modelId.toLowerCase();
  const tags = new Set<string>();

  // Parameter count, e.g. "70b", "8b", "3.2b" — strongest signal for size-based tags
  const sizeMatch = id.match(/(\d+(?:\.\d+)?)b(?!it)/);
  const paramsB = sizeMatch ? parseFloat(sizeMatch[1]) : null;

  if (paramsB !== null) {
    if (paramsB >= 40) {
      tags.add("long"); tags.add("business"); tags.add("reasoning");
    } else if (paramsB >= 15) {
      tags.add("long"); tags.add("business");
    } else {
      tags.add("short"); tags.add("fast"); tags.add("personal");
    }
  }

  if (/instant|flash|mini|turbo|fast|haiku/.test(id)) tags.add("fast");
  if (/r1|reasoning|qwq|o1|o3|think|deepseek/.test(id)) {
    tags.add("reasoning"); tags.add("long");
  }
  if (contextWindow && contextWindow >= 32000) tags.add("long");
  if (contextWindow && contextWindow <= 8192 && !tags.has("long")) tags.add("short");

  // Any model that survived the non-text filter is assumed instruction-tuned
  // (chat/instruct variants are what providers actually serve for completions).
  tags.add("instruction-following");

  if (tags.size === 1) tags.add("general"); // nothing else matched — only instruction-following present

  return Array.from(tags);
}

// Validate a key and return the model list for that provider
export async function validateKeyAndGetModels(
  provider: Provider,
  apiKey: string
): Promise<ModelInfo[]> {
  switch (provider) {
    case "openai": {
      const client = new OpenAI({ apiKey });
      const res = await client.models.list();
      return res.data
        .filter((m) => isTextModel(m.id) && (m.id.startsWith("gpt-") || m.id.startsWith("o1") || m.id.startsWith("o3")))
        .sort((a, b) => b.id.localeCompare(a.id)) // newest first
        .map((m) => {
          const contextWindow = m.id.includes("turbo") || m.id.includes("4o") ? 128000 : 16385;
          return {
            id: m.id,
            name: m.id,
            provider: "openai" as Provider,
            tags: tagsFor(m.id, contextWindow),
            contextWindow,
            supported: true,
          };
        });
    }
    case "groq": {
      const client = new Groq({ apiKey });
      const res = await client.models.list();
      return res.data
        .filter((m) => isTextModel(m.id))
        .map((m) => {
          const contextWindow = (m as { context_window?: number }).context_window ?? 8192;
          return {
            id: m.id,
            name: m.id,
            provider: "groq" as Provider,
            tags: tagsFor(m.id, contextWindow),
            contextWindow,
            supported: true,
          };
        })
        // Largest context window first (e.g. openai/gpt-oss-*, qwen/qwen3-* tend to have
        // much larger windows than the older llama3-*-8192 models) — ties broken alphabetically.
        .sort((a, b) => b.contextWindow - a.contextWindow || a.id.localeCompare(b.id));
    }
    case "gemini": {
      const genai = new GoogleGenerativeAI(apiKey);
      // Gemini doesn't have a list endpoint in the JS SDK — use known models
      const knownModels = ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-1.0-pro"];
      // Validate by making a lightweight call
      const model = genai.getGenerativeModel({ model: "gemini-1.5-flash" });
      await model.generateContent("test");
      return knownModels.map((id) => {
        const contextWindow = id.includes("1.5") ? 1000000 : 32000;
        return {
          id,
          name: id,
          provider: "gemini" as Provider,
          tags: tagsFor(id, contextWindow),
          contextWindow,
          supported: true,
        };
      });
    }
  }
}

// Stream a reply from the selected provider/model
export async function streamReply(
  provider: Provider,
  apiKey: string,
  modelId: string,
  systemPrompt: string,
  userMessage: string,
  onChunk: (text: string) => void
): Promise<string> {
  let full = "";

  switch (provider) {
    case "openai": {
      const client = new OpenAI({ apiKey });
      const stream = await client.chat.completions.create({
        model: modelId,
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      });
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content ?? "";
        full += text;
        onChunk(text);
      }
      break;
    }
    case "groq": {
      const client = new Groq({ apiKey });
      const stream = await client.chat.completions.create({
        model: modelId,
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      });
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content ?? "";
        full += text;
        onChunk(text);
      }
      break;
    }
    case "gemini": {
      const genai = new GoogleGenerativeAI(apiKey);
      const model = genai.getGenerativeModel({
        model: modelId,
        systemInstruction: systemPrompt,
      });
      const result = await model.generateContentStream(userMessage);
      for await (const chunk of result.stream) {
        const text = chunk.text();
        full += text;
        onChunk(text);
      }
      break;
    }
  }

  return full;
}
