// End-to-end LLM tests. Invokes runEmployee directly with realistic prompts
// and verifies the agent picks the correct tool, file lands in workspace,
// and there's no hallucinated "lỗi font / không truy cập được" excuse.
//
// Auth: uses Claude Agent SDK CLI auth (Claude Code login), no API key needed.
// Run: npx tsx scripts/test-e2e.mjs

import { runEmployee } from "../lib/claude.ts";
import { employees, tasks } from "../lib/db.ts";
import { ensureSeed } from "../lib/seed.ts";
import { ensureWorkspace, workspaceDir } from "../lib/upload.ts";
import { writeXlsx } from "../lib/office-tools/xlsx-tools.ts";
import { mkdirSync, existsSync, statSync, readdirSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";

ensureSeed();
const roster = employees.list();
const byName = (n) => roster.find((e) => e.name === n);

console.log(`Loaded ${roster.length} employees: ${roster.map(e => `${e.name}(${e.model.split("-").slice(0,3).join("-")})`).join(", ")}`);

// Hallucination markers we shouldn't see in agent text.
const HALLUCINATION_RE = /(l[ỗo]i font|không truy c[ậa]p|copy.+paste.+vào file|anh t[ựu] m[ởo])/i;

const results = [];
function rec(name, ok, detail, tools, fullText) {
  results.push({ name, ok, detail, tools, fullText });
  const status = ok ? "✓" : "✗";
  console.log(`\n[${status}] ${name}`);
  if (tools && tools.length > 0) console.log(`    tools: ${tools.join(" → ")}`);
  if (detail) console.log(`    ${detail}`);
}

async function runTest({ name, employeeName, prompt, preStage, expectTool, expectFile, expectNoTool, expectInline }) {
  const emp = byName(employeeName);
  if (!emp) return rec(name, false, `employee "${employeeName}" not found`);

  // Fresh task + workspace per test
  const taskId = `test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const dir = ensureWorkspace(taskId);
  tasks.create({ id: taskId, title: name, description: prompt, status: "in_progress", mode: "direct", assignedTo: emp.id });

  if (preStage) {
    await preStage(dir);
  }
  const filesBefore = existsSync(dir) ? readdirSync(dir) : [];

  const toolCalls = [];
  let fullText = "";
  const t0 = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, 120_000);
  const abort = new AbortController();

  try {
    for await (const ev of runEmployee({
      employee: emp,
      prompt,
      taskId,
      signal: abort,
      workspace: { dir, hasFiles: filesBefore.length > 0 },
    })) {
      if (ev.kind === "delta") fullText += ev.text;
      else if (ev.kind === "tool_use") toolCalls.push(ev.toolName);
      else if (ev.kind === "done") fullText = ev.fullText || fullText;
      else if (ev.kind === "error") {
        clearTimeout(timer);
        return rec(name, false, `SDK error: ${ev.error}`, toolCalls, fullText);
      }
    }
  } catch (e) {
    clearTimeout(timer);
    return rec(name, false, `threw: ${(e && e.message) || e}`, toolCalls, fullText);
  }
  clearTimeout(timer);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const filesAfter = existsSync(dir) ? walkFiles(dir) : [];
  const newFiles = filesAfter.filter((f) => !filesBefore.includes(f));

  // Assertions
  const issues = [];
  if (timedOut) issues.push("TIMEOUT 120s");
  if (expectTool) {
    const called = toolCalls.some((t) => t.includes(expectTool));
    if (!called) issues.push(`expected tool "${expectTool}" not called`);
  }
  if (expectNoTool) {
    const called = toolCalls.some((t) => t.includes(expectNoTool));
    if (called) issues.push(`unexpected tool "${expectNoTool}" called`);
  }
  if (expectFile) {
    const match = newFiles.find((f) => f.endsWith(expectFile) || f.includes(expectFile.replace(/^.+\./, "")));
    if (!match) issues.push(`expected file matching "${expectFile}" not created; got: ${newFiles.join(", ") || "(none)"}`);
  }
  if (expectInline && newFiles.length > 0) {
    issues.push(`expected inline-only but agent created files: ${newFiles.join(", ")}`);
  }
  if (HALLUCINATION_RE.test(fullText)) {
    issues.push(`HALLUCINATION marker in text: "${fullText.match(HALLUCINATION_RE)[0]}"`);
  }

  const detail = `${elapsed}s · tools=${toolCalls.length} · newFiles=${newFiles.length} · textLen=${fullText.length}` +
    (issues.length > 0 ? `\n    ISSUES: ${issues.join(" | ")}` : "");
  rec(name, issues.length === 0, detail, toolCalls, fullText);
}

function walkFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

// ============== TESTS ==============

await runTest({
  name: "T1: xlsx_write basic (Atlas)",
  employeeName: "Atlas",
  prompt: "Tạo file Excel danh sách 5 chi nhánh với cột Tên, Khu vực, Doanh thu (triệu VND): Hà Nội Cầu Giấy/Hà Nội/125, TP.HCM Quận 1/TP.HCM/156, Đà Nẵng/Đà Nẵng/87, Hải Phòng/Miền Bắc/102, Cần Thơ/Miền Tây/65. Lưu reports/chi-nhanh.xlsx.",
  expectTool: "xlsx_write",
  expectFile: ".xlsx",
});

await runTest({
  name: "T2: read_xlsx → xlsx_write roundtrip (Atlas)",
  employeeName: "Atlas",
  preStage: async (dir) => {
    await writeXlsx(
      [{
        name: "Raw",
        headers: ["Mã", "Tên", "SL"],
        rows: [
          ["A001", "Sản phẩm 1", 10],
          ["A002", "Sản phẩm 2", 25],
          ["A003", "Sản phẩm 3", 8],
        ],
        style: { headerFill: "EEEEEE", border: false, freezeHeader: false, zebra: false },
      }],
      path.join(dir, "uploaded.xlsx"),
    );
  },
  prompt: "Trong workspace có file uploaded.xlsx. Đọc nó rồi format lại cho đẹp, lưu output ra uploaded_formatted.xlsx.",
  expectTool: "xlsx_write",
  expectFile: "formatted.xlsx",
});

await runTest({
  name: "T3: export_pdf VN content (Atlas)",
  employeeName: "Atlas",
  prompt: "Xuất PDF báo cáo ngắn về doanh thu Q1/2026: có tiêu đề, 1 bảng 3 hàng (chi nhánh × doanh thu), kết luận 2 câu. Lưu reports/q1-summary.pdf.",
  expectTool: "export_pdf",
  expectFile: ".pdf",
});

await runTest({
  name: "T4: export_dashboard KPI VN (Atlas)",
  employeeName: "Atlas",
  prompt: "Tạo dashboard HTML cho doanh thu Q1/2026: 3 KPI tile (Tổng doanh thu 776tr +12%, Số HD 1247 -3%, Conversion 18.2% +0.8pp) + 1 bar chart so sánh 4 chi nhánh. Lưu dashboards/q1-dashboard.html.",
  expectTool: "export_dashboard",
  expectFile: ".html",
});

await runTest({
  name: "T5: Scout inline KPI question (no file)",
  employeeName: "Scout",
  prompt: "Cho 5 KPI quan trọng nhất để theo dõi kênh banca trong bảo hiểm nhân thọ. Trả lời inline ngắn gọn.",
  expectInline: true,
  expectNoTool: "export_pdf",
});

await runTest({
  name: "T6: Aria design landing inline (no file unless asked)",
  employeeName: "Aria",
  prompt: "Em đề xuất aesthetic direction cho landing page bán bảo hiểm sức khỏe gia đình. Chưa cần tạo file, chỉ nói direction + font pairing + palette.",
  expectInline: true,
});

await runTest({
  name: "T7: Forge product brief inline",
  employeeName: "Forge",
  prompt: "Phác họa nhanh sản phẩm bảo hiểm du lịch 7 ngày Đông Nam Á: coverage chính + 2 exclusion + commission cap. 6-8 dòng.",
  expectInline: true,
});

// ============== SUMMARY ==============
const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
console.log(`\n=========================================\nRESULT: ${passed}/${results.length} passed, ${failed} failed\n=========================================`);
if (failed > 0) {
  console.log("\nFAILED TESTS:");
  for (const r of results.filter(r => !r.ok)) {
    console.log(`\n--- ${r.name} ---`);
    console.log(`detail: ${r.detail}`);
    if (r.tools && r.tools.length > 0) console.log(`tools: ${r.tools.join(" → ")}`);
    if (r.fullText) console.log(`text (first 400):\n${r.fullText.slice(0, 400)}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
