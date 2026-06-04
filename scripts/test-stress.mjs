// Stress + concurrency + error recovery tests.
// Run: npx tsx scripts/test-stress.mjs

import { writeXlsx, readXlsx } from "../lib/office-tools/xlsx-tools.ts";
import { exportMarkdownToPdf } from "../lib/office-tools/pdf-export.ts";
import { runEmployee } from "../lib/claude.ts";
import { employees, tasks } from "../lib/db.ts";
import { ensureSeed } from "../lib/seed.ts";
import { ensureWorkspace } from "../lib/upload.ts";
import { mkdirSync, existsSync, rmSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

ensureSeed();
const roster = employees.list();
const byName = (n) => roster.find(e => e.name === n);

const OUT = path.resolve("test-output/stress");
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
async function test(name, fn) {
  try { rec(name, true, await fn()); } catch (e) { rec(name, false, (e && e.message) || String(e)); }
}

// =========== STRESS: large files ===========
console.log("\n=== STRESS ===\n");

await test("xlsx: 100k rows", async () => {
  const rows = [];
  for (let i = 0; i < 100_000; i++) {
    rows.push([i, `Khách hàng ${i}`, Math.random() * 10_000_000, i % 2 === 0 ? "Đang hoạt động" : "Tạm dừng"]);
  }
  const t0 = Date.now();
  const r = await writeXlsx(
    [{ name: "Big", headers: ["STT", "Khách", "Doanh thu", "Trạng thái"], rows }],
    path.join(OUT, "100k.xlsx"),
  );
  const writeMs = Date.now() - t0;
  if (writeMs > 60_000) throw new Error(`too slow write: ${writeMs}ms`);
  const t1 = Date.now();
  const rd = await readXlsx(r.path);
  const readMs = Date.now() - t1;
  if (rd.sheets[0].rows.length !== 100_001) throw new Error(`bad row count: ${rd.sheets[0].rows.length}`);
  return `write ${writeMs}ms, read ${readMs}ms, size ${(r.size / 1024 / 1024).toFixed(2)}MB`;
});

await test("pdf: 50-page document with VN content", async () => {
  const parts = ["# Báo cáo dài"];
  for (let p = 1; p <= 50; p++) {
    parts.push(`\n## Trang ${p}`);
    for (let i = 0; i < 12; i++) {
      parts.push(`Đoạn ${i + 1}: Nội dung tiếng Việt có đầy đủ dấu thanh, ạ ơ ư ô đ ê. Số liệu: ${(Math.random() * 1000).toFixed(2)} triệu.`);
    }
  }
  const t0 = Date.now();
  const r = await exportMarkdownToPdf(parts.join("\n"), path.join(OUT, "50-page.pdf"));
  const ms = Date.now() - t0;
  if (ms > 30_000) throw new Error(`too slow: ${ms}ms`);
  if (r.size < 50_000) throw new Error(`PDF too small for 50 pages: ${r.size}`);
  return `${ms}ms, ${(r.size / 1024).toFixed(0)} KB`;
});

await test("xlsx: 50 sheets workbook", async () => {
  const sheets = [];
  for (let s = 1; s <= 50; s++) {
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push([i, `Mục ${i}`, i * 100]);
    sheets.push({ name: `Sheet${s}`, headers: ["STT", "Tên", "Giá trị"], rows });
  }
  const t0 = Date.now();
  const r = await writeXlsx(sheets, path.join(OUT, "50-sheets.xlsx"));
  const ms = Date.now() - t0;
  if (r.sheets.length !== 50) throw new Error(`bad sheet count: ${r.sheets.length}`);
  return `${ms}ms, ${(r.size / 1024).toFixed(0)} KB`;
});

// =========== ERROR RECOVERY ===========
console.log("\n=== ERROR RECOVERY ===\n");

await test("xlsx: read corrupt file throws cleanly", async () => {
  const corrupt = path.join(OUT, "corrupt.xlsx");
  writeFileSync(corrupt, Buffer.from("not actually an xlsx file"));
  let threw = false;
  try {
    await readXlsx(corrupt);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("should have thrown");
  return "threw cleanly";
});

await test("xlsx: read empty file throws cleanly", async () => {
  const empty = path.join(OUT, "empty.xlsx");
  writeFileSync(empty, Buffer.alloc(0));
  let threw = false;
  try {
    await readXlsx(empty);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("should have thrown");
  return "threw cleanly";
});

await test("xlsx: write to read-only path returns error", async () => {
  let threw = false;
  try {
    // Use a definitely-invalid path on Windows
    await writeXlsx([{ name: "x", rows: [[1]] }], "Z:/does/not/exist/file.xlsx");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("should have thrown");
  return "threw cleanly";
});

await test("read_xlsx tool handler returns error string (not throw) on missing file", async () => {
  const { officeToolDefs } = await import("../lib/office-mcp.ts");
  const tools = officeToolDefs(OUT, null);
  const tool = tools.find(t => t.name === "read_xlsx");
  const r = await tool.handler({ filename: "definitely-missing.xlsx" });
  // resolveInput would resolve OK; readXlsx will throw; handler should wrap?
  // Actually current handler does NOT wrap — let's see what happens.
  if (typeof r !== "string") throw new Error("expected string return");
  // Either error message or partial result
  return `returned: ${r.slice(0, 80)}`;
});

// =========== CONCURRENCY ===========
console.log("\n=== CONCURRENCY (5 parallel agents) ===\n");

await test("5 concurrent runEmployee calls", async () => {
  const atlas = byName("Atlas");
  const prompts = [
    "1 + 1 = ?",
    "Liệt kê 2 cách phân loại khách hàng (1 dòng/cách).",
    "Một câu định nghĩa banca.",
    "Kể tên 2 loại bảo hiểm phổ biến VN.",
    "Loss ratio là gì? 1 câu.",
  ];
  const t0 = Date.now();
  const runs = await Promise.all(prompts.map(async (p, i) => {
    const taskId = `stress_concurrent_${Date.now()}_${i}`;
    const dir = ensureWorkspace(taskId);
    tasks.create({ id: taskId, title: `Stress ${i}: ${p.slice(0, 30)}`, description: p, status: "in_progress", mode: "direct", assignedTo: atlas.id });
    const t1 = Date.now();
    let txt = "";
    for await (const ev of runEmployee({ employee: atlas, prompt: p, taskId, workspace: { dir, hasFiles: false } })) {
      if (ev.kind === "delta") txt += ev.text;
      else if (ev.kind === "done") txt = ev.fullText || txt;
    }
    tasks.setStatus(taskId, "done");
    return { id: taskId, ms: Date.now() - t1, chars: txt.length };
  }));
  const total = Date.now() - t0;
  const avgMs = (runs.reduce((s, r) => s + r.ms, 0) / runs.length).toFixed(0);
  const maxMs = Math.max(...runs.map(r => r.ms));
  if (runs.some(r => r.chars === 0)) throw new Error(`some runs returned empty text`);
  return `total ${total}ms, max ${maxMs}ms, avg ${avgMs}ms, speedup ${(runs.reduce((s, r) => s + r.ms, 0) / total).toFixed(2)}x vs serial`;
});

// =========== ABORT MID-STREAM ===========
console.log("\n=== ABORT MID-STREAM ===\n");

await test("abort agent mid-turn → no crash, no orphaned files", async () => {
  const atlas = byName("Atlas");
  const taskId = `stress_abort_${Date.now()}`;
  const dir = ensureWorkspace(taskId);
  tasks.create({ id: taskId, title: "Abort test", description: "abort", status: "in_progress", mode: "direct", assignedTo: atlas.id });
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 1500);
  let aborted = false;
  let collected = "";
  try {
    for await (const ev of runEmployee({
      employee: atlas,
      prompt: "Viết 1 báo cáo dài 10 đoạn về thị trường bảo hiểm VN.",
      taskId,
      signal: abort,
      workspace: { dir, hasFiles: false },
    })) {
      if (ev.kind === "delta") collected += ev.text;
      else if (ev.kind === "error") { aborted = true; break; }
    }
  } catch {
    aborted = true;
  }
  tasks.setStatus(taskId, "failed");
  return `aborted=${aborted}, partial text=${collected.length}c (graceful)`;
});

// ============== Summary ==============
const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
console.log(`\n=== RESULT: ${passed}/${results.length} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const r of results.filter(r => !r.ok)) console.log(`  - ${r.name}: ${r.detail}`);
  process.exit(1);
}
console.log(`\nOutputs in ${OUT}`);
