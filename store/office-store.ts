"use client";
import { create } from "zustand";
import type { Employee, Message, Task } from "@/lib/types";

export interface FileInfo {
  name: string;
  size: number;
  mtime: number;
}

interface StreamingState {
  text: string;
  /** Extended-thinking summaries from the SDK (adaptive thinking). Streamed
   *  separately from `text` so the bubble can render thoughts above the final
   *  answer. Empty string if the model didn't think (or thinking is disabled). */
  thinking: string;
  startedAt: number;
  /** Which task this stream belongs to. UI filters the typing indicator so
   *  it only shows in the room where the agent is actually replying — fixes
   *  the bug where switching tasks left a stale "typing" bubble visible in
   *  the new task. */
  taskId: string | null;
}

export interface UserProfile {
  name: string;
  address: string;
}

export interface PendingInvite {
  inviteId: string;
  taskId: string;
  fromId: string;
  fromName: string;
  targetId: string;
  targetName: string;
  targetEmoji: string;
  targetRole: string;
  reason: string;
  sourceMessageId: string;
  createdAt: number;
}

export interface CustomSkill {
  id: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  prompt: string;
  source: string;
  createdAt: number;
}

/** User-edited override for a built-in skill. Null fields fall through to default. */
export interface SkillOverride {
  id: string;
  name: string | null;
  description: string | null;
  prompt: string | null;
  updatedAt: number;
}

interface OfficeState {
  employees: Employee[];
  messages: Message[];
  tasks: Task[];
  profile: UserProfile;
  customSkills: CustomSkill[];
  /** Map of built-in skill id → user-edited override fields. Absent = default. */
  skillOverrides: Record<string, SkillOverride>;

  activeTaskId: string | null;
  selectedEmployeeId: string | null;
  hoveredEmployeeId: string | null;

  streamingByEmployee: Record<string, StreamingState | undefined>;

  /** Live planner output during multi-agent room dispatch. One slot at a time
   *  (single planner runs per task). Cleared once the final `plan` event
   *  arrives and the system message has been appended. */
  planStreaming: { taskId: string; text: string } | null;
  startPlanStreaming: (taskId: string) => void;
  appendPlanStreaming: (delta: string) => void;
  clearPlanStreaming: () => void;

  /** Pending agent-to-agent invites awaiting user approval. Server emits an
   *  `invite_request` SSE event when an agent's reply @-mentions someone not
   *  already in the room; the UI renders Accept / Decline buttons that either
   *  fire a handoff dispatch or drop the invite. Ephemeral — lost on reload. */
  pendingInvites: PendingInvite[];
  addPendingInvite: (i: PendingInvite) => void;
  removePendingInvite: (inviteId: string) => void;

  chatOpen: boolean;
  /** True iff *some* task is currently running. Derived from busyTaskId; kept
   *  as a separate field so existing callers that only care about "is anything
   *  going" don't need to thread the id through. */
  isBusy: boolean;
  /** Task id of the currently-running turn, or null when idle. UI uses this
   *  to scope Stop / delete-block to the actually-busy task so the user can
   *  freely interact with other tasks while one is mid-stream. */
  busyTaskId: string | null;

  /* Right panel tab — shared between SideRail / RightPanel / TaskHistory */
  panelTab: "inbox" | "history" | "files" | "dashboard";
  setPanelTab: (t: "inbox" | "history" | "files" | "dashboard") => void;
  /* Whether the entire right panel is hidden (user clicked X) */
  panelCollapsed: boolean;
  setPanelCollapsed: (v: boolean) => void;

  /* Mức B: identity of the logged-in account (used for the sidebar label and
   * optimistic task ownership). Hydrated from /api/bootstrap. */
  currentSpaceId: string;
  currentSpaceName: string;
  setSpaceContext: (id: string, name: string) => void;
  /* Admin approval gate: whether this account is awaiting approval, and whether
   * it is the admin (can approve others). Hydrated from /api/bootstrap. */
  pending: boolean;
  isAdmin: boolean;
  /* Admin view-as: whether this admin is browsing another account, and whose. */
  isViewing: boolean;
  viewingName: string;
  setAccountStatus: (pending: boolean, isAdmin: boolean, isViewing?: boolean, viewingName?: string) => void;

  /* Layout: scene PIP + drawer resize */
  sceneMinimized: boolean;
  scenePipPos: { x: number; y: number }; // anchored from bottom-right of viewport
  drawerWidth: number;
  setSceneMinimized: (v: boolean) => void;
  setScenePipPos: (p: { x: number; y: number }) => void;
  setDrawerWidth: (w: number) => void;

  currentAbort: AbortController | null;
  setCurrentAbort: (c: AbortController | null) => void;
  stopCurrent: () => void;

  filesByTask: Record<string, FileInfo[]>;
  setTaskFiles: (taskId: string, files: FileInfo[]) => void;

  toolEvents: Record<string, { tool: string; input: unknown; at: number; employeeId: string | null }[]>; // taskId → tool history (for UI live ticker)
  appendToolEvent: (taskId: string, tool: string, input: unknown, employeeId: string | null) => void;

  /** Live partial-JSON for a tool call still being generated by the model.
   *  Keyed by (taskId, employeeId). Cleared when the agent's turn ends or the
   *  matched final tool_use lands. The UI uses this to render a real-time
   *  CodeTail preview during long file writes (Write/Edit/Bash). */
  streamingToolByTask: Record<string, Record<string, { id: string; toolName: string; partialJson: string; startedAt: number }>>;
  startStreamingTool: (taskId: string, employeeId: string, id: string, toolName: string) => void;
  appendStreamingTool: (taskId: string, employeeId: string, id: string, partialJson: string) => void;
  /** Pass `matchId` to clear only if the live slot still belongs to that
   *  tool — protects against an out-of-order completed tool_use from a
   *  previous block wiping the currently-streaming preview. Omit to clear
   *  unconditionally (turn end / abort). */
  clearStreamingTool: (taskId: string, employeeId: string, matchId?: string) => void;

  setCustomSkills: (s: CustomSkill[]) => void;
  addCustomSkill: (s: CustomSkill) => void;
  updateCustomSkill: (s: CustomSkill) => void;
  removeCustomSkill: (id: string) => void;
  setSkillOverrides: (rows: SkillOverride[]) => void;
  upsertSkillOverride: (o: SkillOverride) => void;
  removeSkillOverride: (id: string) => void;
  setEmployees: (e: Employee[]) => void;
  setMessages: (m: Message[]) => void;
  mergeMessages: (m: Message[]) => void;
  setTasks: (t: Task[]) => void;
  upsertTask: (t: Task) => void;
  removeTask: (id: string) => void;
  setProfile: (p: UserProfile) => void;
  upsertEmployee: (e: Employee) => void;
  removeEmployee: (id: string) => void;
  updateEmployeePosition: (id: string, x: number, y: number) => void;
  appendMessage: (m: Message) => void;

  startStreaming: (employeeId: string, taskId: string | null) => void;
  appendStreaming: (employeeId: string, delta: string) => void;
  appendThinking: (employeeId: string, delta: string) => void;
  clearStreaming: (employeeId: string) => void;

  setSelected: (id: string | null) => void;
  setHovered: (id: string | null) => void;
  setChatOpen: (open: boolean) => void;
  setIsBusy: (b: boolean) => void;
  setBusyTask: (taskId: string | null) => void;
  setActiveTask: (id: string | null) => void;

  /** Text to inject into the chat composer — set by the Workflow panel so the
   *  user can push an edited workflow back into chat. */
  pendingDraft: string | null;
  setPendingDraft: (v: string | null) => void;

  /** Light/dark theme. Persisted to localStorage by setTheme. Initial value
   *  is hydrated from the <script> in app/layout.tsx so first paint matches. */
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;

  /** Update flow state. Lifted out of UpdatePanel so the user can switch
   *  Settings tabs or close the dialog mid-update without losing progress —
   *  the panel remounts and reads the live phase from here. */
  updatePhase: UpdatePhase;
  setUpdatePhase: (p: UpdatePhase) => void;
}

export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; startedAt: number; size?: number }
  | { kind: "staging"; startedAt: number }
  | { kind: "ready"; version?: string }
  | { kind: "restarting"; startedAt: number }
  | { kind: "error"; message: string };

export const useOffice = create<OfficeState>((set, get) => ({
  employees: [],
  messages: [],
  tasks: [],
  customSkills: [],
  skillOverrides: {},
  profile: { name: "anh", address: "anh" },
  activeTaskId: null,
  selectedEmployeeId: null,
  hoveredEmployeeId: null,
  streamingByEmployee: {},
  planStreaming: null,
  pendingInvites: [],
  chatOpen: false,
  isBusy: false,
  busyTaskId: null,

  panelTab: "inbox",
  setPanelTab: (t) => set({ panelTab: t }),
  panelCollapsed: false,
  setPanelCollapsed: (v) => {
    if (typeof window !== "undefined") localStorage.setItem("vo.panelCollapsed", v ? "1" : "0");
    set({ panelCollapsed: v });
  },

  currentSpaceId: "",
  currentSpaceName: "",
  setSpaceContext: (id, name) => set({ currentSpaceId: id, currentSpaceName: name }),
  pending: false,
  isAdmin: false,
  isViewing: false,
  viewingName: "",
  setAccountStatus: (pending, isAdmin, isViewing = false, viewingName = "") =>
    set({ pending, isAdmin, isViewing, viewingName }),

  sceneMinimized: false,
  scenePipPos: { x: 24, y: 220 },
  drawerWidth: 440,
  setSceneMinimized: (v) => {
    if (typeof window !== "undefined") localStorage.setItem("vo.sceneMin", v ? "1" : "0");
    set({ sceneMinimized: v });
  },
  setScenePipPos: (p) => {
    if (typeof window !== "undefined") localStorage.setItem("vo.pipPos", JSON.stringify(p));
    set({ scenePipPos: p });
  },
  setDrawerWidth: (w) => {
    const maxW = typeof window !== "undefined"
      ? Math.max(500, window.innerWidth - 240) // leave room for side rail (56) + a sensible scene area
      : 1400;
    const clamped = Math.max(360, Math.min(maxW, Math.round(w)));
    if (typeof window !== "undefined") localStorage.setItem("vo.drawerW", String(clamped));
    set({ drawerWidth: clamped });
  },

  currentAbort: null,
  setCurrentAbort: (c) => set({ currentAbort: c }),
  stopCurrent: () => {
    const c = useOffice.getState().currentAbort;
    if (c) c.abort();
  },

  filesByTask: {},
  setTaskFiles: (taskId, files) => set(s => ({ filesByTask: { ...s.filesByTask, [taskId]: files } })),

  streamingToolByTask: {},
  startStreamingTool: (taskId, employeeId, id, toolName) => set(s => {
    if (typeof toolName === "string" && toolName.startsWith("mcp__") && !toolName.startsWith("mcp__office__")) return s;
    const taskMap = { ...(s.streamingToolByTask[taskId] ?? {}) };
    taskMap[employeeId] = { id, toolName, partialJson: "", startedAt: Date.now() };
    return { streamingToolByTask: { ...s.streamingToolByTask, [taskId]: taskMap } };
  }),
  appendStreamingTool: (taskId, employeeId, id, partialJson) => set(s => {
    const taskMap = s.streamingToolByTask[taskId];
    const curr = taskMap?.[employeeId];
    // Only append if the id matches; out-of-order deltas for a stale tool
    // shouldn't bleed into a newer one.
    if (!curr || curr.id !== id) return s;
    const nextTaskMap = { ...taskMap, [employeeId]: { ...curr, partialJson: curr.partialJson + partialJson } };
    return { streamingToolByTask: { ...s.streamingToolByTask, [taskId]: nextTaskMap } };
  }),
  clearStreamingTool: (taskId, employeeId, matchId) => set(s => {
    const taskMap = s.streamingToolByTask[taskId];
    const curr = taskMap?.[employeeId];
    if (!curr) return s;
    if (matchId && curr.id !== matchId) return s;
    const nextTaskMap = { ...taskMap };
    delete nextTaskMap[employeeId];
    return { streamingToolByTask: { ...s.streamingToolByTask, [taskId]: nextTaskMap } };
  }),

  toolEvents: {},
  appendToolEvent: (taskId, tool, input, employeeId) => set(s => {
    // Drop noisy mcp__* leaks from the host's Claude Code config, but keep
    // our own office tools (mcp__office__*) — those ARE the agent's real
    // work and the user wants to see them in the live activity feed.
    if (typeof tool === "string" && tool.startsWith("mcp__") && !tool.startsWith("mcp__office__")) {
      return s;
    }
    const list = s.toolEvents[taskId] ?? [];
    const next = [...list, { tool, input, at: Date.now(), employeeId }].slice(-30); // keep last 30
    return { toolEvents: { ...s.toolEvents, [taskId]: next } };
  }),

  setCustomSkills: (s) => set({ customSkills: s }),
  addCustomSkill: (s) => set((prev) => ({ customSkills: [s, ...prev.customSkills] })),
  updateCustomSkill: (s) => set((prev) => ({
    customSkills: prev.customSkills.map(x => x.id === s.id ? s : x),
  })),
  removeCustomSkill: (id) => set((prev) => ({ customSkills: prev.customSkills.filter(s => s.id !== id) })),
  setSkillOverrides: (rows) => set({ skillOverrides: Object.fromEntries(rows.map(r => [r.id, r])) }),
  upsertSkillOverride: (o) => set((prev) => ({
    skillOverrides: { ...prev.skillOverrides, [o.id]: o },
  })),
  removeSkillOverride: (id) => set((prev) => {
    const { [id]: _, ...rest } = prev.skillOverrides;
    return { skillOverrides: rest };
  }),
  setEmployees: (e) => set({ employees: e }),
  setMessages: (m) => set({ messages: m }),
  mergeMessages: (incoming) => set((s) => {
    const ids = new Set(s.messages.map(m => m.id));
    const merged = [...s.messages];
    for (const m of incoming) if (!ids.has(m.id)) merged.push(m);
    merged.sort((a, b) => a.createdAt - b.createdAt);
    return { messages: merged };
  }),
  setTasks: (t) => set({ tasks: t }),
  upsertTask: (t) => set((s) => {
    const idx = s.tasks.findIndex(x => x.id === t.id);
    const next = [...s.tasks];
    if (idx >= 0) next[idx] = t; else next.unshift(t);
    return { tasks: next };
  }),
  removeTask: (id) => set((s) => {
    const nextFiles = { ...s.filesByTask }; delete nextFiles[id];
    const nextTools = { ...s.toolEvents }; delete nextTools[id];
    const nextStreamingTools = { ...s.streamingToolByTask }; delete nextStreamingTools[id];
    return {
      tasks: s.tasks.filter(t => t.id !== id),
      messages: s.messages.filter(m => m.taskId !== id),
      activeTaskId: s.activeTaskId === id ? null : s.activeTaskId,
      filesByTask: nextFiles,
      toolEvents: nextTools,
      streamingToolByTask: nextStreamingTools,
    };
  }),
  setProfile: (p) => set({ profile: p }),
  upsertEmployee: (e) => set((s) => {
    const idx = s.employees.findIndex(x => x.id === e.id);
    const next = [...s.employees];
    if (idx >= 0) next[idx] = e; else next.push(e);
    return { employees: next };
  }),
  removeEmployee: (id) => set((s) => ({ employees: s.employees.filter(e => e.id !== id) })),
  updateEmployeePosition: (id, x, y) => set((s) => ({
    employees: s.employees.map(e => e.id === id ? { ...e, x, y } : e),
  })),
  appendMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),

  startStreaming: (employeeId, taskId) => set((s) => ({
    streamingByEmployee: { ...s.streamingByEmployee, [employeeId]: { text: "", thinking: "", startedAt: Date.now(), taskId } },
  })),
  appendStreaming: (employeeId, delta) => set((s) => {
    const cur = s.streamingByEmployee[employeeId] ?? { text: "", thinking: "", startedAt: Date.now(), taskId: null };
    return {
      streamingByEmployee: { ...s.streamingByEmployee, [employeeId]: { ...cur, text: cur.text + delta } },
    };
  }),
  appendThinking: (employeeId, delta) => set((s) => {
    const cur = s.streamingByEmployee[employeeId] ?? { text: "", thinking: "", startedAt: Date.now(), taskId: null };
    return {
      streamingByEmployee: { ...s.streamingByEmployee, [employeeId]: { ...cur, thinking: cur.thinking + delta } },
    };
  }),
  clearStreaming: (employeeId) => set((s) => {
    const next = { ...s.streamingByEmployee };
    delete next[employeeId];
    return { streamingByEmployee: next };
  }),

  startPlanStreaming: (taskId) => set({ planStreaming: { taskId, text: "" } }),
  appendPlanStreaming: (delta) => set((s) => {
    if (!s.planStreaming) return s;
    return { planStreaming: { ...s.planStreaming, text: s.planStreaming.text + delta } };
  }),
  clearPlanStreaming: () => set({ planStreaming: null }),

  addPendingInvite: (i) => set((s) => {
    // Idempotent on inviteId — re-emitted events shouldn't duplicate the card.
    if (s.pendingInvites.some(p => p.inviteId === i.inviteId)) return s;
    return { pendingInvites: [...s.pendingInvites, i] };
  }),
  removePendingInvite: (inviteId) => set((s) => ({
    pendingInvites: s.pendingInvites.filter(p => p.inviteId !== inviteId),
  })),

  setSelected: (id) => set({ selectedEmployeeId: id }),
  setHovered: (id) => set({ hoveredEmployeeId: id }),
  setChatOpen: (open) => set({ chatOpen: open }),
  setIsBusy: (b) => set({ isBusy: b, busyTaskId: b ? get().busyTaskId : null }),
  setBusyTask: (taskId) => set({ busyTaskId: taskId, isBusy: !!taskId }),
  setActiveTask: (id) => set({ activeTaskId: id }),

  pendingDraft: null,
  setPendingDraft: (v) => set({ pendingDraft: v }),

  // Read whichever class the bootstrap script attached to <html>; defaults to
  // dark in non-browser contexts (SSR) so the server-rendered markup matches.
  theme: typeof document !== "undefined" && document.documentElement.classList.contains("light")
    ? "light"
    : "dark",
  setTheme: (t) => {
    if (typeof document !== "undefined") {
      const root = document.documentElement;
      root.classList.remove("dark", "light");
      root.classList.add(t);
      try { localStorage.setItem("agentp.theme", t); } catch { /* ignore */ }
    }
    set({ theme: t });
  },

  updatePhase: { kind: "idle" },
  setUpdatePhase: (p) => set({ updatePhase: p }),
}));
