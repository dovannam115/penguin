"use client";
import { useEffect, useState } from "react";
import { Plus, Settings, MessageSquarePlus, Pencil, GripVertical, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useOffice } from "@/store/office-store";
import { TaskHistory } from "./task-history";
import { ThemeToggle } from "./theme-toggle";
import { cn } from "@/lib/utils";

interface Props {
  onOpenHire: () => void;
  onOpenSettings: () => void;
  onEditAgent: (id: string) => void;
}

const COLLAPSE_KEY = "penguin.sidebar.collapsed";

export function ChatSidebar({ onOpenHire, onOpenSettings, onEditAgent }: Props) {
  // Collapse to a thin rail so chat takes the full width. Persisted to
  // localStorage so the choice survives reloads / app restarts. Cmd/Ctrl+B
  // toggles too, matching VSCode muscle memory.
  const [collapsed, setCollapsed] = useState<boolean>(false);
  useEffect(() => {
    try {
      const v = localStorage.getItem(COLLAPSE_KEY);
      if (v === "1") setCollapsed(true);
    } catch { /* localStorage unavailable */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* ignore */ }
  }, [collapsed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setCollapsed(c => !c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Update-available indicator on the Settings cog. Polls /api/update/check
  // on mount + every 6h. Backend returns { available: false } when no repo
  // is configured, so this is a silent no-op for users who don't use GitHub.
  const [updateAvailable, setUpdateAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetch("/api/update/check", { cache: "no-store" });
        const d = await r.json();
        if (!cancelled) setUpdateAvailable(!!d.available);
      } catch { /* offline / endpoint missing — leave badge off */ }
    };
    check();
    const t = setInterval(check, 6 * 60 * 60 * 1000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const employees = useOffice(s => s.employees);
  const setEmployees = useOffice(s => s.setEmployees);
  const selectedId = useOffice(s => s.selectedEmployeeId);
  const setSelected = useOffice(s => s.setSelected);
  const setActiveTask = useOffice(s => s.setActiveTask);
  const setChatOpen = useOffice(s => s.setChatOpen);
  const activeTaskId = useOffice(s => s.activeTaskId);
  const tasks = useOffice(s => s.tasks);
  const profile = useOffice(s => s.profile);
  const nameLabel = profile.name || profile.address;

  // Drag-to-reorder agents. Native HTML5 DnD — small list (<50), no library
  // needed. dragOverId is which row the pointer is hovering; we visually
  // surface a drop indicator above it so the target slot is unambiguous.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  function selectEmployee(id: string) {
    setSelected(id);
    const activeTask = activeTaskId ? tasks.find(t => t.id === activeTaskId) : null;
    if (activeTask && activeTask.assignedTo !== id) setActiveTask(null);
    setChatOpen(true);
  }

  function newChat() {
    setActiveTask(null);
    setSelected(null);
  }

  function commitReorder(fromId: string, toId: string) {
    if (fromId === toId) return;
    const ids = employees.map(e => e.id);
    const fromIdx = ids.indexOf(fromId);
    const toIdx = ids.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...ids];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, fromId);
    // Optimistic update so the move feels instant.
    setEmployees(next.map(id => employees.find(e => e.id === id)!));
    fetch("/api/employees/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: next }),
    }).catch(() => {
      // On failure, refetch authoritative order from server.
      fetch("/api/employees").then(r => r.json()).then(setEmployees).catch(() => {});
    });
  }

  if (collapsed) {
    // Thin rail: just the expand button + a New Task shortcut so the user
    // doesn't have to expand → click → collapse for the most common action.
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center gap-2 border-r border-white/[0.06] bg-[#1A1916] py-3">
        <button
          onClick={() => setCollapsed(false)}
          className="rounded-lg p-2 text-slate-400 hover:bg-white/[0.06] hover:text-slate-200 transition"
          title="Expand sidebar (Ctrl+B)"
          aria-label="Expand sidebar"
        >
          <PanelLeftOpen size={16} />
        </button>
        <button
          onClick={newChat}
          className="rounded-lg p-2 text-slate-400 hover:bg-white/[0.06] hover:text-slate-200 transition"
          title="New task"
          aria-label="New task"
        >
          <MessageSquarePlus size={16} />
        </button>
        <div className="my-1 h-px w-6 bg-white/[0.06]" />
        <button
          onClick={onOpenSettings}
          className="relative mt-auto rounded-lg p-2 text-slate-400 hover:bg-white/[0.06] hover:text-slate-200 transition"
          title={updateAvailable ? "Settings — update available" : "Settings"}
          aria-label="Settings"
        >
          <Settings size={16} />
          {updateAvailable && (
            <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-400 ring-2 ring-[#1A1916]" />
          )}
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-white/[0.06] bg-[#1A1916]">
      <div className="flex items-center justify-between gap-2 px-4 pt-5 pb-3">
        <span className="truncate text-[12px] italic text-slate-500">
          What&apos;s the brief, {nameLabel}?
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <ThemeToggle compact />
          <button onClick={onOpenSettings} className="relative rounded-lg p-1.5 text-slate-500 hover:bg-white/[0.06] hover:text-slate-300 transition-all duration-300 ease-out [&>svg]:hover:rotate-90 [&>svg]:transition-transform [&>svg]:duration-300 [&>svg]:ease-out" title={updateAvailable ? "Settings — update available" : "Settings"}>
            <Settings size={16} />
            {updateAvailable && (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-400 ring-2 ring-[#0e0c1c]" />
            )}
          </button>
          <button
            onClick={() => setCollapsed(true)}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-white/[0.06] hover:text-slate-300 transition"
            title="Collapse sidebar (Ctrl+B)"
            aria-label="Collapse sidebar"
          >
            <PanelLeftClose size={16} />
          </button>
        </div>
      </div>

      <div className="px-3 pb-3">
        <button
          onClick={newChat}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-[13px] font-medium text-slate-200 hover:bg-white/[0.06] transition"
        >
          <MessageSquarePlus size={15} />
          New Task
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="mb-1 px-1 text-[10px] uppercase tracking-widest text-slate-500 font-medium">Agents</div>

        {employees.map(e => {
          const isDragging = draggingId === e.id;
          const showDropAbove = dragOverId === e.id && draggingId && draggingId !== e.id;
          return (
            <div key={e.id} className="relative">
              {showDropAbove && (
                <div className="pointer-events-none absolute -top-px left-2 right-2 h-0.5 rounded-full bg-amber-400/80 shadow-[0_0_8px_rgba(251,191,36,0.6)]" />
              )}
              <div
                draggable
                onDragStart={(ev) => {
                  setDraggingId(e.id);
                  ev.dataTransfer.effectAllowed = "move";
                  // Required for Firefox to actually fire drag events.
                  ev.dataTransfer.setData("text/plain", e.id);
                }}
                onDragOver={(ev) => {
                  ev.preventDefault();
                  ev.dataTransfer.dropEffect = "move";
                  if (dragOverId !== e.id) setDragOverId(e.id);
                }}
                onDragLeave={() => {
                  if (dragOverId === e.id) setDragOverId(null);
                }}
                onDrop={(ev) => {
                  ev.preventDefault();
                  if (draggingId) commitReorder(draggingId, e.id);
                  setDraggingId(null);
                  setDragOverId(null);
                }}
                onDragEnd={() => {
                  setDraggingId(null);
                  setDragOverId(null);
                }}
                role="button"
                tabIndex={0}
                onClick={() => selectEmployee(e.id)}
                onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") selectEmployee(e.id); }}
                className={cn(
                  "group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-all duration-200 ease-out",
                  selectedId === e.id && !activeTaskId
                    ? "bg-white/[0.06] ring-1 ring-white/10 shadow-sm shadow-white/[0.02]"
                    : "text-slate-300 hover:bg-white/[0.05] hover:translate-x-0.5",
                  isDragging && "opacity-40",
                )}
              >
                <span
                  className="shrink-0 text-slate-600 opacity-0 transition group-hover:opacity-100 cursor-grab active:cursor-grabbing"
                  title="Drag to reorder"
                  aria-label="Drag handle"
                >
                  <GripVertical size={12} />
                </span>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm ring-1 ring-black/20" style={{ backgroundColor: e.avatarColor }}>
                  {e.emoji}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-[13px]">{e.name}</div>
                  <div className="truncate text-[11px] text-slate-500">{e.role}</div>
                </div>
                <button
                  onClick={(ev) => { ev.stopPropagation(); onEditAgent(e.id); }}
                  className="shrink-0 rounded-md p-1.5 text-slate-500 opacity-0 transition group-hover:opacity-100 hover:bg-white/10 hover:text-amber-300"
                  title="Edit agent"
                  aria-label={`Edit ${e.name}`}
                >
                  <Pencil size={12} />
                </button>
              </div>
            </div>
          );
        })}

        <button
          onClick={onOpenHire}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-slate-500 hover:bg-white/[0.04] hover:text-slate-300 transition"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-dashed border-slate-600 shrink-0">
            <Plus size={14} />
          </div>
          <span className="text-[13px]">Add agent</span>
        </button>
      </div>

      <div className="mx-3 h-px bg-white/[0.06]" />

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-widest text-slate-500 font-medium">History</div>
        <TaskHistory />
      </div>
    </aside>
  );
}
