import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import path from "node:path";
import { writeFile, statSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { promisify } from "node:util";
import { exportMarkdownToPdf } from "./office-tools/pdf-export";
import { exportMarkdownToDocx } from "./office-tools/docx-export";
import { writeXlsx, readXlsx, type SheetInput } from "./office-tools/xlsx-tools";
import { exportDashboard, type DashboardSpec } from "./office-tools/dashboard-export";
import { readPdf, readDocx } from "./office-tools/doc-readers";
import { inspectTemplate, generatePptx, type PptxSlideSpec } from "./office-tools/pptx-export";

const writeFileAsync = promisify(writeFile);

function resolveOutput(workspaceDir: string, filename: string, defaultExt: string): string {
  // Allow nested filenames like "reports/q1/summary.pdf" so the agent can
  // organize outputs into folders. Block path traversal (..) and absolute
  // paths; auto-mkdir the parent so the write succeeds.
  const raw = filename && filename.trim() ? filename.trim() : `output.${defaultExt}`;
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  const safe: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "..") continue;
    safe.push(part.replace(/[<>:"|?*\x00-\x1f]/g, "_"));
  }
  if (safe.length === 0) safe.push(`output.${defaultExt}`);
  const rel = safe.join(path.sep);
  const full = path.join(workspaceDir, rel);
  // Verify it stays inside workspace after resolving symlinks/normalization.
  const resolved = path.resolve(full);
  const base = path.resolve(workspaceDir);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    // Fell outside (shouldn't happen given the filtering above) — strip to flat.
    return path.join(workspaceDir, path.basename(resolved));
  }
  mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

/** Resolve a workspace-relative path for READING (no mkdir). Returns null if
 *  the path escapes the workspace. */
function resolveInput(workspaceDir: string, filename: string): string | null {
  const normalized = (filename || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(p => p && p !== "." && p !== "..");
  const fullPath = path.resolve(path.join(workspaceDir, ...parts));
  const base = path.resolve(workspaceDir);
  if (!fullPath.startsWith(base + path.sep) && fullPath !== base) return null;
  return fullPath;
}

/**
 * Office tool definition — the single source of truth, consumed by BOTH
 * backends: the Claude Agent SDK MCP server (buildOfficeMcpServer) and the
 * OpenAI-compatible function-calling loop (lib/openai-compat.ts).
 */
export interface OfficeToolDef {
  name: string;
  description: string;
  /** Zod raw shape — feeds the SDK `tool()` and, via z.object(), JSON Schema. */
  shape: z.ZodRawShape;
  /** Run the tool; returns a short human-readable result string. */
  handler: (args: Record<string, unknown>) => Promise<string>;
  /** Gate this tool to employees who hold AT LEAST ONE of these skill IDs.
   *  Undefined = available to everyone. Used to keep "design" tools (slides /
   *  dashboard) on the designer only — e.g. only Aria (design-slides) builds
   *  slides, even though every employee shares the same office MCP surface. */
  requiresAnySkill?: string[];
}

/** All office tools, scoped to one task's workspace directory.
 *  `taskId` (optional) wires the live Excel builder events to the chat SSE
 *  stream — tools fall back to "no-emit" mode when it's absent. */
export function officeToolDefs(
  workspaceDir: string,
  taskId: string | null = null,
  opts: { skills?: string[] } = {},
): OfficeToolDef[] {
  const skills = opts.skills ?? [];
  const defs: OfficeToolDef[] = [
    {
      name: "export_pdf",
      description:
        "Render Markdown content to a PDF file and save it in the task workspace. " +
        "Supports headings, paragraphs, lists, code blocks, blockquotes, tables, and Unicode (Vietnamese).",
      shape: {
        markdown: z.string().describe("Nội dung markdown đầy đủ của báo cáo"),
        filename: z.string().describe("Tên file output, vd 'bao_cao_q1.pdf'"),
        title: z.string().optional().describe("Tiêu đề trang in to ở đầu PDF (tùy chọn)"),
      },
      handler: async ({ markdown, filename, title }) => {
        const outputPath = resolveOutput(workspaceDir, filename as string, "pdf");
        const result = await exportMarkdownToPdf(markdown as string, outputPath, title as string | undefined);
        return `Đã xuất PDF: ${path.basename(result.path)} (${(result.size / 1024).toFixed(1)} KB).`;
      },
    },

    {
      name: "export_docx",
      description:
        "Render Markdown content to a .docx (Word) file in the task workspace. " +
        "Headings, paragraphs, lists, code, blockquotes, and inline bold/italic supported.",
      shape: {
        markdown: z.string().describe("Nội dung markdown của tài liệu"),
        filename: z.string().describe("Tên file output, vd 'tai_lieu.docx'"),
        title: z.string().optional().describe("Tiêu đề ở đầu tài liệu (tùy chọn)"),
      },
      handler: async ({ markdown, filename, title }) => {
        const outputPath = resolveOutput(workspaceDir, filename as string, "docx");
        const result = await exportMarkdownToDocx(markdown as string, outputPath, title as string | undefined);
        return `Đã xuất DOCX: ${path.basename(result.path)} (${(result.size / 1024).toFixed(1)} KB).`;
      },
    },

    {
      name: "xlsx_write",
      description:
        "Ghi 1 file .xlsx ra workspace VỚI STYLE ĐẸP mặc định: header in đậm + nền " +
        "xanh nhạt + border + freeze row 1 + auto column width + zebra rows. Đây là " +
        "TOOL DUY NHẤT để tạo Excel (không có chain begin/add/finish). " +
        "Mỗi sheet truyền 1 lần đầy đủ: headers (sẽ in đậm + freeze) + rows data. " +
        "Per-sheet `style` optional để override preset (tắt zebra, đổi màu header, " +
        "set width tay). Use case: (a) user upload Excel rồi nhờ format lại — đọc " +
        "bằng read_xlsx, suy nghĩ structure, gọi xlsx_write 1 phát; (b) xuất data " +
        "tổng hợp / báo cáo bảng.",
      shape: {
        filename: z.string().describe("Tên file output, vd 'bao_cao_q1.xlsx' hoặc 'reports/q1.xlsx'"),
        sheets: z.array(z.object({
          name: z.string().describe("Tên sheet (max 31 ký tự, không [ ] : * ? / \\)"),
          headers: z.array(z.string()).optional().describe(
            "Tên cột — sẽ in đậm, nền màu, freeze. Bỏ qua nếu data thuần không có header."
          ),
          rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe(
            "Mảng 2 chiều rows DATA (không gồm header). Mỗi cell: string/number/boolean/null. " +
            "MẸO CÔNG THỨC: cell là chuỗi bắt đầu bằng '=' sẽ được ghi thành CÔNG THỨC EXCEL THẬT " +
            "(vd '=SUM(B2:B10)', '=A2*C2', '=B2/SUM(B:B)'). Excel sẽ tự tính khi mở file. " +
            "Tham chiếu ô theo lưới đã ghi (A1, B2...) tính cả dòng header nếu có."
          ),
          style: z.object({
            headerBold: z.boolean().optional(),
            headerFill: z.string().optional().describe("Hex 6 ký tự không '#' (default 'DCE6F1' xanh nhạt)"),
            border: z.boolean().optional(),
            freezeHeader: z.boolean().optional(),
            zebra: z.boolean().optional(),
            columnWidths: z.array(z.number()).optional().describe("Width từng cột (ký tự, vd 20). Bỏ qua = auto."),
          }).optional().describe("Override preset cho sheet này"),
        })).describe("Danh sách sheet để ghi"),
      },
      handler: async ({ filename, sheets }) => {
        const outputPath = resolveOutput(workspaceDir, filename as string, "xlsx");
        try {
          const result = await writeXlsx(sheets as SheetInput[], outputPath);
          return `Đã ghi ${path.basename(result.path)} (${(result.size / 1024).toFixed(1)} KB), ${result.sheets.length} sheet(s): ${result.sheets.join(", ")}.`;
        } catch (err) {
          const e = err as Error;
          console.error("[xlsx_write] failed:", e);
          return `Lỗi ghi file Excel: ${e.name}: ${e.message}. Báo lại user.`;
        }
      },
    },

    {
      name: "read_xlsx",
      description:
        "Đọc file .xlsx trong workspace, trả về TOÀN BỘ data dưới dạng JSON " +
        "({ sheets: [{ name, rowCount, colCount, rows }] }), KHÔNG cắt dòng. Dùng " +
        "trước khi gọi xlsx_write để format/restructure file user upload. " +
        "Ô CÓ CÔNG THỨC trả về dạng object { f: \"=SUM(A1:A2)\", v: <kết quả> } — " +
        "f là công thức, v là giá trị đã tính (ô thường vẫn là string/number/bool/null). " +
        "Muốn ghi lại công thức thì truyền chuỗi '=...' vào xlsx_write. Lưu ý: " +
        "file cực lớn có thể vượt context — khi đó cân nhắc xử lý bằng code (Bash).",
      shape: {
        filename: z.string().describe("Tên file xlsx trong workspace cần đọc, vd 'input.xlsx'"),
      },
      handler: async ({ filename }) => {
        const fullPath = resolveInput(workspaceDir, filename as string);
        if (!fullPath) return "Filename không hợp lệ.";
        let result;
        try {
          result = await readXlsx(fullPath);
        } catch (e) {
          return `Không đọc được Excel: ${e instanceof Error ? e.message : String(e)}`;
        }
        // No cap — return every sheet/row in full. The only ceiling now is the
        // model's context window; an over-large file surfaces as a request error.
        const out = result.sheets.map(s => ({
          name: s.name,
          rowCount: s.rowCount,
          colCount: s.colCount,
          rows: s.rows,
        }));
        return JSON.stringify({ sheets: out }, null, 2);
      },
    },

    {
      name: "read_pdf",
      description:
        "Đọc file PDF trong workspace, trả về text plain (extracted). Dùng khi user " +
        "upload PDF và muốn agent xử lý nội dung. KHÔNG đọc được PDF scan (image-only) " +
        "— chỉ PDF có text layer.",
      shape: {
        filename: z.string().describe("Tên file pdf trong workspace, vd 'data/bao-cao.pdf'"),
      },
      handler: async ({ filename }) => {
        const fullPath = resolveInput(workspaceDir, filename as string);
        if (!fullPath) return "Filename không hợp lệ.";
        try {
          const r = await readPdf(fullPath);
          return JSON.stringify({ pages: r.pages, text: r.text }, null, 2);
        } catch (e) {
          return `Không đọc được PDF: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },

    {
      name: "read_docx",
      description:
        "Đọc file .docx (Word) trong workspace, trả về text plain (extracted). Dùng " +
        "khi user upload Word và muốn agent xử lý nội dung. Format inline (bold/italic) " +
        "không được giữ — chỉ text thuần.",
      shape: {
        filename: z.string().describe("Tên file docx trong workspace, vd 'data/tai-lieu.docx'"),
      },
      handler: async ({ filename }) => {
        const fullPath = resolveInput(workspaceDir, filename as string);
        if (!fullPath) return "Filename không hợp lệ.";
        try {
          const r = await readDocx(fullPath);
          return JSON.stringify({ text: r.text, warnings: r.warnings.length > 0 ? r.warnings.slice(0, 5) : undefined }, null, 2);
        } catch (e) {
          return `Không đọc được DOCX: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },

    {
      name: "read_text",
      description:
        "Read an existing text-based file (txt, csv, json, md, html, etc.) from the task " +
        "workspace and return its content. Use this to inspect files the user uploaded.",
      shape: {
        filename: z.string().describe("Tên file text trong workspace cần đọc, vd 'data/input.csv'"),
      },
      handler: async ({ filename }) => {
        const fullPath = resolveInput(workspaceDir, filename as string);
        if (!fullPath) return "Filename không hợp lệ.";
        try {
          const buf = readFileSync(fullPath);
          return buf.toString("utf8");
        } catch (e) {
          return `Không đọc được file: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },

    {
      name: "export_dashboard",
      requiresAnySkill: ["design-slides"],
      description:
        "Generate an interactive HTML dashboard (KPI cards + Chart.js charts + tables) " +
        "and save it as an .html file. The file will be displayed in the DASHBOARD tab " +
        "for the user to review. Use this for BI / data-analyst output instead of static PDF.",
      shape: {
        spec: z.object({
          title: z.string().describe("Tiêu đề dashboard"),
          subtitle: z.string().optional().describe("Mô tả ngắn dưới tiêu đề"),
          kpis: z.array(z.object({
            label: z.string(),
            value: z.union([z.string(), z.number()]),
            change: z.number().optional().describe("% thay đổi vs kỳ trước"),
            format: z.enum(["number", "currency", "percent", "raw"]).optional(),
          })).optional().describe("KPI cards hàng đầu (3-6 thẻ nổi bật)"),
          charts: z.array(z.object({
            type: z.enum(["bar", "line", "pie", "doughnut", "area"]),
            title: z.string(),
            labels: z.array(z.string()).describe("Trục X / nhãn"),
            series: z.array(z.object({
              name: z.string(),
              values: z.array(z.number()),
              color: z.string().optional().describe("Hex color, vd '#fbbf24'"),
            })),
          })).optional(),
          tables: z.array(z.object({
            title: z.string(),
            columns: z.array(z.string()),
            rows: z.array(z.array(z.union([z.string(), z.number()]))),
          })).optional(),
        }).describe("Spec của dashboard"),
        filename: z.string().describe("Tên file output, vd 'dashboard_q1.html'"),
      },
      handler: async ({ spec, filename }) => {
        const outputPath = resolveOutput(workspaceDir, filename as string, "html");
        const result = await exportDashboard(spec as DashboardSpec, outputPath);
        return `Đã xuất dashboard: ${path.basename(result.path)} (${(result.size / 1024).toFixed(1)} KB). User có thể xem trong tab DASHBOARD.`;
      },
    },

    {
      name: "slide_template",
      requiresAnySkill: ["design-slides"],
      description:
        "Thư viện template slide ĐẸP dựng sẵn (HTML self-contained, chuẩn font tiếng Việt + spec). " +
        "Gọi KHÔNG tham số để liệt kê các style có sẵn; gọi với `name` để lấy MÃ HTML đầy đủ của style đó " +
        "(palette, font, CSS, component, chart) làm điểm khởi đầu chất lượng. Dùng khi user muốn deck đẹp: " +
        "chọn 1 style hợp nội dung rồi TÁI HIỆN phong cách đó với nội dung thật.",
      shape: {
        name: z.string().optional().describe("Tên style, vd '03-bold-pitch'. Bỏ trống = liệt kê danh sách."),
      },
      handler: async ({ name }) => {
        const dir = path.join(process.cwd(), "templates");
        if (!existsSync(dir)) return "Chưa có thư viện template (folder templates/ trống).";
        const files = readdirSync(dir).filter((f) => /^\d.*\.html$/i.test(f)).sort();
        if (files.length === 0) return "Thư viện template trống.";
        if (!name) {
          const list = files.map((f) => {
            let title = f;
            try {
              const m = readFileSync(path.join(dir, f), "utf8").match(/<title>([^<]*)<\/title>/i);
              if (m) title = m[1].trim();
            } catch { /* ignore */ }
            return `- ${f.replace(/\.html$/i, "")} — ${title}`;
          }).join("\n");
          return `Thư viện template slide. ĐƯA cho user 2 thứ: (1) chèn Y NGUYÊN dòng markdown sau để hiện NÚT mở menu (KHÔNG bọc backtick/code, giữ nhãn TIẾNG ANH y nguyên): [Open template menu](#mas-open-template) (bấm là mở menu preview trong trình duyệt); (2) liệt kê ngắn tên các mẫu bên dưới để user chọn theo số/tên. TUYỆT ĐỐI KHÔNG dùng URL http/localhost/port.\nDanh sách mẫu (hoặc gọi slide_template({name}) để lấy mã HTML):\n${list}`;
        }
        const base = String(name).replace(/[^a-zA-Z0-9._-]/g, "").replace(/\.html$/i, "");
        const file = path.join(dir, base + ".html");
        if (!existsSync(file)) return `Không thấy template "${base}". Gọi slide_template() (không tham số) để xem danh sách.`;
        try {
          return readFileSync(file, "utf8");
        } catch (e) {
          return `Không đọc được template: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },

    {
      name: "pptx_inspect_template",
      requiresAnySkill: ["design-slides"],
      description:
        "Đọc 1 file .pptx TEMPLATE trong workspace, trả về cấu trúc để THAM KHẢO thiết " +
        "kế hoặc tạo slide bám template: (a) `theme` = palette (theme colors hex: " +
        "dk1/lt1/accent1-6...) + fonts (major/minor) — dùng làm tham khảo màu/font khi " +
        "dựng deck HTML cho khớp brand; (b) `layouts` (TITLE, TITLE_AND_BODY, " +
        "TITLE_AND_TWO_COLUMNS, BIG_NUMBER, SECTION_HEADER...) để tạo slide chữ mới; " +
        "(c) `demo_slides` (kèm index + text) — index dùng cho pptx_export khi CLONE " +
        "giữ nguyên infographic. Gọi tool này TRƯỚC khi pptx_export, hoặc khi cần lấy " +
        "palette/font của template để thiết kế deck HTML.",
      shape: {
        filename: z.string().describe("Tên file .pptx template trong workspace, vd 'template.pptx'"),
      },
      handler: async ({ filename }) => {
        const fullPath = resolveInput(workspaceDir, filename as string);
        if (!fullPath) return "Filename không hợp lệ.";
        if (!existsSync(fullPath)) return `Không tìm thấy file template: ${filename}`;
        try {
          return await inspectTemplate(fullPath);
        } catch (e) {
          return `Không đọc được template pptx: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },

    {
      name: "pptx_export",
      requiresAnySkill: ["design-slides"],
      description:
        "Tạo file PowerPoint (.pptx) bám theo 1 template .pptx có sẵn trong workspace " +
        "(giữ nguyên màu/font/thiết kế của template). Mỗi phần tử trong `slides` là 1 " +
        "slide, theo 1 trong 2 kiểu:\n" +
        "• KIỂU LAYOUT (slide chữ mới): set `from_layout` = tên layout lấy từ " +
        "pptx_inspect_template, kèm `title`, `subtitle` (nếu layout có), `body` (mảng " +
        "bullet), `body_right` (cột phải nếu layout 2 cột).\n" +
        "• KIỂU CLONE (giữ infographic đẹp): set `clone_slide` = index demo slide từ " +
        "pptx_inspect_template, và `replace` = các cặp {find, with} để thay text trong " +
        "đó (thay cả số liệu, nhãn). KHÔNG set from_layout khi dùng clone.\n" +
        "Mặc định KHÔNG giữ các demo slide gốc — deck cuối chỉ gồm slide bạn định nghĩa, " +
        "đúng thứ tự. PHẢI gọi pptx_inspect_template trước để biết layout/index hợp lệ.",
      shape: {
        template_filename: z.string().describe(
          "Tên file .pptx template trong workspace (đã upload), vd 'template.pptx'"
        ),
        filename: z.string().describe("Tên file output, vd 'bao_cao_q1.pptx'"),
        slides: z.array(z.object({
          from_layout: z.string().optional().describe(
            "Tên layout (vd 'TITLE_AND_BODY') cho slide chữ tạo mới. Bỏ trống nếu là slide clone."
          ),
          title: z.string().optional().describe("Tiêu đề slide"),
          subtitle: z.string().optional().describe("Phụ đề (chỉ layout có placeholder SUBTITLE)"),
          body: z.array(z.string()).optional().describe("Các dòng bullet cho vùng nội dung"),
          body_right: z.array(z.string()).optional().describe("Bullet cột phải (layout 2 cột)"),
          clone_slide: z.number().int().optional().describe(
            "Index demo slide cần nhân bản giữ nguyên thiết kế (lấy từ pptx_inspect_template)"
          ),
          replace: z.array(z.object({
            find: z.string().describe("Chuỗi gốc trong slide clone"),
            with: z.string().describe("Chuỗi thay thế"),
          })).optional().describe("Các cặp thay text áp cho slide clone"),
        })).describe("Danh sách slide theo thứ tự xuất hiện"),
        keep_template_slides: z.boolean().optional().describe(
          "True = giữ luôn toàn bộ demo slide gốc của template (hiếm khi cần). Default false."
        ),
      },
      handler: async ({ template_filename, filename, slides, keep_template_slides }) => {
        const templatePath = resolveInput(workspaceDir, template_filename as string);
        if (!templatePath) return "template_filename không hợp lệ.";
        if (!existsSync(templatePath)) return `Không tìm thấy template: ${template_filename}. User cần upload file .pptx template vào workspace trước.`;
        const outputPath = resolveOutput(workspaceDir, filename as string, "pptx");
        try {
          const result = await generatePptx({
            template: templatePath,
            output: outputPath,
            slides: slides as PptxSlideSpec[],
            keep_template_slides: keep_template_slides as boolean | undefined,
          });
          return `Đã xuất PPTX: ${path.basename(result.path)} (${(result.size / 1024).toFixed(1)} KB), ${result.n_slides} slide.`;
        } catch (err) {
          const e = err as Error;
          console.error("[pptx_export] failed:", e);
          return `Lỗi tạo PowerPoint: ${e.message}. Báo lại user.`;
        }
      },
    },

    {
      name: "write_text",
      description:
        "Write any text content (markdown, txt, csv, json, html, etc.) to a file in the workspace. " +
        "Faster than Bash + echo for non-trivial content. Auto-creates parent folder. " +
        "Khi chỉ cần sửa vài chỗ trong file đã có, ưu tiên `edit_text` để tiết kiệm token.",
      shape: {
        content: z.string().describe("Nội dung file"),
        filename: z.string().describe("Tên file, vd 'notes.md', 'data.csv', 'report.html'"),
      },
      handler: async ({ content, filename }) => {
        const outputPath = resolveOutput(workspaceDir, filename as string, "txt");
        await writeFileAsync(outputPath, content as string, "utf8");
        const size = statSync(outputPath).size;
        return `Đã ghi ${path.basename(outputPath)} (${(size / 1024).toFixed(2)} KB).`;
      },
    },

    {
      name: "edit_text",
      description:
        "Sửa file text hiện có bằng exact-string replace. Rẻ hơn `write_text` rất nhiều " +
        "khi chỉ cần đổi vài chỗ trong file lớn (HTML, MD, CSV, JSON, code...). " +
        "old_string phải khớp chính xác và xuất hiện đúng 1 lần trong file. " +
        "Nếu chuỗi xuất hiện nhiều lần, mở rộng old_string bằng context xung quanh để duy nhất.",
      shape: {
        filename: z.string().describe("Tên file cần sửa, vd 'report.html', 'data.csv'"),
        old_string: z.string().describe("Chuỗi hiện có trong file (phải duy nhất)"),
        new_string: z.string().describe("Chuỗi thay thế"),
      },
      handler: async ({ filename, old_string, new_string }) => {
        const fullPath = resolveInput(workspaceDir, filename as string);
        if (!fullPath) return "Filename không hợp lệ.";
        let content: string;
        try {
          content = readFileSync(fullPath).toString("utf8");
        } catch (e) {
          return `Không đọc được file: ${e instanceof Error ? e.message : String(e)}`;
        }
        const oldStr = old_string as string;
        const newStr = new_string as string;
        if (oldStr.length === 0) return "old_string không được rỗng.";
        if (oldStr === newStr) return "old_string và new_string giống nhau, không có gì để sửa.";
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) return `Không tìm thấy chuỗi cần sửa trong ${path.basename(fullPath)}.`;
        if (occurrences > 1) {
          return `Chuỗi xuất hiện ${occurrences} lần trong ${path.basename(fullPath)}, không duy nhất. ` +
            `Mở rộng old_string bằng context xung quanh để chuỗi xuất hiện đúng 1 lần.`;
        }
        const next = content.replace(oldStr, newStr);
        await writeFileAsync(fullPath, next, "utf8");
        const size = statSync(fullPath).size;
        return `Đã sửa ${path.basename(fullPath)} (${(size / 1024).toFixed(2)} KB).`;
      },
    },
  ];
  // Skill-gating: drop tools the employee isn't licensed for (e.g. slides →
  // design-slides). Tools without `requiresAnySkill` stay available to all.
  return defs.filter(
    (d) => !d.requiresAnySkill || d.requiresAnySkill.some((s) => skills.includes(s)),
  );
}

/** Office tools that duplicate SDK built-ins (Write/Edit/Read). Omitted from
 *  the MCP surface when the SDK gives those tools to avoid agent confusion
 *  between two near-identical options. The OpenAI-compat backend still gets
 *  them via `officeToolDefs()` since that path has no SDK Bash. */
const SDK_DUPLICATES = new Set(["write_text", "edit_text", "read_text"]);

/**
 * Build an in-process MCP server with file-export tools, scoped to one task's
 * workspace directory. Used by the Claude Agent SDK backend. The OpenAI-
 * compatible backend consumes officeToolDefs() directly instead.
 *
 * When `omitSdkDuplicates` is true (default for the Claude path), the office
 * write_text/edit_text/read_text tools are filtered out because the SDK
 * already provides Write/Edit/Read — agent picking between two identical
 * options is noise.
 */
export function buildOfficeMcpServer(
  workspaceDir: string,
  taskId: string | null = null,
  opts: { omitSdkDuplicates?: boolean; skills?: string[] } = {},
) {
  const omit = opts.omitSdkDuplicates ?? true;
  return createSdkMcpServer({
    name: "office",
    version: "1.0.0",
    alwaysLoad: true,
    tools: officeToolDefs(workspaceDir, taskId, { skills: opts.skills })
      .filter(def => !omit || !SDK_DUPLICATES.has(def.name))
      .map(def =>
        tool(
          def.name,
          def.description,
          def.shape,
          async (args) => ({
            content: [{
              type: "text",
              text: await def.handler(args as Record<string, unknown>),
            }],
          }),
        ),
      ),
  });
}
