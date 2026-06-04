// Code-level tool test battery. Runs every office tool with realistic Vietnamese
// content + edge cases, then verifies outputs. Cleans up after itself.
//
// Run: npx tsx scripts/test-tools.mjs

import { writeXlsx, readXlsx } from "../lib/office-tools/xlsx-tools.ts";
import { exportMarkdownToPdf } from "../lib/office-tools/pdf-export.ts";
import { exportMarkdownToDocx } from "../lib/office-tools/docx-export.ts";
import { exportDashboard } from "../lib/office-tools/dashboard-export.ts";
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-output");
mkdirSync(OUT, { recursive: true });
// Only clear our own outputs, not the whole folder (other tests live here too).
const OURS = ["xlsx-single.xlsx", "xlsx-multi.xlsx", "xlsx-no-header.xlsx", "xlsx-sanitize.xlsx", "xlsx-bad-name.xlsx", "pdf-vn.pdf", "pdf-long.pdf", "docx-vn.docx", "dashboard.html", "dashboard-min.html"];
for (const f of OURS) {
  try { rmSync(path.join(OUT, f), { force: true }); } catch { /* ignore */ }
}

const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
async function test(name, fn) {
  try {
    const detail = await fn();
    rec(name, true, detail);
  } catch (e) {
    rec(name, false, (e && e.message) || String(e));
  }
}

// =============== xlsx_write ===============
await test("xlsx: write single sheet with VN content + default preset", async () => {
  const r = await writeXlsx(
    [{
      name: "Doanh thu",
      headers: ["Mã NV", "Chi nhánh", "Khu vực", "Phí BH (VND)"],
      rows: [
        ["T1001", "HN-Cầu Giấy", "Hà Nội", 125_000_000],
        ["T1002", "HN-Đống Đa", "Hà Nội", 98_500_000],
        ["T1003", "HCM-Quận 1", "TP.HCM", 156_300_000],
      ],
    }],
    path.join(OUT, "xlsx-single.xlsx"),
  );
  if (r.size < 5000) throw new Error(`file too small (${r.size})`);
  if (r.sheets[0] !== "Doanh thu") throw new Error(`bad name: ${r.sheets[0]}`);
  return `${(r.size / 1024).toFixed(1)} KB`;
});

await test("xlsx: write multi-sheet with style overrides", async () => {
  const r = await writeXlsx(
    [
      {
        name: "Default style",
        headers: ["A", "B"],
        rows: [["x", 1], ["y", 2]],
      },
      {
        name: "No zebra no freeze",
        headers: ["Col1", "Col2"],
        rows: [["a", 100], ["b", 200], ["c", 300]],
        style: { zebra: false, freezeHeader: false, headerFill: "FFE4B5" },
      },
      {
        name: "Custom widths",
        headers: ["Short", "Very long header text here"],
        rows: [["x", "data"]],
        style: { columnWidths: [5, 40] },
      },
    ],
    path.join(OUT, "xlsx-multi.xlsx"),
  );
  if (r.sheets.length !== 3) throw new Error(`bad sheet count: ${r.sheets.length}`);
  return `${r.sheets.length} sheets, ${(r.size / 1024).toFixed(1)} KB`;
});

await test("xlsx: edge case — no headers (plain data dump)", async () => {
  const r = await writeXlsx(
    [{ name: "Plain", rows: [["a", 1], ["b", 2]] }],
    path.join(OUT, "xlsx-no-header.xlsx"),
  );
  if (r.size < 4000) throw new Error(`file too small (${r.size})`);
  return `${(r.size / 1024).toFixed(1)} KB`;
});

await test("xlsx: edge case — sanitize NaN, undefined, control chars", async () => {
  const r = await writeXlsx(
    [{
      name: "Sanitize",
      headers: ["A", "B", "C"],
      rows: [
        [NaN, undefined, "normal"],
        ["with\x00null\x01char", "ok", 3.14],
        [null, 0, false],
      ],
    }],
    path.join(OUT, "xlsx-sanitize.xlsx"),
  );
  if (r.size < 4000) throw new Error(`file too small`);
  // Roundtrip read to ensure no garbage in cells
  const rd = await readXlsx(path.join(OUT, "xlsx-sanitize.xlsx"));
  const dataRow = rd.sheets[0].rows[1]; // first data row
  if (dataRow[0] !== null) throw new Error(`NaN should be null, got ${JSON.stringify(dataRow[0])}`);
  if (dataRow[1] !== null) throw new Error(`undefined should be null, got ${JSON.stringify(dataRow[1])}`);
  return `roundtrip OK`;
});

await test("xlsx: edge case — sheet name with forbidden chars + long name", async () => {
  const r = await writeXlsx(
    [{
      name: "This/sheet:has*forbidden?chars and is too long beyond 31 limit",
      headers: ["x"],
      rows: [[1]],
    }],
    path.join(OUT, "xlsx-bad-name.xlsx"),
  );
  if (r.sheets[0].length > 31) throw new Error(`name not truncated: ${r.sheets[0]}`);
  if (/[\[\]:\*\?\/\\]/.test(r.sheets[0])) throw new Error(`bad chars: ${r.sheets[0]}`);
  return `→ "${r.sheets[0]}"`;
});

await test("xlsx: empty sheets array throws", async () => {
  let threw = false;
  try {
    await writeXlsx([], path.join(OUT, "should-not-exist.xlsx"));
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("should have thrown");
  return "threw as expected";
});

// =============== read_xlsx ===============
await test("xlsx: read roundtrip preserves VN strings + numbers", async () => {
  const r = await readXlsx(path.join(OUT, "xlsx-single.xlsx"));
  const sh = r.sheets[0];
  if (sh.rows.length !== 4) throw new Error(`expected 4 rows (header + 3 data), got ${sh.rows.length}`);
  if (sh.rows[1][1] !== "HN-Cầu Giấy") throw new Error(`VN string corrupted: ${sh.rows[1][1]}`);
  if (sh.rows[2][3] !== 98_500_000) throw new Error(`number corrupted: ${sh.rows[2][3]}`);
  return `${sh.rows.length} rows, ${sh.colCount} cols`;
});

// =============== PDF ===============
await test("pdf: VN content with headings, lists, table, blockquote", async () => {
  const md = `# Báo cáo Quý 1/2026

## Tổng quan
Doanh thu **tăng 12%** so với cùng kỳ. Các chi nhánh dẫn đầu: *Hà Nội*, *TP.HCM*.

### Chi tiết theo khu vực
- Hà Nội: 125 triệu VND
- Đà Nẵng: 87 triệu VND
- Cần Thơ: 65 triệu VND

### Bảng so sánh
| Khu vực | Doanh thu | % |
|---------|-----------|---|
| Hà Nội | 125 triệu | 38% |
| Đà Nẵng | 87 triệu | 25% |

> Lưu ý: số liệu chưa kiểm toán, mang tính tham khảo.

\`\`\`
sample code block
const x = 42;
\`\`\`

Kết luận: cần đẩy mạnh chi nhánh miền Trung trong Q2.`;
  const r = await exportMarkdownToPdf(md, path.join(OUT, "pdf-vn.pdf"), "Test tiếng Việt");
  if (r.size < 20_000) throw new Error(`PDF too small: ${r.size}`);
  // Check PDF header bytes
  const head = readFileSync(r.path).subarray(0, 4).toString();
  if (head !== "%PDF") throw new Error(`bad PDF header: ${head}`);
  return `${(r.size / 1024).toFixed(1)} KB`;
});

await test("pdf: stress test — long doc with many headings", async () => {
  const sections = [];
  for (let i = 1; i <= 20; i++) {
    sections.push(`## Phần ${i}`);
    sections.push(`Nội dung phần ${i}: lorem ipsum tiếng Việt có dấu đầy đủ ạ ơ ư ô đ ê.`);
    sections.push(`- Mục ${i}.1: data số ${i * 100}.`);
    sections.push(`- Mục ${i}.2: data số ${i * 200}.\n`);
  }
  const md = `# Báo cáo dài\n\n${sections.join("\n")}`;
  const r = await exportMarkdownToPdf(md, path.join(OUT, "pdf-long.pdf"));
  if (r.size < 30_000) throw new Error(`PDF too small`);
  return `${(r.size / 1024).toFixed(1)} KB, 20 sections`;
});

// =============== DOCX ===============
await test("docx: VN content with markdown structures", async () => {
  const md = `# Tài liệu kỹ thuật

## Giới thiệu
Đây là **tài liệu mẫu** tiếng Việt có *dấu* đầy đủ.

### Quy trình
1. Bước một: thu thập dữ liệu
2. Bước hai: phân tích
3. Bước ba: báo cáo

> Quan trọng: kiểm tra số liệu trước khi gửi.

Inline code: \`SELECT * FROM khach_hang WHERE status = 'active'\`.`;
  const r = await exportMarkdownToDocx(md, path.join(OUT, "docx-vn.docx"), "Test DOCX");
  if (r.size < 5000) throw new Error(`docx too small`);
  // DOCX is a zip; first 4 bytes = PK signature
  const head = readFileSync(r.path).subarray(0, 2);
  if (head[0] !== 0x50 || head[1] !== 0x4B) throw new Error(`bad DOCX header`);
  return `${(r.size / 1024).toFixed(1)} KB`;
});

// =============== Dashboard HTML ===============
await test("dashboard: full spec with VN labels + KPIs + 2 chart types + table", async () => {
  const r = await exportDashboard({
    title: "Dashboard Doanh thu Q1/2026",
    subtitle: "Số liệu tổng hợp 7 chi nhánh tại Việt Nam",
    kpis: [
      { label: "Tổng doanh thu", value: "776 triệu", change: 12.3, format: "raw" },
      { label: "Số hợp đồng", value: 1247, change: -3.5, format: "number" },
      { label: "Tỷ lệ chuyển đổi", value: 0.182, change: 0.8, format: "percent" },
    ],
    charts: [
      {
        type: "bar",
        title: "Doanh thu theo chi nhánh (triệu VND)",
        labels: ["Hà Nội", "TP.HCM", "Đà Nẵng", "Cần Thơ", "Hải Phòng"],
        series: [
          { name: "Q1/2026", values: [125, 156, 87, 65, 102], color: "#0EA5E9" },
          { name: "Q4/2025", values: [110, 145, 80, 58, 95], color: "#94A3B8" },
        ],
      },
      {
        type: "doughnut",
        title: "Phân bổ theo khu vực",
        labels: ["Miền Bắc", "Miền Trung", "Miền Nam"],
        series: [{ name: "Tỷ lệ", values: [42, 23, 35] }],
      },
    ],
    tables: [
      {
        title: "Top 5 chi nhánh",
        columns: ["Chi nhánh", "Khu vực", "Doanh thu (triệu)"],
        rows: [
          ["TP.HCM Quận 1", "TP.HCM", 156],
          ["HN Cầu Giấy", "Hà Nội", 125],
          ["Hải Phòng", "Miền Bắc", 102],
          ["HN Đống Đa", "Hà Nội", 98],
          ["Đà Nẵng", "Đà Nẵng", 87],
        ],
      },
    ],
  }, path.join(OUT, "dashboard.html"));
  if (r.size < 3000) throw new Error(`dashboard too small (${r.size})`);
  const html = readFileSync(r.path, "utf8");
  if (!html.includes("Doanh thu")) throw new Error(`VN text missing in HTML`);
  if (!/chart\.js/i.test(html)) throw new Error(`Chart.js not included`);
  if (!html.includes("Hà Nội")) throw new Error(`chart labels missing`);
  if (!html.includes("Tổng doanh thu")) throw new Error(`KPI labels missing`);
  return `${(r.size / 1024).toFixed(1)} KB`;
});

await test("dashboard: minimal spec (only KPIs)", async () => {
  const r = await exportDashboard({
    title: "KPI snapshot",
    kpis: [
      { label: "Active users", value: 1234 },
      { label: "Revenue", value: 56789, format: "currency" },
    ],
  }, path.join(OUT, "dashboard-min.html"));
  if (r.size < 1500) throw new Error(`too small (${r.size})`);
  const html = readFileSync(r.path, "utf8");
  if (!html.includes("Active users")) throw new Error(`KPI label missing`);
  return `${(r.size / 1024).toFixed(1)} KB`;
});

// =============== Path resolution / sanitizer ===============
await test("path: VN filename roundtrip via sanitizer (regression for 404 bug)", async () => {
  // Simulate the resolver path used by office-mcp.resolveOutput
  const filename = "HoaDon_ChúKiệt.html";
  const normalized = filename.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  const safe = parts.map(p => p.replace(/[<>:"|?*\x00-\x1f]/g, "_"));
  const written = safe.join(path.sep);
  if (written !== filename) throw new Error(`writer sanitizer changed name: ${written}`);

  // Now simulate upload.sanitizeRelativePath (after fix)
  const readNormalized = filename.replace(/\\/g, "/").replace(/^\/+/, "");
  const readParts = readNormalized.split("/").filter(Boolean);
  const readSafe = readParts
    .filter(p => p !== "." && p !== "..")
    .map(p => p.replace(/[<>:"|?*\x00-\x1f]/g, "_"));
  const read = readSafe.join(path.sep);
  if (read !== filename) throw new Error(`reader sanitizer changed name: ${read}`);
  return `"${filename}" preserved both ways`;
});

// =============== Summary ===============
const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const r of results.filter(r => !r.ok)) console.log(`  - ${r.name}: ${r.detail}`);
  process.exit(1);
}

// Keep outputs in test-output/ for visual inspection — open files in Excel,
// browser, etc. to verify styling looks right.
console.log(`\nOutputs in: ${OUT}`);
console.log(`Open these files manually to review:`);
console.log(`  - xlsx-single.xlsx, xlsx-multi.xlsx, xlsx-no-header.xlsx, xlsx-sanitize.xlsx`);
console.log(`    → check: header bold + blue fill, freeze row 1, zebra rows, border, auto widths`);
console.log(`  - pdf-vn.pdf, pdf-long.pdf`);
console.log(`    → check: Vietnamese diacritics render correctly, tables formatted`);
console.log(`  - docx-vn.docx`);
console.log(`    → check: headings, lists, blockquote render in Word`);
console.log(`  - dashboard.html, dashboard-min.html`);
console.log(`    → open in browser: KPI tiles, charts render, VN labels visible`);
