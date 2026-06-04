"use client";
import { useEffect, useState, useCallback } from "react";
import { useOffice } from "@/store/office-store";
import { GitBranch, RefreshCw, Plus, X, ChevronRight, Save, MessageSquarePlus } from "lucide-react";
import { cn } from "@/lib/utils";

interface WorkflowNode {
  label: string;
  children?: WorkflowNode[];
  _id?: string; // client-only stable key (stripped server-side on save)
}

// ── stable client ids so editing/collapse state survives add/delete ──
let _idc = 0;
const genId = () => `n${++_idc}_${Math.random().toString(36).slice(2, 7)}`;
function withIds(node: WorkflowNode): WorkflowNode {
  return {
    ...node,
    _id: node._id ?? genId(),
    children: node.children?.map(withIds),
  };
}

// ── immutable tree ops; path = array of child indices from root ──
function updateAt(root: WorkflowNode, path: number[], fn: (n: WorkflowNode) => WorkflowNode): WorkflowNode {
  if (path.length === 0) return fn(root);
  const [i, ...rest] = path;
  const children = root.children ?? [];
  return { ...root, children: children.map((c, idx) => (idx === i ? updateAt(c, rest, fn) : c)) };
}
function deleteAt(root: WorkflowNode, path: number[]): WorkflowNode {
  if (path.length === 0) return root; // never delete the root
  const idx = path[path.length - 1];
  return updateAt(root, path.slice(0, -1), p => ({
    ...p,
    children: (p.children ?? []).filter((_, i) => i !== idx),
  }));
}
function addChildAt(root: WorkflowNode, path: number[], label: string): WorkflowNode {
  return updateAt(root, path, n => ({
    ...n,
    children: [...(n.children ?? []), { label, _id: genId() }],
  }));
}

// ── tree → indented text for the chat composer ──
function serialize(node: WorkflowNode, depth = 0): string {
  const indent = "  ".repeat(Math.max(0, depth - 1));
  const bullet = depth === 0 ? "" : depth === 1 ? "▸ " : "- ";
  const line = depth === 0 ? "" : `${indent}${bullet}${node.label}\n`;
  const kids = (node.children ?? []).map(c => serialize(c, depth + 1)).join("");
  return line + kids;
}

export function TaskWorkflow() {
  const activeTaskId = useOffice(s => s.activeTaskId);
  const setPendingDraft = useOffice(s => s.setPendingDraft);

  const [tree, setTree] = useState<WorkflowNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Load the cached map whenever the active task changes.
  useEffect(() => {
    setTree(null); setError(null); setFetched(false); setDirty(false);
    if (!activeTaskId) return;
    let cancelled = false;
    fetch(`/api/tasks/${activeTaskId}/workflow`)
      .then(r => r.json())
      .then((d: { map: WorkflowNode | null }) => {
        if (cancelled) return;
        setTree(d.map ? withIds(d.map) : null);
        setFetched(true);
      })
      .catch(() => { if (!cancelled) setFetched(true); });
    return () => { cancelled = true; };
  }, [activeTaskId]);

  const generate = useCallback(async () => {
    if (!activeTaskId) return;
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/tasks/${activeTaskId}/workflow`, { method: "POST" });
      const text = await res.text();
      let d: { map?: WorkflowNode; error?: string } = {};
      try { d = JSON.parse(text); }
      catch {
        console.error("[workflow] non-JSON response:", res.status, text);
        setError(`Server ${res.status} (xem console F12 để thấy full HTML)`);
        return;
      }
      if (!res.ok) { setError(d.error || `Tạo map thất bại (${res.status})`); return; }
      if (!d.map) { setError("Server không trả map"); return; }
      setTree(withIds(d.map));
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lỗi mạng");
    } finally {
      setLoading(false);
    }
  }, [activeTaskId]);

  const save = useCallback(async () => {
    if (!activeTaskId || !tree) return;
    try {
      await fetch(`/api/tasks/${activeTaskId}/workflow`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ map: tree }),
      });
      setDirty(false);
    } catch { /* keep dirty so the user can retry */ }
  }, [activeTaskId, tree]);

  const mutate = useCallback((fn: (root: WorkflowNode) => WorkflowNode) => {
    setTree(t => (t ? fn(t) : t));
    setDirty(true);
  }, []);

  function sendToChat() {
    if (!tree) return;
    const text = `Làm lại task này theo workflow đã điều chỉnh:\n\n${serialize(tree).trimEnd()}`;
    setPendingDraft(text);
    if (dirty) save();
  }

  if (!activeTaskId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-slate-500">
        Open a task to see its workflow.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex items-center gap-1.5 border-b border-white/[0.06] px-3 py-2">
        <span className="flex-1 truncate text-[11px] italic text-slate-500">
          {tree ? "Sửa các bước rồi đưa vào chat làm lại" : "Chưa có workflow map"}
        </span>
        {tree && dirty && (
          <button
            onClick={save}
            title="Lưu chỉnh sửa"
            className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-slate-300 transition hover:border-white/25"
          >
            <Save size={11} /> Lưu
          </button>
        )}
        <button
          onClick={generate}
          disabled={loading}
          title={tree ? "Tạo lại map" : "Tạo map"}
          className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-slate-300 transition hover:border-white/25 disabled:opacity-50"
        >
          <RefreshCw size={11} className={cn(loading && "animate-spin")} />
          {loading ? "Đang tạo..." : tree ? "Tạo lại" : "Tạo map"}
        </button>
      </div>

      {/* body */}
      <div className="flex-1 overflow-y-auto p-3">
        {error && (
          <div className="mb-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">
            {error}
          </div>
        )}

        {loading && !tree && (
          <div className="flex h-full items-center justify-center text-xs text-slate-500">
            Đang tóm tắt workflow của task...
          </div>
        )}

        {!loading && !tree && fetched && !error && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <GitBranch size={26} className="text-slate-600" />
            <div className="text-xs leading-relaxed text-slate-400">
              Bấm <span className="text-slate-200">Tạo map</span> để tóm tắt workflow của task này thành cây.
              Anh sửa lại các bước rồi đưa vào chat cho agent làm lại.
            </div>
          </div>
        )}

        {tree && <Node node={tree} path={[]} mutate={mutate} />}
      </div>

      {/* footer */}
      {tree && (
        <div className="border-t border-white/[0.06] p-3">
          <button
            onClick={sendToChat}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-ember px-3 py-2 text-[13px] font-medium text-white transition hover:bg-ember-soft"
          >
            <MessageSquarePlus size={14} />
            Đưa vào chat làm lại
          </button>
        </div>
      )}
    </div>
  );
}

function Node({ node, path, mutate }: {
  node: WorkflowNode;
  path: number[];
  mutate: (fn: (root: WorkflowNode) => WorkflowNode) => void;
}) {
  const depth = path.length;
  const isRoot = depth === 0;
  const hasChildren = !!node.children?.length;
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.label);

  useEffect(() => { setDraft(node.label); }, [node.label]);

  function commit() {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== node.label) {
      mutate(root => updateAt(root, path, n => ({ ...n, label: v })));
    } else {
      setDraft(node.label);
    }
  }

  return (
    <div>
      <div
        className="group flex items-start gap-1 rounded-md py-0.5 pr-1 transition-colors hover:bg-white/[0.025]"
        style={{ paddingLeft: depth * 14 }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            className="mt-[3px] shrink-0 text-slate-500 hover:text-slate-300"
            aria-label={open ? "Thu gọn" : "Mở rộng"}
          >
            <ChevronRight size={12} className={cn("transition-transform", open && "rotate-90")} />
          </button>
        ) : (
          <span className="mt-[9px] mx-[3px] h-1 w-1 shrink-0 rounded-full bg-slate-600" />
        )}

        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") { setEditing(false); setDraft(node.label); }
            }}
            className="min-w-0 flex-1 rounded border border-amber-400/40 bg-[#262624] px-1.5 py-0.5 text-[12px] text-slate-100 outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            title="Bấm để sửa"
            className={cn(
              "min-w-0 flex-1 cursor-text break-words text-left text-[12px] leading-snug",
              isRoot ? "font-semibold text-slate-100" : depth === 1 ? "font-medium text-slate-200" : "text-slate-400"
            )}
          >
            {node.label || <span className="italic text-slate-600">(trống)</span>}
          </button>
        )}

        {/* row actions — appear on hover */}
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={() => {
              mutate(root => addChildAt(root, path, depth === 0 ? "New agent" : "New step"));
              setOpen(true);
            }}
            title="Thêm nhánh con"
            className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-emerald-400"
          >
            <Plus size={11} />
          </button>
          {!isRoot && (
            <button
              type="button"
              onClick={() => mutate(root => deleteAt(root, path))}
              title="Xóa"
              className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {hasChildren && open && (
        <div>
          {node.children!.map((c, i) => (
            <Node key={c._id ?? i} node={c} path={[...path, i]} mutate={mutate} />
          ))}
        </div>
      )}
    </div>
  );
}
