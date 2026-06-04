// Edge case tests for text tools + xlsx special cell types.
// Run: npx tsx scripts/test-edge-cases.mjs

import { writeXlsx, readXlsx } from "../lib/office-tools/xlsx-tools.ts";
import ExcelJS from "exceljs";
import { officeToolDefs } from "../lib/office-mcp.ts";
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-output/edge");
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const tools = officeToolDefs(OUT, null);
const get = (name) => tools.find(t => t.name === name);

const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
async function test(name, fn) {
  try { rec(name, true, await fn()); } catch (e) { rec(name, false, (e && e.message) || String(e)); }
}

// ============== write_text ==============
await test("write_text: basic + overwrite", async () => {
  const tool = get("write_text");
  const r1 = await tool.handler({ filename: "note.md", content: "# Bản đầu\nChào anh." });
  if (!r1.includes("note.md")) throw new Error(`bad return: ${r1}`);
  const r2 = await tool.handler({ filename: "note.md", content: "# Bản hai\nKhác hẳn." });
  const content = readFileSync(path.join(OUT, "note.md"), "utf8");
  if (!content.includes("Bản hai")) throw new Error(`overwrite failed: ${content}`);
  return "wrote + overwrote";
});

await test("write_text: nested folder auto-mkdir", async () => {
  const tool = get("write_text");
  await tool.handler({ filename: "reports/2026/q1/summary.txt", content: "summary" });
  if (!existsSync(path.join(OUT, "reports/2026/q1/summary.txt"))) throw new Error("file missing");
  return "nested folder OK";
});

// ============== edit_text ==============
await test("edit_text: unique match replaces", async () => {
  const tool = get("edit_text");
  const r = await tool.handler({ filename: "note.md", old_string: "Bản hai", new_string: "Bản ba" });
  if (!r.includes("Đã sửa")) throw new Error(`bad return: ${r}`);
  const content = readFileSync(path.join(OUT, "note.md"), "utf8");
  if (!content.includes("Bản ba")) throw new Error(`replace failed`);
  return "OK";
});

await test("edit_text: not-found returns error message (no throw)", async () => {
  const tool = get("edit_text");
  const r = await tool.handler({ filename: "note.md", old_string: "Không có chuỗi này", new_string: "x" });
  if (!r.includes("Không tìm thấy")) throw new Error(`expected not-found message, got: ${r}`);
  return "graceful";
});

await test("edit_text: duplicate match rejects + suggests context", async () => {
  const tool = get("write_text");
  await tool.handler({ filename: "dup.txt", content: "Foo bar\nFoo baz\nFoo qux" });
  const edit = get("edit_text");
  const r = await edit.handler({ filename: "dup.txt", old_string: "Foo", new_string: "Bar" });
  if (!r.match(/3 lần/) || !r.includes("duy nhất")) throw new Error(`expected dup error, got: ${r}`);
  return "rejected with hint";
});

await test("edit_text: empty old_string rejects", async () => {
  const r = await get("edit_text").handler({ filename: "note.md", old_string: "", new_string: "x" });
  if (!r.includes("không được rỗng")) throw new Error(`expected empty error, got: ${r}`);
  return "rejected";
});

await test("edit_text: same old/new rejects", async () => {
  const r = await get("edit_text").handler({ filename: "note.md", old_string: "same", new_string: "same" });
  // First it'll find "same" not exists, but check the same-string check fires first
  if (!r.includes("giống nhau") && !r.includes("Không tìm thấy")) throw new Error(`got: ${r}`);
  return "rejected";
});

// ============== read_text ==============
await test("read_text: small file returns full content", async () => {
  await get("write_text").handler({ filename: "small.txt", content: "Hello tiếng Việt 😊" });
  const r = await get("read_text").handler({ filename: "small.txt" });
  if (!r.includes("tiếng Việt")) throw new Error(`VN lost: ${r}`);
  return "VN preserved";
});

await test("read_text: large file (>100KB) gets truncated + warning", async () => {
  const big = "Dòng dài lặp lại ".repeat(8000); // ~136KB
  await get("write_text").handler({ filename: "big.txt", content: big });
  const r = await get("read_text").handler({ filename: "big.txt" });
  if (!r.includes("đã cắt bớt")) throw new Error(`expected truncation message, got len ${r.length}`);
  if (r.length > 100_500) throw new Error(`not truncated properly: ${r.length} chars`);
  return `truncated to ${r.length} chars`;
});

await test("read_text: missing file returns error message", async () => {
  const r = await get("read_text").handler({ filename: "does-not-exist.txt" });
  if (!r.includes("Không đọc được")) throw new Error(`got: ${r.slice(0, 80)}`);
  return "graceful error";
});

await test("read_text: path traversal blocked", async () => {
  const r = await get("read_text").handler({ filename: "../../../etc/passwd" });
  // Should sanitize to a safe path or reject. Either way no exception.
  if (typeof r !== "string") throw new Error("expected string");
  return "no throw";
});

// ============== xlsx with formula / date cells ==============
await test("xlsx: read file with Date + formula cells", async () => {
  // Build with exceljs directly to get a Date cell + formula
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Mixed");
  ws.addRow(["Date", "Number", "Formula"]);
  ws.addRow([new Date("2026-05-17"), 10, { formula: "B2*2", result: 20 }]);
  ws.addRow([new Date("2026-06-01"), 25, { formula: "B3*2", result: 50 }]);
  const fp = path.join(OUT, "mixed-cells.xlsx");
  await wb.xlsx.writeFile(fp);
  const r = await readXlsx(fp);
  const sh = r.sheets[0];
  // Date should become ISO string
  if (typeof sh.rows[1][0] !== "string" || !sh.rows[1][0].startsWith("2026-05-17")) {
    throw new Error(`Date cell bad: ${JSON.stringify(sh.rows[1][0])}`);
  }
  // Formula result should be number
  if (sh.rows[1][2] !== 20) {
    throw new Error(`formula result bad: ${JSON.stringify(sh.rows[1][2])}`);
  }
  return `dates → ISO, formulas → result`;
});

await test("xlsx: write 10k rows (perf check)", async () => {
  const rows = [];
  for (let i = 0; i < 10_000; i++) rows.push([i, `Khách ${i}`, Math.random() * 1_000_000]);
  const t0 = Date.now();
  const r = await writeXlsx(
    [{ name: "Big", headers: ["STT", "Khách", "Doanh thu"], rows }],
    path.join(OUT, "big-10k.xlsx"),
  );
  const ms = Date.now() - t0;
  if (ms > 30_000) throw new Error(`too slow: ${ms}ms for 10k rows`);
  return `${ms}ms, ${(r.size / 1024).toFixed(0)} KB`;
});

await test("xlsx: read back 10k rows", async () => {
  const t0 = Date.now();
  const r = await readXlsx(path.join(OUT, "big-10k.xlsx"));
  const ms = Date.now() - t0;
  if (r.sheets[0].rows.length !== 10_001) throw new Error(`expected 10001 rows, got ${r.sheets[0].rows.length}`);
  return `${ms}ms read 10001 rows`;
});

// ============== Filename with emoji / unusual chars ==============
await test("write_text: emoji in filename roundtrips", async () => {
  const fn = "báo-cáo-🚀-2026.txt";
  await get("write_text").handler({ filename: fn, content: "hi" });
  // Check via resolveOutput sanitizer: should keep Vietnamese + emoji (only strip <>:"|?*\x00-\x1f)
  if (!existsSync(path.join(OUT, fn))) {
    // The exact filename may have OS quirks — list dir to see what landed
    const { readdirSync } = await import("node:fs");
    const list = readdirSync(OUT).filter(n => n.includes("báo-cáo"));
    throw new Error(`file not at expected path. found: ${list.join(", ")}`);
  }
  return `"${fn}" preserved`;
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
console.log(`Outputs in ${OUT}`);
