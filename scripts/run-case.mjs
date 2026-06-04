// Reusable test driver: auth → POST /api/chat → consume SSE → dump events + workspace.
// Run: node scripts/run-case.mjs <password> <employeeId> <case-name> < prompt.txt
// Prompt text is read from stdin to avoid Windows quoting hell.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const [, , pass, employeeId, caseName] = process.argv;
if (!pass || !employeeId || !caseName) {
  console.error("Usage: node scripts/run-case.mjs <password> <employeeId> <case-name>  (prompt via stdin)");
  process.exit(1);
}
const prompt = readFileSync(0, "utf8").trim();
if (!prompt) {
  console.error("Empty prompt on stdin");
  process.exit(1);
}

const base = process.env.BASE_URL || "http://localhost:3000";

const authRes = await fetch(`${base}/api/auth`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: pass }),
});
if (!authRes.ok) { console.error("auth failed:", authRes.status); process.exit(1); }
const tokMatch = (authRes.headers.get("set-cookie") || "").match(/mas-token=([^;]+)/);
const cookie = `mas-token=${tokMatch[1]}`;

console.log(`[${caseName}] auth OK, posting to /api/chat …`);
const chatRes = await fetch(`${base}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: JSON.stringify({ message: prompt, employeeIds: [employeeId] }),
});
if (!chatRes.ok) {
  console.error("chat failed:", chatRes.status, await chatRes.text());
  process.exit(1);
}

const decoder = new TextDecoder("utf-8");
let buf = "";
const events = [];
let taskId = null;
const reader = chatRes.body.getReader();
const t0 = Date.now();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf("\n\n")) >= 0) {
    const block = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    let event = null, data = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (!event) continue;
    let parsed;
    try { parsed = JSON.parse(data); } catch { parsed = data; }
    events.push({ event, data: parsed });
    if (event === "task_created" && parsed?.taskId) {
      taskId = parsed.taskId;
      console.log(`  task_created taskId=${taskId}`);
    }
    if (event === "tool_use" && parsed?.toolName) {
      console.log(`  tool_use: ${parsed.toolName}`);
    }
    if (event === "files_changed") {
      console.log(`  files_changed: ${parsed?.files?.map(f => f.name).join(", ") || "(empty)"}`);
    }
    if (event === "turn_done") {
      console.log(`  turn_done: textLen=${parsed?.fullText?.length || 0}`);
    }
    if (event === "error" || event === "turn_error") {
      console.log(`  ERROR: ${parsed?.error}`);
    }
    if (event === "end") {
      console.log(`  end. elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  }
}

const outBase = path.join(process.env.TEMP || "C:\\Users\\dovan\\AppData\\Local\\Temp", `case-${caseName}`);
writeFileSync(`${outBase}-events.json`, JSON.stringify(events, null, 2), "utf8");
writeFileSync(`${outBase}-prompt.txt`, prompt, "utf8");

const turnTexts = events.filter(e => e.event === "turn_done").map(e => e.data?.fullText || "");
writeFileSync(`${outBase}-agent.txt`, turnTexts.join("\n\n---\n\n"), "utf8");

console.log(`\n[${caseName}] DONE`);
console.log(`  taskId: ${taskId}`);
console.log(`  events: ${events.length}`);
console.log(`  tool calls: ${events.filter(e => e.event === "tool_use").length}`);
console.log(`  errors: ${events.filter(e => e.event === "error" || e.event === "turn_error").length}`);
console.log(`  agent text saved: ${outBase}-agent.txt`);
console.log(`  events saved: ${outBase}-events.json`);

if (taskId) {
  const wsDir = path.join(process.cwd(), ".data", "uploads", taskId);
  if (existsSync(wsDir)) {
    console.log(`\n  workspace ${wsDir}:`);
    function walk(d, prefix = "") {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full, rel);
        else {
          const st = statSync(full);
          console.log(`    ${rel}  ${st.size} bytes`);
        }
      }
    }
    walk(wsDir);
  }
}
