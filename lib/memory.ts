import { messages, employees, getUserProfile } from "./db";
import type { Employee } from "./types";

const MAX_CONTENT_PER_MSG = 600;
const DEFAULT_LIMIT = 30;

/**
 * Build a personal-memory transcript for one employee, scoped to a single
 * task. Cross-task context is intentionally excluded so a brand-new task
 * doesn't pull in unrelated history from prior tasks. If the user wants to
 * reference an old task, they can open it via the HISTORY tab (which sets
 * activeTaskId → its messages get loaded as memory).
 */
export function buildEmployeeMemory(
  employee: Employee,
  taskId: string | null | undefined,
  limit = DEFAULT_LIMIT,
): string {
  if (!taskId) return ""; // No task context = no memory; agent starts fresh.

  const all = messages.listByTask(taskId);
  const relevant = all.filter(m =>
    m.fromId === employee.id ||
    m.toId === employee.id ||
    (m.mentions ?? []).includes(employee.id) ||
    m.fromId === null // user messages in this task are always relevant
  );

  const sliced = relevant.slice(-limit);
  if (sliced.length === 0) return "";

  const roster = new Map<string, Employee>();
  for (const e of employees.list()) roster.set(e.id, e);

  const profile = getUserProfile();
  const userLabel = profile.name && profile.name !== profile.address
    ? `${profile.address} (${profile.name})`
    : profile.address;

  const lines: string[] = [];
  for (const m of sliced) {
    const ts = new Date(m.createdAt).toISOString().slice(0, 16).replace("T", " ");
    let speaker: string;
    if (m.fromId === null) speaker = userLabel;
    else if (m.fromId === employee.id) speaker = "Bạn";
    else {
      const from = roster.get(m.fromId);
      speaker = from ? `${from.name} (${from.role})` : "Đồng nghiệp cũ";
    }

    let suffix = "";
    if (m.toId === employee.id) suffix = " (gửi bạn)";
    else if (m.toId && m.toId !== employee.id) {
      const to = roster.get(m.toId);
      suffix = to ? ` (gửi ${to.name})` : "";
    } else if ((m.mentions ?? []).includes(employee.id) && m.fromId !== employee.id) {
      suffix = " (mention bạn)";
    }

    const content = m.content.length > MAX_CONTENT_PER_MSG
      ? m.content.slice(0, MAX_CONTENT_PER_MSG) + "…"
      : m.content;
    lines.push(`[${ts}] ${speaker}${suffix}: ${content}`);
  }

  // Roster snapshot, so the agent always uses CURRENT names (not whatever
  // name appeared in old message content before a rename).
  const rosterLines = Array.from(roster.values())
    .map(e => `- ${e.name} (${e.role})${e.id === employee.id ? " ← BẠN" : ""}`);

  return [
    "=== DANH SÁCH ĐỒNG NGHIỆP HIỆN TẠI ===",
    "Đây là tên hiện tại của mọi người. Nếu thấy tên khác trong trí nhớ bên dưới, người đó đã đổi tên, LUÔN dùng tên hiện tại khi @mention hoặc nhắc đến.",
    ...rosterLines,
    "",
    "=== TRÍ NHỚ CỦA BẠN ===",
    "Đây là những việc bạn đã làm và đã trao đổi trước đó. Chỉ dùng để giữ ngữ cảnh, KHÔNG cần trả lời lại các tin nhắn cũ.",
    "",
    ...lines,
    "=== HẾT TRÍ NHỚ ===",
    "",
  ].join("\n");
}
