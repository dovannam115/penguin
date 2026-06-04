import { NextResponse } from "next/server";
import path from "node:path";
import { resolveFilePath } from "@/lib/upload";
import { previewPptx, type PptxPreview, type PreviewShape } from "@/lib/office-tools/pptx-export";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Render docx/pptx -> standalone styled HTML for in-app preview (iframe).
 *  Other types are served raw by /api/files/... — this route is preview-only. */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlResponse(body: string): NextResponse {
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

const BASE_CSS = `
  *{box-sizing:border-box}
  body{margin:0;background:#f1f5f9;color:#0f172a;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
    line-height:1.6;font-size:15px}
  .wrap{max-width:820px;margin:0 auto;padding:32px 24px 64px}
`;

function docShell(title: string, inner: string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${BASE_CSS}
  .doc{background:#fff;padding:48px 56px;border-radius:8px;
    box-shadow:0 1px 3px rgba(0,0,0,.12),0 8px 24px rgba(0,0,0,.06)}
  .doc h1,.doc h2,.doc h3{line-height:1.3;margin:1.2em 0 .5em}
  .doc h1{font-size:1.7em}.doc h2{font-size:1.35em}.doc h3{font-size:1.12em}
  .doc p{margin:.6em 0}.doc img{max-width:100%;height:auto}
  .doc table{border-collapse:collapse;width:100%;margin:1em 0}
  .doc td,.doc th{border:1px solid #cbd5e1;padding:6px 10px;text-align:left}
  .doc ul,.doc ol{padding-left:1.5em}
</style></head><body><div class="wrap"><div class="doc">${inner}</div></div></body></html>`;
}

function noteShell(msg: string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<style>${BASE_CSS}.note{text-align:center;color:#64748b;padding:48px 16px}</style></head>
<body><div class="wrap"><div class="note">${escapeHtml(msg)}</div></div></body></html>`;
}

/** Render 1 shape -> HTML (định vị tuyệt đối theo % của slide). Kích thước font/
 *  viền dùng đơn vị container-query (cqw) để co giãn theo bề rộng slide. */
function shapeHtml(sh: PreviewShape): string {
  const pos = `left:${(sh.x * 100).toFixed(2)}%;top:${(sh.y * 100).toFixed(2)}%;` +
    `width:${(sh.w * 100).toFixed(2)}%;height:${(sh.h * 100).toFixed(2)}%;`;
  if (sh.img) {
    return `<img class="sh" style="${pos}object-fit:contain" src="${sh.img}" alt="">`;
  }
  let css = pos;
  if (sh.fill) css += `background:${sh.fill};`;
  if (sh.line && sh.line_w) css += `border:${(sh.line_w * 0.104).toFixed(3)}cqw solid ${sh.line};`;
  if (sh.radius) css += `border-radius:${Math.min(50, sh.radius * 100).toFixed(1)}%;`;
  let inner = "";
  if (sh.runs && sh.runs.length) {
    const valign = sh.valign === "middle" ? "center" : sh.valign === "bottom" ? "flex-end" : "flex-start";
    const align = sh.align === "center" || sh.align === "right" || sh.align === "justify" ? sh.align : "left";
    const runHtml = sh.runs.map((r) => {
      if (r.br) return "<br>";
      // pt -> cqw: slide rộng 960pt, cqw = 1% bề rộng slide -> pt/960*100.
      const fs = r.size_pt ? `font-size:${(r.size_pt * 0.10417).toFixed(3)}cqw;` : "";
      const fw = r.bold ? "font-weight:700;" : "";
      const fi = r.italic ? "font-style:italic;" : "";
      const fc = r.color ? `color:${r.color};` : "";
      return `<span style="${fs}${fw}${fi}${fc}">${escapeHtml(r.text || "")}</span>`;
    }).join("");
    inner = `<div class="tx" style="justify-content:${valign};text-align:${align}">${runHtml}</div>`;
  }
  return `<div class="sh" style="${css}">${inner}</div>`;
}

function pptxVisualShell(title: string, preview: PptxPreview): string {
  const aspect = preview.aspect && preview.aspect > 0.2 ? preview.aspect : 16 / 9;
  const slidesHtml = preview.slides.map((s, i) =>
    `<div class="slidewrap"><div class="snum">Slide ${i + 1}</div>` +
    `<div class="slide">${s.shapes.map(shapeHtml).join("")}</div></div>`,
  ).join("");
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${BASE_CSS}
  .hint{font-size:12px;color:#64748b;margin:0 0 18px;text-align:center}
  .slidewrap{max-width:900px;margin:0 auto 18px}
  .snum{font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:.04em;margin:0 0 4px}
  .slide{position:relative;width:100%;aspect-ratio:${aspect};background:#fff;
    border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.15),0 8px 24px rgba(0,0,0,.06);
    container-type:inline-size}
  .sh{position:absolute;overflow:hidden}
  img.sh{display:block}
  .tx{position:absolute;inset:0;display:flex;flex-direction:column;color:#0f172a;
    line-height:1.18;white-space:pre-wrap;word-break:break-word;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif}
</style></head><body><div class="wrap">
  <p class="hint">Bản xem trước trực quan ${preview.n_slides} slide (gần đúng). Tải về để xem/chỉnh bản đầy đủ trong PowerPoint.</p>
  ${slidesHtml}
</div></body></html>`;
}

export async function GET(_req: Request, ctx: { params: Promise<{ taskId: string; filename: string[] }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { taskId, filename } = await ctx.params;
  const decoded = filename.map(decodeURIComponent).join("/");
  const ext = path.extname(decoded).toLowerCase();
  const abs = resolveFilePath(taskId, decoded);
  if (!abs) return htmlResponse(noteShell("Không tìm thấy file."));
  const leaf = decoded.split("/").pop() ?? decoded;

  try {
    if (ext === ".docx") {
      const mammoth = await import("mammoth");
      const { value } = await mammoth.convertToHtml({ path: abs });
      const inner = (value ?? "").trim() || "<p><em>Tài liệu rỗng.</em></p>";
      return htmlResponse(docShell(leaf, inner));
    }
    if (ext === ".pptx") {
      const preview = await previewPptx(abs);
      if (!preview.slides || preview.slides.length === 0) {
        return htmlResponse(noteShell("File PowerPoint không có slide nào."));
      }
      return htmlResponse(pptxVisualShell(leaf, preview));
    }
    return htmlResponse(noteShell(`Preview không hỗ trợ ${ext || "file này"}.`));
  } catch (e) {
    return htmlResponse(noteShell(`Lỗi tạo bản xem trước: ${e instanceof Error ? e.message : String(e)}`));
  }
}
