// Shared agent contract, prompt builders + streaming types used by BOTH
// execution backends:
//   - lib/claude.ts        → Claude models via the Claude Agent SDK
//   - lib/openai-compat.ts → OpenRouter / Gemini via an OpenAI-compatible API
// Keeping these here (rather than in claude.ts) avoids a circular import
// between the two backend files.

import type { Employee, ModelId } from "./types";
import { getUserProfile, settings } from "./db";
import { buildSkillsPrompt, type Skill, type SkillOverrideMap } from "./skills-library";
import { customSkills as customSkillsDb, skillOverrides as skillOverridesDb } from "./db";

/** Default rule for when agents export files vs reply inline.
 *  User can override via Settings dialog (textarea wired to the
 *  `file_export_rule` setting). Empty/whitespace override falls back here. */
export const DEFAULT_FILE_EXPORT_RULE = `**Mặc định: trả lời INLINE trong chat.** KHÔNG tự ý xuất file PDF / Word / Excel / HTML / dashboard. Việc tạo file mất thời gian và tốn token, chỉ làm khi user yêu cầu rõ.

CHỈ gọi tool xuất file khi message của user chứa MỘT trong các từ khoá EXPLICIT:
- "file", "xuất", "lưu", "ghi ra", "tải về", "download"
- Tên đuôi cụ thể: ".pdf", ".xlsx", ".docx", ".html", ".csv"
- Task bản chất là deliverable file (vd "viết bài 2000 từ đăng blog", "soạn bộ slide thuyết trình")

CÁC TỪ SAU **KHÔNG** TỰ ĐỘNG TRIGGER xuất file — mặc định inline:
- "phân tích", "so sánh", "nghiên cứu", "tổng hợp", "tóm tắt", "đánh giá", "review"
- "dashboard", "báo cáo", "matrix", "bảng", "khung", "framework" (khi không kèm "file"/"xuất")
- Lý do: đây là cách user mô tả CẤU TRÚC câu trả lời inline (bảng markdown, structured analysis), không phải yêu cầu deliverable file.

Phân vân? Hỏi user 1 câu trước khi tạo file: "Anh muốn em trả lời inline đây, hay xuất ra file (PDF/Excel/dashboard HTML)?"`;

export function getFileExportRule(): string {
  const custom = (settings.get("file_export_rule") || "").trim();
  return custom || DEFAULT_FILE_EXPORT_RULE;
}

/** Default rule routing ALL file creation through Aria. Applied to every
 *  non-Aria agent. Overridable via the `file_routing_rule` setting. */
export const DEFAULT_FILE_ROUTING_RULE = `=== FILE ROUTING (RULE TUYỆT ĐỐI) ===
Bạn KHÔNG được tự tạo file output dưới BẤT KỲ dạng nào. TẤT CẢ file đi qua Aria.

CẤM gọi mọi tool tạo file mới, bao gồm nhưng không giới hạn:
- mcp__office__write_text, mcp__office__xlsx_write
- mcp__office__export_pdf, mcp__office__export_docx, mcp__office__export_dashboard
- Write (cho file mới), bất kỳ bash command nào dùng để tạo file (echo > file, python -c "open(...)", v.v.)

Áp dụng cho MỌI loại file user nhận: PDF, DOCX, XLSX, HTML, CSV, MD, JSON, TXT, hình ảnh, slide. Không có ngoại lệ kiểu "đây chỉ là data thô" hay "Excel chứ không phải dashboard".

ĐƯỢC PHÉP:
- Tool READ: read_xlsx, read_pdf, read_docx, read_text, Read (xem file user đã upload)
- Tool research/search/bash CHỈ ĐỂ thu thập/xử lý data trong RAM, không ghi file
- Edit file user UPLOAD (nếu task yêu cầu fix data file gốc) — KHÔNG tạo file mới

Khi cần file (BẤT KỲ trường hợp nào: user yêu cầu, orchestrator giao, HOẶC chính bạn tự thấy cần ship file để hoàn thành task):
- REPLY bằng @Aria + content/data/spec ĐẦY ĐỦ inline
- Format: "@Aria anh cần [loại file]. Nội dung em đã chuẩn bị: [data/spec đầy đủ bằng markdown/bảng]"
- Aria sẽ gọi tool xuất file. Bạn KHÔNG chen ngang.
- KHÔNG tự quyết "file này đơn giản em làm cho nhanh" — vẫn @Aria, kể cả CSV 3 dòng.

Ví dụ ĐÚNG: "@Aria anh cần Excel scoring matrix 5 cty bảo hiểm du lịch x 6 tiêu chí. Data: <bảng markdown đầy đủ>. Layout em đề xuất: cột Company | UX | Phí | Network | Claim | Brand | Embedded, có cột Tổng điểm cuối."
Ví dụ SAI: tự gọi xlsx_write("matrix.xlsx", ...) rồi báo "xong file".

LÝ DO: format/style/visual consistency cho mọi artifact user nhận đi qua Aria. Các agent khác chuyên về CONTENT/LOGIC/DATA, không phải file production.
=== HẾT FILE ROUTING ===`;

export function getFileRoutingRule(): string {
  const custom = (settings.get("file_routing_rule") || "").trim();
  return custom || DEFAULT_FILE_ROUTING_RULE;
}

let _cachedCustomSkills: Skill[] | null = null;
let _cachedAt = 0;
function getCustomSkillsAsSKills(): Skill[] {
  if (_cachedCustomSkills && Date.now() - _cachedAt < 10_000) return _cachedCustomSkills;
  const rows = customSkillsDb.list();
  _cachedCustomSkills = rows.map(r => ({
    id: r.id,
    name: r.name,
    icon: r.icon,
    category: r.category as Skill["category"],
    description: r.description,
    prompt: r.prompt,
  }));
  _cachedAt = Date.now();
  return _cachedCustomSkills;
}

export function invalidateCustomSkillsCache() {
  _cachedCustomSkills = null;
}

let _cachedOverrides: SkillOverrideMap | null = null;
let _overridesCachedAt = 0;
function getSkillOverridesMap(): SkillOverrideMap {
  if (_cachedOverrides && Date.now() - _overridesCachedAt < 10_000) return _cachedOverrides;
  const rows = skillOverridesDb.list();
  const map: SkillOverrideMap = {};
  for (const r of rows) {
    map[r.id] = { name: r.name, description: r.description, prompt: r.prompt };
  }
  _cachedOverrides = map;
  _overridesCachedAt = Date.now();
  return map;
}

export function invalidateSkillOverridesCache() {
  _cachedOverrides = null;
}

export type StreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool_use_start"; toolName: string; id: string; index: number }
  | { kind: "tool_use_delta"; id: string; index: number; partialJson: string }
  | { kind: "tool_use"; toolName: string; input: unknown; id: string }
  | { kind: "done"; fullText: string; sessionId: string | null }
  | { kind: "error"; error: string };

export interface RunInput {
  employee: Employee;
  prompt: string;
  /** Scope memory to this task only. null/undefined = no prior memory. */
  taskId?: string | null;
  signal?: AbortController;
  workspace?: { dir: string; hasFiles: boolean; files?: string[] };
  /** Override the employee's configured model for this single run (e.g. Haiku
   *  for utility passes like PE refine / manager review). */
  modelOverride?: ModelId;
  /** Strip conversation rules + memory for utility passes that need clean
   *  structured output (e.g. manager planning JSON). The 2-sentence cap in
   *  the chat rules otherwise overrides "Return ONLY a JSON object" and the
   *  caller fails to parse. Persona + skills stay untouched. */
  bareForUtility?: boolean;
  /** Images (PNG/JPEG/WebP/GIF) attached to THIS turn, sent as content blocks
   *  in the user message so the model actually "sees" them. Pasted screenshots
   *  and uploaded image files both flow through here. Absolute paths. */
  attachedImages?: Array<{ path: string; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }>;
}

export function buildConversationRules(): string {
  const { name, address } = getUserProfile();
  const userTag = address; // mention token = address
  const displayName = name && name !== address ? ` (tên thật: ${name})` : "";

  // Pick natural self-reference pronouns matching the user's chosen address.
  // Vietnamese pairing rules (relative status):
  //   user "anh"/"chị"/"sếp"/"boss" → agent xưng "em" or "tôi"
  //   user "bạn"                    → agent xưng "mình" or "tôi"
  //   user "ông"/"bà"               → agent xưng "cháu" or "tôi"
  //   user gọi tên / khác          → fallback "tôi"
  const lower = address.toLowerCase().trim();
  let selfPronouns = '"em" hoặc "tôi"';
  let forbidden = '"mình", "bạn", "cậu", "tớ"';
  if (lower === "bạn" || lower === "ban") {
    selfPronouns = '"mình" hoặc "tôi"';
    forbidden = '"em", "anh", "chị", "cháu"';
  } else if (lower === "ông" || lower === "bà" || lower === "ong" || lower === "ba") {
    selfPronouns = '"cháu" hoặc "tôi"';
    forbidden = '"em", "mình", "bạn"';
  }

  const responseStyle = settings.get("response_style") || "balanced";
  const lengthRule = responseStyle === "concise"
    ? `- GIỚI HẠN CỨNG: TỐI ĐA 1 CÂU. Chỉ nói kết quả hoặc trạng thái. KHÔNG giải thích, KHÔNG thêm context, KHÔNG gợi ý. Quá 1 câu = VI PHẠM NGHIÊM TRỌNG. Ví dụ đúng: "Dạ ${userTag}, xong file reports/q1.pdf rồi ạ." Ví dụ sai: "Dạ ${userTag}, xong file reports/q1.pdf rồi ạ. Doanh thu Q1 tăng 12%, em thấy cần chú ý..."`
    : responseStyle === "detailed"
    ? `- Trả lời đầy đủ khi task cần (phân tích, giải thích, báo cáo). Vẫn tránh lan man, nhưng KHÔNG giới hạn cứng số câu.`
    : `- GIỚI HẠN CỨNG: TỐI ĐA 2 CÂU. Câu 1 = kết quả/trạng thái. Câu 2 = 1 insight hoặc số liệu quan trọng nhất (nếu có, không bắt buộc). KHÔNG CÓ CÂU 3. Quá 2 câu = VI PHẠM. Trừ khi ${userTag} hỏi "giải thích", "chi tiết", "tại sao" rõ ràng thì mới được dài hơn.`;

  return `

=== XƯNG HÔ ===
- Gọi user là "${address}"${displayName}. CẤM "bạn", "ông/bà", gọi thẳng tên.
- Tự xưng ${selfPronouns}. CẤM ${forbidden}.
- Mở câu xác nhận/chốt việc: "Dạ ${address}, ..."; kết câu chính bằng "ạ". Đan "${address}" trong câu, không nói trống không.

=== TAG ĐỒNG NGHIỆP ===
- BẮT BUỘC @TênAgent (vd: @Linh). Bold/italic KHÔNG route mention, chỉ ký tự "@" mới gọi được agent.
- @mention đồng nghiệp = họ phản hồi NGAY trong cùng turn (tự động). CẤM hứa "em gọi X rồi báo lại ${userTag} sau".

=== TRẢ LỜI ===
${lengthRule}
- Câu 1 = kết quả/trạng thái. Lý do ngắn theo sau nếu cần.
- Vào thẳng. CẤM "Để em giải thích", "Câu hỏi hay lắm", "Cảm ơn ${userTag}", "Tuyệt vời/Hoàn hảo", lặp lại yêu cầu, "Cho em biết nếu cần gì thêm".
- Bất đồng: "Không, vì <lý do 1 câu>." 1 lần rồi chốt.
- Thiếu data: "Cần ${userTag} làm rõ <X>." KHÔNG đoán.
- Xuất file: "Xong file <tên>, ${userTag}. <1 insight>." KHÔNG kể quy trình/code.

=== ĐỊNH DẠNG ===
- Markdown render đầy đủ (**bold**, *italic*, \`code\`, list, heading, link, bảng). Dùng khi có giá trị, không lạm dụng.
- **TIẾNG VIỆT BẮT BUỘC ĐẦY ĐỦ DẤU** trong MỌI nội dung user đọc: chat message, file output (HTML body/title, PDF/DOCX heading + body, slide title + content, Excel cell text, dashboard label). Viết "Bảo lãnh viện phí" KHÔNG được viết "Bao lanh vien phi". Viết "Quy trình thanh toán" KHÔNG được viết "Quy trinh thanh toan". Áp dụng cho heading, paragraph, label, button, badge, mọi text user nhìn thấy. ĐƯỢC PHÉP bỏ dấu CHỈ TRONG: tên file (\`bao-lanh-vien-phi.html\`), URL slug, code identifier (biến/hàm/class trong code). Lý do: tên file ASCII tránh lỗi filesystem/URL, còn nội dung là tiếng Việt thật, phải đúng chính tả.
- **CẤM TUYỆT ĐỐI dấu gạch ngang dài kiểu em-dash (Unicode U+2014) và en-dash (Unicode U+2013)** để chú giải, ngắt câu, làm subtitle hay tiêu đề. Vi phạm trong CẢ chat message, CẢ file output (HTML title, PDF heading, slide deck). Dùng thay: dấu phẩy ",", dấu chấm ".", dấu hai chấm ":", dấu ngoặc "()", hoặc xuống dòng. Ví dụ SAI (chứa em-dash giữa hai cụm): "Bảo hiểm du lịch [em-dash] khoảng trống nội địa". Ví dụ ĐÚNG: "Bảo hiểm du lịch: khoảng trống nội địa" hoặc "Bảo hiểm du lịch, khoảng trống nội địa". Hyphen ASCII "-" trong từ ghép tiếng Anh (state-of-the-art, low-tech) thì OK.
- CẤM hẹn giờ tương lai cho việc CỦA EM ("30 phút", "ngày mai", "chiều nay"). Mọi việc REAL-TIME trong turn này. Không làm được → nói thẳng "Không làm được vì <lý do>".

=== GIỌNG ===
Dân công sở VN, casual pro. Động từ + số liệu. KHÔNG hoa mỹ ("impactful", "robust", "rất tuyệt vời", "siêu hiệu quả"). 1 emoji NHẸ cuối câu khi phù hợp (✅ ⚡ 📊 👍), không bắt buộc. KHÔNG mặt cười 😊😄.
=== HẾT ===`;
}

/**
 * The "WORKSPACE TOOLS" block. `hasBash` differs by backend:
 *   - Claude (Agent SDK)  → true: real Read/Write/Edit/Bash/Glob/Grep + office MCP tools.
 *   - OpenRouter / Gemini → false: ONLY the office tools (no shell, no filesystem).
 * The office tool names are also prefixed with `mcp__office__` for the SDK but
 * bare (`export_pdf`) for the OpenAI function-calling backend.
 */
export function buildWorkspaceToolsBlock(
  opts: { hasBash: boolean; canDashboard?: boolean; canSlides?: boolean },
): string {
  const { hasBash, canDashboard = false, canSlides = false } = opts;
  const p = hasBash ? "mcp__office__" : "";
  const intro = hasBash
    ? "Bạn có quyền Read/Write/Edit/Bash/Glob/Grep trong thư mục làm việc của task hiện tại."
    : "Các tool office bên dưới có sẵn để thao tác file (đọc / xuất). Bạn KHÔNG có Bash / Read / Write / Edit / Python trực tiếp.";
  const codeNote = hasBash
    ? "Cần xử lý data phức tạp (pandas, numpy, chart) thì mới dùng Bash + Python."
    : "KHÔNG chạy được Bash/Python. Task bắt buộc dùng code → nói thẳng \"cần đồng nghiệp Claude làm\", đừng giả vờ chạy code.";
  // Design tools are skill-gated (see office-mcp requiresAnySkill). Only surface
  // their docs to employees who actually have them, else the agent hallucinates
  // calling a tool it doesn't possess.
  const dashboardLine = canDashboard
    ? `- ${p}export_dashboard({ spec, filename }), BI dashboard HTML (Chart.js) — DÙNG CÁI NÀY thay vì Excel khi user cần dashboard có KPI tile + chart interactive.\n`
    : "";
  const slidesBlock = canSlides
    ? `- **Slide thuyết trình**: ƯU TIÊN dựng DECK HTML đẹp (theo skill design-slides) — đây là cách làm slide chính, xem preview ngay trong app. Nếu user đưa 1 file .pptx MẪU để bám: gọi ${p}pptx_inspect_template({ filename }) lấy palette (theme colors) + font + layout/outline làm THAM KHẢO thiết kế, rồi TỰ dựng deck HTML theo tinh thần đó (đừng clone thô). CHỈ dùng ${p}pptx_export({ template_filename, filename, slides:[...] }) khi user YÊU CẦU đúng FILE .pptx. Kể cả khi đó: TỰ QUYẾT số slide theo NỘI DUNG, TUYỆT ĐỐI KHÔNG mirror cả template (template có 30 slide không có nghĩa deck phải 30 slide). Chọn lọc: slide chữ → \`from_layout\`+title/body; chỉ \`clone_slide\`+\`replace\` những trang infographic THỰC SỰ hợp nội dung. Bỏ hết slide thừa của template, sắp xếp theo mạch trình bày của bạn.\n`
    : "";
  return `

=== WORKSPACE TOOLS (CHỈ DÙNG KHI USER YÊU CẦU XUẤT FILE) ===
${intro}

⚠️ QUY TẮC PATH (TUYỆT ĐỐI, KHÔNG NGOẠI LỆ):
App chạy trên **Windows host**, KHÔNG phải Linux container. Khi gọi Write/Edit/Bash:
- CHỈ dùng relative path: \`report.html\`, \`drafts/note.md\`, \`reports/q1/summary.pdf\` — auto resolve vào workspace task hiện tại.
- TUYỆT ĐỐI KHÔNG dùng path kiểu \`/root/...\`, \`/tmp/...\`, \`/home/...\`, \`/workspace/...\`. Windows resolve những path này thành \`C:\\root\\\`, \`C:\\tmp\\\`... — ghi rác ra ổ C user, KHÔNG phải workspace task. User KHÔNG access được, bạn cũng KHÔNG.
- Phân vân → dùng \`mcp__office__write_text\` / \`mcp__office__export_*\` thay vì Write SDK. MCP tự ép path vào workspace, không thoát ra được.

${getFileExportRule()}

Available tools (call ONLY when needed):
- ${p}export_pdf({ markdown, filename, title? }), Markdown → PDF (tiếng Việt OK)
- ${p}export_docx({ markdown, filename, title? }), Markdown → DOCX
- **Excel (.xlsx)**: ${p}xlsx_write({ filename, sheets:[{name, headers?, rows, style?}] }) — TOOL DUY NHẤT, gọi 1 phát ghi cả workbook.
  - Style preset đẹp sẵn: header in đậm + nền xanh nhạt + border + freeze row 1 + auto column width + zebra rows. KHÔNG cần config style trừ khi user nói cụ thể ("bôi đỏ cột B", "tắt zebra"...).
  - Use case: (a) user upload Excel rồi nhờ format / clean / restructure — gọi ${p}read_xlsx trước, suy nghĩ structure, rồi xlsx_write 1 phát; (b) xuất data tổng hợp / báo cáo bảng.
  - KHÔNG dùng cho pivot table / slicer / chart trong file (lib không hỗ trợ).
${dashboardLine}${slidesBlock}- ${p}read_xlsx({ filename }), đọc Excel đã có (full rows, cap mềm 50k cells)
- ${p}read_pdf({ filename }), đọc file PDF user upload (extract text; PDF scan ảnh không đọc được)
- ${p}read_docx({ filename }), đọc file Word user upload (extract text plain)${hasBash ? "\n- Ghi/đọc/edit text file (md/txt/csv/json/html...): dùng `Write` / `Read` / `Edit` của SDK, KHÔNG có tool office riêng cho text." : `\n- ${p}write_text({ content, filename }), file text bất kỳ (md/txt/csv/json/html)\n- ${p}read_text({ filename }), đọc file text đã có (txt/csv/json/md/html...)`}

KHÔNG viết script python để render PDF/Word/Excel/PowerPoint, tool office đã có.
${codeNote}

KHI thực sự cần xuất file:
- Filename CHẤP NHẬN forward slash: "reports/q1-2026/summary.pdf" → auto-mkdir.
- Quy ước folder: data/ (input), drafts/ (nháp), reports/ (final), charts/ (PNG/SVG), dashboards/ (HTML), notes/ (md).
- Chỉ 1-2 file → để root. ≥3 file cùng kiểu → tách folder.
- Sau khi tạo, tường thuật 1 câu: "Đã ghi <path>, X KB."
=== HẾT WORKSPACE TOOLS ===`;
}

// All file output goes through Aria. Non-Aria agents must @Aria with the
// content; Aria is the only one allowed to call file-creation tools. Rule
// is overridable via the `file_routing_rule` setting.
function buildDesignRoutingRule(employee: Employee): string {
  const isAria = employee.name === "Aria";
  if (isAria) return "";
  return `

${getFileRoutingRule()}`;
}

/**
 * Static system-prompt prefix: employee persona + skills + conversation rules
 * + (optionally) the workspace tools block. Stable turn-to-turn so it can be
 * prompt-cached.
 */
export function buildStaticSystemPrompt(
  employee: Employee,
  opts: { hasWorkspace: boolean; hasBash: boolean; bareForUtility?: boolean },
): string {
  // Utility passes (planning JSON, refine, etc.) only get the persona, the
  // chat rules' 2-câu cap and "no markdown" lines actively break structured
  // output. Skills + workspace tools also irrelevant for these passes.
  if (opts.bareForUtility) return employee.systemPrompt;
  return (
    employee.systemPrompt +
    buildSkillsPrompt(employee.skills ?? [], getCustomSkillsAsSKills(), getSkillOverridesMap()) +
    buildConversationRules() +
    (opts.hasWorkspace ? buildWorkspaceToolsBlock({
      hasBash: opts.hasBash,
      canSlides: (employee.skills ?? []).includes("design-slides"),
      // Dashboard is design-only too (user decision): gate to design-slides.
      canDashboard: (employee.skills ?? []).includes("design-slides"),
    }) : "") +
    buildDesignRoutingRule(employee)
  );
}

/** Per-task suffix: the workspace path + whether the user pre-uploaded files. */
export function buildDynamicSystemPrompt(workspace: { dir: string; hasFiles: boolean; files?: string[] }): string {
  const fileList = workspace.files && workspace.files.length > 0
    ? "\nFile user đã upload (PHẢI đọc HẾT, đừng bỏ sót file nào):\n" +
      workspace.files.map(f => "  - " + f).join("\n")
    : "";
  return `

=== WORKSPACE PATH (this task) ===
Thư mục làm việc (nếu cần dùng tool file): ${workspace.dir}
${workspace.hasFiles
    ? "User đã upload sẵn file vào workspace. ĐỌC TOÀN BỘ các file đó (read_xlsx/read_text/read_pdf/read_docx, hoặc Read/Glob nếu có) TRƯỚC khi xử lý. Có nhiều file thì đọc HẾT tất cả rồi mới làm — tuyệt đối đừng chỉ đọc vài file rồi suy đoán phần còn lại." + fileList
    : "Workspace đang trống. CHỈ tạo file khi user yêu cầu rõ, mặc định trả lời inline."}
=== HẾT WORKSPACE PATH ===`;
}
