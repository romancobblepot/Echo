import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { fileId } = await request.json();
  if (!fileId) return NextResponse.json({ error: "fileId required" }, { status: 400 });

  // Fetch file record (ensures ownership)
  const { data: fileRecord, error: fetchError } = await supabase
    .from("uploaded_files")
    .select("file_path")
    .eq("id", fileId)
    .eq("user_id", user.id)
    .single();

  if (fetchError || !fileRecord) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  // Delete from Storage
  await supabase.storage.from("knowledge-base").remove([fileRecord.file_path]);

  // Delete from DB — cascades to doc_chunks automatically
  const { error: deleteError } = await supabase
    .from("uploaded_files")
    .delete()
    .eq("id", fileId)
    .eq("user_id", user.id);

  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
