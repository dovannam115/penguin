import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import type { Employee } from "./types";
import { buildEmployeeMemory } from "./memory";
import { buildOfficeMcpServer } from "./office-mcp";
import { parseModel } from "./models";
import { runEmployeeViaOpenAI } from "./openai-compat";
import { taskSessions } from "./db";
import { reuseSession, createWarmSession, dropSession, preWarmSession, type UserPrompt } from "./session-pool";
import { readFileSync } from "node:fs";
import { employees as employeesDb } from "./db";
import { ensureWorkspace } from "./upload";
import {
  buildStaticSystemPrompt,
  buildDynamicSystemPrompt,
  type StreamEvent,
  type RunInput,
} from "./employee-prompt";

// Re-export the shared agent contract so existing importers of "@/lib/claude"
// keep working.
export type { StreamEvent, RunInput } from "./employee-prompt";

export async function* runEmployee(input: RunInput): AsyncGenerator<StreamEvent> {
  // Route non-Claude models (OpenRouter / Gemini) to the OpenAI-compatible
  // backend. `modelOverride` (used for cheap utility passes) is always a Claude
  // model, so it wins here and keeps those passes on the Agent SDK.
  const effectiveModel = input.modelOverride ?? input.employee.model;
  if (parseModel(effectiveModel).provider !== "claude") {
    yield* runEmployeeViaOpenAI(input);
    return;
  }

  const { employee, prompt, signal, taskId } = input;
  const abortController = signal ?? new AbortController();
  let fullText = "";
  let sessionId: string | null = null;

  const hasWorkspace = !!input.workspace;
  const effectiveModelName = input.modelOverride ?? employee.model;

  // Warm session pool. Two regimes:
  //   - Chat: keyed per (task, employee) so each conversation has its own
  //     subprocess. Memory + system prompt baked in on first turn.
  //   - Utility (planning JSON, refine): keyed per (employee, model) and
  //     SHARED ACROSS TASKS — planning runs at most once per task, so a
  //     per-task pool would never get reused. Cross-task reuse means a single
  //     warm subprocess serves Manager planning for every new task that comes
  //     through. Trade-off: prior plans accumulate as session history; for
  //     bare JSON output this rarely affects correctness but the subprocess
  //     does grow, hence the idle-timeout reaper in session-pool.ts.
  const poolKey = input.bareForUtility
    ? `util:${employee.id}:${effectiveModelName}`
    : (taskId ? `chat:${taskId}:${employee.id}` : null);
  const optionsSig = `${effectiveModelName}|${hasWorkspace ? "tools" : "plain"}|${input.workspace?.dir ?? ""}|${input.bareForUtility ? "bare" : "full"}`;

  // Build image payload once (read base64 from disk). Capped at 10 images per
  // turn + 5MB each — Anthropic's hard limit is higher but we play safe so a
  // single accidentally huge upload doesn't blow up the request.
  const MAX_IMAGES = 10;
  const MAX_IMG_BYTES = 5 * 1024 * 1024;
  const images: UserPrompt["images"] = [];
  if (input.attachedImages && input.attachedImages.length > 0) {
    for (const img of input.attachedImages.slice(0, MAX_IMAGES)) {
      try {
        const buf = readFileSync(img.path);
        if (buf.length > MAX_IMG_BYTES) continue;
        images.push({ data: buf.toString("base64"), mediaType: img.mediaType });
      } catch {
        // missing/unreadable image → skip silently, agent gets text only
      }
    }
  }

  const t0 = Date.now();
  // Try warm reuse first. If we hit a pooled session, push only the bare new
  // user message — system prompt + history live in the subprocess already.
  const warmPrompt: string | UserPrompt = images.length > 0 ? { text: prompt, images } : prompt;
  let warm = poolKey ? reuseSession(poolKey, optionsSig, warmPrompt) : null;

  // If no warm hit, build the full cold prompt: memory (skipped when SDK
  // resume from disk is available) + new message. Utility passes never use
  // DB resume — they're stateless one-shots.
  const dbResumeId =
    !warm && taskId && !input.bareForUtility ? taskSessions.get(taskId, employee.id) : null;
  const memory =
    warm || input.bareForUtility || dbResumeId
      ? ""
      : buildEmployeeMemory(employee, taskId);
  const finalPrompt = memory ? `${memory}=== NHIỆM VỤ HIỆN TẠI ===\n${prompt}` : prompt;

  // Split into a static prefix (employee persona + skills + rules + tool list)
  // and a dynamic suffix (workspace dir + input-files note). The boundary
  // marker lets the SDK cache the prefix across sessions/turns.
  const staticSystemPrompt = buildStaticSystemPrompt(employee, {
    hasWorkspace,
    hasBash: hasWorkspace,
    bareForUtility: input.bareForUtility,
  });
  const dynamicSystemPrompt =
    hasWorkspace && input.workspace ? buildDynamicSystemPrompt(input.workspace) : "";
  const systemPrompt: string[] = dynamicSystemPrompt
    ? [staticSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, dynamicSystemPrompt]
    : [staticSystemPrompt];

  const mcpServers = hasWorkspace && input.workspace
    ? { office: buildOfficeMcpServer(input.workspace.dir, taskId ?? null, { skills: employee.skills ?? [] }) }
    : ({} as Record<string, never>);
  const sdkOptions: Parameters<typeof query>[0]["options"] = {
    systemPrompt,
    model: effectiveModelName,
    tools: hasWorkspace
      ? ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookEdit"]
      : [],
    settingSources: [],
    mcpServers,
    disallowedTools: ["mcp__pencil__*", "mcp__claude_ai_*", "mcp__figma__*"],
    maxTurns: hasWorkspace ? 12 : 1,
    includePartialMessages: true,
    // Extended thinking disabled to cut cost. If complex multi-tool tasks
    // (Excel multi-sheet, product brief 7-phase, market scan) start producing
    // incomplete output, re-enable with: { type: "enabled", budgetTokens: 3000, display: "summarized" }.
    thinking: { type: "disabled" },
    abortController,
    ...(dbResumeId ? { resume: dbResumeId } : {}),
    ...(hasWorkspace && input.workspace ? {
      cwd: input.workspace.dir,
      permissionMode: "bypassPermissions" as const,
    } : {}),
  };

  // Aborting a warm-pooled turn: closing the session is the cleanest way to
  // interrupt. The next turn will spin up a new subprocess.
  if (warm && poolKey) {
    abortController.signal.addEventListener("abort", () => dropSession(poolKey), { once: true });
  }

  const t1 = Date.now();
  let firstTokenAt = 0;
  try {
    let gen: AsyncIterable<unknown>;
    if (warm) {
      gen = warm.events;
    } else if (poolKey) {
      const coldPrompt: string | UserPrompt = images.length > 0 ? { text: finalPrompt, images } : finalPrompt;
      const handle = createWarmSession(poolKey, optionsSig, sdkOptions, coldPrompt);
      // Same abort-as-close hook for freshly created pooled sessions.
      abortController.signal.addEventListener("abort", () => dropSession(poolKey), { once: true });
      gen = handle.events;
    } else {
      // Non-poolable (utility passes, no taskId) — one-shot. Utility passes
      // never carry images, so plain string is sufficient.
      gen = query({ prompt: finalPrompt, options: sdkOptions }) as AsyncIterable<unknown>;
    }

    // Map block index -> tool_use id so input_json_delta events (which only
    // carry the index) can be tied back to the tool they belong to on the UI.
    const toolBlocks = new Map<number, string>();
    let thinkingChars = 0;
    let thinkingBlocks = 0;
    let lastWasThinking = false;
    for await (const _msg of gen as AsyncIterable<{ type: string; event?: unknown; session_id?: string; error?: string; message?: { content?: unknown } }>) {
      const msg = _msg;
      if (msg.type === "stream_event") {
        const ev = msg.event as {
          type: string;
          index?: number;
          content_block?: { type: string; name?: string; id?: string };
          delta?: { type: string; text?: string; partial_json?: string; thinking?: string };
        };
        if (ev.type === "content_block_start" && typeof ev.index === "number" && ev.content_block?.type === "tool_use") {
          const id = ev.content_block.id ?? `tool_${ev.index}`;
          const name = ev.content_block.name ?? "";
          toolBlocks.set(ev.index, id);
          yield { kind: "tool_use_start", toolName: name, id, index: ev.index };
        } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          if (firstTokenAt === 0) firstTokenAt = Date.now();
          fullText += ev.delta.text;
          yield { kind: "delta", text: ev.delta.text };
        } else if (ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta" && typeof ev.delta.thinking === "string") {
          // Surface Claude's adaptive-thinking summary to the UI so the user
          // sees real reasoning during the long pre-tool wait. Don't bump
          // firstTokenAt — thinking happens before the answer proper.
          thinkingChars += ev.delta.thinking.length;
          if (!lastWasThinking) thinkingBlocks += 1;
          lastWasThinking = true;
          yield { kind: "thinking_delta", text: ev.delta.thinking };
        } else if (ev.type === "content_block_start" && ev.content_block?.type !== "thinking") {
          lastWasThinking = false;
        } else if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta" && typeof ev.delta.partial_json === "string" && typeof ev.index === "number") {
          const id = toolBlocks.get(ev.index);
          if (id) {
            yield { kind: "tool_use_delta", id, index: ev.index, partialJson: ev.delta.partial_json };
          }
        }
      } else if (msg.type === "assistant") {
        sessionId = msg.session_id ?? sessionId;
        if (msg.error) {
          yield { kind: "error", error: msg.error };
          return;
        }
        const content = (msg.message?.content ?? []) as Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>;
        for (const block of content) {
          if (block.type === "tool_use" && block.name) {
            yield { kind: "tool_use", toolName: block.name, input: block.input ?? {}, id: block.id ?? "" };
          } else if (block.type === "text" && block.text && !fullText.includes(block.text)) {
            fullText += block.text;
            yield { kind: "delta", text: block.text };
          }
        }
      } else if (msg.type === "result") {
        sessionId = msg.session_id ?? sessionId;
      }
    }

    // Persist the latest sessionId for this (task, employee) so the next
    // turn can resume instead of re-sending memory.
    if (taskId && sessionId && !input.bareForUtility) {
      taskSessions.set(taskId, employee.id, sessionId);
    }

    const t2 = Date.now();
    const memChars = memory.length;
    const promptChars = finalPrompt.length;
    const ttft = firstTokenAt ? firstTokenAt - t1 : -1;
    const stream = firstTokenAt ? t2 - firstTokenAt : -1;
    const thinkingTokenEst = Math.round(thinkingChars / 3.5);
    console.log(
      `[claude] emp=${employee.name} model=${effectiveModelName} ` +
      `tools=${hasWorkspace ? "Y" : "N"} bare=${input.bareForUtility ? "Y" : "N"} ` +
      `warm=${warm ? "Y" : "N"} dbresume=${dbResumeId ? "Y" : "N"} ` +
      `mem=${memChars}c prompt=${promptChars}c | ` +
      `build=${t1 - t0}ms first_token=${ttft}ms stream=${stream}ms total=${t2 - t0}ms ` +
      `out=${fullText.length}c think=${thinkingChars}c(~${thinkingTokenEst}tok x${thinkingBlocks}blk)`,
    );
    yield { kind: "done", fullText, sessionId };
  } catch (err) {
    // If a warm session crashed, drop it from the pool so any retry spawns fresh.
    if (poolKey) dropSession(poolKey);
    // SDK resume can fail if the session transcript is missing (cleared disk, or
    // the app folder moved so the cwd-derived project dir changed). Clear the
    // stale id and — if nothing was streamed yet — transparently retry this same
    // turn WITHOUT resume so it rebuilds context from message history instead of
    // surfacing an error. The recursive call re-reads taskSessions (now cleared)
    // → dbResumeId null → buildEmployeeMemory path. firstTokenAt===0 guards
    // against duplicate output; the now-null dbResumeId prevents a second retry
    // (no infinite loop).
    if (dbResumeId && taskId && firstTokenAt === 0) {
      taskSessions.clear(taskId, employee.id);
      console.log(`[claude] resume failed for emp=${employee.name} task=${taskId} — retrying cold with reconstructed memory`);
      yield* runEmployee(input);
      return;
    }
    if (dbResumeId && taskId) taskSessions.clear(taskId, employee.id);
    yield { kind: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Pre-warm SDK subprocess(es) for an employee in a task — call this when the
 *  user picks an employee in compose mode or opens a task, so the SDK spawn
 *  cost happens during user typing time instead of after they hit send.
 *  No-op if a session already exists for that key, or if the employee uses a
 *  non-Claude provider (OpenRouter doesn't pool subprocesses).
 *
 *  CRITICAL: this MUST mirror the options signature the real chat will use
 *  (workspace + tools), otherwise reuseSession evicts the warm subprocess for
 *  signature mismatch and the user still pays the cold-spawn cost. The chat
 *  route always passes `hasWorkspace: true`, so we do the same here and pre-
 *  create the workspace dir so the SDK can boot with the same cwd. */
export function prewarmChatSession(taskId: string, employeeId: string): void {
  const employee = employeesDb.get(employeeId);
  if (!employee) return;
  if (parseModel(employee.model).provider !== "claude") return;

  const effectiveModel = employee.model;
  const wsDir = ensureWorkspace(taskId);

  const chatPoolKey = `chat:${taskId}:${employeeId}`;
  const chatOptionsSig = `${effectiveModel}|tools|${wsDir}|full`;
  const chatSystemPrompt = buildStaticSystemPrompt(employee, {
    hasWorkspace: true,
    hasBash: true,
    bareForUtility: false,
  });
  preWarmSession(chatPoolKey, chatOptionsSig, {
    systemPrompt: [chatSystemPrompt],
    model: effectiveModel,
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookEdit"],
    settingSources: [],
    mcpServers: { office: buildOfficeMcpServer(wsDir, taskId, { skills: employee.skills ?? [] }) },
    disallowedTools: ["mcp__pencil__*", "mcp__claude_ai_*", "mcp__figma__*"],
    maxTurns: 12,
    includePartialMessages: true,
    thinking: { type: "disabled" },
    abortController: new AbortController(),
    cwd: wsDir,
    permissionMode: "bypassPermissions" as const,
  });
}

const MENTION_RE = /@([A-Za-zÀ-ỹ][A-Za-zÀ-ỹ0-9_]*)/g;

export function extractMentions(text: string, roster: Employee[]): string[] {
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const name = m[1].toLowerCase();
    const hit = roster.find(e => e.name.toLowerCase() === name);
    if (hit) names.add(hit.id);
  }
  return [...names];
}
