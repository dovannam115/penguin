"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Folder, Upload, Download, FileText, Trash2, Wrench, Inbox, Copy, Check, ChevronRight, X, ExternalLink, RotateCw, Pencil } from "lucide-react";
import { useOffice, type FileInfo } from "@/store/office-store";
import { cn } from "@/lib/utils";
import { toast, appConfirm } from "./toast";
import { FileEditorModal } from "./file-editor";

const EDITABLE_EXTS = new Set(["html", "htm", "md", "css", "js", "json", "txt", "csv", "tsv", "xml", "log", "svg"]);
const MAX_EDIT_BYTES = 1_000_000;
function isEditable(file: FileInfo): boolean {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  return EDITABLE_EXTS.has(ext) && file.size <= MAX_EDIT_BYTES;
}

type SortKey = "name" | "mtime" | "size";
type SortDir = "asc" | "desc";

interface FolderNode {
  type: "folder";
  name: string;     // segment name, e.g. "reports"
  path: string;     // path from workspace root, e.g. "reports/q1"
  children: TreeNode[];
}
interface FileNode {
  type: "file";
  name: string;     // leaf, e.g. "summary.pdf"
  file: FileInfo;   // full info; file.name = full relative path
}
type TreeNode = FolderNode | FileNode;

function buildTree(files: FileInfo[]): TreeNode[] {
  const root: FolderNode = { type: "folder", name: "", path: "", children: [] };
  for (const f of files) {
    const parts = f.name.split("/").filter(Boolean);
    let cur: FolderNode = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let next = cur.children.find(c => c.type === "folder" && c.name === seg) as FolderNode | undefined;
      if (!next) {
        next = {
          type: "folder",
          name: seg,
          path: cur.path ? `${cur.path}/${seg}` : seg,
          children: [],
        };
        cur.children.push(next);
      }
      cur = next;
    }
    cur.children.push({ type: "file", name: parts[parts.length - 1] || f.name, file: f });
  }
  return root.children;
}

function sortTree(nodes: TreeNode[], key: SortKey, dir: SortDir): TreeNode[] {
  const folders = nodes.filter((n): n is FolderNode => n.type === "folder");
  const filesOnly = nodes.filter((n): n is FileNode => n.type === "file");
  // Folders always alphabetical, ignoring the user-selected sort
  folders.sort((a, b) => a.name.localeCompare(b.name, "vi", { sensitivity: "base" }));
  for (const f of folders) f.children = sortTree(f.children, key, dir);
  filesOnly.sort((a, b) => {
    let cmp = 0;
    if (key === "name") cmp = a.name.localeCompare(b.name, "vi", { sensitivity: "base" });
    else if (key === "size") cmp = a.file.size - b.file.size;
    else cmp = a.file.mtime - b.file.mtime;
    return dir === "asc" ? cmp : -cmp;
  });
  return [...folders, ...filesOnly];
}

function countFiles(node: FolderNode): number {
  let n = 0;
  for (const c of node.children) {
    if (c.type === "file") n++;
    else n += countFiles(c);
  }
  return n;
}

export function TaskFiles() {
  const activeTaskId = useOffice(s => s.activeTaskId);
  const tasks = useOffice(s => s.tasks);
  const filesByTask = useOffice(s => s.filesByTask);
  const setTaskFiles = useOffice(s => s.setTaskFiles);
  const toolEvents = useOffice(s => s.toolEvents);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("mtime");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<FileInfo | null>(null);
  const [editing, setEditing] = useState<FileInfo | null>(null);

  const activeTask = activeTaskId ? tasks.find(t => t.id === activeTaskId) : null;
  const files = activeTaskId ? filesByTask[activeTaskId] ?? [] : [];
  const tools = activeTaskId ? toolEvents[activeTaskId] ?? [] : [];

  const tree = useMemo(
    () => sortTree(buildTree(files), sortKey, sortDir),
    [files, sortKey, sortDir],
  );

  const toggleFolder = (path: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const refresh = useCallback(async (opts?: { manual?: boolean }) => {
    if (!activeTaskId) return;
    if (opts?.manual) setRefreshing(true);
    try {
      const res = await fetch(`/api/tasks/${activeTaskId}/files`);
      if (!res.ok) return;
      const list = (await res.json()) as FileInfo[];
      setTaskFiles(activeTaskId, list);
    } finally {
      if (opts?.manual) {
        // Hold the spin animation for a short minimum so the click registers
        // visually even when the network round-trip is instant.
        setTimeout(() => setRefreshing(false), 350);
      }
    }
  }, [activeTaskId, setTaskFiles]);

  useEffect(() => { if (activeTaskId) void refresh(); }, [activeTaskId, refresh]);

  const upload = useCallback(async (list: FileList | File[]) => {
    if (!activeTaskId) {
      toast("Select a task first, then upload.", "warning");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      for (const f of Array.from(list)) fd.append("files", f);
      const res = await fetch(`/api/tasks/${activeTaskId}/files`, { method: "POST", body: fd });
      const data = (await res.json()) as { files: FileInfo[] };
      setTaskFiles(activeTaskId, data.files);
    } finally {
      setUploading(false);
    }
  }, [activeTaskId, setTaskFiles]);

  const remove = useCallback(async (name: string) => {
    if (!activeTaskId) return;
    if (!(await appConfirm(`Delete ${name}?`))) return;
    const res = await fetch(`/api/tasks/${activeTaskId}/files?name=${encodeURIComponent(name)}`, { method: "DELETE" });
    const data = (await res.json()) as { files: FileInfo[] };
    setTaskFiles(activeTaskId, data.files);
  }, [activeTaskId, setTaskFiles]);

  if (!activeTaskId) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] px-6 py-8 max-w-[280px]">
          <FolderOpen size={28} className="mx-auto mb-2 text-slate-500" />
          <div className="text-sm font-semibold text-slate-100">No task open</div>
          <div className="mt-1.5 text-xs text-slate-400 leading-relaxed">
            Files are per-task. Select a task from <span className="text-amber-300">History</span> or
            create a new one to see the workspace.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn("task-files", dragOver && "task-files-dragover")}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files?.length) void upload(e.dataTransfer.files);
      }}
    >
      <div className="task-files-header">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">
            Workspace
          </div>
          <div className="truncate text-[13px] font-semibold text-slate-100 mt-0.5">
            {activeTask?.title || "(untitled)"}
          </div>
        </div>
        <button
          onClick={() => refresh({ manual: true })}
          disabled={refreshing}
          className="flex items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] p-1.5 text-slate-300 hover:bg-white/10 hover:text-slate-100 disabled:opacity-50"
          title="Refresh file list"
          aria-label="Refresh files"
        >
          <RotateCw size={12} className={cn(refreshing && "animate-spin")} />
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 rounded-lg border border-teal-400/30 bg-teal-400/10 px-2.5 py-1.5 text-xs font-medium text-teal-200 hover:bg-teal-400/15 disabled:opacity-50"
        >
          <Upload size={12} /> {uploading ? "Uploading…" : "Upload"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && upload(e.target.files)}
        />
      </div>

      {files.length === 0 ? (
        <div className="task-files-empty">
          <Inbox size={22} className="mx-auto mb-1.5 text-slate-500" />
          <div className="text-xs text-slate-400">No files yet</div>
          <div className="mt-1 text-[10px] text-slate-500">
            Drag & drop here or click Upload. When employees finish, output files will appear here.
          </div>
        </div>
      ) : (
        <div className="task-files-list">
          <TreeRender
            nodes={tree}
            depth={0}
            taskId={activeTaskId}
            onDelete={remove}
            onPreview={setPreview}
            onEdit={setEditing}
            collapsed={collapsed}
            onToggleFolder={toggleFolder}
          />
        </div>
      )}

      {preview && (
        <FilePreviewModal
          taskId={activeTaskId}
          file={preview}
          onClose={() => setPreview(null)}
        />
      )}

      {editing && (
        <FileEditorModal
          taskId={activeTaskId}
          file={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void refresh()}
        />
      )}

      {tools.length > 0 && (
        <div className="task-files-tools">
          <div className="text-[10px] uppercase tracking-wider text-slate-400 font-medium mb-1.5 flex items-center gap-1">
            <Wrench size={10} /> Recent activity
          </div>
          <div className="flex flex-col gap-1">
            {tools.slice(-8).reverse().map((t, i) => (
              <div key={i} className="text-[11px] text-slate-400 truncate">
                <span className="text-teal-300 font-mono">{t.tool}</span>
                <span className="opacity-50"> · {new Date(t.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FileRow({
  taskId, file, onDelete, onPreview, onEdit, displayName, depth = 0,
}: {
  taskId: string;
  file: FileInfo;
  onDelete: (name: string) => void;
  onPreview: (f: FileInfo) => void;
  onEdit: (f: FileInfo) => void;
  displayName?: string;
  depth?: number;
}) {
  const href = `/api/files/${taskId}/${encodeURIComponent(file.name)}`;
  const [copied, setCopied] = useState(false);
  const leaf = displayName ?? file.name;

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(file.name);
    } catch {
      // Fallback for non-secure contexts (HTTP over LAN without HTTPS)
      const ta = document.createElement("textarea");
      ta.value = file.name;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* give up */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div
      className="task-file-row group"
      style={{ paddingLeft: `${10 + depth * 14}px` }}
    >
      {/* Spacer matching the folder-row chevron so file icons align under
          folder icons (both folder and file rows at the same depth start
          their icon at the same x). */}
      <span aria-hidden className="inline-block w-3 shrink-0" />
      <FileText size={14} className="text-amber-300 shrink-0 task-file-head-icon" />
      <button
        type="button"
        onClick={() => onPreview(file)}
        className="flex-1 truncate text-left text-[13px] text-slate-100 hover:text-amber-300"
        title={`${file.name} · ${(file.size / 1024).toFixed(1)} KB · ${new Date(file.mtime).toLocaleString("vi-VN")}`}
      >
        {leaf}
      </button>
      <span className="task-file-col-date text-[10px] text-slate-500 tabular-nums">
        {formatMtime(file.mtime)}
      </span>
      <span className="task-file-col-size text-[10px] text-slate-500 tabular-nums text-right">
        {formatSize(file.size)}
      </span>
      <div className="task-file-col-actions flex items-center gap-0.5 shrink-0">
        <button
          onClick={copyPath}
          className={cn(
            "rounded p-1 hover:bg-white/5",
            copied ? "text-emerald-400" : "text-slate-400 hover:text-amber-300",
          )}
          title={copied ? "Path copied" : "Copy path (paste in chat for agents to read)"}
          aria-label="Copy path"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
        {isEditable(file) && (
          <button
            onClick={() => onEdit(file)}
            className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-amber-300"
            title="Edit"
            aria-label="Edit file"
          >
            <Pencil size={12} />
          </button>
        )}
        <a
          href={href}
          download
          className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-amber-300"
          title="Download"
        >
          <Download size={12} />
        </a>
        <button
          onClick={() => onDelete(file.name)}
          className="rounded p-1 text-slate-500 opacity-0 group-hover:opacity-100 hover:bg-white/5 hover:text-rose-400"
          title="Delete"
          aria-label="Delete file"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

function TreeRender({
  nodes, depth, taskId, onDelete, onPreview, onEdit, collapsed, onToggleFolder,
}: {
  nodes: TreeNode[];
  depth: number;
  taskId: string;
  onDelete: (name: string) => void;
  onPreview: (f: FileInfo) => void;
  onEdit: (f: FileInfo) => void;
  collapsed: Set<string>;
  onToggleFolder: (path: string) => void;
}) {
  return (
    <>
      {nodes.map(n => {
        if (n.type === "folder") {
          const isCollapsed = collapsed.has(n.path);
          return (
            <div key={`folder:${n.path}`}>
              <FolderRow
                node={n}
                depth={depth}
                collapsed={isCollapsed}
                onToggle={() => onToggleFolder(n.path)}
              />
              {!isCollapsed && (
                <TreeRender
                  nodes={n.children}
                  depth={depth + 1}
                  taskId={taskId}
                  onDelete={onDelete}
                  onPreview={onPreview}
                  onEdit={onEdit}
                  collapsed={collapsed}
                  onToggleFolder={onToggleFolder}
                />
              )}
            </div>
          );
        }
        return (
          <FileRow
            key={`file:${n.file.name}`}
            taskId={taskId}
            file={n.file}
            displayName={n.name}
            depth={depth}
            onDelete={onDelete}
            onPreview={onPreview}
            onEdit={onEdit}
          />
        );
      })}
    </>
  );
}

function FilePreviewModal({
  taskId, file, onClose,
}: { taskId: string; file: FileInfo; onClose: () => void }) {
  const href = `/api/files/${taskId}/${encodeURIComponent(file.name)}`;
  // docx is rendered server-side to HTML (mammoth). pptx preview disabled (user):
  // bản dựng lại không đủ đẹp -> chỉ cho tải về, mở trong PowerPoint.
  const previewHref = `/api/preview/${taskId}/${encodeURIComponent(file.name)}`;
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const isExcel = ext === "xlsx" || ext === "xls";
  const isPdf = ext === "pdf";
  const isRendered = ext === "docx";
  const iframeable = ["html", "htm", "png", "jpg", "jpeg", "gif", "webp", "svg", "txt", "md", "json", "csv", "log"].includes(ext);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 backdrop-blur-sm p-6 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="flex h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#262624] shadow-2xl ring-1 ring-black/40 animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
          <FileText size={14} className="text-amber-300 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-slate-100">{file.name}</div>
            <div className="text-[10px] text-slate-500 tabular-nums">
              {(file.size / 1024).toFixed(1)} KB · {new Date(file.mtime).toLocaleString("vi-VN")}
            </div>
          </div>
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] text-slate-300 hover:bg-white/10 hover:text-slate-100"
            title="Open in new tab"
          >
            <ExternalLink size={12} /> Open
          </a>
          <a
            href={href}
            download
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] text-slate-300 hover:bg-white/10 hover:text-slate-100"
            title="Download"
          >
            <Download size={12} /> Download
          </a>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-100"
            title="Close (Esc)"
            aria-label="Close preview"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-hidden bg-[#2F2D29]">
          {isExcel ? (
            <ExcelView href={href} />
          ) : isPdf ? (
            <object data={href} type="application/pdf" className="h-full w-full">
              <div className="flex h-full items-center justify-center p-8 text-center text-slate-400">
                Trình duyệt không có PDF viewer.{" "}
                <a href={href} download className="text-amber-300 underline ml-1">Tải về</a>
              </div>
            </object>
          ) : iframeable ? (
            <iframe
              src={href}
              title={file.name}
              className="h-full w-full border-0"
              sandbox="allow-same-origin allow-scripts allow-popups"
            />
          ) : isRendered ? (
            <iframe
              src={previewHref}
              title={file.name}
              className="h-full w-full border-0 bg-white"
              sandbox="allow-same-origin"
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <div>
                <FileText size={32} className="mx-auto mb-3 text-slate-500" />
                <div className="text-sm font-medium text-slate-300">Preview không hỗ trợ {ext.toUpperCase() || "file này"}</div>
                <div className="mt-1 text-xs text-slate-500">Bấm Download để tải về xem bằng app phù hợp.</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ExcelView({ href }: { href: string }) {
  const [sheets, setSheets] = useState<{ name: string; html: string }[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(href);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const XLSX = await import("xlsx");
        const wb = XLSX.read(buf, { type: "array" });
        const out = wb.SheetNames.map(n => ({
          name: n,
          html: XLSX.utils.sheet_to_html(wb.Sheets[n], { editable: false }),
        }));
        if (!cancelled) {
          setSheets(out);
          setActive(0);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [href]);

  if (error) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-rose-300">Lỗi đọc Excel: {error}</div>;
  }
  if (sheets.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-400">Đang đọc workbook…</div>;
  }

  return (
    <div className="flex h-full flex-col">
      {sheets.length > 1 && (
        <div className="flex gap-1 border-b border-white/10 bg-[#262624] px-2 py-1.5 overflow-x-auto shrink-0">
          {sheets.map((s, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className={cn(
                "rounded px-2.5 py-1 text-[11px] font-medium whitespace-nowrap transition",
                i === active
                  ? "bg-teal-400/15 text-teal-200 ring-1 ring-teal-400/30"
                  : "text-slate-400 hover:bg-white/5 hover:text-slate-200",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div
        className="excel-preview-pane flex-1 overflow-auto bg-white text-slate-900"
        dangerouslySetInnerHTML={{ __html: sheets[active].html }}
      />
    </div>
  );
}

function FolderRow({
  node, depth, collapsed, onToggle,
}: { node: FolderNode; depth: number; collapsed: boolean; onToggle: () => void }) {
  const count = countFiles(node);
  return (
    <button
      type="button"
      onClick={onToggle}
      className="task-file-row group w-full text-left"
      style={{ paddingLeft: `${10 + depth * 14}px` }}
      title={collapsed ? "Expand folder" : "Collapse folder"}
    >
      <ChevronRight
        size={12}
        className={cn(
          "shrink-0 text-slate-400 transition-transform",
          !collapsed && "rotate-90",
        )}
      />
      <Folder size={14} className="text-teal-300 shrink-0" />
      <span className="flex-1 truncate text-[13px] font-medium text-slate-100">{node.name}</span>
      <span className="text-[10px] text-slate-500 tabular-nums">{count} file</span>
    </button>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatMtime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  if (sameDay) {
    return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
}
