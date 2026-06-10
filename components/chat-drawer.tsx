"use client";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X, User, Edit2, HelpCircle, Send, Square, ListChecks, Plus, Paperclip, FolderOpen, Wrench, CornerUpLeft, MessageSquarePlus, ChevronDown, ImageIcon, GitBranch, Sparkles } from "lucide-react";
import { useOffice } from "@/store/office-store";
import { cn, formatTime, shortId } from "@/lib/utils";
import { toast, appConfirm } from "./toast";
import { MessageContent, useBossSet, hasBossPing } from "./message-content";
import { highlightCode } from "@/lib/highlight";
import { AgentInfoPane } from "./agent-info-pane";
import type { Employee, Message } from "@/lib/types";
import type { FileInfo } from "@/store/office-store";

/** Smooths token-bursty SSE streams into a typewriter reveal. The SDK delivers
 *  text_delta in clumps of varying size — sometimes 1 word, sometimes a full
 *  sentence — which makes the bubble visibly "jump". This component buffers
 *  the target text and reveals characters at an adaptive rate via rAF so the
 *  motion stays even regardless of network/model bursts. Rate scales with the
 *  backlog so we don't fall behind on big chunks.
 *
 *  Renders via MessageContent so markdown + @mention highlighting stay live
 *  during stream. To avoid mid-word jerks (half-typed markdown like `**bold`
 *  re-flowing every frame), the reveal snaps to the nearest word/punctuation
 *  boundary so the DOM only sees complete tokens. */
const BOUNDARY_RE = /[\s.,;:!?)\]"'`*_~>]/;

function SmoothText({ text }: { text: string }) {
  const [displayed, setDisplayed] = useState("");
  const targetRef = useRef(text);
  targetRef.current = text;

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const target = targetRef.current;
      setDisplayed(curr => {
        if (curr.length >= target.length) return curr;
        const backlog = target.length - curr.length;
        // Base 140 chars/sec; scale up with backlog so a big burst catches up
        // within a few hundred ms instead of trickling out.
        const rate = Math.max(140, backlog * 8);
        const advance = Math.max(2, Math.ceil((dt / 1000) * rate));
        let end = Math.min(target.length, curr.length + advance);
        // Snap back to the most recent word boundary inside the new slice so
        // we don't render a half-typed word/markdown token. Capped: if no
        // boundary in the last 24 chars, just advance — handles long URLs and
        // ensures we don't stall on words with no breaks.
        if (end < target.length) {
          let snap = end;
          const floor = Math.max(curr.length + 1, end - 24);
          while (snap > floor && !BOUNDARY_RE.test(target[snap - 1])) snap--;
          if (snap > curr.length) end = snap;
        }
        return target.slice(0, end);
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <MessageContent text={displayed} />;
}

/** Live code "tail" preview, à la claude.ai when an artifact is being built.
 *  The tool call lands atomically (full content arrives in one event), but we
 *  typewriter through it and always show only the last few lines so the user
 *  sees the visual feel of "code being written at the cursor". A blinking
 *  block-cursor at the end sells the live-typing effect.
 *
 *  The pre block has a FIXED height so the bubble doesn't jitter as content
 *  streams in (early lines short, later lines long, would re-flow the page).
 *  Tail-clipping (last N lines) handles overflow on the tall side; on the
 *  short side, an empty bottom-anchored flex column reserves the space. */
function CodeTail({ code, lang, label, lines = 8 }: { code: string; lang: string; label: string; lines?: number }) {
  const [displayed, setDisplayed] = useState(0);
  const targetRef = useRef(code.length);
  targetRef.current = code.length;

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      setDisplayed(curr => {
        const target = targetRef.current;
        if (curr >= target) return curr;
        const backlog = target - curr;
        // Fast scroll — we want the "continuously running" feel, not slow
        // typewriter. Big files catch up within ~1s via the backlog multiplier.
        const rate = Math.max(300, backlog * 10);
        const advance = Math.max(3, Math.ceil((dt / 1000) * rate));
        return Math.min(target, curr + advance);
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const visible = code.slice(0, displayed);
  const tail = visible.split("\n").slice(-lines).join("\n");
  const stillTyping = displayed < code.length;

  // height = lines × line-height (10px × 1.45) + py-1.5 (12px total).
  // 8 × 14.5 + 12 ≈ 128px. Round to 132px for a stable visual.
  const boxHeight = lines * 15 + 12;

  return (
    <div className="code-tail mt-1.5 overflow-hidden rounded-md">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-2 py-1 text-[10px] text-slate-500">
        <span className="truncate">{label}</span>
        <span className="ml-2 shrink-0 text-slate-600">{lang}</span>
      </div>
      <div
        className="relative flex flex-col justify-end overflow-hidden px-2 py-1.5"
        style={{ height: boxHeight }}
      >
        <pre className="font-mono text-[10px] leading-[1.45] whitespace-pre-wrap break-all">
          <code dangerouslySetInnerHTML={{ __html: highlightCode(tail, lang) }} />
          <span className={cn(
            "ml-px inline-block h-[10px] w-[5px] bg-sky-300/80 align-middle",
            stillTyping ? "animate-pulse" : "opacity-0",
          )} />
        </pre>
      </div>
    </div>
  );
}

/** Rotating status pill shown above a streaming bubble while we wait for the
 *  model. Used as a FALLBACK only when adaptive thinking is unavailable. The
 *  list cycles indefinitely (loops back to the first phrase) so the user keeps
 *  seeing motion instead of staring at "Synthesizing ideas" forever, and an
 *  elapsed-time counter proves the request is still alive. */
function StreamingStatus({ startedAt }: { startedAt: number }) {
  const phases = useMemo(
    () => [
      "Reading skill",
      "Thinking context",
      "Brainstorming ideas",
      "Synthesizing ideas",
      "Structuring layout",
      "Composing draft",
      "Refining details",
      "Finalizing",
    ],
    [],
  );
  const phaseMs = 4000;
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force(n => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
  const idx = Math.floor(elapsedSec / (phaseMs / 1000)) % phases.length;
  return (
    <span className="text-[11px] text-slate-500">
      {phases[idx]} <span className="text-slate-600">({elapsedSec}s)</span>
    </span>
  );
}

/** Compact activity feed in the streaming bubble, à la claude.ai: each line is
 *  a one-liner summary of one "step" Claude is doing. The SDK's adaptive
 *  thinking with display:summarized emits paragraph-shaped summaries; we split
 *  on blank-line / sentence boundary into discrete steps and keep the last few.
 *  Older steps fade muted, latest pulses. No scrolling, no full transcript —
 *  the goal is "what is it doing now" not "show me everything it thought". */
function ActivityFeed({ thinking }: { thinking: string }) {
  const lines = useMemo(() => {
    if (!thinking) return [];
    return thinking
      .split(/\n\n+|(?<=[.!?])\s+(?=[A-ZÀ-Ỹ])/)
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .slice(-3);
  }, [thinking]);

  if (lines.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {lines.map((line, i) => {
        const isLast = i === lines.length - 1;
        return (
          <div key={i} className="flex min-w-0 items-start gap-1.5 text-[11px] leading-[1.45]">
            <Sparkles
              size={10}
              className={cn(
                "mt-[3px] shrink-0",
                isLast ? "text-violet-300/80 animate-pulse" : "text-slate-500/60",
              )}
            />
            <span
              className={cn(
                "min-w-0 truncate",
                isLast ? "text-slate-300/90" : "text-slate-500/80",
              )}
            >
              {line}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface Props {
  onEdit: (id: string) => void;
  onToggleFiles?: () => void;
  filesOpen?: boolean;
  onToggleWorkflow?: () => void;
  workflowOpen?: boolean;
}

// Map raw tool name + input to a short Vietnamese status line so the user
// can see at a glance what the agent is currently doing (searching, reading,
// writing, exporting...). Used in the live "thinking" indicator above each
// streaming bubble.
function describeTool(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = (k: string): string => (typeof i[k] === "string" ? (i[k] as string) : "");
  const trim = (s: string, n = 60) => (s.length > n ? s.slice(0, n).trim() + "…" : s);
  const name = tool.replace(/^mcp__office__/, "");
  switch (name) {
    case "WebSearch":
      return `🔍 Searching: "${trim(v("query") || v("q"), 70)}"`;
    case "WebFetch":
      return `🌐 Fetching: ${trim(v("url"), 70)}`;
    case "Read":
    case "read_text":
      return `📄 Reading: ${trim(v("filename") || v("file_path") || v("path"), 60)}`;
    case "read_xlsx":
      return `📊 Reading Excel: ${trim(v("filename"), 60)}`;
    case "Write":
    case "write_text":
      return `✍️ Writing: ${trim(v("filename") || v("file_path"), 60)}`;
    case "Edit":
      return `✏️ Editing: ${trim(v("file_path"), 60)}`;
    case "Bash":
      return `⚙️ Running: ${trim(v("command"), 70)}`;
    case "export_pdf":
      return `📤 Exporting PDF: ${trim(v("filename"), 60)}`;
    case "export_docx":
      return `📤 Exporting Word: ${trim(v("filename"), 60)}`;
    case "xlsx_write":
      return `📤 Exporting Excel: ${trim(v("filename"), 60)}`;
    case "read_xlsx":
      return `📥 Reading Excel: ${trim(v("filename"), 60)}`;
    case "export_dashboard":
      return `📊 Building dashboard: ${trim(v("filename"), 60)}`;
    case "Grep":
      return `🔎 Searching pattern: "${trim(v("pattern"), 50)}"`;
    case "Glob":
      return `🔎 Scanning files: ${trim(v("pattern"), 60)}`;
    case "TodoWrite":
      return `📋 Planning steps`;
    default:
      return `🛠️ ${name}`;
  }
}

// Lookup a file-extension → display language label for the live code preview
// header. Falls back to "text" so the header always has something useful.
function extLang(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "html": case "htm": return "html";
    case "tsx": return "tsx";
    case "ts": return "ts";
    case "jsx": return "jsx";
    case "js": case "mjs": case "cjs": return "js";
    case "py": return "python";
    case "json": return "json";
    case "css": return "css";
    case "md": return "markdown";
    case "yml": case "yaml": return "yaml";
    case "sql": return "sql";
    case "sh": case "bash": return "bash";
    default: return ext || "text";
  }
}

// Parse a single string field out of a still-incomplete JSON buffer. The
// model streams tool inputs as `input_json_delta` chunks — by the time
// `"content": "<!DOCTYPE...` reaches us, the closing `"` hasn't been written
// yet. We can't `JSON.parse` it, so we walk byte-by-byte from the field
// marker, unescape JSON string escapes on the fly, and bail on the first
// unescaped `"` (or the end of buffer for truly partial input). Returns the
// decoded streamed content, or null if the field hasn't appeared yet.
function extractStreamingField(partialJson: string, field: string): string | null {
  const marker = `"${field}"`;
  const fIdx = partialJson.indexOf(marker);
  if (fIdx < 0) return null;
  // Skip past the marker, whitespace, colon, whitespace, opening quote.
  let i = fIdx + marker.length;
  while (i < partialJson.length && /\s/.test(partialJson[i])) i++;
  if (partialJson[i] !== ":") return null;
  i++;
  while (i < partialJson.length && /\s/.test(partialJson[i])) i++;
  if (partialJson[i] !== "\"") return null;
  i++;
  let out = "";
  while (i < partialJson.length) {
    const ch = partialJson[i];
    if (ch === "\\") {
      const next = partialJson[i + 1];
      if (next === undefined) break; // incomplete escape — render what we have
      switch (next) {
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "\"": out += "\""; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "u": {
          if (i + 6 > partialJson.length) return out; // incomplete \uXXXX
          out += String.fromCharCode(parseInt(partialJson.slice(i + 2, i + 6), 16));
          i += 4;
          break;
        }
        default: out += next;
      }
      i += 2;
      continue;
    }
    if (ch === "\"") break; // unescaped closing quote — field complete
    out += ch;
    i++;
  }
  return out;
}

// Same shape as `previewToolPayload` but fed from a streaming partial-JSON
// buffer. Returns the running code body if the relevant field has started
// streaming, else null (e.g. partial JSON still on `{"file_path":"…`).
function streamingPreviewFor(toolName: string, partialJson: string): { lang: string; label: string; code: string } | null {
  const name = toolName.replace(/^mcp__office__/, "");
  let field = "", filename = "", label = "", lang = "text";
  switch (name) {
    case "Write":
    case "write_text": {
      field = "content";
      filename = extractStreamingField(partialJson, "file_path") ?? extractStreamingField(partialJson, "filename") ?? "";
      label = `✍️ ${filename || "writing…"}`;
      lang = extLang(filename);
      break;
    }
    case "Edit": {
      field = "new_string";
      filename = extractStreamingField(partialJson, "file_path") ?? "";
      label = `✏️ ${filename || "editing…"}`;
      lang = extLang(filename);
      break;
    }
    case "Bash": {
      field = "command";
      label = "⚙️ $";
      lang = "bash";
      break;
    }
    case "export_dashboard": {
      field = "spec";
      filename = extractStreamingField(partialJson, "filename") ?? "";
      label = `📊 ${filename || "dashboard"}`;
      lang = "json";
      break;
    }
    default:
      return null;
  }
  const code = extractStreamingField(partialJson, field);
  if (code === null) return null;
  return { lang, label, code };
}

// Pull out the "code being written" payload for tools the user wants to watch
// in real time (file writes, edits, shell commands). Returns null for tools
// like Read/Grep where there's no authored content to show.
function previewToolPayload(tool: string, input: unknown): { lang: string; label: string; code: string } | null {
  const i = (input ?? {}) as Record<string, unknown>;
  const get = (k: string) => typeof i[k] === "string" ? (i[k] as string) : "";
  const name = tool.replace(/^mcp__office__/, "");
  switch (name) {
    case "Write":
    case "write_text": {
      const fn = get("filename") || get("file_path") || get("path");
      const code = get("content");
      if (!code) return null;
      return { lang: extLang(fn), label: `✍️ ${fn || "untitled"}`, code };
    }
    case "Edit": {
      const fn = get("file_path");
      const code = get("new_string");
      if (!code) return null;
      return { lang: extLang(fn), label: `✏️ ${fn || "edit"}`, code };
    }
    case "Bash": {
      const cmd = get("command");
      if (!cmd) return null;
      return { lang: "bash", label: "⚙️ $", code: cmd };
    }
    case "export_dashboard": {
      const fn = get("filename");
      const spec = i["spec"];
      const code = typeof spec === "string" ? spec : (spec ? JSON.stringify(spec, null, 2) : "");
      if (!code) return null;
      return { lang: "json", label: `📊 ${fn || "dashboard"}`, code };
    }
    default:
      return null;
  }
}

// Scan backwards from the caret to detect an active @-mention being typed.
// Returns the anchor index of "@" and the query string after it, or null.
function findMentionTrigger(text: string, caret: number): { anchor: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "@") {
      // The "@" must be at start of input or preceded by whitespace, so we
      // don't trigger inside email addresses or mid-word.
      if (i === 0 || /\s/.test(text[i - 1])) {
        return { anchor: i, query: text.slice(i + 1, caret) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

// Diacritic-insensitive lowercase for matching Vietnamese names.
function normalizeForMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/** One chat bubble, memoized so that typing in the composer or a streaming
 *  token elsewhere does NOT re-render every message in a long conversation.
 *  A row only re-renders when its own props change (content, edit state,
 *  reply-highlight…). The `.cv-row` class adds CSS content-visibility so the
 *  browser skips layout/paint for rows scrolled out of view — that's what keeps
 *  scrolling back through a long history smooth. `editDraft` is passed as ""
 *  to every non-editing row so a keystroke while editing only re-renders the
 *  single row being edited. */
type MessageRowProps = {
  m: Message;
  from: Employee | null;
  bossSet: Set<string>;
  isReplyTarget: boolean;
  isEditing: boolean;
  canEdit: boolean;
  busy: boolean;
  editDraft: string;
  setEditDraft: (v: string) => void;
  onEdit: (id: string, draft: string) => void;
  onStartEdit: (m: Message) => void;
  onCancelEdit: () => void;
  onReply: (m: Message) => void;
};

const MessageRow = memo(function MessageRow({
  m, from, bossSet, isReplyTarget, isEditing, canEdit, busy,
  editDraft, setEditDraft, onEdit, onStartEdit, onCancelEdit, onReply,
}: MessageRowProps) {
  // System messages (auto-plan summary, dispatch notes) render as a centered
  // card — not a chat bubble — so they don't get confused with user/agent turns.
  if (m.role === "system") {
    return (
      <div className="cv-row my-2 flex justify-center">
        <div className="w-full max-w-[88%] rounded-xl border border-sky-400/15 bg-sky-400/[0.04] px-4 py-3 ring-1 ring-sky-400/10">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-sky-300/80">
            Auto plan
          </div>
          <div className="text-[13px] leading-relaxed text-slate-200">
            <MessageContent text={m.content} />
          </div>
        </div>
      </div>
    );
  }
  const isUser = m.fromId === null;
  const ping = !isUser && hasBossPing(m.content, bossSet);
  return (
    <div className={cn("cv-row group flex gap-2", isUser ? "justify-end" : "justify-start")}>
      {!isUser && from && (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs" style={{ backgroundColor: from.avatarColor }} title={`${from.name} · ${from.role}`}>
          {from.emoji}
        </div>
      )}
      <div className={cn(
        "relative max-w-[78%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ring-1 selectable",
        isUser
          ? "bg-[#3D3B36] text-slate-100 rounded-br-md ring-white/[0.07]"
          : "bg-white/[0.045] text-slate-100 rounded-bl-md ring-white/[0.05]",
        isReplyTarget && "ring-2 ring-ember/70 ring-offset-2 ring-offset-[#262624]",
        !isEditing && "whitespace-pre-wrap"
      )}>
        {!isUser && from && (
          <div className="mb-1 text-[10px] uppercase tracking-wider opacity-70">{from.name}</div>
        )}
        {ping && (
          <div className="mb-1.5 inline-flex items-center gap-1 rounded-md bg-ember/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ember-soft ring-1 ring-ember/40">
            <HelpCircle size={11} /> Needs your reply
          </div>
        )}
        {m.images && m.images.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {m.images.map((img, i) => {
              const src = img.startsWith("data:") ? img : `/api/tasks/${m.taskId}/files/${img}`;
              return <img key={i} src={src} alt="" className="max-h-48 max-w-full rounded-lg border border-white/10 cursor-pointer" onClick={() => window.open(src, "_blank")} />;
            })}
          </div>
        )}
        {m.files && m.files.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-2">
            {m.files.map((fname, i) => {
              const ext = (fname.split(".").pop() || "FILE").toUpperCase().slice(0, 5);
              const href = m.taskId ? `/api/tasks/${m.taskId}/files/${encodeURIComponent(fname)}` : "#";
              return (
                <a
                  key={i}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-24 w-28 flex-col justify-between rounded-xl border border-white/10 bg-white/[0.04] p-2.5 transition-colors hover:bg-white/[0.06]"
                  title={fname}
                >
                  <span className="line-clamp-3 break-all text-[11px] leading-tight text-slate-200">
                    {fname}
                  </span>
                  <span className="inline-flex w-fit rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-400">
                    {ext}
                  </span>
                </a>
              );
            })}
          </div>
        )}
        {isEditing ? (
          <div className="flex flex-col gap-2">
            <textarea
              autoFocus
              value={editDraft}
              spellCheck={false}
              onChange={e => setEditDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Escape") { onCancelEdit(); }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  onEdit(m.id, editDraft);
                }
              }}
              rows={Math.min(8, Math.max(2, editDraft.split("\n").length))}
              className="w-full resize-none rounded-lg border border-white/15 bg-white/[0.05] px-3 py-2 text-sm outline-none focus:border-amber-400/50"
            />
            <div className="flex justify-end gap-1.5">
              <button
                onClick={() => onCancelEdit()}
                className="rounded-lg px-2.5 py-1 text-[12px] text-slate-400 hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                onClick={() => onEdit(m.id, editDraft)}
                disabled={!editDraft.trim() || busy}
                className="rounded-lg bg-amber-400 px-3 py-1 text-[12px] font-medium text-slate-900 hover:bg-amber-300 disabled:opacity-40"
              >
                Save & Resend
              </button>
            </div>
          </div>
        ) : isUser ? m.content : <MessageContent text={m.content} />}
        {!isEditing && (
          <div className={cn("mt-1.5 text-[10px]", isUser ? "text-slate-400/80" : "text-slate-500")}>
            {formatTime(m.createdAt)}
          </div>
        )}
        {/* Action buttons — visible on hover */}
        {!isEditing && (
          <div className={cn(
            "absolute -top-2 flex gap-0.5 opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-200 ease-out",
            isUser ? "-left-2 flex-row-reverse" : "-right-2"
          )}>
            {canEdit && (
              <button
                onClick={() => onStartEdit(m)}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-[#3D3B36] border border-white/15 text-slate-300 hover:bg-white/10 hover:text-amber-300 shadow-md"
                title="Edit & resend"
                aria-label="Edit"
              >
                <Edit2 size={10} />
              </button>
            )}
            <button
              onClick={() => onReply(m)}
              className="flex h-6 w-6 items-center justify-center rounded-full bg-[#3D3B36] border border-white/15 text-slate-300 hover:bg-white/10 hover:text-ember-soft shadow-md"
              title="Reply to this message"
              aria-label="Reply"
            >
              <CornerUpLeft size={11} />
            </button>
          </div>
        )}
      </div>
      {isUser && (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#3D3B36] text-slate-300 ring-1 ring-white/[0.06]">
          <User size={14} />
        </div>
      )}
    </div>
  );
});

export function ChatDrawer({ onEdit, onToggleFiles, filesOpen, onToggleWorkflow, workflowOpen }: Props) {
  const selectedId = useOffice(s => s.selectedEmployeeId);
  const activeTaskId = useOffice(s => s.activeTaskId);
  const setActiveTask = useOffice(s => s.setActiveTask);
  const employeesList = useOffice(s => s.employees);
  const messagesList = useOffice(s => s.messages);
  const tasksList = useOffice(s => s.tasks);
  const streaming = useOffice(s => s.streamingByEmployee);
  const planStreaming = useOffice(s => s.planStreaming);
  const profile = useOffice(s => s.profile);
  const isBusy = useOffice(s => s.isBusy);
  const busyTaskId = useOffice(s => s.busyTaskId);
  const setBusyTask = useOffice(s => s.setBusyTask);
  const appendMessage = useOffice(s => s.appendMessage);
  const startStreaming = useOffice(s => s.startStreaming);
  const appendStreaming = useOffice(s => s.appendStreaming);
  const appendThinking = useOffice(s => s.appendThinking);
  const clearStreaming = useOffice(s => s.clearStreaming);
  const startPlanStreaming = useOffice(s => s.startPlanStreaming);
  const appendPlanStreaming = useOffice(s => s.appendPlanStreaming);
  const clearPlanStreaming = useOffice(s => s.clearPlanStreaming);
  const pendingInvites = useOffice(s => s.pendingInvites);
  const addPendingInvite = useOffice(s => s.addPendingInvite);
  const removePendingInvite = useOffice(s => s.removePendingInvite);
  const upsertTask = useOffice(s => s.upsertTask);
  const currentSpaceId = useOffice(s => s.currentSpaceId);

  const setCurrentAbort = useOffice(s => s.setCurrentAbort);
  const stopCurrent = useOffice(s => s.stopCurrent);
  const setSelected = useOffice(s => s.setSelected);
  const filesByTask = useOffice(s => s.filesByTask);
  const setTaskFiles = useOffice(s => s.setTaskFiles);
  const toolEvents = useOffice(s => s.toolEvents);
  const appendToolEvent = useOffice(s => s.appendToolEvent);
  const streamingToolByTask = useOffice(s => s.streamingToolByTask);
  const startStreamingTool = useOffice(s => s.startStreamingTool);
  const appendStreamingTool = useOffice(s => s.appendStreamingTool);
  const clearStreamingTool = useOffice(s => s.clearStreamingTool);
  const pendingDraft = useOffice(s => s.pendingDraft);
  const setPendingDraft = useOffice(s => s.setPendingDraft);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  // Cached plan assignments per task — populated when an Auto-plan event arrives
  // so each agent's streaming "Thinking" bubble can surface its assigned subtask
  // (otherwise later agents that don't fire tool_use look like a bare spinner).
  const [assignmentsByTask, setAssignmentsByTask] = useState<Record<string, Record<string, string>>>({});
  // Live greeting for the compose ("New Chat") empty state — keyed off Vietnam
  // local time. Initialized to null so server + initial client render match,
  // then the effect below fills it in.
  const [greeting, setGreeting] = useState<{ phrase: string; vnTime: string } | null>(null);
  useEffect(() => {
    const compute = () => {
      const now = new Date();
      const vnHour = Number(new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Ho_Chi_Minh",
        hour: "numeric",
        hour12: false,
      }).format(now));
      let phrase: string;
      if (vnHour >= 5 && vnHour < 12) phrase = "Good Morning";
      else if (vnHour >= 12 && vnHour < 18) phrase = "Good Afternoon";
      else if (vnHour >= 18 && vnHour < 22) phrase = "Good Evening";
      else phrase = "Good Night";
      const hhmm = new Intl.DateTimeFormat("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(now);
      // English weekday + vi-style DD/MM (so "Saturday, 16/05" not "Saturday, 05/16").
      const weekday = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Ho_Chi_Minh",
        weekday: "long",
      }).format(now);
      const dayMonth = new Intl.DateTimeFormat("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
        day: "2-digit",
        month: "2-digit",
      }).format(now);
      const vnTime = `${hhmm} ${weekday}, ${dayMonth}`;
      setGreeting({ phrase, vnTime });
    };
    compute();
    const t = setInterval(compute, 60_000);
    return () => clearInterval(t);
  }, []);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  // composeTargets = ordered list of agents selected for the new chat. First
  // entry is primary (becomes task.assignedTo). When length > 1 all picked
  // agents reply in parallel to the first message; subsequent turns route via
  // @mentions like a normal room.
  const [composeTargets, setComposeTargets] = useState<string[]>([]);
  const [composePickerOpen, setComposePickerOpen] = useState(false);
  const composeTarget = composeTargets[0] ?? null;
  const composeTargetsDisplay = (() => {
    const names = composeTargets
      .map(id => employeesList.find(e => e.id === id)?.name)
      .filter((n): n is string => !!n);
    return names;
  })();
  // Pre-generate taskId on compose target select so /api/warm can pre-spawn
  // the SDK subprocess for that exact (taskId, employeeId) pool key. Reused
  // verbatim when the user hits send.
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const composePickerRef = useRef<HTMLDivElement>(null);
  const bossSet = useBossSet();

  interface QueuedRequest {
    userText: string;
    taskId: string | null;
    employeeId: string | null;
    /** Multi-agent fan-out for new chats. Populated from composeTargets. */
    employeeIds?: string[];
    mode: "direct";
    images: string[];
    files: string[];
    skipUserMessage?: boolean;
    /** Set when this request is an accepted agent-to-agent invite — the
     *  server uses it to build the handoff prompt and skip user-message
     *  creation. */
    dispatch?: { targetId: string; sourceMessageId: string };
  }
  const [queue, setQueue] = useState<QueuedRequest[]>([]);
  // Ref guard so the drain effect can't fire twice for the same idle slot
  // (React StrictMode + zustand re-renders).
  const drainingRef = useRef(false);

  // @-mention autocomplete state. Null query = popup closed.
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  // Files attached in either mode. Uploaded to the (current or new) task's
  // workspace in `submit()` right before the chat POST, so the agent sees them
  // on disk when it starts.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const attachInputRef = useRef<HTMLInputElement>(null);

  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAnchor, setMentionAnchor] = useState<number>(0);
  const [mentionIdx, setMentionIdx] = useState(0);

  const currentFiles = activeTaskId ? filesByTask[activeTaskId] ?? [] : [];
  const currentTools = activeTaskId ? toolEvents[activeTaskId] ?? [] : [];

  async function refreshFiles() {
    if (!activeTaskId) return;
    const res = await fetch(`/api/tasks/${activeTaskId}/files`);
    if (!res.ok) return;
    const files = (await res.json()) as FileInfo[];
    setTaskFiles(activeTaskId, files);
  }

  useEffect(() => {
    if (activeTaskId) refreshFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTaskId]);

  // The Workflow panel pushes an edited workflow here — load it into the
  // composer (don't auto-send) so the user can review before hitting Enter.
  useEffect(() => {
    if (pendingDraft != null) {
      setDraft(pendingDraft);
      setPendingDraft(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [pendingDraft, setPendingDraft]);

  useEffect(() => {
    if (!composePickerOpen) return;
    function onClick(e: MouseEvent) {
      if (composePickerRef.current && !composePickerRef.current.contains(e.target as Node)) setComposePickerOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [composePickerOpen]);

  // Auto-grow the composer textarea: thin (single row, ~40px) when empty,
  // expands up to the CSS max-height as content wraps. ChatGPT-style.
  useLayoutEffect(() => {
    const t = inputRef.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight}px`;
  }, [draft]);

  // Pre-warm SDK subprocess when compose target is picked. Generates a stable
  // taskId now so submit() can reuse it (server treats client-supplied id as
  // a new-task creation request — see chat/route.ts).
  useEffect(() => {
    if (!composeTarget) { setPendingTaskId(null); return; }
    const newTaskId = shortId("task");
    setPendingTaskId(newTaskId);
    fetch("/api/warm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: newTaskId, employeeId: composeTarget }),
    }).catch(() => { /* best effort, no-op on failure */ });
  }, [composeTarget]);

  // NOTE: we deliberately do NOT pre-warm when an existing task is opened.
  // Pre-warming spawns an EMPTY SDK subprocess (no resume, no history). On the
  // next turn runEmployee sees a "warm" session and skips BOTH the DB-resume
  // AND buildEmployeeMemory (see claude.ts: memory is only built when !warm) —
  // so the agent answers with zero context = amnesia. This bit hard after a
  // machine restart: task_sessions is wiped on boot, the reopened task got
  // pre-warmed empty, and the first message lost all prior conversation.
  // Letting the first turn of a reopened task go cold (~1-2s spawn) is the
  // price for it to actually rebuild context from message history. Compose
  // (new task) still pre-warms above — a new task has no history to lose.

  async function uploadFiles(files: FileList | File[]) {
    if (!activeTaskId) {
      toast("Create a task first, then upload files.", "warning");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append("files", f);
      const res = await fetch(`/api/tasks/${activeTaskId}/files`, { method: "POST", body: fd });
      const data = (await res.json()) as { files: FileInfo[] };
      setTaskFiles(activeTaskId, data.files);
    } finally {
      setUploading(false);
    }
  }

  async function deleteUpload(name: string) {
    if (!activeTaskId) return;
    if (!(await appConfirm(`Delete ${name}?`))) return;
    const res = await fetch(`/api/tasks/${activeTaskId}/files?name=${encodeURIComponent(name)}`, { method: "DELETE" });
    const data = (await res.json()) as { files: FileInfo[] };
    setTaskFiles(activeTaskId, data.files);
  }

  function newTask() {
    setActiveTask(null);
    setSelected(null);
  }

  async function editAndResend(msgId: string, newContent: string) {
    if (!activeTaskId || !newContent.trim()) return;
    // Block only when THIS task is mid-stream; other tasks running elsewhere
    // shouldn't lock the user out of editing messages here.
    if (busyTaskId === activeTaskId) return;
    const msg = messagesList.find(m => m.id === msgId);
    if (!msg) return;

    const res = await fetch(`/api/tasks/${encodeURIComponent(activeTaskId)}/edit-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: msgId, content: newContent.trim() }),
    });
    if (!res.ok) { toast("Edit failed", "error"); return; }
    const data = await res.json() as { messages: Message[] };
    useOffice.getState().setMessages(
      messagesList.filter(m => m.taskId !== activeTaskId).concat(data.messages),
    );
    setEditingMsgId(null);
    setEditDraft("");

    const task = tasksList.find(t => t.id === activeTaskId);
    await runRequest({
      userText: newContent.trim(),
      taskId: activeTaskId,
      employeeId: null,
      mode: task?.mode ?? "direct",
      images: [],
      files: [],
      skipUserMessage: true,
    });
  }

  // Stable handlers passed to every memoized MessageRow. `editAndResend` closes
  // over fast-changing state (messagesList, etc.) so we read the latest via a
  // ref instead of recreating the callback each render — that keeps the row
  // props referentially stable so React.memo can actually skip re-renders.
  const editAndResendRef = useRef(editAndResend);
  editAndResendRef.current = editAndResend;
  const handleEditMessage = useCallback((id: string, draft: string) => { void editAndResendRef.current(id, draft); }, []);
  const handleStartEdit = useCallback((msg: Message) => { setEditingMsgId(msg.id); setEditDraft(msg.content); }, []);
  const handleCancelEdit = useCallback(() => { setEditingMsgId(null); setEditDraft(""); }, []);
  const handleReply = useCallback((msg: Message) => { setReplyingTo(msg); inputRef.current?.focus(); }, []);

  const activeTask = activeTaskId ? tasksList.find(t => t.id === activeTaskId) : null;
  const isTaskMode = !!activeTask;

  const employee = selectedId ? employeesList.find(e => e.id === selectedId) : null;

  // Messages to display
  const displayed = useMemo<Message[]>(() => {
    if (isTaskMode) {
      return messagesList.filter(m => m.taskId === activeTaskId);
    }
    if (selectedId) {
      return messagesList.filter(m =>
        m.fromId === selectedId || m.toId === selectedId || (m.mentions ?? []).includes(selectedId)
      );
    }
    return [];
  }, [isTaskMode, activeTaskId, selectedId, messagesList]);

  // Participants in task mode
  const participants = useMemo<Employee[]>(() => {
    if (!isTaskMode) return [];
    const ids = new Set<string>();
    for (const m of displayed) {
      if (m.fromId) ids.add(m.fromId);
      if (m.toId) ids.add(m.toId);
      for (const x of m.mentions ?? []) ids.add(x);
    }
    return employeesList.filter(e => ids.has(e.id));
  }, [isTaskMode, displayed, employeesList]);

  // Show typing indicator only for streams belonging to THIS task/room.
  // Without the taskId filter, switching tasks mid-stream left a stale
  // "agent typing" bubble in the new room.
  const streamingEntries = useMemo(() => {
    if (isTaskMode) {
      return Object.entries(streaming).filter(
        ([, v]) => v && v.taskId === activeTaskId,
      ) as [string, { text: string; thinking: string; startedAt: number; taskId: string | null }][];
    }
    if (selectedId && streaming[selectedId] && !streaming[selectedId]!.taskId) {
      return [[selectedId, streaming[selectedId]]] as [string, { text: string; thinking: string; startedAt: number; taskId: string | null }][];
    }
    return [] as [string, { text: string; thinking: string; startedAt: number; taskId: string | null }][];
  }, [isTaskMode, selectedId, streaming, activeTaskId]);

  // "Stick to bottom" auto-scroll: only follow new content when the user is
  // already near the bottom. If they've scrolled up to read earlier messages,
  // a streaming delta won't yank them back down.
  const stickToBottomRef = useRef(true);
  const onScrollContainer = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 80;
  };
  useEffect(() => {
    if (!scrollRef.current) return;
    if (!stickToBottomRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [displayed.length, streamingEntries.length, streamingEntries.map(([, v]) => v?.text).join("|"), planStreaming?.text]);
  // Switching tasks or arriving at one for the first time → always show the
  // latest message; reset the stick state so the next stream tick anchors us
  // there even if we were scrolled up in the previous room.
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [activeTaskId]);

  // Drain the queue as soon as the previous turn finishes. MUST live above
  // the early-return below or React fires "change in the order of Hooks".
  useEffect(() => {
    if (isBusy || queue.length === 0 || drainingRef.current) return;
    drainingRef.current = true;
    const [next, ...rest] = queue;
    setQueue(rest);
    runRequest(next).finally(() => {
      drainingRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBusy, queue]);

  // Candidates for the @-mention popup. Prioritize participants of the
  // current task room (most useful suggestions first), then the rest of the
  // roster. Filtered by the partial typed after "@". MUST live above the
  // early-return below or React fires "change in the order of Hooks".
  const mentionCandidates = useMemo<Employee[]>(() => {
    if (mentionQuery === null) return [];
    const q = normalizeForMatch(mentionQuery);
    const inRoom = new Set(participants.map(p => p.id));
    const scored = employeesList
      .filter(e => !q || normalizeForMatch(e.name).includes(q))
      .map(e => ({
        e,
        // 0 = best (starts with query in room), 3 = worst (substring outside room)
        priority:
          (inRoom.has(e.id) ? 0 : 2) +
          (normalizeForMatch(e.name).startsWith(q) ? 0 : 1),
      }))
      .sort((a, b) => a.priority - b.priority || a.e.name.localeCompare(b.e.name, "vi"))
      .slice(0, 8)
      .map(s => s.e);
    return scored;
  }, [mentionQuery, employeesList, participants]);

  const isComposeMode = !isTaskMode && !employee;

  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData.items;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        const file = items[i].getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length === 0) return;
    e.preventDefault();
    for (const file of imageFiles) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          setPendingImages(prev => [...prev, reader.result as string]);
        }
      };
      reader.readAsDataURL(file);
    }
  }

  function buildPayloadFromDraft(): QueuedRequest | null {
    if (!draft.trim() && pendingImages.length === 0 && pendingFiles.length === 0) return null;
    let userText = draft;
    if (replyingTo) {
      const fromEmp = replyingTo.fromId
        ? employeesList.find(e => e.id === replyingTo.fromId) ?? null
        : null;
      const fromLabel = fromEmp?.name ?? "you";
      const preview = replyingTo.content.slice(0, 200).replace(/\s+/g, " ");
      const reference = `[Replying to ${fromLabel}'s message: "${preview}${replyingTo.content.length > 200 ? "…" : ""}"]`;
      // Reply chỉ định người trả lời cụ thể: auto-prepend @Name để server route
      // qua userMentions thay vì fallback về task.assignedTo (primary của room).
      // Bỏ qua nếu user đã tự @-tag agent đó trong draft.
      const needsTag = fromEmp && !new RegExp(`@${fromEmp.name}\\b`, "i").test(draft);
      const mentionPrefix = needsTag ? `@${fromEmp.name} ` : "";
      userText = `${mentionPrefix}${reference}\n\n${draft}`;
    }

    const imgs = [...pendingImages];

    if (isComposeMode) {
      if (composeTargets.length === 0) return null;
      return {
        userText,
        taskId: null,
        employeeId: composeTargets[0],
        employeeIds: composeTargets,
        mode: "direct",
        images: imgs,
        files: [],
      };
    }

    return {
      userText,
      taskId: isTaskMode ? activeTaskId : null,
      employeeId: !isTaskMode && employee ? employee.id : null,
      mode: isTaskMode ? (activeTask?.mode ?? "direct") : "direct",
      images: imgs,
      files: [],
    };
  }

  async function acceptInvite(inv: { inviteId: string; taskId: string; targetId: string; sourceMessageId: string }) {
    removePendingInvite(inv.inviteId);
    const payload: QueuedRequest = {
      userText: "",
      taskId: inv.taskId,
      employeeId: inv.targetId,
      mode: "direct",
      images: [],
      files: [],
      skipUserMessage: true,
      dispatch: { targetId: inv.targetId, sourceMessageId: inv.sourceMessageId },
    };
    if (isBusy) {
      setQueue(q => [...q, payload]);
      return;
    }
    await runRequest(payload);
  }

  async function submit() {
    const payload = buildPayloadFromDraft();
    if (!payload) return;
    // User just hit send — they want to see their own message land at the
    // bottom, even if they were scrolled up reading history.
    stickToBottomRef.current = true;

    // Optimistic task creation: jump to the new room IMMEDIATELY so the user
    // doesn't see a flash of the agent's prior chat history during the network
    // round-trip. Generate the taskId client-side and pass it to the server,
    // which honors a supplied id for new tasks (route.ts).
    if (isComposeMode && composeTargets.length > 0) {
      // Use the pre-generated id (matches the one /api/warm pre-warmed).
      // Fall back to a fresh id if the effect hadn't fired yet (rare race).
      const newTaskId = pendingTaskId ?? shortId("task");
      upsertTask({
        id: newTaskId,
        title: payload.userText.slice(0, 80),
        description: payload.userText,
        status: "in_progress",
        mode: "direct",
        assignedTo: composeTargets[0],
        pinned: false,
        ownerId: currentSpaceId,
        createdAt: Date.now(),
      });
      setActiveTask(newTaskId);
      setComposeTargets([]);
      payload.taskId = newTaskId;
    }

    // Upload any attached files to the (new or existing) task's workspace
    // BEFORE the chat POST runs so the agent sees them on disk. saveFile()
    // auto-creates the workspace dir.
    const uploadTaskId = payload.taskId;
    if (pendingFiles.length > 0 && uploadTaskId) {
      try {
        const fd = new FormData();
        for (const f of pendingFiles) fd.append("files", f);
        const res = await fetch(`/api/tasks/${uploadTaskId}/files`, { method: "POST", body: fd });
        if (res.ok) {
          const data = (await res.json()) as { files: FileInfo[]; saved?: FileInfo[] };
          setTaskFiles(uploadTaskId, data.files);
          payload.files = data.saved?.map(f => f.name) ?? pendingFiles.map(f => f.name);
        }
      } catch {
        toast("Upload failed; the agent won't see the file.", "error");
      }
      setPendingFiles([]);
    }

    setDraft("");
    setPendingImages([]);
    setReplyingTo(null);
    if (isBusy) {
      setQueue(q => [...q, payload]);
      return;
    }
    await runRequest(payload);
  }

  async function runRequest(payload: QueuedRequest) {
    // Start with whatever taskId the payload already has (existing task,
    // optimistic compose). If null, the server's task_created event below
    // will update busyTaskId once the new id is known.
    setBusyTask(payload.taskId ?? "pending");
    const controller = new AbortController();
    setCurrentAbort(controller);

    const body: Record<string, unknown> = {
      message: payload.userText,
    };
    if (payload.taskId) {
      body.taskId = payload.taskId;
    }
    if (payload.employeeIds && payload.employeeIds.length > 0) {
      body.employeeIds = payload.employeeIds;
    } else if (payload.employeeId) {
      body.employeeId = payload.employeeId;
    }
    if (payload.images.length > 0) {
      body.images = payload.images;
    }
    if (payload.files.length > 0) {
      body.files = payload.files;
    }
    if (payload.skipUserMessage) {
      body.skipUserMessage = true;
    }
    if (payload.dispatch) {
      body.dispatch = payload.dispatch;
    }
    const userText = payload.userText;
    const sentImages = payload.images;
    const sentFiles = payload.files;
    // Track the live task id through the stream. The component's `activeTaskId`
    // closure is STALE for a brand-new task (it was null when runRequest was
    // created), so messages would be saved with the wrong taskId and not show
    // until a page reload. `task_created` updates this to the real id.
    let currentTaskId: string | null = payload.taskId;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.body) throw new Error("No stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const handleEvent = (event: string, payload: Record<string, unknown>) => {
        switch (event) {
          case "task_created": {
            const taskId = payload.taskId as string;
            currentTaskId = taskId;
            // Now that we know the real task id, pin busyTaskId to it (was
            // "pending" or the optimistic id when runRequest started).
            setBusyTask(taskId);
            const isContinuation = !!payload.continuation;
            setActiveTask(taskId);
            if (!isContinuation) {
              upsertTask({
                id: taskId,
                title: userText.slice(0, 80),
                description: userText,
                status: "in_progress",
                mode: "direct",
                assignedTo: (body.employeeId as string) ?? null,
                pinned: false,
                ownerId: currentSpaceId,
                createdAt: Date.now(),
              });
            }
            if (payload.userMessageId) {
              appendMessage({
                id: payload.userMessageId as string,
                taskId,
                fromId: null,
                toId: (body.employeeId as string) ?? null,
                role: "user",
                content: userText,
                mentions: [],
                images: (payload.images as string[]) ?? sentImages,
                files: (payload.files as string[]) ?? sentFiles,
                createdAt: Date.now(),
              });
            }
            break;
          }
          case "plan_start":
            if (currentTaskId) startPlanStreaming(currentTaskId);
            break;
          case "invite_request":
            addPendingInvite({
              inviteId: payload.inviteId as string,
              taskId: payload.taskId as string,
              fromId: payload.fromId as string,
              fromName: payload.fromName as string,
              targetId: payload.targetId as string,
              targetName: payload.targetName as string,
              targetEmoji: (payload.targetEmoji as string) ?? "🧑",
              targetRole: (payload.targetRole as string) ?? "",
              reason: (payload.reason as string) ?? "",
              sourceMessageId: payload.sourceMessageId as string,
              createdAt: Date.now(),
            });
            break;
          case "plan_delta":
            appendPlanStreaming(payload.text as string);
            break;
          case "plan": {
            // Auto-plan saved server-side as a role:"system" message. Append
            // immediately so the user sees the breakdown before workers stream,
            // and clear the live-streaming preview now that the final card
            // exists.
            const planMsgId = payload.messageId as string | undefined;
            const planContent = payload.content as string | undefined;
            const planObj = payload.plan as { assignments?: Array<{ employeeId: string; subtask: string }> } | undefined;
            if (planMsgId && planContent && currentTaskId) {
              appendMessage({
                id: planMsgId,
                taskId: currentTaskId,
                fromId: null,
                toId: null,
                role: "system",
                content: planContent,
                mentions: planObj?.assignments?.map(a => a.employeeId) ?? [],
                images: [],
                files: [],
                createdAt: Date.now(),
              });
            }
            if (planObj?.assignments && currentTaskId) {
              const map: Record<string, string> = {};
              for (const a of planObj.assignments) map[a.employeeId] = a.subtask;
              const taskId = currentTaskId;
              setAssignmentsByTask(prev => ({ ...prev, [taskId]: map }));
            }
            clearPlanStreaming();
            break;
          }
          case "task_titled": {
            const tid = payload.taskId as string;
            const st = useOffice.getState();
            const ex = st.tasks.find(t => t.id === tid);
            if (ex) st.upsertTask({ ...ex, title: payload.title as string });
            break;
          }
          case "turn_start":
            startStreaming(payload.employeeId as string, currentTaskId);
            break;
          case "delta":
            appendStreaming(payload.employeeId as string, payload.text as string);
            break;
          case "thinking_delta":
            appendThinking(payload.employeeId as string, payload.text as string);
            break;
          case "tool_use":
            if (currentTaskId) {
              appendToolEvent(currentTaskId, payload.toolName as string, payload.input, (payload.employeeId as string) ?? null);
              // Final tool_use arrives once the model has fully serialized its
              // input. Drop the streaming slot for THIS specific tool id — but
              // only if it still holds it. Guards against a parallel
              // tool_use_start (block B) wiping while block A's completion
              // arrives.
              clearStreamingTool(currentTaskId, payload.employeeId as string, payload.id as string | undefined);
            }
            break;
          case "tool_use_start":
            if (currentTaskId) {
              startStreamingTool(
                currentTaskId,
                payload.employeeId as string,
                payload.id as string,
                payload.toolName as string,
              );
            }
            break;
          case "tool_use_delta":
            if (currentTaskId) {
              appendStreamingTool(
                currentTaskId,
                payload.employeeId as string,
                payload.id as string,
                payload.partialJson as string,
              );
            }
            break;
          case "files_changed":
            if (payload.files && currentTaskId) {
              setTaskFiles(currentTaskId, payload.files as FileInfo[]);
            }
            break;
          case "turn_done": {
            const empId = payload.employeeId as string;
            clearStreaming(empId);
            if (currentTaskId) clearStreamingTool(currentTaskId, empId);
            const resolvedTaskId = currentTaskId ?? useOffice.getState().activeTaskId;
            const fullText = payload.fullText as string;
            appendMessage({
              id: payload.messageId as string,
              taskId: resolvedTaskId,
              fromId: empId,
              toId: null,
              role: "assistant",
              content: fullText,
              mentions: (payload.mentions as string[]) ?? [],
              images: [],
              files: [],
              createdAt: Date.now(),
            });
            // Notify on @-mentions to the user — defer to turn_done so we use
            // the final, stable text (partial-stream regex matches like `@anh`
            // mid-word would false-positive otherwise).
            if (hasBossPing(fullText, bossSet)) {
              const empName = employeesList.find(e => e.id === empId)?.name ?? "Agent";
              toast(`${empName} needs your reply`, "info");
            }
            break;
          }
          case "turn_error":
            clearStreaming(payload.employeeId as string);
            if (currentTaskId) clearStreamingTool(currentTaskId, payload.employeeId as string);
            break;
          case "stopped": {
            const state = useOffice.getState();
            const cTask = currentTaskId;
            Object.keys(state.streamingByEmployee).forEach(id => {
              clearStreaming(id);
              if (cTask) clearStreamingTool(cTask, id);
            });
            clearPlanStreaming();
            const tid = (payload.taskId as string | undefined) ?? cTask;
            if (tid) {
              const cur = state.tasks.find(t => t.id === tid);
              if (cur && cur.status === "in_progress") {
                upsertTask({ ...cur, status: "failed" });
              }
            }
            break;
          }
          case "end": {
            // Sync server-side status update so other UI (badges, filters) sees
            // the task as actually done instead of staying on `in_progress`.
            const tid = (payload.taskId as string | undefined) ?? currentTaskId;
            if (tid) {
              const cur = useOffice.getState().tasks.find(t => t.id === tid);
              if (cur && cur.status !== "done") {
                upsertTask({ ...cur, status: "done" });
              }
            }
            break;
          }
          case "error":
            toast(String(payload.error), "error");
            break;
        }
      };

      const parseBlock = (block: string) => {
        const lines = block.split("\n");
        let event = "";
        let data = "";
        for (const ln of lines) {
          if (ln.startsWith("event: ")) event = ln.slice(7);
          else if (ln.startsWith("data: ")) data += ln.slice(6);
        }
        if (!event) return;
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(data); } catch { return; }
        handleEvent(event, payload);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (!done) {
          buffer += decoder.decode(value, { stream: true });
        } else {
          buffer += decoder.decode();
        }
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        if (done && buffer.trim()) events.push(buffer);
        for (const block of events) parseBlock(block);
        if (done) break;
      }

      // Re-sync messages from DB — catches any SSE events that were
      // missed due to buffering, network issues, or parsing edge cases.
      if (currentTaskId) {
        try {
          const syncRes = await fetch(`/api/tasks/${currentTaskId}`);
          if (syncRes.ok) {
            const syncData = await syncRes.json();
            if (syncData.messages) useOffice.getState().mergeMessages(syncData.messages);
          }
        } catch { /* ignore */ }
      }
    } catch (err) {
      const e = err as { name?: string };
      if (e?.name !== "AbortError") console.error(err);
      const cTask = currentTaskId;
      Object.keys(useOffice.getState().streamingByEmployee).forEach(id => {
        clearStreaming(id);
        if (cTask) clearStreamingTool(cTask, id);
      });
      clearPlanStreaming();
    } finally {
      setCurrentAbort(null);
      setBusyTask(null);
    }
  }

  function stop() {
    // Stop = halt the CURRENT turn only. Anything the user already queued
    // stays and sends as soon as this turn aborts — pressing Stop because the
    // agent is slow should let your queued message through, not lose it. (The
    // queue chip has its own ✕ button to discard it explicitly.)
    stopCurrent();
  }

  function commitMention(name: string) {
    const t = inputRef.current;
    if (!t) return;
    const insert = `@${name} `;
    const before = draft.slice(0, mentionAnchor);
    const caret = t.selectionStart ?? draft.length;
    const after = draft.slice(caret);
    const next = before + insert + after;
    setDraft(next);
    setMentionQuery(null);
    // Restore focus + place caret right after the inserted text.
    requestAnimationFrame(() => {
      t.focus();
      const pos = mentionAnchor + insert.length;
      t.setSelectionRange(pos, pos);
    });
  }

  function handleDraftChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setDraft(value);
    const caret = e.target.selectionStart ?? value.length;
    const trig = findMentionTrigger(value, caret);
    if (trig) {
      setMentionAnchor(trig.anchor);
      setMentionQuery(trig.query);
      setMentionIdx(0);
    } else if (mentionQuery !== null) {
      setMentionQuery(null);
    }
  }

  return (
    <div className="flex h-full flex-col bg-[#262624]">
      {/* Shared hidden file input for the attach button in both compose & task
          modes — keeps a single ref so both Paperclip buttons trigger it. */}
      <input
        ref={attachInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={e => {
          if (e.target.files && e.target.files.length > 0) {
            const picked = Array.from(e.target.files);
            setPendingFiles(prev => [...prev, ...picked]);
            e.target.value = "";
          }
        }}
      />

      {/* Header */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-3.5">
        {isComposeMode ? (
          <>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal/15 text-teal-soft shrink-0">
              <MessageSquarePlus size={17} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-[14px] text-slate-100">New Task</div>
              <div className="text-[11px] text-slate-500 mt-0.5">Select an assignee and describe the task</div>
            </div>
          </>
        ) : isTaskMode ? (
          <>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-ember/15 text-ember-soft shrink-0">
              <ListChecks size={17} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold text-[14px] text-slate-100">
                {activeTask?.title || "(untitled)"}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">Direct</div>
            </div>
          </>
        ) : employee ? (
          <>
            <div className="flex h-9 w-9 items-center justify-center rounded-xl text-base ring-1 ring-black/20 shrink-0" style={{ backgroundColor: employee.avatarColor }}>
              {employee.emoji}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold text-[14px] text-slate-100">{employee.name}</div>
              <div className="truncate text-[11px] text-slate-500 mt-0.5">{employee.role}</div>
            </div>
            <button onClick={() => onEdit(employee.id)} aria-label="Edit agent" className="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-200" title="Edit agent">
              <Edit2 size={15} />
            </button>
          </>
        ) : null}
        {isTaskMode && (
          <>
            <button
              onClick={onToggleWorkflow}
              className={cn(
                "rounded-lg p-1.5 transition",
                workflowOpen ? "text-amber-300 bg-amber-400/10" : "text-slate-500 hover:bg-white/5 hover:text-slate-200"
              )}
              title={workflowOpen ? "Close workflow map" : "Workflow map"}
              aria-label="Toggle workflow map"
            >
              <GitBranch size={15} />
            </button>
            <button
              onClick={onToggleFiles}
              className={cn(
                "rounded-lg p-1.5 transition",
                filesOpen ? "text-teal-400 bg-teal-400/10" : "text-slate-500 hover:bg-white/5 hover:text-slate-200"
              )}
              title={filesOpen ? "Close files" : "Open files"}
              aria-label="Toggle files"
            >
              <FolderOpen size={15} />
            </button>
          </>
        )}
      </div>

      {/* Compose mode: new task creation */}
      {isComposeMode && (
        <>
          <div className="flex-1 flex flex-col px-8">
            {greeting && (
              <div className="pt-10 pb-2 text-center selectable">
                <div className="text-[26px] font-medium tracking-tight text-slate-100">
                  {greeting.phrase},{" "}
                  <span className="text-amber-300">
                    {profile.name || profile.address}
                  </span>
                </div>
                <div className="mt-1.5 text-[11px] uppercase tracking-wider text-slate-500">
                  {greeting.vnTime}
                </div>
              </div>
            )}
          <div className="flex-1 flex flex-col items-center justify-center">
            <div className="w-full max-w-sm">
              <div className="mb-6 text-center">
                <div className="text-4xl mb-3">
                  {composeTargets.length > 0 ? (
                    <div className="flex items-center justify-center -space-x-2">
                      {composeTargets.slice(0, 4).map(id => {
                        const e = employeesList.find(x => x.id === id);
                        if (!e) return null;
                        return (
                          <span key={id} className="flex h-12 w-12 items-center justify-center rounded-2xl text-2xl ring-2 ring-[#262624]" style={{ backgroundColor: e.avatarColor }}>
                            {e.emoji}
                          </span>
                        );
                      })}
                      {composeTargets.length > 4 && (
                        <span className="flex h-12 w-12 items-center justify-center rounded-2xl text-sm font-semibold ring-2 ring-[#262624] bg-white/10 text-slate-300">
                          +{composeTargets.length - 4}
                        </span>
                      )}
                    </div>
                  ) : (
                    <MessageSquarePlus size={36} className="mx-auto text-slate-500" />
                  )}
                </div>
                <div className="text-sm text-slate-400">
                  {composeTargets.length === 0
                    ? "Pick one or more agents for this room"
                    : composeTargets.length === 1
                    ? `Direct task for ${composeTargetsDisplay[0]}`
                    : `Room with ${composeTargets.length} agents · they reply in parallel`}
                </div>
              </div>

              <div ref={composePickerRef} className="relative mb-4">
                <button
                  onClick={() => setComposePickerOpen(o => !o)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm font-medium transition",
                    composeTargets.length > 0
                      ? "border-white/10 bg-white/5 text-slate-100 hover:bg-white/10"
                      : "border-dashed border-white/20 bg-white/[0.02] text-slate-400 hover:border-white/30 hover:text-slate-200"
                  )}
                >
                  {composeTargets.length > 0 ? (
                    <>
                      <div className="flex -space-x-1.5">
                        {composeTargets.slice(0, 3).map(id => {
                          const e = employeesList.find(x => x.id === id);
                          if (!e) return null;
                          return (
                            <span key={id} className="flex h-6 w-6 items-center justify-center rounded-full text-xs ring-2 ring-[#262624]" style={{ backgroundColor: e.avatarColor }}>
                              {e.emoji}
                            </span>
                          );
                        })}
                      </div>
                      <span className="truncate">
                        {composeTargetsDisplay.length <= 2
                          ? composeTargetsDisplay.join(", ")
                          : `${composeTargetsDisplay.slice(0, 2).join(", ")} +${composeTargetsDisplay.length - 2}`}
                      </span>
                    </>
                  ) : (
                    <>
                      <User size={16} />
                      <span>Select agents...</span>
                    </>
                  )}
                  <ChevronDown size={14} className="ml-auto opacity-60" />
                </button>

                {composePickerOpen && (
                  <div className="absolute left-0 right-0 top-full mt-1.5 z-20 max-h-64 overflow-auto rounded-xl border border-white/10 bg-[#2F2D29] p-1 shadow-2xl ring-1 ring-black/40 animate-slide-up">
                    {employeesList.map(e => {
                      const picked = composeTargets.includes(e.id);
                      return (
                        <button
                          key={e.id}
                          onClick={() =>
                            setComposeTargets(prev =>
                              prev.includes(e.id) ? prev.filter(id => id !== e.id) : [...prev, e.id]
                            )
                          }
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-white/5",
                            picked && "bg-white/5 ring-1 ring-white/10"
                          )}
                        >
                          <span className="flex h-7 w-7 items-center justify-center rounded-lg text-sm ring-1 ring-black/20" style={{ backgroundColor: e.avatarColor }}>{e.emoji}</span>
                          <div className="flex-1 min-w-0">
                            <div className="truncate font-medium">{e.name}</div>
                            <div className="truncate text-[11px] text-slate-400">{e.role}</div>
                          </div>
                          <span className={cn(
                            "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition",
                            picked
                              ? "border-sky-400 bg-sky-400/20 text-sky-300"
                              : "border-white/15 bg-transparent"
                          )}>
                            {picked && (
                              <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2}>
                                <polyline points="2.5,6.5 5,9 9.5,3.5" />
                              </svg>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
          </div>

          <div className="border-t border-white/[0.06] bg-[#262624] p-4">
            {pendingFiles.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {pendingFiles.map((f, i) => {
                  const ext = (f.name.split(".").pop() || "FILE").toUpperCase().slice(0, 5);
                  return (
                    <div
                      key={i}
                      className="group/file relative flex h-24 w-28 flex-col justify-between rounded-xl border border-white/10 bg-white/[0.04] p-2.5 transition-colors hover:bg-white/[0.06]"
                    >
                      <span className="line-clamp-3 break-all text-[11px] leading-tight text-slate-200">
                        {f.name}
                      </span>
                      <span className="inline-flex w-fit rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-400">
                        {ext}
                      </span>
                      <button
                        onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))}
                        className="absolute -left-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[#3D3B36] text-slate-300 opacity-0 ring-1 ring-black/40 transition-opacity group-hover/file:opacity-100 hover:bg-rose-600 hover:text-white"
                        aria-label="Remove file"
                        title="Remove"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={draft}
                spellCheck={false}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder={composeTargets.length > 0 ? "Describe the task..." : "Select at least one agent first..."}
                rows={1}
                disabled={composeTargets.length === 0}
                className="flex-1 resize-none rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-2 text-sm leading-6 outline-none placeholder:text-slate-500/70 focus:border-white/20 focus:bg-white/[0.05] transition-all duration-200 ease-out disabled:opacity-50 min-h-10 max-h-48 overflow-y-auto"
              />
              <button
                onClick={() => attachInputRef.current?.click()}
                disabled={composeTargets.length === 0}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-slate-400 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.06] hover:text-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
                title={composeTargets.length === 0 ? "Select an agent first" : "Attach file (goes into the new task's workspace)"}
                aria-label="Attach file"
              >
                <Paperclip size={14} />
              </button>
              <button
                onClick={submit}
                disabled={(!draft.trim() && pendingFiles.length === 0) || composeTargets.length === 0}
                className="group/send flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white bg-gradient-to-br from-ember to-ember-soft transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-lg hover:shadow-ember/30 disabled:from-slate-700 disabled:to-slate-700 disabled:shadow-none disabled:translate-y-0 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Send"
              >
                <Send size={16} className="transition-transform duration-200 ease-out group-hover/send:translate-x-0.5 group-hover/send:-translate-y-0.5" />
              </button>
            </div>
          </div>
        </>
      )}

      {/* Participants strip (task mode) */}
      {!isComposeMode && isTaskMode && (
        <ParticipantsStrip
          participants={participants}
          allEmployees={employeesList}
          onInsertMention={(name) => {
            const t = inputRef.current;
            if (!t) return;
            const mention = `@${name} `;
            const start = t.selectionStart ?? draft.length;
            const end = t.selectionEnd ?? draft.length;
            const next = draft.slice(0, start) + mention + draft.slice(end);
            setDraft(next);
            requestAnimationFrame(() => {
              t.focus();
              const pos = start + mention.length;
              t.setSelectionRange(pos, pos);
            });
          }}
        />
      )}

      {!isComposeMode && isTaskMode && currentTools.length > 0 && (
        <div className="flex items-center gap-2 border-b border-white/[0.04] px-4 py-1.5 text-[11px]">
          <div className="ml-auto flex items-center gap-1 truncate text-[10px] text-slate-500">
            <Wrench size={10} />
            <span className="truncate">{currentTools.slice(-3).map(t => t.tool).join(" → ")}</span>
          </div>
        </div>
      )}

      {/* Agent info pane — when an agent is selected but no task is open,
          show their profile (description / skills / model) instead of the
          cross-task message history. New tasks still start from the composer
          below. */}
      {!isComposeMode && !isTaskMode && employee && (
        <AgentInfoPane employee={employee} />
      )}

      {/* Messages */}
      {!isComposeMode && isTaskMode && <div
        ref={scrollRef}
        onScroll={onScrollContainer}
        className={cn(
          "relative flex-1 overflow-y-auto px-4 py-3 space-y-3",
          dragOver && isTaskMode && "ring-2 ring-ember/60 ring-inset bg-ember/5"
        )}
        onDragOver={(e) => { if (isTaskMode) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!isTaskMode) return;
          if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
        }}
      >
        {dragOver && isTaskMode && (
          <div className="pointer-events-none absolute inset-4 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-ember/60 bg-[#2F2D29]/80 backdrop-blur-sm">
            <div className="text-center">
              <Paperclip size={24} className="mx-auto mb-2 text-ember-soft" />
              <div className="text-sm font-medium text-ember-soft">Drop files here</div>
              <div className="text-xs text-slate-400">Files will go to this task's workspace</div>
            </div>
          </div>
        )}
        {displayed.length === 0 && streamingEntries.length === 0 && (
          <div className="mt-12 text-center text-sm text-slate-500">
            {isTaskMode ? "Task created, waiting for response..." : "No conversations yet."}
            <div className="mt-1 text-xs">Type below to start.</div>
          </div>
        )}

        {displayed.map(m => {
          const isUser = m.fromId === null;
          const from = isUser ? null : (employeesList.find(e => e.id === m.fromId) ?? null);
          const isEditing = editingMsgId === m.id;
          return (
            <MessageRow
              key={m.id}
              m={m}
              from={from}
              bossSet={bossSet}
              isReplyTarget={replyingTo?.id === m.id}
              isEditing={isEditing}
              canEdit={isUser && isTaskMode && busyTaskId !== activeTaskId}
              busy={busyTaskId === activeTaskId}
              editDraft={isEditing ? editDraft : ""}
              setEditDraft={setEditDraft}
              onEdit={handleEditMessage}
              onStartEdit={handleStartEdit}
              onCancelEdit={handleCancelEdit}
              onReply={handleReply}
            />
          );
        })}

        {isTaskMode && pendingInvites
          .filter(inv => inv.taskId === activeTaskId)
          .map(inv => (
            <div key={inv.inviteId} className="my-2 flex justify-center selectable">
              <div className="w-full max-w-[88%] rounded-xl border border-amber-400/20 bg-amber-400/[0.04] px-4 py-3 ring-1 ring-amber-400/10">
                <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-amber-300/80">
                  <HelpCircle size={11} /> Invite request
                </div>
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-lg ring-1 ring-black/20" style={{ backgroundColor: employeesList.find(e => e.id === inv.targetId)?.avatarColor ?? "#3D3B36" }}>
                    {inv.targetEmoji}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-slate-100">
                      <span className="font-medium text-amber-200">{inv.fromName}</span>
                      {" wants to invite "}
                      <span className="font-medium text-amber-200">{inv.targetName}</span>
                      {inv.targetRole && <span className="text-slate-400"> · {inv.targetRole}</span>}
                      {" to the room"}
                    </div>
                    {inv.reason && (
                      <div className="mt-1 rounded-md bg-white/[0.04] px-2.5 py-1.5 text-[12px] italic text-slate-300 leading-snug">
                        “{inv.reason}”
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    onClick={() => removePendingInvite(inv.inviteId)}
                    className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[12px] font-medium text-slate-300 hover:bg-white/[0.06] hover:text-slate-100 transition"
                  >
                    Decline
                  </button>
                  <button
                    onClick={() => acceptInvite(inv)}
                    className="rounded-lg bg-gradient-to-br from-amber-400 to-amber-500 px-3 py-1.5 text-[12px] font-semibold text-slate-900 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-lg hover:shadow-amber-400/30"
                  >
                    Accept
                  </button>
                </div>
              </div>
            </div>
          ))}

        {planStreaming && (isTaskMode ? planStreaming.taskId === activeTaskId : false) && (
          <div className="my-2 flex justify-center">
            <div className="w-full max-w-[88%] rounded-xl border border-sky-400/15 bg-sky-400/[0.04] px-4 py-3 ring-1 ring-sky-400/10">
              <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-sky-300/80">
                <span>Auto plan</span>
                <span className="flex gap-[3px]">
                  <span className="typing-dot h-[4px] w-[4px] rounded-full bg-sky-300/80" />
                  <span className="typing-dot h-[4px] w-[4px] rounded-full bg-sky-300/80" />
                  <span className="typing-dot h-[4px] w-[4px] rounded-full bg-sky-300/80" />
                </span>
              </div>
              <div className="text-[13px] leading-relaxed text-slate-200">
                {planStreaming.text
                  ? <SmoothText text={planStreaming.text} />
                  : <span className="text-slate-400">Planning…</span>}
              </div>
            </div>
          </div>
        )}

        {streamingEntries.map(([id, s]) => {
          const emp = employeesList.find(e => e.id === id);
          if (!emp || !s) return null;
          const agentTools = currentTools.filter(t => t.employeeId === id && t.at >= s.startedAt);
          const latestTool = agentTools[agentTools.length - 1];
          const olderTools = agentTools.slice(-4, -1);
          const hasText = s.text.length > 0;
          const ping = hasText && hasBossPing(s.text, bossSet);
          const subtask = activeTaskId ? assignmentsByTask[activeTaskId]?.[id] : undefined;
          // Live-streaming tool: the model is mid-flight building a tool input
          // (Write/Edit/Bash/...). We feed the running partial JSON to a code
          // preview so the user can watch the file being generated in real
          // time — same screen real-estate as the completed-tool fallback,
          // but updated every input_json_delta tick.
          const liveTool = activeTaskId ? streamingToolByTask[activeTaskId]?.[id] : undefined;
          const livePreview = liveTool ? streamingPreviewFor(liveTool.toolName, liveTool.partialJson) : null;
          const hasThinking = s.thinking.length > 0;
          // Show fake-rotating status ONLY when we have nothing real yet (no
          // text, no live tool, no thinking summary). The moment any real
          // signal arrives, switch to it.
          const showRotatingFallback = !hasText && !livePreview && !hasThinking;
          const elapsedSec = Math.floor((Date.now() - s.startedAt) / 1000);
          return (
            <div key={`stream-${id}`} className="flex gap-2 justify-start items-start">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs" style={{ backgroundColor: emp.avatarColor }}>
                {emp.emoji}
              </div>
              <div className="min-w-0 max-w-[78%] rounded-2xl rounded-bl-sm px-3 py-2.5 ring-1 bg-white/[0.05] ring-white/[0.05]">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-slate-400">{emp.name}</span>
                  {showRotatingFallback && (
                    <>
                      <StreamingStatus startedAt={s.startedAt} />
                      <span className="flex gap-[3px]">
                        <span className="typing-dot h-[5px] w-[5px] rounded-full bg-slate-400" />
                        <span className="typing-dot h-[5px] w-[5px] rounded-full bg-slate-400" />
                        <span className="typing-dot h-[5px] w-[5px] rounded-full bg-slate-400" />
                      </span>
                    </>
                  )}
                  {hasThinking && !hasText && !livePreview && (
                    <span className="text-[11px] text-violet-300/80">Thinking ({elapsedSec}s)</span>
                  )}
                  {!hasText && livePreview && (
                    <span className="text-[11px] text-sky-300/80">Writing…</span>
                  )}
                </div>
                {hasThinking && !hasText && !livePreview && (
                  <ActivityFeed thinking={s.thinking} />
                )}
                {ping && (
                  <div className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-ember/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ember-soft ring-1 ring-ember/40">
                    <HelpCircle size={11} /> Needs your reply
                  </div>
                )}
                {hasText && (
                  <div className="mt-1 text-[13px] leading-relaxed text-slate-200">
                    <SmoothText text={s.text} />
                  </div>
                )}
                {/* Live streaming tool preview wins over the completed-tool
                    fallback — once we're streaming a new write, the older
                    flash-through doesn't add information. */}
                {livePreview ? (
                  <CodeTail
                    key={liveTool!.id}
                    code={livePreview.code}
                    lang={livePreview.lang}
                    label={livePreview.label}
                  />
                ) : (!hasText && (
                  <>
                    {agentTools.length === 0 && subtask && (
                      <div className="mt-1 text-[11px] italic text-slate-500">
                        {subtask}
                      </div>
                    )}
                    {olderTools.length > 0 && (
                      <div className="mt-1.5 flex flex-col gap-0.5 text-[10px] text-slate-600">
                        {olderTools.map((t, idx) => (
                          <div key={idx} className="truncate">✓ {describeTool(t.tool, t.input)}</div>
                        ))}
                      </div>
                    )}
                    {latestTool && (() => {
                      const preview = previewToolPayload(latestTool.tool, latestTool.input);
                      return preview ? (
                        <CodeTail
                          key={latestTool.at}
                          code={preview.code}
                          lang={preview.lang}
                          label={preview.label}
                        />
                      ) : (
                        <div className="mt-1 truncate text-[11px] text-sky-300">
                          {describeTool(latestTool.tool, latestTool.input)}
                        </div>
                      );
                    })()}
                  </>
                ))}
              </div>
            </div>
          );
        })}

      </div>}

      {/* Input footer */}
      {!isComposeMode && <div className="relative border-t border-white/[0.06] bg-[#262624] p-4">
        {/* @-mention popup: rendered above the textarea so it doesn't push
            content down. Sticks while textarea has focus + query is set. */}
        {mentionQuery !== null && mentionCandidates.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-1 z-20 max-h-56 overflow-auto rounded-xl border border-white/10 bg-[#2F2D29] p-1 shadow-2xl ring-1 ring-black/40 animate-slide-up">
            <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-slate-500">
              Mention {participants.length > 0 ? "· in-room prioritized" : ""}
            </div>
            {mentionCandidates.map((e, i) => {
              const inRoom = participants.some(p => p.id === e.id);
              return (
                <button
                  key={e.id}
                  type="button"
                  onMouseDown={ev => ev.preventDefault() /* don't blur textarea */}
                  onClick={() => commitMention(e.name)}
                  onMouseEnter={() => setMentionIdx(i)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs",
                    i === mentionIdx ? "bg-white/10" : "hover:bg-white/5",
                  )}
                >
                  <span
                    className="flex h-6 w-6 items-center justify-center rounded-full text-xs ring-1 ring-black/20"
                    style={{ backgroundColor: e.avatarColor }}
                  >
                    {e.emoji}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate font-medium text-slate-100">{e.name}</span>
                    <span className="block truncate text-[10px] text-slate-400">{e.role}</span>
                  </span>
                  {inRoom && (
                    <span className="text-[9px] uppercase tracking-wider text-ember-soft/80 shrink-0">
                      room
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {replyingTo && (() => {
          const from = replyingTo.fromId
            ? employeesList.find(e => e.id === replyingTo.fromId)
            : null;
          return (
            <div className="mb-1.5 flex items-center gap-2 rounded-lg border-l-2 border-ember bg-ember/10 px-2.5 py-1.5">
              <CornerUpLeft size={12} className="text-ember-soft shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-medium text-ember-soft">
                  Replying to {from ? `${from.name}` : "you"}
                </div>
                <div className="truncate text-[11px] text-slate-300">
                  {replyingTo.content.replace(/\s+/g, " ").slice(0, 120)}
                </div>
              </div>
              <button
                onClick={() => setReplyingTo(null)}
                className="rounded p-0.5 text-slate-400 hover:bg-white/5 hover:text-slate-100 shrink-0"
                title="Cancel reply"
                aria-label="Cancel reply"
              >
                <X size={12} />
              </button>
            </div>
          );
        })()}
        <div className="text-[10px] text-slate-500 mb-1.5">
          {isTaskMode
            ? "Continue this task. @Name to assign a responder."
            : employee
              ? `Direct chat with ${employee.name}`
              : ""}
        </div>
        {(() => {
          // Accepted-invite dispatches sit in the same queue as typed messages
          // but they aren't "messages the user typed and is waiting on" — they
          // run silently after the current turn finishes. Hide them from the
          // visible counter so the banner doesn't surface as a misleading
          // "Queued" status to the user.
          const visibleQueued = queue.filter(q => !q.dispatch);
          if (visibleQueued.length === 0) return null;
          return (
            <div className="mb-1.5 flex items-center gap-2 rounded-lg border border-ember/30 bg-ember/10 px-2.5 py-1.5 text-[11px] text-ember-soft">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ember-soft" />
              <span className="flex-1">
                Queued · {visibleQueued.length} message{visibleQueued.length > 1 ? "s" : ""}
              </span>
              <button
                onClick={() => setQueue(q => q.filter(x => x.dispatch))}
                className="rounded p-0.5 text-ember-soft/80 hover:bg-white/5 hover:text-ember-soft"
                title="Clear queue"
                aria-label="Clear queue"
              >
                <X size={12} />
              </button>
            </div>
          );
        })()}
        {pendingFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingFiles.map((f, i) => {
              const ext = (f.name.split(".").pop() || "FILE").toUpperCase().slice(0, 5);
              return (
                <div
                  key={i}
                  className="group/file relative flex h-24 w-28 flex-col justify-between rounded-xl border border-white/10 bg-white/[0.04] p-2.5 transition-colors hover:bg-white/[0.06]"
                >
                  <span className="line-clamp-3 break-all text-[11px] leading-tight text-slate-200">
                    {f.name}
                  </span>
                  <span className="inline-flex w-fit rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-400">
                    {ext}
                  </span>
                  <button
                    onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))}
                    className="absolute -left-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[#3D3B36] text-slate-300 opacity-0 ring-1 ring-black/40 transition-opacity group-hover/file:opacity-100 hover:bg-rose-600 hover:text-white"
                    aria-label="Remove file"
                    title="Remove"
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {pendingImages.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {pendingImages.map((src, i) => (
              <div key={i} className="group/img relative">
                <img src={src} alt="" className="h-16 w-auto max-w-[120px] rounded-lg border border-white/10 object-cover" />
                <button
                  onClick={() => setPendingImages(prev => prev.filter((_, j) => j !== i))}
                  className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-[#3D3B36] text-slate-300 opacity-0 group-hover/img:opacity-100 transition-opacity hover:bg-rose-600 hover:text-white"
                  aria-label="Remove image"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
            <div className="flex items-center text-[10px] text-slate-500">
              <ImageIcon size={10} className="mr-1" />{pendingImages.length} image{pendingImages.length > 1 ? "s" : ""}
            </div>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={draft}
            spellCheck={false}
            onChange={handleDraftChange}
            onPaste={handlePaste}
            onKeyUp={e => {
              // Caret may move via arrow keys without value changing; rescan.
              const v = (e.target as HTMLTextAreaElement).value;
              const caret = (e.target as HTMLTextAreaElement).selectionStart ?? v.length;
              const trig = findMentionTrigger(v, caret);
              if (trig) {
                setMentionAnchor(trig.anchor);
                setMentionQuery(trig.query);
              } else if (mentionQuery !== null && !["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key)) {
                setMentionQuery(null);
              }
            }}
            onKeyDown={e => {
              const popupOpen = mentionQuery !== null && mentionCandidates.length > 0;
              if (popupOpen) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionIdx(i => (i + 1) % mentionCandidates.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIdx(i => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  commitMention(mentionCandidates[mentionIdx].name);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMentionQuery(null);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            onBlur={() => {
              // Close popup when textarea loses focus, after a short delay so
              // a click on a popup item can still register.
              setTimeout(() => setMentionQuery(null), 120);
            }}
            placeholder="Type a message..."
            rows={1}
            className="flex-1 resize-none rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-2 text-sm leading-6 outline-none placeholder:text-slate-500/70 focus:border-white/20 focus:bg-white/[0.05] transition-all duration-200 ease-out min-h-10 max-h-48 overflow-y-auto"
          />
          <button
            onClick={() => attachInputRef.current?.click()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-slate-400 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.06] hover:text-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Attach file (uploads when you send the message)"
            aria-label="Attach file"
          >
            <Paperclip size={14} />
          </button>
          {busyTaskId === activeTaskId && busyTaskId !== null && (
            <button
              onClick={stop}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white bg-gradient-to-br from-rose-500 to-rose-600 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-lg hover:shadow-rose-500/30 animate-pop-in"
              title="Stop current turn and clear queue"
            >
              <Square size={14} fill="currentColor" />
            </button>
          )}
          <button
            onClick={submit}
            disabled={!draft.trim() && pendingImages.length === 0}
            className="group/send flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white bg-gradient-to-br from-ember to-ember-soft transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-lg hover:shadow-ember/30 disabled:from-slate-700 disabled:to-slate-700 disabled:shadow-none disabled:translate-y-0 disabled:opacity-50 disabled:cursor-not-allowed"
            title={isBusy ? "Queue (sends when current turn finishes)" : "Send"}
          >
            <Send size={16} className="transition-transform duration-200 ease-out group-hover/send:translate-x-0.5 group-hover/send:-translate-y-0.5" />
          </button>
        </div>
      </div>}
    </div>
  );
}

// -------------------- Participants strip with "Invite" picker --------------------
function ParticipantsStrip({
  participants, allEmployees, onInsertMention,
}: {
  participants: Employee[];
  allEmployees: Employee[];
  onInsertMention: (name: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const participantIds = new Set(participants.map(p => p.id));
  const candidates = allEmployees.filter(e => !participantIds.has(e.id));

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-white/5 bg-white/[0.02] px-4 py-2">
      <span className="text-[10px] uppercase tracking-wider text-slate-500 mr-1">In task:</span>
      {participants.map(p => (
        <div key={p.id} className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 py-0.5 pl-0.5 pr-2 text-xs">
          <span className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] ring-1 ring-black/20" style={{ backgroundColor: p.avatarColor }}>
            {p.emoji}
          </span>
          <span>{p.name}</span>
        </div>
      ))}
      {participants.length === 0 && (
        <span className="text-[11px] text-slate-500">No one yet. Invite to start</span>
      )}

      {candidates.length > 0 && (
        <div ref={pickerRef} className="relative ml-auto">
          <button
            onClick={() => setPickerOpen(o => !o)}
            className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[11px] font-medium text-slate-200 hover:border-ember/40 hover:text-ember-soft"
            title="Invite others to this task"
          >
            <Plus size={11} /> Invite
          </button>
          {pickerOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-60 rounded-xl border border-white/10 bg-[#2F2D29] p-1 shadow-2xl ring-1 ring-black/40 z-10 animate-pop-in">
              <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-slate-500">
                Insert @mention into chat
              </div>
              {candidates.map(e => (
                <button
                  key={e.id}
                  onClick={() => { onInsertMention(e.name); setPickerOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-white/5"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-full text-xs ring-1 ring-black/20" style={{ backgroundColor: e.avatarColor }}>
                    {e.emoji}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate font-medium text-slate-100">{e.name}</span>
                    <span className="block truncate text-[10px] text-slate-400">{e.role}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
