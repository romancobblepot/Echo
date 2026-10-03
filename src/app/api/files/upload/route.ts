import { createClient } from "@/lib/supabase/server";
import { extractText, chunkText } from "@/lib/file-parser";
import { embedTexts } from "@/lib/embeddings";
import { NextResponse } from "next/server";

const ALLOWED_TYPES: Record<string, boolean> = {
  "application/pdf": true,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
  "application/msword": true,
  "application/json": true,
  "text/plain": true,
  "text/html": true,
  "text/markdown": true,
};

const BATCH_SIZE = 16;

function sse(controller: ReadableStreamDefaultController, event: string, data: object) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  controller.enqueue(new TextEncoder().encode(msg));
}

// POST /api/files/upload  — streams SSE progress back to the client
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const parentFolder = formData.get("parentFolder") as string | null;

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (!ALLOWED_TYPES[file.type]) {
    return NextResponse.json({ error: `Unsupported file type: ${file.type}` }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const storagePath = `${user.id}/${Date.now()}_${file.name}`;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Step 1 — Upload to Storage
        sse(controller, "progress", { step: "uploading", message: "Uploading file…", pct: 10 });
        const { error: storageError } = await supabase.storage
          .from("knowledge-base")
          .upload(storagePath, buffer, { contentType: file.type, upsert: false });

        if (storageError) throw new Error(storageError.message);

        // Step 2 — Register in DB
        sse(controller, "progress", { step: "registering", message: "Registering file…", pct: 20 });
        const { data: fileRecord, error: dbError } = await supabase
          .from("uploaded_files")
          .insert({
            user_id: user.id,
            file_name: file.name,
            file_path: storagePath,
            file_type: file.type,
            file_size: file.size,
            parent_folder: parentFolder ?? null,
          })
          .select()
          .single();

        if (dbError) throw new Error(dbError.message);

        // Step 3 — Extract text
        sse(controller, "progress", { step: "parsing", message: "Parsing document…", pct: 35 });
        const text = await extractText(buffer, file.type);

        // Step 4 — Chunk
        sse(controller, "progress", { step: "chunking", message: "Chunking text…", pct: 45 });
        const chunks = chunkText(text);

        // Step 5 — Embed + upsert in batches
        const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);
        for (let b = 0; b < totalBatches; b++) {
          const batch = chunks.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
          const pct = Math.round(45 + ((b + 1) / totalBatches) * 50);

          sse(controller, "progress", {
            step: "embedding",
            message: `Embedding batch ${b + 1}/${totalBatches}…`,
            pct,
          });

          const embeddings = await embedTexts(batch);

          const rows = batch.map((chunk, j) => ({
            file_id: fileRecord.id,
            user_id: user.id,
            chunk_text: chunk,
            embedding: JSON.stringify(embeddings[j]),
            chunk_index: b * BATCH_SIZE + j,
            metadata: {
              file_name: file.name,
              file_type: file.type,
              source_file_id: fileRecord.id,
            },
          }));

          const { error: chunkError } = await supabase.from("doc_chunks").insert(rows);
          if (chunkError) throw new Error(chunkError.message);
        }

        sse(controller, "done", { fileId: fileRecord.id, fileName: file.name, chunks: chunks.length });
      } catch (err) {
        // Roll back storage + file record on failure
        await supabase.storage.from("knowledge-base").remove([storagePath]);
        await supabase.from("uploaded_files").delete().eq("file_path", storagePath);
        sse(controller, "error", { message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
