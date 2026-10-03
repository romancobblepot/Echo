"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, CheckSquare, Trash2, X as XIcon } from "lucide-react";

const FOLDER_PICKER_HINT_FS_ACCESS =
  "Pick any folder in the dialog and click Select/Upload — everything inside it, including subfolders, gets uploaded automatically.";
const FOLDER_PICKER_HINT_MAC =
  "In the dialog: switch to List View (toolbar icon), single-click the folder once to highlight it (don't double-click into it), then click Open.";
const FOLDER_PICKER_HINT_GENERIC =
  "In the dialog, select the folder itself (don't open it) and confirm — all files inside, including subfolders, will be uploaded.";

const ACCEPTED = ".pdf,.docx,.doc,.json,.txt,.html,.md";
const ACCEPTED_EXTS = [".pdf", ".docx", ".doc", ".json", ".txt", ".html", ".md"];

function hasAcceptedExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ACCEPTED_EXTS.some((ext) => lower.endsWith(ext));
}

interface UploadedFile {
  id: string;
  file_name: string;
  file_type: string;
  file_size: number | null;
  parent_folder: string | null;
  uploaded_at: string;
}

interface UploadProgress {
  fileName: string;
  message: string;
  pct: number;
  done: boolean;
  error?: string;
}

function formatBytes(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(type: string) {
  if (type === "application/pdf") return "📄";
  if (type.includes("word")) return "📝";
  if (type === "application/json") return "📋";
  if (type === "text/html") return "🌐";
  if (type === "text/markdown") return "🗒️";
  return "📃";
}

interface FilePanelProps {
  /** When set, show checkboxes for context scoping */
  scopingMode?: boolean;
  selectedFileIds?: Set<string>;
  onSelectionChange?: (ids: Set<string>) => void;
}

export default function FilePanel({
  scopingMode = false,
  selectedFileIds,
  onSelectionChange,
}: FilePanelProps = {}) {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [progresses, setProgresses] = useState<UploadProgress[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [confirmingFolder, setConfirmingFolder] = useState<string | null>(null);
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [isMac, setIsMac] = useState(false);
  const [hasFSAccess, setHasFSAccess] = useState(false);
  const [skippedNotice, setSkippedNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setIsMac(/mac/i.test(navigator.userAgent));
    setHasFSAccess(typeof window !== "undefined" && "showDirectoryPicker" in window);
  }, []);

  // Warn when a selection/drop contained files but none matched the supported types —
  // previously this failed completely silently, leaving the user with no feedback at all.
  function checkForSkipped(totalCount: number, acceptedCount: number) {
    if (totalCount > 0 && acceptedCount === 0) {
      setSkippedNotice(
        `No supported files found (${totalCount} file${totalCount !== 1 ? "s" : ""} skipped). Supported types: ${ACCEPTED}`
      );
    } else if (totalCount > acceptedCount) {
      setSkippedNotice(
        `${totalCount - acceptedCount} unsupported file${totalCount - acceptedCount !== 1 ? "s" : ""} skipped. Supported types: ${ACCEPTED}`
      );
    } else {
      setSkippedNotice(null);
    }
  }

  function toggleFile(id: string) {
    if (!onSelectionChange || !selectedFileIds) return;
    const next = new Set(selectedFileIds);
    next.has(id) ? next.delete(id) : next.add(id);
    onSelectionChange(next);
  }

  function toggleBulkFile(id: string) {
    setBulkSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // Clicking a folder's own checkbox selects/deselects every file inside it at once —
  // if some (but not all) are already selected, this completes the selection rather
  // than clearing it, which reads more predictably than a strict toggle.
  function toggleBulkFolder(folderFileIds: string[]) {
    setBulkSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = folderFileIds.every((id) => next.has(id));
      for (const id of folderFileIds) {
        allSelected ? next.delete(id) : next.add(id);
      }
      return next;
    });
  }

  function exitBulkSelectMode() {
    setBulkSelectMode(false);
    setBulkSelectedIds(new Set());
  }

  async function handleBulkDelete() {
    setBulkDeleting(true);
    try {
      await Promise.all(
        Array.from(bulkSelectedIds).map((id) =>
          fetch("/api/files/delete", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileId: id }),
          })
        )
      );
    } finally {
      setBulkDeleting(false);
      setConfirmingBulkDelete(false);
      exitBulkSelectMode();
      await loadFiles();
    }
  }

  function toggleFolder(folder: string, expand: boolean) {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      next.has(folder) ? next.delete(folder) : next.add(folder);
      return next;
    });
  }

  async function loadFiles() {
    setFilesLoading(true);
    setFilesError("");
    try {
      const res = await fetch("/api/files/list");
      const data = await res.json();
      if (!res.ok || !data.files) throw new Error(data.error ?? "Failed to load files");
      setFiles(data.files);
    } catch (err) {
      setFilesError((err as Error).message || "Failed to load files");
    } finally {
      setFilesLoading(false);
    }
  }

  useEffect(() => { loadFiles(); }, []);

  async function uploadFileWithProgress(file: File, parentFolder?: string) {
    const form = new FormData();
    form.append("file", file);
    if (parentFolder) form.append("parentFolder", parentFolder);

    const progressKey = `${file.name}-${Date.now()}`;

    setProgresses((prev) => [
      ...prev,
      { fileName: file.name, message: "Starting…", pct: 0, done: false },
    ]);

    const res = await fetch("/api/files/upload", { method: "POST", body: form });
    if (!res.body) throw new Error("No response stream");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let event = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          event = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          try {
            const payload = JSON.parse(line.slice(6));
            if (event === "progress") {
              setProgresses((prev) =>
                prev.map((p) =>
                  p.fileName === file.name && !p.done
                    ? { ...p, message: payload.message, pct: payload.pct }
                    : p
                )
              );
            } else if (event === "done") {
              setProgresses((prev) =>
                prev.map((p) =>
                  p.fileName === file.name && !p.done
                    ? { ...p, message: "Done!", pct: 100, done: true }
                    : p
                )
              );
            } else if (event === "error") {
              setProgresses((prev) =>
                prev.map((p) =>
                  p.fileName === file.name && !p.done
                    ? { ...p, message: payload.message, pct: 0, done: true, error: payload.message }
                    : p
                )
              );
              throw new Error(payload.message);
            }
          } catch { /* JSON parse error on partial lines — safe to ignore */ }
        }
      }
    }

    // Remove completed progress bar after 3s
    setTimeout(() => {
      setProgresses((prev) => prev.filter((p) => p.fileName !== file.name || !p.done));
    }, 3000);
  }

  async function handleFiles(fileList: FileList, parentFolder?: string) {
    const all = Array.from(fileList);
    let accepted = 0;
    for (const file of all) {
      if (!hasAcceptedExtension(file.name)) continue;
      accepted++;
      await uploadFileWithProgress(file, parentFolder);
    }
    checkForSkipped(all.length, accepted);
    await loadFiles();
  }

  // webkitdirectory grabs an entire folder tree in one picker call (click path),
  // since browsers only allow one directory per <input> click and ignore `accept`.
  // Used only as a fallback for browsers without the File System Access API.
  async function handleFolderPick(fileList: FileList) {
    const all = Array.from(fileList);
    let accepted = 0;
    for (const file of all) {
      if (!hasAcceptedExtension(file.name)) continue;
      accepted++;
      const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const topFolder = relPath.split("/")[0] || "folder";
      await uploadFileWithProgress(file, topFolder);
    }
    checkForSkipped(all.length, accepted);
    await loadFiles();
  }

  async function collectFromDirectoryHandle(
    dirHandle: FileSystemDirectoryHandle,
    folderName: string,
    out: { file: File; folder: string }[]
  ) {
    // @ts-expect-error -- FileSystemDirectoryHandle async iterator isn't in TS DOM lib yet
    for await (const entry of dirHandle.values()) {
      if (entry.kind === "file") {
        const file = await (entry as FileSystemFileHandle).getFile();
        out.push({ file, folder: folderName });
      } else if (entry.kind === "directory") {
        await collectFromDirectoryHandle(entry as FileSystemDirectoryHandle, folderName, out);
      }
    }
  }

  // Modern folder picker — gives a real "select this folder" dialog with no
  // navigate-vs-select ambiguity, unlike the legacy webkitdirectory input.
  async function handleChooseFolderClick() {
    if (typeof window !== "undefined" && "showDirectoryPicker" in window) {
      try {
        const dirHandle = await (window as Window & {
          showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
        }).showDirectoryPicker();

        const collected: { file: File; folder: string }[] = [];
        await collectFromDirectoryHandle(dirHandle, dirHandle.name, collected);

        let accepted = 0;
        for (const { file, folder } of collected) {
          if (!hasAcceptedExtension(file.name)) continue;
          accepted++;
          await uploadFileWithProgress(file, folder);
        }
        checkForSkipped(collected.length, accepted);
        await loadFiles();
      } catch (err) {
        // AbortError = user cancelled the picker — not an error
        if ((err as Error).name !== "AbortError") {
          console.error("Folder picker failed:", err);
        }
      }
    } else {
      // Fallback for browsers without File System Access API support
      folderInputRef.current?.click();
    }
  }

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);

    // Snapshot items immediately — DataTransferItemList becomes invalid after await
    const itemSnapshots = Array.from(e.dataTransfer.items).map((item) => ({
      entry: item.webkitGetAsEntry?.() ?? null,
      file: item.getAsFile(),
    }));

    const fileList: { file: File; folder?: string }[] = [];

    for (const { entry, file } of itemSnapshots) {
      if (entry?.isDirectory) {
        await collectFolder(entry as FileSystemDirectoryEntry, entry.name, fileList);
      } else if (file) {
        fileList.push({ file });
      }
    }

    let accepted = 0;
    for (const { file, folder } of fileList) {
      if (!hasAcceptedExtension(file.name)) continue;
      accepted++;
      await uploadFileWithProgress(file, folder);
    }
    checkForSkipped(fileList.length, accepted);
    await loadFiles();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function collectFolder(
    dir: FileSystemDirectoryEntry,
    folderName: string,
    out: { file: File; folder?: string }[]
  ) {
    const reader = dir.createReader();
    // readEntries returns at most 100 entries — call repeatedly until empty
    const readAll = (): Promise<FileSystemEntry[]> =>
      new Promise((resolve, reject) => {
        const all: FileSystemEntry[] = [];
        const read = () => {
          reader.readEntries((entries) => {
            if (entries.length === 0) return resolve(all);
            all.push(...entries);
            read();
          }, reject);
        };
        read();
      });

    const entries = await readAll();
    for (const entry of entries) {
      if (entry.isFile) {
        const file = await new Promise<File>((res, rej) =>
          (entry as FileSystemFileEntry).file(res, rej)
        );
        out.push({ file, folder: folderName });
      } else if (entry.isDirectory) {
        await collectFolder(entry as FileSystemDirectoryEntry, folderName, out);
      }
    }
  }

  async function deleteFile(id: string) {
    await fetch("/api/files/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: id }),
    });
    await loadFiles();
  }

  async function deleteFolder(folderName: string) {
    await fetch("/api/files/delete-folder", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderName }),
    });
    await loadFiles();
  }

  const topLevel = files.filter((f) => !f.parent_folder);
  const folders = [...new Set(files.filter((f) => f.parent_folder).map((f) => f.parent_folder!))];
  const isUploading = progresses.some((p) => !p.done);

  return (
    <div className="flex flex-col h-full border-r bg-muted/30">
      <div className="p-4 border-b flex items-center justify-between">
        <span className="text-sm font-semibold flex items-center gap-1.5">
          {scopingMode ? "Select Sources" : bulkSelectMode ? "Select to Remove" : "Knowledge Base"}
          {!scopingMode && !bulkSelectMode && (
            <InfoTooltip text="Documents you upload here are used as context for drafting replies — the AI searches them for relevant info (via semantic + keyword search) and weaves it into your draft, without ever quoting them verbatim or mentioning them in the reply itself." />
          )}
        </span>
        <div className="flex items-center gap-1.5">
          {scopingMode && selectedFileIds && selectedFileIds.size > 0 && (
            <Badge className="h-5 px-1.5 text-xs">{selectedFileIds.size} selected</Badge>
          )}
          {bulkSelectMode && bulkSelectedIds.size > 0 && (
            <Badge className="h-5 px-1.5 text-xs">{bulkSelectedIds.size} selected</Badge>
          )}
          <Badge variant="secondary">{files.length} file{files.length !== 1 ? "s" : ""}</Badge>
          {!scopingMode && !bulkSelectMode && files.length > 0 && (
            <button
              onClick={() => setBulkSelectMode(true)}
              className="h-6 px-2 flex items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Select multiple files/folders to remove at once"
            >
              <CheckSquare size={13} /> Select
            </button>
          )}
          {bulkSelectMode && (
            <button
              onClick={exitBulkSelectMode}
              className="h-6 px-2 flex items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Exit selection mode"
            >
              <XIcon size={13} /> Cancel
            </button>
          )}
        </div>
      </div>

      {bulkSelectMode && (
        <div className="px-3 py-2 border-b flex items-center justify-between gap-2 bg-muted/50">
          <button
            onClick={() =>
              setBulkSelectedIds((prev) =>
                prev.size === files.length ? new Set() : new Set(files.map((f) => f.id))
              )
            }
            className="text-xs text-primary hover:underline"
          >
            {bulkSelectedIds.size === files.length ? "Deselect all" : "Select all"}
          </button>
          <Button
            size="sm"
            variant="destructive"
            className="h-7 text-xs gap-1"
            disabled={bulkSelectedIds.size === 0}
            onClick={() => setConfirmingBulkDelete(true)}
          >
            <Trash2 size={13} /> Remove {bulkSelectedIds.size > 0 ? `(${bulkSelectedIds.size})` : ""}
          </Button>
        </div>
      )}

      <AlertDialog open={confirmingBulkDelete} onOpenChange={setConfirmingBulkDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {bulkSelectedIds.size} file{bulkSelectedIds.size !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the selected files and their indexed content. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {bulkDeleting ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Drop zone — one click target, files vs folder resolved via a small menu
          since no single native picker can offer both in one dialog */}
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={isUploading}
          nativeButton={false}
          render={
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`w-full mx-3 mt-3 rounded-lg border-2 border-dashed flex flex-col items-center justify-center gap-1 py-5 transition-colors text-center
                ${isUploading ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}
                ${dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/30 hover:border-primary/50"}`}
              style={{ width: "calc(100% - 1.5rem)" }}
            />
          }
        >
          <span className="text-xl">{isUploading ? "⏳" : "📂"}</span>
          <span className="text-xs text-muted-foreground">
            {isUploading ? "Indexing…" : "Drop files or folders here"}
          </span>
          {!isUploading && (
            <>
              <span className="text-xs text-muted-foreground/60">or click to upload</span>
              <span className="text-[10px] text-muted-foreground/50 mt-0.5">
                {ACCEPTED_EXTS.map((e) => e.slice(1).toUpperCase()).join(" · ")}
              </span>
            </>
          )}
        </DropdownMenuTrigger>

        <DropdownMenuContent align="center">
          <DropdownMenuItem onClick={() => inputRef.current?.click()}>
            Upload files
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={handleChooseFolderClick}
            className="flex items-center justify-between gap-2"
          >
            Upload folder
            <InfoTooltip
              text={hasFSAccess ? FOLDER_PICKER_HINT_FS_ACCESS : (isMac ? FOLDER_PICKER_HINT_MAC : FOLDER_PICKER_HINT_GENERIC)}
            />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={(el) => {
          folderInputRef.current = el;
          // JSX attribute passthrough for non-standard boolean attrs like
          // webkitdirectory is unreliable across browsers/React versions —
          // set both the attribute AND the IDL property imperatively.
          if (el) {
            el.setAttribute("webkitdirectory", "true");
            el.setAttribute("directory", "true");
            (el as HTMLInputElement & { webkitdirectory: boolean; directory: boolean }).webkitdirectory = true;
            (el as HTMLInputElement & { webkitdirectory: boolean; directory: boolean }).directory = true;
          }
        }}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) handleFolderPick(e.target.files);
          e.target.value = "";
        }}
      />

      {skippedNotice && (
        <div className="mx-3 mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-300">
          <span className="flex-1">{skippedNotice}</span>
          <button
            onClick={() => setSkippedNotice(null)}
            className="shrink-0 text-amber-600 hover:text-amber-900 dark:hover:text-amber-100"
            aria-label="Dismiss"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Progress bars */}
      {progresses.length > 0 && (
        <div className="mx-3 mt-2 flex flex-col gap-2">
          {progresses.map((p, i) => (
            <div key={i} className="text-xs">
              <div className="flex justify-between mb-0.5">
                <span className="truncate max-w-[150px]" title={p.fileName}>{p.fileName}</span>
                <span className={p.error ? "text-destructive" : "text-muted-foreground"}>
                  {p.error ? "Failed" : `${p.pct}%`}
                </span>
              </div>
              <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${p.error ? "bg-destructive" : "bg-primary"}`}
                  style={{ width: `${p.pct}%` }}
                />
              </div>
              <p className={`mt-0.5 ${p.error ? "text-destructive" : "text-muted-foreground"}`}>
                {p.error ?? p.message}
              </p>
            </div>
          ))}
        </div>
      )}

      <Separator className="mt-3" />

      <ScrollArea className="flex-1 px-2 py-2">
        {filesLoading ? (
          <div className="flex flex-col gap-2 px-2 mt-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : filesError ? (
          <div className="flex flex-col items-center gap-2 text-center mt-4 px-2">
            <AlertTriangle size={16} className="text-amber-500" />
            <p className="text-xs text-muted-foreground">{filesError}</p>
            <Button size="sm" variant="outline" className="h-6 text-xs" onClick={loadFiles}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            {files.length === 0 && progresses.length === 0 && (
              <p className="text-xs text-muted-foreground text-center mt-4">No files yet</p>
            )}

            {topLevel.map((f) => (
          <FileRow
            key={f.id}
            file={f}
            onDelete={deleteFile}
            showCheckbox={scopingMode || bulkSelectMode}
            hideRemove={scopingMode || bulkSelectMode}
            checked={bulkSelectMode ? bulkSelectedIds.has(f.id) : (selectedFileIds?.has(f.id) ?? false)}
            onToggle={bulkSelectMode ? () => toggleBulkFile(f.id) : () => toggleFile(f.id)}
          />
        ))}

        {folders.map((folder) => {
          const folderFiles = files.filter((f) => f.parent_folder === folder);
          const expanded = expandedFolders.has(folder);
          const confirming = confirmingFolder === folder;
          return (
            <div key={folder} className="group">
              <div className="w-full flex items-center gap-2 px-2 py-1.5 text-xs font-medium hover:bg-muted rounded-md">
                {bulkSelectMode && (
                  <input
                    type="checkbox"
                    checked={folderFiles.every((f) => bulkSelectedIds.has(f.id))}
                    onChange={() => toggleBulkFolder(folderFiles.map((f) => f.id))}
                    className="w-3.5 h-3.5 shrink-0 accent-primary cursor-pointer"
                    title="Select/deselect all files in this folder"
                  />
                )}
                <button
                  onClick={() => toggleFolder(folder, !expanded)}
                  className="flex items-center gap-2 flex-1 min-w-0 text-left"
                >
                  <span>{expanded ? "📂" : "📁"}</span>
                  <span className="flex-1 text-left truncate">{folder}</span>
                </button>
                <span className="text-muted-foreground shrink-0">{folderFiles.length}</span>
                {!scopingMode && !bulkSelectMode && (
                  confirming ? (
                    <div className="flex gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-5 px-1.5 text-xs"
                        onClick={() => { deleteFolder(folder); setConfirmingFolder(null); }}
                      >
                        Remove all
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-5 px-1.5 text-xs"
                        onClick={() => setConfirmingFolder(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmingFolder(folder)}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity shrink-0"
                      title={`Remove folder "${folder}" and all ${folderFiles.length} file${folderFiles.length !== 1 ? "s" : ""} inside it`}
                    >
                      ✕
                    </button>
                  )
                )}
              </div>
              {expanded && (
                <div className="pl-4">
                  {folderFiles.map((f) => (
                    <FileRow
                      key={f.id}
                      file={f}
                      onDelete={deleteFile}
                      showCheckbox={scopingMode || bulkSelectMode}
                      hideRemove={scopingMode || bulkSelectMode}
                      checked={bulkSelectMode ? bulkSelectedIds.has(f.id) : (selectedFileIds?.has(f.id) ?? false)}
                      onToggle={bulkSelectMode ? () => toggleBulkFile(f.id) : () => toggleFile(f.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
          </>
        )}
      </ScrollArea>
    </div>
  );
}

function FileRow({
  file,
  onDelete,
  showCheckbox = false,
  checked = false,
  onToggle,
  hideRemove = false,
}: {
  file: UploadedFile;
  onDelete: (id: string) => void;
  showCheckbox?: boolean;
  checked?: boolean;
  onToggle?: () => void;
  hideRemove?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted text-xs">
      {showCheckbox && (
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="w-3.5 h-3.5 shrink-0 accent-primary cursor-pointer"
          title={checked ? "Deselect" : "Select"}
        />
      )}
      <span className="shrink-0">{fileIcon(file.file_type)}</span>
      <span className="flex-1 truncate" title={file.file_name}>{file.file_name}</span>
      {file.file_size && (
        <span className="text-muted-foreground shrink-0">{formatBytes(file.file_size)}</span>
      )}
      {!hideRemove && (
        confirming ? (
          <div className="flex gap-1 shrink-0">
            <Button size="sm" variant="destructive" className="h-5 px-1.5 text-xs"
              onClick={() => onDelete(file.id)}>
              Remove
            </Button>
            <Button size="sm" variant="ghost" className="h-5 px-1.5 text-xs"
              onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity shrink-0"
            title="Remove file"
          >
            ✕
          </button>
        )
      )}
    </div>
  );
}
