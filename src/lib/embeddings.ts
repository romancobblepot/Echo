// HF retired api-inference.huggingface.co in favor of the Inference Providers router
const HF_API_URL =
  "https://router.huggingface.co/hf-inference/models/sentence-transformers/all-mpnet-base-v2/pipeline/feature-extraction";

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const res = await fetch(HF_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.HF_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs: texts, options: { wait_for_model: true } }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HuggingFace embedding error: ${err}`);
  }

  const data = await res.json();
  // HF returns either number[][] directly or a nested array — normalise
  if (Array.isArray(data[0][0])) {
    return (data as number[][][]).map((item) => item[0]);
  }
  return data as number[][];
}

export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  return embedding;
}
