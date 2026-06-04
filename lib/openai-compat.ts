// OpenAI-compatible execution backend for non-Claude "employees".
//
// OpenRouter and Google Gemini both expose an OpenAI-style /chat/completions
// API. This module runs an employee against either of them with streaming +
// a function-calling loop over the office tools (PDF / DOCX / XLSX / dashboard
// / read_text / write_text). It deliberately does NOT provide Bash / raw
// filesystem access — that stays exclusive to the Claude Agent SDK backend.

import { z } from "zod";
import type { StreamEvent, RunInput } from "./employee-prompt";
import {
  buildStaticSystemPrompt,
  buildDynamicSystemPrompt,
} from "./employee-prompt";
import { buildEmployeeMemory } from "./memory";
import { officeToolDefs, type OfficeToolDef } from "./office-mcp";
import { getProviderKeys } from "./db";
import { parseModel } from "./models";

interface Endpoint {
  url: string;
  headers: Record<string, string>;
  modelName: string;
  label: string;
}

/** Map a stored model id → a concrete OpenAI-compatible endpoint, or an error
 *  string when the OpenRouter API key has not been configured. */
function resolveEndpoint(model: string): { ep: Endpoint } | { error: string } {
  const { provider, modelName } = parseModel(model);
  if (provider !== "openrouter") {
    return { error: `Model "${model}" không chạy được qua backend này.` };
  }

  const keys = getProviderKeys();
  if (!keys.openrouter) {
    return { error: "Chưa cấu hình OpenRouter API key. Mở Settings (góc trên bên trái) để dán key vào." };
  }
  return {
    ep: {
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: {
        "Authorization": `Bearer ${keys.openrouter}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Penguin",
      },
      modelName,
      label: `OpenRouter · ${modelName}`,
    },
  };
}

/** Office tool defs → OpenAI `tools` array (function-calling format). */
function toOpenAITools(defs: OfficeToolDef[]) {
  return defs.map(def => {
    let parameters: unknown;
    try {
      parameters = z.toJSONSchema(z.object(def.shape));
    } catch {
      // Fallback: a permissive object schema if a tool's schema can't be
      // converted (keeps the rest of the tools usable).
      parameters = { type: "object", properties: {}, additionalProperties: true };
    }
    return {
      type: "function" as const,
      function: {
        name: def.name,
        description: def.description,
        parameters,
      },
    };
  });
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** A streamed chat completion can spread one tool call across many chunks;
 *  reassemble them keyed by `index`. */
interface AssemblingCall {
  id: string;
  name: string;
  args: string;
}

const MAX_ROUNDS = 10;

export async function* runEmployeeViaOpenAI(input: RunInput): AsyncGenerator<StreamEvent> {
  const { employee, prompt, taskId } = input;
  const abort = input.signal ?? new AbortController();

  const resolved = resolveEndpoint(input.modelOverride ?? employee.model);
  if ("error" in resolved) {
    yield { kind: "error", error: resolved.error };
    return;
  }
  const { ep } = resolved;

  const hasWorkspace = !!input.workspace;
  const memory = input.bareForUtility ? "" : buildEmployeeMemory(employee, taskId);
  const finalPrompt = memory ? `${memory}=== NHIỆM VỤ HIỆN TẠI ===\n${prompt}` : prompt;

  const systemPrompt =
    buildStaticSystemPrompt(employee, { hasWorkspace, hasBash: false, bareForUtility: input.bareForUtility }) +
    (hasWorkspace && input.workspace ? buildDynamicSystemPrompt(input.workspace) : "");

  const toolDefs = hasWorkspace && input.workspace
    ? officeToolDefs(input.workspace.dir, taskId ?? null, { skills: employee.skills ?? [] })
    : [];
  const toolMap = new Map(toolDefs.map(d => [d.name, d]));
  const tools = toolDefs.length > 0 ? toOpenAITools(toolDefs) : undefined;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: finalPrompt },
  ];

  let fullText = "";

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (abort.signal.aborted) break;

      const res = await fetch(ep.url, {
        method: "POST",
        headers: ep.headers,
        body: JSON.stringify({
          model: ep.modelName,
          messages,
          ...(tools ? { tools, tool_choice: "auto" } : {}),
          stream: true,
        }),
        signal: abort.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        yield {
          kind: "error",
          error: `${ep.label}: HTTP ${res.status}. ${errText.slice(0, 400)}`,
        };
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let roundText = "";
      const calls: AssemblingCall[] = [];

      readLoop:
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let chunk: {
            choices?: Array<{
              delta?: {
                content?: string | null;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
            error?: { message?: string };
          };
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          if (chunk.error?.message) {
            yield { kind: "error", error: `${ep.label}: ${chunk.error.message}` };
            return;
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          if (typeof delta.content === "string" && delta.content) {
            roundText += delta.content;
            fullText += delta.content;
            yield { kind: "delta", text: delta.content };
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!calls[idx]) calls[idx] = { id: "", name: "", args: "" };
              if (tc.id) calls[idx].id = tc.id;
              if (tc.function?.name) calls[idx].name += tc.function.name;
              if (tc.function?.arguments) calls[idx].args += tc.function.arguments;
            }
          }
          if (choice.finish_reason) break readLoop;
        }
      }

      const wanted = calls.filter(c => c && c.name);
      if (wanted.length === 0) {
        // Plain text answer — the employee is done.
        break;
      }

      // Some providers (e.g. Gemini's compat layer) omit tool-call ids; assign
      // a stable fallback ONCE so the assistant/tool message ids line up.
      for (const c of wanted) {
        if (!c.id) c.id = `call_${Math.random().toString(36).slice(2, 12)}`;
      }

      messages.push({
        role: "assistant",
        content: roundText || null,
        tool_calls: wanted.map(c => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.args || "{}" },
        })),
      });

      for (const call of wanted) {
        if (abort.signal.aborted) break;
        let args: Record<string, unknown> = {};
        try {
          args = call.args ? JSON.parse(call.args) : {};
        } catch {
          /* malformed JSON args — handler validation below will report it */
        }
        yield { kind: "tool_use", toolName: call.name, input: args, id: call.id };

        const def = toolMap.get(call.name);
        let result: string;
        if (!def) {
          result = `Tool "${call.name}" không tồn tại. Chỉ dùng các tool office được liệt kê trong system prompt.`;
        } else {
          const parsed = z.object(def.shape).safeParse(args);
          if (!parsed.success) {
            result = `Tham số không hợp lệ cho ${call.name}: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
          } else {
            try {
              result = await def.handler(parsed.data as Record<string, unknown>);
            } catch (e) {
              result = `Lỗi chạy tool ${call.name}: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      // Loop: feed the tool results back so the employee can react / finish.
    }

    yield { kind: "done", fullText, sessionId: null };
  } catch (err) {
    if (abort.signal.aborted) {
      // Aborted mid-stream — surface whatever text we already have.
      yield { kind: "done", fullText, sessionId: null };
    } else {
      yield { kind: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }
}
