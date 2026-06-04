"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useOffice } from "@/store/office-store";
import type { Employee, Message, Task } from "@/lib/types";
import { EmployeeDialog } from "./employee-dialog";
import { SettingsDialog } from "./settings-dialog";
import { ChatSidebar } from "./chat-sidebar";
import { ChatDrawer } from "./chat-drawer";
import { TaskFiles } from "./task-files";
import { TaskWorkflow } from "./task-workflow";
import type { UserProfile } from "@/store/office-store";
import { LordIcon } from "./lord-icon";

type SidePanel = "files" | "workflow" | null;

export function OfficeCanvas() {
  const employees = useOffice(s => s.employees);
  const setEmployees = useOffice(s => s.setEmployees);
  const setMessages = useOffice(s => s.setMessages);
  const setTasks = useOffice(s => s.setTasks);
  const setProfile = useOffice(s => s.setProfile);
  const setCustomSkills = useOffice(s => s.setCustomSkills);
  const setSkillOverrides = useOffice(s => s.setSkillOverrides);
  const activeTaskId = useOffice(s => s.activeTaskId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Only one side panel open at a time (Files or Workflow).
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);

  // Aside (Files/Workflow) panel width, drag-resizable. Persisted across sessions.
  const ASIDE_MIN = 280;
  const ASIDE_MAX_FRAC = 0.7; // never let aside eat more than 70% of viewport width
  const [asideWidth, setAsideWidth] = useState(400);
  const [dragging, setDragging] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("mas-aside-width") : null;
    if (saved) {
      const n = parseInt(saved, 10);
      if (!Number.isNaN(n)) setAsideWidth(n);
    }
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const rect = mainRef.current?.getBoundingClientRect();
      if (!rect) return;
      const right = rect.right - e.clientX;
      const max = Math.floor(rect.width * ASIDE_MAX_FRAC);
      const next = Math.max(ASIDE_MIN, Math.min(max, right));
      setAsideWidth(next);
    };
    const onUp = () => setDragging(false);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  useEffect(() => {
    localStorage.setItem("mas-aside-width", String(asideWidth));
  }, [asideWidth]);

  useEffect(() => {
    fetch("/api/bootstrap")
      .then(r => r.json())
      .then((data: { employees: Employee[]; recentMessages: Message[]; tasks: Task[]; profile: UserProfile; customSkills?: unknown[]; skillOverrides?: unknown[] }) => {
        setEmployees(data.employees);
        setMessages(data.recentMessages);
        setTasks(data.tasks ?? []);
        if (data.profile) setProfile(data.profile);
        if (data.customSkills) setCustomSkills(data.customSkills as import("@/store/office-store").CustomSkill[]);
        if (data.skillOverrides) setSkillOverrides(data.skillOverrides as import("@/store/office-store").SkillOverride[]);
      })
      .catch(err => console.error("bootstrap failed", err));
  }, [setEmployees, setMessages, setTasks, setProfile, setCustomSkills, setSkillOverrides]);

  const openEdit = (id: string) => {
    setEditingId(id);
    setDialogOpen(true);
  };

  const editingEmployee = useMemo(
    () => employees.find(e => e.id === editingId) ?? null,
    [employees, editingId],
  );

  const toggle = (p: Exclude<SidePanel, null>) =>
    setSidePanel(cur => (cur === p ? null : p));

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#262624]">
      <ChatSidebar
        onOpenHire={() => { setEditingId(null); setDialogOpen(true); }}
        onOpenSettings={() => setSettingsOpen(true)}
        onEditAgent={openEdit}
      />

      <main ref={mainRef} className="relative flex flex-1 min-w-0">
        <div className="flex-1 min-w-0">
          <ChatDrawer
            onEdit={openEdit}
            onToggleFiles={() => toggle("files")}
            filesOpen={sidePanel === "files"}
            onToggleWorkflow={() => toggle("workflow")}
            workflowOpen={sidePanel === "workflow"}
          />
        </div>

        {sidePanel && activeTaskId && (
          <>
            {/* Drag handle to resize the aside vs chat pane */}
            <div
              onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
              onDoubleClick={() => setAsideWidth(400)}
              className={`group relative w-1 shrink-0 cursor-col-resize bg-white/[0.06] hover:bg-amber-400/40 ${dragging ? "bg-amber-400/60" : ""}`}
              title="Drag to resize, double-click to reset"
            >
              <div className="absolute inset-y-0 -left-1 -right-1" />
            </div>
            <aside
              style={{ width: `${asideWidth}px` }}
              className="shrink-0 bg-[#262624] flex flex-col animate-slide-right"
            >
              <div className="flex items-center justify-between px-3 pt-3 pb-1">
                <span className="text-[11px] uppercase tracking-widest text-slate-500 font-medium">
                  {sidePanel === "files" ? "Files" : "Workflow"}
                </span>
                <button
                  onClick={() => setSidePanel(null)}
                  className="rounded-lg p-0.5 text-slate-500 hover:bg-white/5 hover:text-slate-300"
                  title="Close"
                  aria-label="Close panel"
                >
                  <LordIcon src="https://cdn.lordicon.com/vfiwitrm.json" size={22} trigger="hover" />
                </button>
              </div>
              <div className="flex-1 min-h-0">
                {sidePanel === "files" ? <TaskFiles /> : <TaskWorkflow />}
              </div>
            </aside>
          </>
        )}

        {dragging && <div className="absolute inset-0 z-50 cursor-col-resize" />}
      </main>

      <EmployeeDialog
        open={dialogOpen}
        employee={editingEmployee}
        onClose={() => { setDialogOpen(false); setEditingId(null); }}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
