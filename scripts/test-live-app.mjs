// Live app test against the running dev server at localhost:3000.
// Measures latency of every key endpoint + a real chat run via SSE.
// Reports bottlenecks.
//
// Run: npx tsx scripts/test-live-app.mjs
// Prereq: `npm run dev` already running.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3000";
const PASSWORD = (readFileSync("password-backup.txt", "utf8").match(/Mat khau:\s*([^\r\n]+)/)?.[1] || "").trim();

console.log(`Password: ${PASSWORD ? `"${PASSWORD}"` : "MISSING"}`);
if (!PASSWORD) {
  console.error("password-backup.txt missing or unreadable — cannot login");
  process.exit(2);
}

let cookie = "";

async function timed(label, fn) {
  const t0 = Date.now();
  let result;
  let err;
  try {
    result = await fn();
  } catch (e) {
    err = e;
  }
  const ms = Date.now() - t0;
  const status = err ? `✗ ${(err.message || err).slice(0, 60)}` : "✓";
  console.log(`  [${ms.toString().padStart(5)}ms] ${status}  ${label}`);
  return { ms, result, err };
}

async function login() {
  const r = await fetch(`${BASE}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`auth failed: ${r.status}`);
  const setCookie = r.headers.get("set-cookie");
  const m = setCookie?.match(/mas-token=([^;]+)/);
  if (!m) throw new Error("no token in set-cookie");
  cookie = `mas-token=${m[1]}`;
  return cookie;
}

// =========== Phase A — auth + simple endpoints ===========
console.log("\n=== Phase A: Endpoint latency (cold cache) ===");
await timed("POST /api/auth (login)", login);
await timed("GET /api/employees", async () => {
  const r = await fetch(`${BASE}/api/employees`, { headers: { cookie } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return data;
});
await timed("GET /api/tasks", async () => {
  const r = await fetch(`${BASE}/api/tasks`, { headers: { cookie } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return data;
});
await timed("GET /api/skills", async () => {
  const r = await fetch(`${BASE}/api/skills`, { headers: { cookie } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
});
await timed("GET /api/bootstrap", async () => {
  const r = await fetch(`${BASE}/api/bootstrap`, { headers: { cookie } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
});

// Warm cache, re-fetch
console.log("\n=== Phase A2: Same endpoints (warm cache) ===");
for (let i = 0; i < 3; i++) {
  const e = await timed(`GET /api/employees (run ${i + 1})`, async () => {
    const r = await fetch(`${BASE}/api/employees`, { headers: { cookie } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  });
  if (e.err) break;
}

// =========== Phase B — real chat via SSE ===========
console.log("\n=== Phase B: Chat SSE (single agent, simple prompt) ===");

async function chatSSE(employeeId, message, label) {
  const t0 = Date.now();
  let firstByte = 0;
  let firstDelta = 0;
  let firstTool = 0;
  let firstTurnDone = 0;
  let endAt = 0;
  let totalBytes = 0;
  let textLen = 0;
  let toolCount = 0;

  const r = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ employeeId, message }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByte === 0) firstByte = Date.now() - t0;
    totalBytes += value.length;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const eventLine = block.split("\n").find(l => l.startsWith("event: "));
      const dataLine = block.split("\n").find(l => l.startsWith("data: "));
      if (!eventLine) continue;
      const event = eventLine.slice(7);
      const data = dataLine ? JSON.parse(dataLine.slice(6)) : {};
      if (event === "delta") {
        if (firstDelta === 0) firstDelta = Date.now() - t0;
        textLen += (data.text || "").length;
      } else if (event === "tool_use") {
        if (firstTool === 0) firstTool = Date.now() - t0;
        toolCount++;
      } else if (event === "turn_done") {
        if (firstTurnDone === 0) firstTurnDone = Date.now() - t0;
      } else if (event === "end" || event === "stopped") {
        endAt = Date.now() - t0;
      }
    }
  }

  console.log(`  ${label}`);
  console.log(`    first byte: ${firstByte}ms`);
  console.log(`    first delta: ${firstDelta}ms`);
  console.log(`    first tool:  ${firstTool > 0 ? firstTool + "ms" : "(no tool)"}`);
  console.log(`    turn_done:   ${firstTurnDone}ms`);
  console.log(`    end:         ${endAt}ms`);
  console.log(`    bytes=${totalBytes}, textChars=${textLen}, tools=${toolCount}`);
  return { firstByte, firstDelta, firstTool, firstTurnDone, endAt, textLen, toolCount };
}

const empRes = await fetch(`${BASE}/api/employees`, { headers: { cookie } });
const employees = await empRes.json();
const atlas = employees.find(e => e.name === "Atlas");
const iris = employees.find(e => e.name === "Iris");
const scout = employees.find(e => e.name === "Scout");

if (!atlas) console.error("no Atlas employee found — abort");
else {
  await timed("chat: simple inline question", () =>
    chatSSE(atlas.id, "1 + 1 = ?", "Atlas, super short")
  );
}

// =========== Phase C — concurrent chats ===========
console.log("\n=== Phase C: Concurrent chats (2 in parallel) ===");
if (atlas && scout) {
  const t0 = Date.now();
  const [a, b] = await Promise.all([
    chatSSE(atlas.id, "Liệt kê 3 chỉ số doanh thu chính cho banca, mỗi cái 1 dòng.", "Atlas (concurrent)"),
    chatSSE(scout.id, "Cho 3 nhóm khách hàng mục tiêu của bảo hiểm xe ô tô VN, mỗi nhóm 1 dòng.", "Scout (concurrent)"),
  ]);
  const total = Date.now() - t0;
  console.log(`\n  Total parallel: ${total}ms (vs serial would be ${a.endAt + b.endAt}ms)`);
  console.log(`  Speedup: ${((a.endAt + b.endAt) / total).toFixed(2)}x`);
}

// =========== Phase D — file download endpoint (sample existing file) ===========
console.log("\n=== Phase D: File download endpoint ===");
const tasksRes = await fetch(`${BASE}/api/tasks`, { headers: { cookie } });
const tasksData = await tasksRes.json();
const sampleTask = (Array.isArray(tasksData) ? tasksData : (tasksData.tasks || [])).find(t => t.id);
if (sampleTask) {
  // Try to list files
  const filesRes = await fetch(`${BASE}/api/tasks/${sampleTask.id}/files`, { headers: { cookie } });
  if (filesRes.ok) {
    const files = await filesRes.json();
    const list = Array.isArray(files) ? files : (files.files || []);
    if (list.length > 0) {
      const f = list[0];
      await timed(`GET file (${f.name}, ${f.size} bytes)`, async () => {
        const r = await fetch(`${BASE}/api/files/${sampleTask.id}/${encodeURIComponent(f.name)}`, { headers: { cookie } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = await r.arrayBuffer();
        return buf.byteLength;
      });
    } else {
      console.log("  (no files in sample task)");
    }
  }
} else {
  console.log("  (no existing task to test file download)");
}

console.log("\n=== DONE ===");
