/** Model identifier — see lib/models.ts. Plain string so adding providers
 *  (OpenRouter / Gemini) needs no DB migration. Claude ids stay bare
 *  ("claude-sonnet-4-6"); other providers are prefixed ("or:...", "gemini:..."). */
export type ModelId = string;

export interface Employee {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  model: ModelId;
  avatarColor: string;
  emoji: string;
  x: number;
  y: number;
  /** 0 or 1. When 1, this agent only responds in 1-on-1 prompt-refining chats
   *  with the user; never auto-pulled into multi-agent rooms via @mentions. */
  isPromptEngineer: number;
  /** Skill packs installed (IDs from lib/skills-library.ts). */
  skills: string[];
  sessionId: string | null;
  /** Display order in sidebar (lower = higher up). Null for legacy rows; sort
   *  falls back to createdAt in that case. Updated by drag-to-reorder. */
  sortOrder?: number | null;
  createdAt: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "done" | "failed";
  /** "direct" = chat with one or more specific agents (set in compose).
   *  Kept as a column for forward-compat; only "direct" is used today. */
  mode: "direct";
  assignedTo: string | null;
  /** Pinned tasks float to the top of the sidebar history list. */
  pinned: boolean;
  createdAt: number;
}

export interface Message {
  id: string;
  taskId: string | null;
  fromId: string | null; // null = user
  toId: string | null;   // null = broadcast
  role: "user" | "assistant" | "system";
  content: string;
  mentions: string[];
  images: string[];
  files: string[];
  createdAt: number;
}

