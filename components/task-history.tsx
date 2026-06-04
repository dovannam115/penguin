"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { User, Inbox, Clock, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useOffice } from "@/store/office-store";
import { cn, formatTime } from "@/lib/utils";
import { toast, appConfirm } from "@/components/toast";
import type { Task, Message } from "@/lib/types";

export function TaskHistory() {
  const tasks = useOffice(s => s.tasks);
  const employees = useOffice(s => s.employees);
  const activeTaskId = useOffice(s => s.activeTaskId);
  const setActiveTask = useOffice(s => s.setActiveTask);
  const mergeMessages = useOffice(s => s.mergeMessages);
  const setSelected = useOffice(s => s.setSelected);
  const setPanelTab = useOffice(s => s.setPanelTab);
  const upsertTask = useOffice(s => s.upsertTask);
  const removeTask = useOffice(s => s.removeTask);

  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  function closeMenu() {
    setMenuOpenId(null);
    setMenuPos(null);
  }

  function openMenuFor(triggerEl: HTMLElement, taskId: string) {
    const rect = triggerEl.getBoundingClientRect();
    // Anchor to the right edge of the trigger so the menu hugs the row's
    // right side regardless of sidebar width.
    setMenuPos({
      top: Math.round(rect.bottom + 4),
      right: Math.round(window.innerWidth - rect.right),
    });
    setMenuOpenId(taskId);
  }

  // Close menu on outside click / Escape / scroll (since the menu uses fixed
  // positioning, scrolling the sidebar would otherwise leave it floating in
  // the wrong place).
  useEffect(() => {
    if (!menuOpenId) return;
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement;
      if (!t.closest?.("[data-task-menu]") && !t.closest?.("[data-task-menu-trigger]")) {
        closeMenu();
      }
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") closeMenu(); };
    const onScroll = () => closeMenu();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true); // capture: catch scrolling inside the sidebar container
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [menuOpenId]);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const openTask = useCallback(async (t: Task) => {
    setActiveTask(t.id);
    if (t.assignedTo) setSelected(t.assignedTo);
    setPanelTab("inbox");
    try {
      const res = await fetch(`/api/tasks?taskId=${encodeURIComponent(t.id)}`, { method: "POST" });
      if (!res.ok) return;
      const msgs = (await res.json()) as Message[];
      mergeMessages(msgs);
    } catch {
      /* ignore — store still has recent messages */
    }
  }, [setActiveTask, setSelected, setPanelTab, mergeMessages]);

  function startRename(t: Task) {
    closeMenu();
    setRenameDraft(t.title);
    setRenamingId(t.id);
  }

  async function commitRename(t: Task) {
    const next = renameDraft.trim();
    setRenamingId(null);
    if (!next || next === t.title) return;
    upsertTask({ ...t, title: next });
    try {
      await fetch(`/api/tasks/${encodeURIComponent(t.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
    } catch {
      toast("Rename failed", "error");
    }
  }

  async function togglePin(t: Task) {
    closeMenu();
    const next = !t.pinned;
    upsertTask({ ...t, pinned: next });
    try {
      await fetch(`/api/tasks/${encodeURIComponent(t.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: next }),
      });
    } catch {
      // Roll back optimistic update on failure.
      upsertTask({ ...t, pinned: t.pinned });
      toast(next ? "Pin failed" : "Unpin failed", "error");
    }
  }

  async function deleteTask(t: Task) {
    closeMenu();
    if (!(await appConfirm(`Delete task "${t.title}"?\n\nAll chat and files for this task will be lost.`))) return;
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(t.id)}`, { method: "DELETE" });
      if (!res.ok) {
        toast("Delete failed", "error");
        return;
      }
      removeTask(t.id);
    } catch {
      toast("Delete failed", "error");
    }
  }

  if (tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center">
        <div>
          <Inbox size={28} className="mx-auto mb-2 text-slate-500" />
          <div className="text-sm text-slate-400">No tasks yet</div>
          <div className="mt-1 text-xs text-slate-500">Create a task below to get started</div>
        </div>
      </div>
    );
  }

  // Mirror server-side sort: pinned first (preserving relative order), then
  // the rest. Without this, an optimistic pin-toggle leaves the row in place
  // until the next refetch.
  const sorted = [...tasks].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.createdAt - a.createdAt;
  });

  return (
    <div className="task-history">
      {sorted.map(t => {
        const assignee = t.assignedTo ? employees.find(e => e.id === t.assignedTo) : null;
        const isActive = t.id === activeTaskId;
        const isRenaming = renamingId === t.id;
        const menuOpen = menuOpenId === t.id;
        return (
          <div
            key={t.id}
            className={cn("task-row group relative", isActive && "task-row-active")}
            onClick={() => { if (!isRenaming && !menuOpen) openTask(t); }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (!isRenaming && (e.key === "Enter" || e.key === " ")) openTask(t); }}
          >
            <div className="task-row-icon">
              {t.pinned ? <Pin size={12} className="text-amber-300" /> : <User size={14} />}
            </div>
            <div className="task-row-body">
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  value={renameDraft}
                  onChange={e => setRenameDraft(e.target.value)}
                  onClick={e => e.stopPropagation()}
                  onKeyDown={e => {
                    e.stopPropagation();
                    if (e.key === "Enter") { e.preventDefault(); commitRename(t); }
                    if (e.key === "Escape") { e.preventDefault(); setRenamingId(null); }
                  }}
                  onBlur={() => commitRename(t)}
                  className="w-full rounded-md border border-teal-400/40 bg-[#262624]/80 px-1.5 py-0.5 text-[13px] font-medium text-slate-100 outline-none focus:ring-1 focus:ring-teal-400/30"
                />
              ) : (
                <div className="task-row-title">{t.title || "(untitled)"}</div>
              )}
              <div className="task-row-meta">
                <Clock size={10} className="opacity-70" />
                <span>{formatTime(t.createdAt)}</span>
                {assignee && (
                  <>
                    <span className="text-slate-500">·</span>
                    <span
                      className="task-row-avatar"
                      style={{ background: assignee.avatarColor }}
                      title={assignee.name}
                    >
                      {assignee.emoji}
                    </span>
                  </>
                )}
              </div>
            </div>

            <button
              data-task-menu-trigger
              onClick={(e) => {
                e.stopPropagation();
                if (menuOpen) closeMenu();
                else openMenuFor(e.currentTarget, t.id);
              }}
              className={cn(
                "shrink-0 self-start rounded-md p-1 transition",
                menuOpen
                  ? "bg-white/10 text-slate-200 opacity-100"
                  : "text-slate-500 opacity-0 hover:bg-white/10 hover:text-slate-200 group-hover:opacity-100",
                isActive && "opacity-100",
              )}
              aria-label="Task actions"
              title="Actions"
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
        );
      })}

      {/* Menu rendered via portal at document.body level so it escapes the
          sidebar's stacking context (the row hover-transform was clipping it). */}
      {menuOpenId && menuPos && typeof window !== "undefined" && createPortal(
        (() => {
          const t = sorted.find(x => x.id === menuOpenId);
          if (!t) return null;
          return (
            <div
              data-task-menu
              style={{ position: "fixed", top: menuPos.top, right: menuPos.right, zIndex: 1000 }}
              className="w-40 overflow-hidden rounded-lg border border-white/10 bg-[#34322D] shadow-xl ring-1 ring-black/40 animate-pop-in"
              onClick={(e) => e.stopPropagation()}
            >
              <MenuItem icon={Pencil}                     label="Rename"                          onClick={() => startRename(t)} />
              <MenuItem icon={t.pinned ? PinOff : Pin}    label={t.pinned ? "Unpin" : "Pin"}      onClick={() => togglePin(t)} />
              <div className="my-0.5 h-px bg-white/[0.06]" />
              <MenuItem icon={Trash2}                     label="Delete"                   danger onClick={() => deleteTask(t)} />
            </div>
          );
        })(),
        document.body,
      )}
    </div>
  );
}

function MenuItem({
  icon: Icon, label, onClick, danger,
}: {
  icon: typeof Pin;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition",
        danger
          ? "text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
          : "text-slate-200 hover:bg-white/[0.06]"
      )}
    >
      <Icon size={13} className={danger ? "text-rose-300" : "text-slate-400"} />
      {label}
    </button>
  );
}

