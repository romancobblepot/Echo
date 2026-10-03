import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { folderName } = await request.json();
  if (!folderName) return NextResponse.json({ error: "folderName required" }, { status: 400 });

  const { data: files, error: fetchError } = await supabase
    .from("uploaded_files")
    .select("id, file_path")
    .eq("user_id", user.id)
    .eq("parent_folder", folderName);

  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!files || files.length === 0) {
    return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }

  // Delete from Storage — one batched call covers every file in the folder
  const paths = files.map((f) => f.file_path);
  await supabase.storage.from("knowledge-base").remove(paths);

  // Delete from DB — cascades to doc_chunks automatically for each row
  const { error: deleteError } = await supabase
    .from("uploaded_files")
    .delete()
    .eq("user_id", user.id)
    .eq("parent_folder", folderName);

  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });

  return NextResponse.json({ success: true, removed: files.length });
}
