// Test read_pdf + read_docx using fixtures from test-output/
// Run: npx tsx scripts/test-doc-readers.mjs (requires test-output/pdf-vn.pdf + docx-vn.docx)

import { readPdf, readDocx } from "../lib/office-tools/doc-readers.ts";
import { officeToolDefs } from "../lib/office-mcp.ts";
import { existsSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const FIXTURES = path.resolve("test-output");
const OUT = path.resolve("test-output/doc-readers");
mkdirSync(OUT, { recursive: true });

// Copy fixtures into a workspace-style dir so we can also test the MCP tool wrapper.
const wsPdf = path.join(OUT, "sample.pdf");
const wsDocx = path.join(OUT, "sample.docx");
if (!existsSync(path.join(FIXTURES, "pdf-vn.pdf"))) {
  console.error("Missing fixture test-output/pdf-vn.pdf. Run `npx tsx scripts/test-tools.mjs` first.");
  process.exit(2);
}
copyFileSync(path.join(FIXTURES, "pdf-vn.pdf"), wsPdf);
copyFileSync(path.join(FIXTURES, "docx-vn.docx"), wsDocx);

const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
async function test(name, fn) {
  try { rec(name, true, await fn()); } catch (e) { rec(name, false, (e && e.message) || String(e)); }
}

// ============== readPdf direct ==============
await test("readPdf: extract VN text + page count", async () => {
  const r = await readPdf(wsPdf);
  if (r.pages < 1) throw new Error(`expected pages >= 1, got ${r.pages}`);
  if (r.text.length < 50) throw new Error(`text too short: ${r.text.length}`);
  if (!r.text.includes("Báo cáo")) throw new Error(`VN content missing: ${r.text.slice(0, 200)}`);
  return `${r.pages} page(s), ${r.text.length} chars`;
});

// ============== readDocx direct ==============
await test("readDocx: extract VN text", async () => {
  const r = await readDocx(wsDocx);
  if (r.text.length < 50) throw new Error(`text too short: ${r.text.length}`);
  if (!r.text.includes("Tài liệu")) throw new Error(`VN content missing`);
  return `${r.text.length} chars, ${r.warnings.length} warnings`;
});

// ============== MCP tool wrappers ==============
const tools = officeToolDefs(OUT, null);
const get = (n) => tools.find(t => t.name === n);

await test("MCP read_pdf wrapper: returns JSON with pages + text", async () => {
  const r = await get("read_pdf").handler({ filename: "sample.pdf" });
  const parsed = JSON.parse(r);
  if (!parsed.text || !parsed.pages) throw new Error(`bad shape: ${r.slice(0, 100)}`);
  return `pages=${parsed.pages}, textLen=${parsed.text.length}`;
});

await test("MCP read_docx wrapper: returns JSON with text", async () => {
  const r = await get("read_docx").handler({ filename: "sample.docx" });
  const parsed = JSON.parse(r);
  if (!parsed.text || parsed.text.length < 50) throw new Error(`bad output: ${r.slice(0, 100)}`);
  return `textLen=${parsed.text.length}`;
});

await test("read_pdf: missing file → graceful error", async () => {
  const r = await get("read_pdf").handler({ filename: "does-not-exist.pdf" });
  if (!r.includes("Không đọc được")) throw new Error(`expected error msg, got: ${r.slice(0, 80)}`);
  return "OK";
});

await test("read_docx: missing file → graceful error", async () => {
  const r = await get("read_docx").handler({ filename: "does-not-exist.docx" });
  if (!r.includes("Không đọc được")) throw new Error(`expected error msg, got: ${r.slice(0, 80)}`);
  return "OK";
});

await test("read_pdf: path traversal blocked", async () => {
  const r = await get("read_pdf").handler({ filename: "../../../etc/passwd" });
  if (typeof r !== "string") throw new Error("expected string");
  return "no throw";
});

const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
console.log(`\n=== RESULT: ${passed}/${results.length} passed, ${failed} failed ===`);
if (failed > 0) {
  for (const r of results.filter(r => !r.ok)) console.log(`  - ${r.name}: ${r.detail}`);
  process.exit(1);
}
