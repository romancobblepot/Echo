import { embedQuery } from "./embeddings";
import { createClient } from "./supabase/server";

// HF retired api-inference.huggingface.co in favor of the Inference Providers router
const RERANKER_URL =
  "https://router.huggingface.co/hf-inference/models/cross-encoder/ms-marco-MiniLM-L-6-v2";

interface Candidate {
  id: string;
  file_id: string;
  chunk_text: string;
  metadata: Record<string, unknown>;
  semantic_score: number;
  keyword_rank: number;
}

interface RankedChunk {
  chunk_text: string;
  score: number;
  file_name: string;
  source_file_id: string;
}

function fallbackRanking(candidates: Candidate[]): RankedChunk[] {
  return candidates
    .sort((a, b) => b.semantic_score - a.semantic_score)
    .map((c) => ({
      chunk_text: c.chunk_text,
      score: c.semantic_score,
      file_name: (c.metadata?.file_name as string) ?? "",
      source_file_id: c.file_id,
    }));
}

async function rerank(query: string, candidates: Candidate[]): Promise<RankedChunk[]> {
  const pairs = candidates.map((c) => [query, c.chunk_text]);

  let res: Response;
  try {
    res = await fetch(RERANKER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: pairs, options: { wait_for_model: true } }),
    });
  } catch {
    // Network-level failure (DNS, timeout, etc.) — fall back to semantic ordering
    return fallbackRanking(candidates);
  }

  if (!res.ok) {
    // Reranker unavailable — fall back to semantic score ordering
    return fallbackRanking(candidates);
  }

  const scores: number[] = await res.json();

  return candidates
    .map((c, i) => ({
      chunk_text: c.chunk_text,
      score: scores[i],
      file_name: (c.metadata?.file_name as string) ?? "",
      source_file_id: c.file_id,
    }))
    .sort((a, b) => b.score - a.score);
}

export async function retrieveContext(
  emailText: string,
  userId: string,
  topK = 3,
  fileIds?: string[]
): Promise<RankedChunk[]> {
  const supabase = await createClient();

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedQuery(emailText);
  } catch {
    // Embedding service unavailable — draft without knowledge-base context
    return [];
  }

  const rpcArgs: Record<string, unknown> = {
    query_embedding: JSON.stringify(queryEmbedding),
    query_text: emailText,
    match_user_id: userId,
    top_k: 5,
  };
  if (fileIds && fileIds.length > 0) {
    rpcArgs.filter_file_ids = fileIds;
  }

  const { data, error } = await supabase.rpc("hybrid_search", rpcArgs);

  if (error || !data || data.length === 0) return [];

  const candidates = data as Candidate[];
  const ranked = await rerank(emailText, candidates);

  return ranked.slice(0, topK);
}

export function formatContextForPrompt(chunks: RankedChunk[]): string {
  if (chunks.length === 0) return "";
  return chunks
    .map(
      (c, i) =>
        `[Source ${i + 1}: ${c.file_name}]\n${c.chunk_text}`
    )
    .join("\n\n---\n\n");
}
