// Vision e2e test. Generates a 100x100 PNG with 4 colored quadrants
// (TL red, TR green, BL blue, BR yellow), uploads to a fresh task workspace,
// then asks the agent to describe it. The agent should NOT call Read on the
// image — it should describe the colors directly from the vision input.
//
// Run: npx tsx scripts/test-vision.mjs  (needs dev server: not strictly, uses
// runEmployee directly. Creates a real Task + Message in DB so it shows up
// in the app.)

import { runEmployee } from "../lib/claude.ts";
import { employees, tasks, messages } from "../lib/db.ts";
import { ensureSeed } from "../lib/seed.ts";
import { ensureWorkspace } from "../lib/upload.ts";
import { PNG } from "pngjs";
import { createWriteStream, statSync } from "node:fs";
import path from "node:path";

ensureSeed();
const roster = employees.list();
const byName = (n) => roster.find((e) => e.name === n);

function makeQuadrantPng(filePath) {
  return new Promise((resolve, reject) => {
    const png = new PNG({ width: 100, height: 100 });
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        const idx = (y * 100 + x) * 4;
        const left = x < 50;
        const top = y < 50;
        if (left && top)       { png.data[idx] = 220; png.data[idx + 1] =  30; png.data[idx + 2] =  30; }  // TL red
        else if (!left && top) { png.data[idx] =  30; png.data[idx + 1] = 180; png.data[idx + 2] =  60; }  // TR green
        else if (left && !top) { png.data[idx] =  40; png.data[idx + 1] =  90; png.data[idx + 2] = 220; }  // BL blue
        else                   { png.data[idx] = 240; png.data[idx + 1] = 200; png.data[idx + 2] =  40; }  // BR yellow
        png.data[idx + 3] = 255;
      }
    }
    png.pack().pipe(createWriteStream(filePath))
      .on("finish", resolve)
      .on("error", reject);
  });
}

async function runVisionTest(employeeName, prompt, opts = {}) {
  const emp = byName(employeeName);
  if (!emp) throw new Error(`No ${employeeName}`);

  // Real task + workspace (visible in the app under tasks list)
  const taskId = `vision_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const dir = ensureWorkspace(taskId);
  tasks.create({
    id: taskId,
    title: opts.title ?? `Vision test: ${employeeName}`,
    description: prompt,
    status: "in_progress",
    mode: "direct",
    assignedTo: emp.id,
  });

  const pngPath = path.join(dir, "quadrants.png");
  await makeQuadrantPng(pngPath);
  const pngSize = statSync(pngPath).size;
  console.log(`  prepared PNG: ${pngPath} (${pngSize} bytes)`);

  // Save user msg
  messages.create({
    id: `msg_user_${Date.now()}`,
    taskId,
    fromId: null,
    toId: emp.id,
    role: "user",
    content: prompt,
    mentions: [],
    images: ["quadrants.png"],
    files: [],
  });

  const t0 = Date.now();
  const toolCalls = [];
  let fullText = "";
  for await (const ev of runEmployee({
    employee: emp,
    prompt,
    taskId,
    workspace: { dir, hasFiles: true },
    attachedImages: [{ path: pngPath, mediaType: "image/png" }],
  })) {
    if (ev.kind === "delta") fullText += ev.text;
    else if (ev.kind === "tool_use") toolCalls.push(ev.toolName);
    else if (ev.kind === "done") fullText = ev.fullText || fullText;
    else if (ev.kind === "error") throw new Error(`SDK error: ${ev.error}`);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // Save agent msg
  messages.create({
    id: `msg_assistant_${Date.now()}`,
    taskId,
    fromId: emp.id,
    toId: null,
    role: "assistant",
    content: fullText,
    mentions: [],
    images: [],
    files: [],
  });
  tasks.setStatus(taskId, "done");

  return { taskId, fullText, toolCalls, elapsed };
}

// ============== Vision tests ==============
console.log("\n=== Vision E2E ===\n");
const results = [];

console.log("[T1] Aria describes quadrant PNG (4 colors)");
const r1 = await runVisionTest("Aria",
  "Trong ảnh này có gì? Mô tả các vùng màu sắc.",
  { title: "Vision: Aria 4-color quadrants" },
);
console.log(`  ${r1.elapsed}s · tools=${r1.toolCalls.length} · text=${r1.fullText.length}c`);
console.log(`  reply: "${r1.fullText.slice(0, 250).replace(/\n/g, " ")}"`);

// Heuristic check: did the model mention at least 3 of 4 colors?
const text = r1.fullText.toLowerCase();
const colorHits = [
  /đỏ|red/i.test(text),
  /xanh.{0,15}(lá|green|cây)/i.test(text) || /green/i.test(text),
  /xanh.{0,15}(dương|blue|biển)/i.test(text) || /blue/i.test(text),
  /vàng|yellow/i.test(text),
].filter(Boolean).length;

const visionWorked = colorHits >= 3;
const readToolCalled = r1.toolCalls.some(t => t === "Read" || t.includes("read"));
results.push({
  name: "T1: Aria describes 4-color quadrant PNG via vision",
  ok: visionWorked && !readToolCalled,
  colorHits,
  readToolCalled,
});

console.log(`  ✓ colorHits=${colorHits}/4`);
console.log(`  ${readToolCalled ? "✗" : "✓"} Read tool ${readToolCalled ? "WAS" : "was NOT"} called (good = NOT called)`);

console.log("\n[T2] Atlas asked a simple data question with attached PNG (control test)");
const r2 = await runVisionTest("Atlas",
  "Ảnh này có vùng màu nào ở góc trên bên trái?",
  { title: "Vision: Atlas precise quadrant question" },
);
console.log(`  ${r2.elapsed}s · tools=${r2.toolCalls.length} · text=${r2.fullText.length}c`);
console.log(`  reply: "${r2.fullText.slice(0, 250).replace(/\n/g, " ")}"`);
const t2text = r2.fullText.toLowerCase();
const t2ok = /đỏ|red/.test(t2text);
results.push({
  name: "T2: Atlas identifies top-left red quadrant",
  ok: t2ok,
});
console.log(`  ${t2ok ? "✓" : "✗"} mentions red/đỏ (top-left)`);

// ============== Summary ==============
const passed = results.filter(r => r.ok).length;
console.log(`\n=== RESULT: ${passed}/${results.length} passed ===`);
console.log(`\nTask IDs created (visible in app):`);
console.log(`  - ${r1.taskId}: "Vision: Aria 4-color quadrants"`);
console.log(`  - ${r2.taskId}: "Vision: Atlas precise quadrant question"`);
if (passed < results.length) process.exit(1);
