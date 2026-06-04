import { writeFile, statSync } from "node:fs";
import { promisify } from "node:util";

const writeFileAsync = promisify(writeFile);

export interface KpiSpec {
  label: string;
  value: string | number;
  change?: number;        // % change vs previous period
  format?: "number" | "currency" | "percent" | "raw";
}

export interface ChartSpec {
  type: "bar" | "line" | "pie" | "doughnut" | "area";
  title: string;
  labels: string[];
  series: Array<{ name: string; values: number[]; color?: string }>;
}

export interface TableSpec {
  title: string;
  columns: string[];
  rows: (string | number)[][];
}

export interface DashboardSpec {
  title: string;
  subtitle?: string;
  kpis?: KpiSpec[];
  charts?: ChartSpec[];
  tables?: TableSpec[];
}

const PALETTE = ["#fbbf24", "#14b8a6", "#60a5fa", "#a78bfa", "#f472b6", "#34d399", "#f87171", "#fb923c"];

function escapeHtml(s: string | number): string {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatKpi(v: string | number, fmt?: KpiSpec["format"]): string {
  if (typeof v === "string") return escapeHtml(v);
  switch (fmt) {
    case "currency":
      return escapeHtml(new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(v));
    case "percent":
      return escapeHtml(`${v.toFixed(1)}%`);
    case "number":
      return escapeHtml(new Intl.NumberFormat("vi-VN").format(v));
    default:
      return escapeHtml(v);
  }
}

function renderKpis(kpis: KpiSpec[]): string {
  return `<section class="kpis">${kpis.map(k => {
    const change = k.change == null ? "" : `
      <div class="kpi-change ${k.change >= 0 ? "kpi-up" : "kpi-down"}">
        ${k.change >= 0 ? "▲" : "▼"} ${Math.abs(k.change).toFixed(1)}%
      </div>`;
    return `
      <div class="kpi">
        <div class="kpi-label">${escapeHtml(k.label)}</div>
        <div class="kpi-value">${formatKpi(k.value, k.format)}</div>
        ${change}
      </div>`;
  }).join("")}</section>`;
}

function renderTables(tables: TableSpec[]): string {
  return tables.map(t => `
    <section class="card">
      <h3>${escapeHtml(t.title)}</h3>
      <table class="data-table">
        <thead><tr>${t.columns.map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
        <tbody>${t.rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </section>`).join("");
}

export async function exportDashboard(spec: DashboardSpec, outputPath: string): Promise<{ path: string; size: number }> {
  const html = renderDashboardHtml(spec);
  await writeFileAsync(outputPath, html, "utf8");
  return { path: outputPath, size: statSync(outputPath).size };
}

export function renderDashboardHtml(spec: DashboardSpec): string {
  const charts = spec.charts ?? [];
  const chartsHtml = charts.map((c, i) => `
    <section class="card chart-card">
      <h3>${escapeHtml(c.title)}</h3>
      <canvas id="chart-${i}"></canvas>
    </section>`).join("");

  const chartInits = charts.map((c, i) => {
    const datasets = c.series.map((s, sIdx) => {
      const color = s.color || PALETTE[sIdx % PALETTE.length];
      const base = {
        label: s.name,
        data: s.values,
        backgroundColor: c.type === "pie" || c.type === "doughnut"
          ? c.labels.map((_, li) => PALETTE[li % PALETTE.length])
          : color + "cc",
        borderColor: color,
        borderWidth: 2,
        fill: c.type === "area",
        tension: c.type === "line" || c.type === "area" ? 0.35 : 0,
      };
      return base;
    });
    const chartType = c.type === "area" ? "line" : c.type;
    return `
      new Chart(document.getElementById("chart-${i}"), {
        type: ${JSON.stringify(chartType)},
        data: {
          labels: ${JSON.stringify(c.labels)},
          datasets: ${JSON.stringify(datasets)}
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: "#cbd5e1" } },
            tooltip: { backgroundColor: "#262624", borderColor: "#46443F", borderWidth: 1 }
          },
          scales: ${JSON.stringify(c.type)} === '"pie"' || ${JSON.stringify(c.type)} === '"doughnut"' ? {} : {
            x: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(255,255,255,0.05)" } },
            y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(255,255,255,0.05)" } }
          }
        }
      });`;
  }).join("\n");

  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(spec.title)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  background: #262624;
  color: #f1f5f9;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
  line-height: 1.5;
}
.wrap { max-width: 1280px; margin: 0 auto; padding: 24px; }
.header { margin-bottom: 24px; }
.header h1 { margin: 0 0 6px 0; font-size: 26px; letter-spacing: -0.01em; color: #fde68a; }
.header p { margin: 0; color: #94a3b8; font-size: 14px; }

.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
  margin-bottom: 24px;
}
.kpi {
  background: linear-gradient(180deg, #34322D 0%, #2F2D29 100%);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 14px;
  padding: 16px 18px;
}
.kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; }
.kpi-value { font-size: 28px; font-weight: 600; margin-top: 6px; color: #f1f5f9; }
.kpi-change { font-size: 12px; margin-top: 4px; display: inline-block; padding: 2px 8px; border-radius: 999px; }
.kpi-up   { color: #34d399; background: rgba(52,211,153,0.10); }
.kpi-down { color: #f87171; background: rgba(248,113,113,0.10); }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}
.card {
  background: linear-gradient(180deg, #34322D 0%, #2F2D29 100%);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 14px;
  padding: 18px;
}
.card h3 { margin: 0 0 12px 0; font-size: 14px; color: #fde68a; font-weight: 500; letter-spacing: 0.02em; }
.chart-card { min-height: 320px; }
.chart-card canvas { width: 100% !important; height: 280px !important; }

.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th, .data-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.05); }
.data-table th { color: #94a3b8; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
.data-table tbody tr:hover { background: rgba(255,255,255,0.02); }
</style>
</head>
<body>
<div class="wrap">
  <header class="header">
    <h1>${escapeHtml(spec.title)}</h1>
    ${spec.subtitle ? `<p>${escapeHtml(spec.subtitle)}</p>` : ""}
  </header>
  ${spec.kpis && spec.kpis.length > 0 ? renderKpis(spec.kpis) : ""}
  ${chartsHtml ? `<div class="grid">${chartsHtml}</div>` : ""}
  ${spec.tables && spec.tables.length > 0 ? `<div class="grid">${renderTables(spec.tables)}</div>` : ""}
</div>
<script>
${chartInits}
</script>
</body>
</html>`;
}
