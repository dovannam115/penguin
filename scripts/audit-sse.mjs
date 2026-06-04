// Parse an SSE dump from /api/chat and summarize: taskId, agent text length,
// tool calls, files produced, hallucination markers.
//
// Run: node scripts/audit-sse.mjs <sse-file-path>

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ssePath = process.argv[2];
if (!ssePath || !existsSync(ssePath)) {
  console.error("Usage: node scripts/audit-sse.mjs <sse-file>");
  process.exit(1);
}

const raw = readFileSync(ssePath, "utf8");
const events = [];
for (const block of raw.split(/\r?\n\r?\n/)) {
  const lines = block.split(/\r?\n/);
  let event = null, data = null;
  for (const l of lines) {
    if (l.startsWith("event: ")) event = l.slice(7).trim();
    else if (l.startsWith("data: ")) data = l.slice(6);
  }
  if (event && data) {
    try { events.push({ event, data: JSON.parse(data) }); }
    catch { events.push({ event, data }); }
  }
}

const taskCreated = events.find(e => e.event === "task_created");
const taskId = taskCreated?.data?.taskId;
const taskTitled = events.find(e => e.event === "task_titled");
const turnDone = events.filter(e => e.event === "turn_done");
const toolUses = events.filter(e => e.event === "tool_use");
const filesChanged = events.filter(e => e.event === "files_changed");
const errors = events.filter(e => e.event === "error" || e.event === "turn_error");
const ended = events.find(e => e.event === "end");

console.log("=== SSE AUDIT ===");
console.log("Events:", events.length);
console.log("Task ID:", taskId);
console.log("Task title:", taskTitled?.data?.title ?? "(default = first 80 of msg)");
console.log("Errors:", errors.length);
console.log("Ended:", !!ended);
console.log();

console.log("Tool calls:");
for (const t of toolUses) {
  const inp = typeof t.data.input === "object" ? JSON.stringify(t.data.input).slice(0, 200) : t.data.input;
  console.log(`  - ${t.data.toolName}  input=${inp}`);
}
console.log();

console.log("Files changed events:", filesChanged.length);
if (filesChanged.length > 0) {
  const last = filesChanged[filesChanged.length - 1].data.files ?? [];
  for (const f of last) console.log(`  - ${f.name} (${f.size ?? "?"} bytes)`);
}
console.log();

const HALLUCINATION_RE = /(l[ỗo]i font|không truy c[ậa]p|copy.+paste.+vào file|anh t[ựu] m[ởo])/i;
for (const t of turnDone) {
  const text = t.data.fullText ?? "";
  console.log(`Agent ${t.data.employeeId} turn: textLen=${text.length}`);
  console.log("--- text (first 1500 chars) ---");
  console.log(text.slice(0, 1500));
  console.log("--- end excerpt ---");
  const m = text.match(HALLUCINATION_RE);
  if (m) console.log("HALLUCINATION marker:", m[0]);
}
console.log();

if (taskId) {
  const wsDir = path.join("C:", "Users", "dovan", "Downloads", "mas-ai-office-20260515-1712", ".data", "uploads", taskId);
  if (existsSync(wsDir)) {
    console.log("Workspace files in", wsDir);
    function walk(dir, prefix = "") {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, rel);
        else {
          const st = statSync(full);
          console.log(`  ${rel}  ${st.size} bytes`);
        }
      }
    }
    walk(wsDir);
  } else {
    console.log("No workspace dir for", taskId);
  }
}
