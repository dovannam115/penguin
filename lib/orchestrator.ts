// Lightweight planner for multi-agent rooms. Runs once per new chat when the
// user selects 2+ agents: cheap Haiku call decomposes the task into one
// subtask per picked agent (mandatory — user's selection is the source of
// truth), then the chat route runs them sequentially so each agent sees
// prior outputs.
//
// Uses Claude Agent SDK (CLI auth) so it works under Claude Max / Claude
// Code login without a separate ANTHROPIC_API_KEY. If anything goes wrong
// at runtime (no Claude, model error, malformed JSON), falls back to a
// flat plan that just dispatches the original prompt to every picked agent
// in selection order, degraded but never breaks the chat flow.

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Employee } from "./types";
import { getUserProfile } from "./db";
import { reuseSession, createWarmSession, preWarmSession } from "./session-pool";

export interface AssignmentPlan {
  summary: string;
  assignments: Array<{ employeeId: string; subtask: string }>;
}

const PLANNER_MODEL = "claude-haiku-4-5";

// Shared warm subprocess for ALL plan calls — planner is stateless one-shot and
// runs at most once per new multi-agent task, so per-task pooling would never
// reuse. Cross-task reuse pays the ~3-5s SDK subprocess boot cost exactly once
// per ~10min idle window (see IDLE_MS in session-pool). Prior plans accumulate
// as session history; the planner prompt is fully self-contained (new agent
// list + new task each turn) so contamination is negligible in practice.
const PLANNER_POOL_KEY = `util:planner:${PLANNER_MODEL}`;
const PLANNER_OPTIONS_SIG = `planner|${PLANNER_MODEL}`;

const PLANNER_SDK_OPTIONS: Options = {
  model: PLANNER_MODEL,
  systemPrompt: "Bạn là planner. Trả lời đúng format text đã chỉ định. Không thêm prose, không markdown fence.",
  // Pure completion, no tools, no MCP, no settings dir scan.
  allowedTools: [],
  mcpServers: {} as Record<string, never>,
  settingSources: [],
  maxTurns: 1,
  includePartialMessages: true,
};

/** Spawn the planner subprocess idle, ready for the first plan call. Safe to
 *  call multiple times — no-op if already warming. */
export function prewarmPlanner(): void {
  preWarmSession(PLANNER_POOL_KEY, PLANNER_OPTIONS_SIG, PLANNER_SDK_OPTIONS);
}

function buildPlannerPrompt(userTask: string, picked: Employee[]): string {
  const lines = picked
    .map(e => `- @${e.name} (role: ${e.role}, id: ${e.id})`)
    .join("\n");
  const n = picked.length;
  const { address } = getUserProfile();
  return `User task (user xưng "${address}"):
${userTask}

Agents user đã chọn cho room này (PHẢI dùng hết TẤT CẢ ${n} người, không bỏ ai, không tự thêm ai khác):
${lines}

Trả lời ĐÚNG format dưới đây, không thêm prose, không markdown fence, không giải thích:

Tóm tắt: <1 câu ≤ 12 từ tóm tắt cách chia việc>

Phân công:
- @<TênChínhXác>: <chỉ thị 1-2 câu, tiếng Việt, hành động cụ thể>
- @<TênChínhXác>: <chỉ thị 1-2 câu, tiếng Việt, hành động cụ thể>
(... tổng cộng ĐÚNG ${n} dòng, mỗi agent 1 dòng)

Rules:
- assignments tuần tự: dòng 1 chạy trước, dòng sau thấy output dòng trước và làm tiếp.
- PHẢI có đúng ${n} dòng (= số agent user chọn), không thiếu không thừa. Mỗi agent xuất hiện đúng 1 lần.
- Sắp xếp thứ tự dòng theo logic phụ thuộc: ai làm nền tảng trước, ai tổng hợp/review sau.
- Nếu một agent role không khớp task, vẫn giao việc phụ phù hợp với role họ (vd: review, bổ sung góc nhìn, format output) - KHÔNG được bỏ qua.
- Tên phải copy CHÍNH XÁC từ danh sách trên (giữ nguyên hoa/thường, dấu).
- Subtask không bullet, không liệt kê, 1-2 câu mô tả việc cần làm.
- DESIGN FILE RULE: nếu task có output là design/visual file (HTML landing, dashboard, mockup, infographic, slide visual), chỉ Aria được giao "tạo file". Các agent khác giao việc cung cấp data/spec/insights, KHÔNG giao "tạo file"/"thiết kế wireframe"/"build mockup". Nếu Aria không có trong picked list, vẫn KHÔNG giao file design cho ai khác - giao spec/data, để user tự handoff.
- DATA COVERAGE RULE: nếu user prompt có keyword data/research, BẮT BUỘC giao thu thập data CỤ THỂ cho agent đúng role TRƯỚC Aria (Aria chỉ render). Mapping:
  * "so sánh" / "compare" / "competitor" / "benchmark" / "vs" → research/data agent thu thập scoring matrix N công ty x M tiêu chí (vd "Scout pull 5-7 competitor + scoring 1-5 trên 6 trục: phí, UX, network, claim speed, brand, embedded")
  * "nghiên cứu" / "phân tích thị trường" / "market analysis" → research agent ship market size + CAGR + segment breakdown CỤ THỂ
  * "pricing" / "giá" → data agent pull price range theo company/tier
  * "channel" / "kênh phân phối" → research agent pull channel mix %
  * "segment" / "phân khúc" → data agent pull segment volume + characteristics
  Subtask cho agent phải nêu RÕ format output (vd "bảng scoring 5x6", "donut chart channel mix %"). Đừng giao mơ hồ kiểu "nghiên cứu thị trường" - phải spec cụ thể để Aria có data render.`;
}

function fallbackPlan(userTask: string, picked: Employee[]): AssignmentPlan {
  return {
    summary: "Chạy tuần tự, planner không phản hồi, dispatch nguyên task cho từng agent",
    assignments: picked.map(e => ({ employeeId: e.id, subtask: userTask })),
  };
}

function parsePlannerOutput(text: string, picked: Employee[]): AssignmentPlan | null {
  const byName = new Map(picked.map(e => [e.name.toLowerCase(), e.id]));
  const byId = new Map(picked.map(e => [e.id.toLowerCase(), e.id]));
  let summary = "";
  const assignments: Array<{ employeeId: string; subtask: string }> = [];
  const seen = new Set<string>();

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const sumMatch = line.match(/^(?:\*\*)?(?:Tóm tắt|Summary)(?:\*\*)?\s*[:：]\s*(.+)$/i);
    if (sumMatch && !summary) {
      summary = sumMatch[1].replace(/\*\*/g, "").trim();
      continue;
    }

    // Accept "@Name: subtask" (preferred) or bare "id: subtask" as fallback.
    const assignMatch = line.match(/^[-*•]\s*@?([^:：]+?)[:：]\s*(.+)$/);
    if (assignMatch) {
      const ref = assignMatch[1].trim().replace(/^@/, "").toLowerCase();
      const subtask = assignMatch[2].trim();
      const id = byName.get(ref) ?? byId.get(ref);
      if (id && !seen.has(id)) {
        seen.add(id);
        assignments.push({ employeeId: id, subtask });
      }
    }
  }

  if (!summary || assignments.length === 0) return null;
  return { summary, assignments };
}

export async function planAssignments(
  userTask: string,
  picked: Employee[],
  onChunk?: (text: string) => void,
): Promise<AssignmentPlan> {
  if (picked.length === 0) {
    return { summary: "Không có agent được chọn", assignments: [] };
  }
  if (picked.length === 1) {
    return {
      summary: "Single agent",
      assignments: [{ employeeId: picked[0].id, subtask: userTask }],
    };
  }

  const prompt = buildPlannerPrompt(userTask, picked);
  const t0 = Date.now();
  let text = "";
  let reused = false;
  try {
    // Warm reuse first; cold-spawn (~3-5s subprocess boot) only on first call
    // per ~10min idle window.
    const warm = reuseSession(PLANNER_POOL_KEY, PLANNER_OPTIONS_SIG, prompt);
    const handle = warm ?? createWarmSession(
      PLANNER_POOL_KEY,
      PLANNER_OPTIONS_SIG,
      PLANNER_SDK_OPTIONS,
      prompt,
    );
    reused = handle.reused;
    type StreamMsg = {
      type: string;
      event?: { type?: string; delta?: { type?: string; text?: string } };
      message?: { content: Array<{ type: string; text?: string }> };
    };
    for await (const _msg of handle.events as AsyncIterable<unknown>) {
      const message = _msg as StreamMsg;
      if (message.type === "stream_event") {
        const ev = message.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          text += ev.delta.text;
          onChunk?.(ev.delta.text);
        }
      } else if (message.type === "assistant" && message.message) {
        // Fallback: if includePartialMessages didn't fire deltas for some
        // reason, recover the final text from the assembled assistant block
        // (only emit what we haven't seen).
        for (const block of message.message.content) {
          if (block.type === "text" && block.text && !text.includes(block.text)) {
            const chunk = block.text;
            text += chunk;
            onChunk?.(chunk);
          }
        }
      }
    }
  } catch {
    return fallbackPlan(userTask, picked);
  }
  console.log(`[planner] warm=${reused ? "Y" : "N"} ms=${Date.now() - t0} agents=${picked.length} out=${text.length}c`);

  const parsed = parsePlannerOutput(text, picked);
  if (!parsed) return fallbackPlan(userTask, picked);

  // Safety net: planner sometimes drops agents despite the rules. Append any
  // missing picked agent at the end with the original task, so the user's
  // selection is always honored.
  const assignedIds = new Set(parsed.assignments.map(a => a.employeeId));
  for (const e of picked) {
    if (!assignedIds.has(e.id)) {
      parsed.assignments.push({ employeeId: e.id, subtask: userTask });
    }
  }
  return parsed;
}
