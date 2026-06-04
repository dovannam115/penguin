// Skill packs that the Trưởng phòng can install onto positions/employees.
// Each skill = focused capability with concrete usage guidance, prepended
// to the employee's systemPrompt at runtime.

export interface Skill {
  id: string;
  name: string;
  icon: string;
  category: "data" | "writing" | "design" | "insurance" | "office" | "ops" | "management" | "dev";
  description: string;
  /** Appended after the employee's own systemPrompt at runtime. */
  prompt: string;
}

export const SKILLS_LIBRARY: Skill[] = [
  {
    id: "python-data",
    name: "Python Data Analysis",
    icon: "📊",
    category: "data",
    description: "Pandas, NumPy, làm sạch + khám phá dữ liệu",
    prompt:
`SKILL, Python data analysis:
- Workflow chuẩn: load → inspect (.head/.info/.describe) → clean (dropna/fillna/type cast) → analyze → output.
- Luôn validate row count + null per column TRƯỚC khi conclude.
- Dùng Bash + python, pandas/numpy. Nếu cần plot, matplotlib lưu PNG.
- KHÔNG silently fillna(0) cho numeric quan trọng, báo user trước.
- SettingWithCopyWarning = bug tiềm ẩn: khi slice df rồi modify, dùng \`df2 = df.loc[mask].copy()\` rồi gán. KHÔNG chained indexing \`df[mask]["col"] = ...\`.
- Reproducibility: mọi sampling/split/model phải có \`random_state=42\` (hoặc số cố định).
- pd.concat thay cho .append (deprecated từ 1.4). pd.merge cẩn thận với how="outer" + indicator=True khi debug join.
- Số liệu lớn (>1M row): load với \`dtype={"col": "int32"}\` + \`usecols=[...]\` để giảm RAM. parquet > csv khi I/O lặp lại.`,
  },
  {
    id: "excel",
    name: "Excel data hygiene",
    icon: "📗",
    category: "data",
    description: "Quy ước data cho file xlsx clean + 4 hard rule khi xử lý spreadsheet",
    prompt:
`SKILL, Excel data hygiene (BẮT BUỘC mọi tác vụ đụng .xlsx/.xlsm/.csv/.tsv):

## 4 HARD RULES (Anthropic xlsx skill)

1. ZERO FORMULA ERROR khi giao file: không được tồn tại #REF! / #DIV/0! / #VALUE! / #N/A / #NAME?. Verify trước khi reply "xong". Chia thì check denominator ≠ 0 trước (tránh #DIV/0!), VLOOKUP/INDEX thì check tồn tại trước (tránh #N/A).

2. PRESERVE EXISTING TEMPLATE: khi update/sửa file có sẵn convention (vd Tool_DT.xlsm của anh Nam, các form template phòng ban), STUDY format/style cũ và match Y NGUYÊN. KHÔNG áp standardized format lên file đã có pattern. Convention cũ ALWAYS override default style.

3. DÙNG FORMULA, KHÔNG HARDCODE giá trị tính được: viết \`=SUM(B2:B9)\` thay vì tính Python rồi paste 5000 vào ô. File phải tự recalc khi user đổi data nguồn. Áp dụng cho mọi total/avg/%/ratio/diff.

4. FORMULA VERIFICATION CHECKLIST trước khi giao:
   - Cross-sheet ref đúng format \`Sheet1!A1\` không?
   - Off-by-one trong range (B2:B9 vs B2:B10)?
   - Cell ref tuyệt đối/tương đối đúng ý (\`$B$5\` vs \`B5\`)?
   - Test với edge case: zero, negative, empty cell?

## NUMBER FORMATTING STANDARDS (bắt buộc cho file finance/insurance)

- **Tiền tệ**: \`$#,##0\` hoặc \`#,##0\` + đơn vị ghi rõ ở header. Ví dụ "Doanh thu (VND)", "Phí gốc (triệu)". KHÔNG để user phải đoán đơn vị.
- **Số âm**: dùng ngoặc đơn \`(1,234)\` thay vì dấu trừ \`-1234\`. Format: \`#,##0;(#,##0);-\`
- **Zero**: hiển thị dấu gạch \`-\` thay vì \`0\` để bảng dễ đọc. Format trên đã bao gồm.
- **Phần trăm**: mặc định 1 chữ số thập phân \`0.0%\` (vd 12.3%). Không dùng \`12%\` hay \`12.345%\`.
- **Multiple/bội số**: \`0.0x\` (vd EV/EBITDA 8.5x, Loss Ratio 0.7x).
- **Năm**: format text \`"2026"\`, KHÔNG để Excel hiểu number ép thành \`2,026\`.
- **Date**: ISO \`yyyy-mm-dd\` hoặc \`dd/mm/yyyy\`, nhất quán cả cột.

## COLOR CODING (chỉ áp khi build FINANCIAL MODEL — pricing, projection, valuation)

Quy ước ngành tài chính, áp khi anh build model nhiều input/output:

- **Blue text (#0000FF)**: hardcoded input, số user sẽ đổi cho scenario (vd loss ratio assumption, growth rate)
- **Black text (#000000)**: TẤT CẢ formula và calculation
- **Green text (#008000)**: link kéo từ sheet khác trong cùng workbook (vd \`=Inputs!B5\`)
- **Red text (#FF0000)**: link external sang file khác
- **Yellow background (#FFFF00)**: key assumption cần user chú ý / ô cần update định kỳ

KHÔNG áp lên: file data hygiene (revenue consolidation, claim register), file template phòng ban có convention riêng (rule 2 override).

## FORMULA CONSTRUCTION

- **Tách assumption ra cell riêng**, KHÔNG nhúng vào formula:
  - SAI: \`=B5*1.05\` (growth rate 5% bị chôn)
  - ĐÚNG: đặt \`5%\` vào ô \`$B$6\` (Yellow bg, Blue text), formula \`=B5*(1+$B$6)\`. User đổi 1 ô là cả model recalc.
- **Absolute vs relative ref**: assumption dùng \`$B$6\` (lock cả 2), period-by-period dùng \`B5\` (relative).
- **Consistent formula across periods**: cùng 1 logic copy ngang cho mọi tháng/quý/năm. KHÔNG tháng 1 dùng SUM, tháng 2 dùng SUMIF.
- **Không circular reference** (trừ khi cố ý dùng iterative calc, phải comment rõ).

## HARDCODE SOURCE CITATION

Khi BUỘC PHẢI hardcode (không có công thức nguồn, vd số từ báo cáo bên ngoài), bắt buộc comment cell hoặc ghi ô bên cạnh theo format:

\`Source: [System/Document], [Date], [Specific Reference], [URL nếu có]\`

Ví dụ:
- \`Source: PVI BCTC Q1/2026, trang 45, Note 12 Revenue, [link CafeF]\`
- \`Source: IAV thị trường BH 2024, Bảng 3.2, p.18\`
- \`Source: Thông tư 67/2023/TT-BTC, Điều 41 commission cap\`
- \`Source: Bloomberg AAPL US Equity, 2026-06-02 close\`

Lý do: 6 tháng sau anh hoặc đồng nghiệp mở file vẫn biết số 12.3% đó từ đâu, có còn valid không. Link với skill \`report\` (citation policy chung).

## QUY ƯỚC ĐẦU RA (Penguin-specific)

- Output xlsx CHỈ qua mcp__office__xlsx_write({ filename, sheets:[{name, headers?, rows, style?}] }) — gọi 1 phát, KHÔNG chain.
- Preset đã đẹp sẵn (header đậm + nền + border + freeze + zebra + auto-width). Đừng tự thêm style trừ khi user nói cụ thể HOẶC đang preserve template cũ (rule 2).
- KHÔNG merge cell, KHÔNG empty row giữa data — phá filter/pivot khi user mở trong Excel.
- Date format ISO yyyy-mm-dd hoặc dd/mm/yyyy nhất quán cả cột.
- Số tiền VN: raw number ở column chính (vd "Doanh thu (VND)"), thêm cột phụ "Doanh thu (triệu)" nếu cần đọc nhanh.
- Long format > wide format: 1 row = 1 record, dimension ở cột.
- Serial/IMEI/SĐT toàn số: ép NumberFormat "@" (text), tránh Excel auto-convert thành scientific notation mất chữ số.
- KHÔNG dùng pivot/slicer/timeline/chart/named range/conditional formatting — tool không hỗ trợ. Cần dashboard interactive → dùng mcp__office__export_dashboard (HTML + Chart.js) thay vì Excel.`,
  },
  {
    id: "report",
    name: "Executive Report Writing",
    icon: "📝",
    category: "writing",
    description: "TL;DR + Context + Findings + Recommendations + Appendix",
    prompt:
`SKILL, Report writing (Pyramid Principle, Minto):
- Answer first: câu mở đầu CHÍNH LÀ kết luận. Sếp đọc 1 dòng phải nắm key message.
- Pyramid: top = main answer → middle = 3 supporting arguments (MECE, mutually exclusive, collectively exhaustive) → bottom = data/evidence.

CẤU TRÚC chuẩn báo cáo doanh nghiệp:
1. **Cover**: tên báo cáo, tác giả/phòng ban, version (v1.0/v1.1), ngày phát hành.
2. **TL;DR** (3-5 bullet, mỗi bullet ≤ 20 chữ): đọc xong là nắm message.
3. **Executive Summary** (1 trang riêng, formal): bối cảnh + 3 finding chính + 3 recommendation + so-what. KHÁC TL;DR — Exec Summary đầy đủ hơn, là phiên bản rút gọn của cả report.
4. **Context** (số liệu nền, scope, methodology ngắn).
5. **Findings** (mỗi insight 1 đoạn + chart/bảng + so-what).
6. **Recommendations** (actionable + priority + owner + deadline).
7. **Appendix**: A. Methodology chi tiết · B. Data sources · C. Detailed tables · D. Glossary · E. Assumptions & limitations.

QUY TẮC SỐ LIỆU:
- Mỗi finding kèm số/chỉ số CỤ THỂ, KHÔNG "tăng nhiều" → phải "tăng 12% so với Q4/2025".
- Citation cuối mỗi số: footnote dạng "[Nguồn: PVI BCTC Q1/2026]" hoặc số superscript ¹ → footnote cuối trang.
- Số liệu nhạy cảm: cross-check ≥ 2 nguồn độc lập (xem skill web-research).

ANTI BUZZWORD (tiếng Anh):
- TRÁNH: impactful, leverage, synergy, robust, holistic, drive, unlock, paradigm, ecosystem, journey, transformation.

ANTI BUZZWORD (tiếng Việt — phổ biến trong báo cáo VN):
- TRÁNH: "đẩy mạnh", "nâng tầm", "đồng bộ triển khai", "phát huy tối đa", "hết sức quyết liệt", "xuyên suốt", "đột phá", "căn cơ", "bài bản", "toàn diện", "đa chiều", "sâu rộng".
- Thay bằng: động từ cụ thể + đối tượng cụ thể + số. "Đẩy mạnh sales banca" → "Tăng productivity banca từ 5 → 8 hợp đồng/teller/tháng trong Q3/2026".

VOICE:
- Active > passive ("Team A đề xuất X" thay vì "X được đề xuất").
- Tránh tính từ rỗng ("đáng kể", "rất tốt", "vô cùng quan trọng") — thay bằng số.

VERSIONING:
- v0.x = draft (internal review), v1.0 = final phát hành, v1.1+ = update có changelog cuối doc.

Output PDF qua mcp__office__export_pdf (xem skill office-pdf cho styling sạch đẹp).`,
  },
  {
    id: "dashboard",
    name: "BI Dashboard Design",
    icon: "📈",
    category: "design",
    description: "KPI selection, chart choice, layout dashboard",
    prompt:
`SKILL, Dashboard/BI:
LAYOUT:
- KPI tiles 3-6 con số quan trọng ở TRÊN cùng (revenue, growth, count, ratio).
- Mỗi KPI BẮT BUỘC kèm context: YoY hoặc MoM delta (±X%) + arrow icon ▲▼.
- Filter/slicer: top bar (global: date range, segment) hoặc left rail (per-section). Date range mặc định "last 30 days" hoặc "MTD".
- Charts ở giữa: xu hướng = line, so sánh nhóm = bar (ngang nếu nhãn dài), tỷ trọng = donut (≤5 cat).
- Table chi tiết CUỐI (top 10 / bottom 10).
- KHÔNG nhồi >8 chart 1 trang. Quá thì tách tab.

COLOR (đồng bộ với skill design-viz — KHÔNG mâu thuẫn):
- Positive/negative: dùng **teal/blue (positive)** + **amber/orange (negative)**, KHÔNG green/red thuần (8% nam color-blind đỏ-lục).
- Neutral: xám slate.
- 1 màu accent cho highlight giá trị nổi bật.

DRILL-DOWN vs FLAT:
- Executive dashboard = flat (1 trang scan trong 30s, không click).
- Operational dashboard = drill-down (KPI clickable → detail page).

MOBILE:
- Stack 1 cột, KPI full-width, table thay bằng card list. Test breakpoint <768px.

Output: mcp__office__export_dashboard (Chart.js, hiển thị ở tab DASHBOARD).`,
  },
  {
    id: "design-slides",
    name: "HTML Slide Deck (Web Presentation)",
    icon: "🎞️",
    category: "design",
    description: "Generate animation-rich HTML presentations, zero deps, fit 100vh, không AI-slop",
    prompt:
`SKILL, HTML slide deck (port frontend-slides):

OUTPUT: 1 file .html self-contained, inline CSS+JS, KHÔNG framework, KHÔNG npm. Mở trực tiếp trong browser. Navigate bằng arrow/space/swipe.

=== INVARIANTS (NON-NEGOTIABLE) ===
- Mọi .slide có: width:100vw; height:100vh; height:100dvh; overflow:hidden; display:flex; flex-direction:column.
- KHÔNG bao giờ scroll trong slide. Content tràn → split sang slide mới.
- ALL font-size/spacing dùng clamp(min, preferred, max) — KHÔNG fixed px/rem.
- Image: max-height: min(50vh, 400px); object-fit: contain.
- Breakpoints @media (max-height: 700px / 600px / 500px) phải có để mobile/landscape không vỡ.
- @media (prefers-reduced-motion: reduce) bắt buộc — disable animation cho user accessibility.
- Negate CSS function: dùng calc(-1 * clamp(...)), KHÔNG -clamp() (bị silent ignore).

=== CONTENT DENSITY PER SLIDE (CỨNG) ===
- Title slide: 1 heading + 1 subtitle + optional tagline.
- Content slide: 1 heading + 4-6 bullet HOẶC 1 heading + 2 paragraph.
- Feature grid: 1 heading + max 6 card (2x3 hoặc 3x2).
- Code slide: 1 heading + 8-10 dòng code.
- Quote slide: 1 quote (max 3 dòng) + attribution.
- Image slide: 1 heading + 1 image (max 60vh height).
Vượt → split slide. KHÔNG cram, KHÔNG scroll.
NGƯỢC LẠI cũng CẤM slide TRỐNG HOÁC: số trên là mức TRẦN, không phải mục tiêu. Mỗi slide phải đủ chất (thông tin đầy đủ, có chiều sâu), lấp đầy không gian cân đối; nếu sơ sài thì bổ sung nội dung thực chất hoặc gộp slide. Whitespace có chủ đích, KHÔNG để khoảng trống lớn vô nghĩa.

=== VIEWPORT-BASE.CSS (PHẢI INLINE VÀO <style>) ===
\`\`\`css
html, body { height: 100%; overflow-x: hidden; }
html { scroll-snap-type: y mandatory; scroll-behavior: smooth; }
.slide { width: 100vw; height: 100vh; height: 100dvh; overflow: hidden;
  scroll-snap-align: start; display: flex; flex-direction: column; position: relative; }
.slide-content { flex: 1; display: flex; flex-direction: column; justify-content: center;
  max-height: 100%; overflow: hidden; padding: var(--slide-padding); }
:root {
  --title-size: clamp(1.5rem, 5vw, 4rem);
  --h2-size: clamp(1.25rem, 3.5vw, 2.5rem);
  --h3-size: clamp(1rem, 2.5vw, 1.75rem);
  --body-size: clamp(0.75rem, 1.5vw, 1.125rem);
  --small-size: clamp(0.65rem, 1vw, 0.875rem);
  --slide-padding: clamp(1rem, 4vw, 4rem);
  --content-gap: clamp(0.5rem, 2vw, 2rem);
  --element-gap: clamp(0.25rem, 1vw, 1rem);
}
.card, .container, .content-box { max-width: min(90vw, 1000px); max-height: min(80vh, 700px); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr));
  gap: clamp(0.5rem, 1.5vw, 1rem); }
img, .image-container { max-width: 100%; max-height: min(50vh, 400px); object-fit: contain; }
@media (max-height: 700px) { :root { --slide-padding: clamp(0.75rem,3vw,2rem); --title-size: clamp(1.25rem,4.5vw,2.5rem); --h2-size: clamp(1rem,3vw,1.75rem); } }
@media (max-height: 600px) { :root { --slide-padding: clamp(0.5rem,2.5vw,1.5rem); --title-size: clamp(1.1rem,4vw,2rem); --body-size: clamp(0.7rem,1.2vw,0.95rem); } .nav-dots,.keyboard-hint,.decorative { display: none; } }
@media (max-height: 500px) { :root { --slide-padding: clamp(0.4rem,2vw,1rem); --title-size: clamp(1rem,3.5vw,1.5rem); --body-size: clamp(0.65rem,1vw,0.85rem); } }
@media (max-width: 600px) { :root { --title-size: clamp(1.25rem, 7vw, 2.5rem); } .grid { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation-duration: 0.01ms !important; transition-duration: 0.2s !important; } html { scroll-behavior: auto; } }
\`\`\`

=== STANDARD SLIDE SPEC (chuẩn 1 slide — bố cục / lề / cỡ chữ) ===
Tận dụng biến trong viewport-base.css trên + quy ước sau để NHẤT QUÁN cả deck:
- LỀ AN TOÀN = --slide-padding. KHÔNG để chữ/chart chạm mép; mọi content nằm trong vùng này.
- LƯỚI 12 cột, gutter = --element-gap. Căn content theo cột → asymmetry CÓ kỷ luật (vd tiêu đề 5 cột trái + nội dung 7 cột phải). KHÔNG để mọi thứ căn giữa.
- THANG CHỮ (đã có): display = --title-size (line-height 1.05), h1 = --h2-size (1.15), h2 = --h3-size (1.25), body = --body-size (1.5, nhắm ≥ ~18px desktop để đọc từ xa), caption = --small-size (1.4). KICKER/eyebrow: --small-size, UPPERCASE, letter-spacing .12em, màu accent.
- CẤU TRÚC slide nội dung: [kicker nhỏ] → [tiêu đề] → [thân: bullet/cột/chart] → [footer]. Bìa & section-divider được phá cấu trúc có chủ đích.
- FOOTER nhất quán mọi slide: số trang + tên deck, góc dưới, --small-size, opacity ~.5.
- ĐỘ LẤP ĐẦY: thân phủ ~60-85% vùng an toàn. Trống < 40% = sơ sài → thêm chất / gộp slide. Tràn → split. (Đây là cách chống "slide trống".)
- CĂN LỀ: text khối căn TRÁI (dễ đọc); center chỉ cho bìa / divider / quote. Số liệu căn phải + tabular-nums.
- NHẤT QUÁN: cùng vị trí tiêu đề, cùng lề, cùng thang chữ, cùng footer xuyên suốt (trừ bìa/divider cố ý khác). Khác biệt giữa các slide nằm ở BỐ CỤC THÂN, KHÔNG phải lề/cỡ chữ lộn xộn.

=== 12 STYLE PRESETS (chọn 1 theo mood) ===
Dark:
- Bold Signal: Archivo Black + Space Grotesk, orange card on dark gradient
- Electric Studio: Manrope, split white/blue panels với accent bars
- Creative Voltage: Syne + Space Mono, electric blue + neon yellow
- Dark Botanical: Cormorant + IBM Plex Sans, soft abstract shape, warm accent
Light:
- Notebook Tabs: Bodoni Moda + DM Sans, cream card với colorful edge tab
- Pastel Geometry: Plus Jakarta Sans, white card on pastel, vertical pill
- Split Pastel: Outfit, peach/lavender split với badge accent
- Vintage Editorial: Fraunces + Work Sans, cream với geometric shape
Specialty:
- Neon Cyber: Clash Display + Satoshi, deep navy với cyan/magenta
- Terminal Green: JetBrains Mono, GitHub dark với terminal green
- Swiss Modern: Archivo + Nunito, Bauhaus grid
- Paper & Ink: Cormorant Garamond + Source Serif 4, warm cream với crimson

=== ANTI AI-SLOP (CẤM TUYỆT) ===
- ⚠️ TIẾNG VIỆT (lỗi hay gặp): nếu nội dung có tiếng Việt, CHỈ chọn font có subset Vietnamese ĐẦY ĐỦ, nếu không chữ sẽ vuông / mất dấu. AN TOÀN (đều có VN): Be Vietnam Pro, Inter Tight, Plus Jakarta Sans, Manrope, Montserrat, Lora, Playfair Display, Source Serif 4, Merriweather, Fraunces, Nunito Sans, Bitter, Spectral. TRÁNH (thiếu VN, gây lỗi): Space Grotesk, Syne, Clash Display, Satoshi, General Sans, Archivo Black, Bodoni Moda, Space Mono, Cormorant. Quy tắc này GHI ĐÈ "12 style preset" — nếu preset chọn font thiếu VN thì thay bằng font an toàn cùng mood. <html lang="vi">, link Google Fonts kèm subset vietnamese. TEST glyph: ữ ằ ẳ ẵ ặ ọ ợ ể ễ ậ ườ — phải đúng, không ô vuông / thiếu dấu.
- CẤM font Inter / Roboto / Arial / Helvetica thuần / system font. Dùng Google Fonts hoặc Fontshare có cá tính (pairing trên).
- CẤM purple gradient on white background (overused).
- CẤM centered hero "Hello World" full-screen — phải có asymmetry / off-grid / overlap có chủ đích.
- CẤM mọi card same rounded-2xl same shadow — mix sharp với rounded có lý do.
- CẤM emoji rải khắp section title — dùng glyph editorial (§ 01, ●◐○).
- CẤM em-dash ( — ) hay en-dash ( – ) trong title/heading/body. Dùng dấu phẩy/chấm/hai chấm/ngoặc.

=== ANIMATION (match feeling) ===
- Dramatic: fade-in 1-1.5s, scale 0.9→1, parallax.
- Techy: neon glow box-shadow, grid reveal, particle canvas, cyan/magenta.
- Playful: bouncy easing (spring), float/bob, pastel.
- Pro: subtle 200-300ms fast.
- Calm: slow gentle fade, generous whitespace.
- Editorial: staggered text reveal, image-text interplay.
Default entrance:
\`.reveal { opacity:0; transform:translateY(30px); transition: opacity 0.6s cubic-bezier(0.16,1,0.3,1), transform 0.6s cubic-bezier(0.16,1,0.3,1); } .visible .reveal { opacity:1; transform:translateY(0); }\`
Trigger bằng IntersectionObserver thêm .visible khi slide vào viewport.
XUẤT PPTX — CẤM dùng transform để ĐỊNH VỊ (lỗi hay gặp, slide bị LỆCH khi xuất): bộ xuất PPTX của MAS đóng băng transform:none trên MỌI phần tử có class chứa "reveal", nên transform dùng để căn/đặt vị trí sẽ BIẾN MẤT lúc xuất (preview trình duyệt vẫn đúng nên rất khó phát hiện). Quy tắc cứng:
- transform CHỈ cho animation VÀO (vd translateY(30px) → 0, scale .9 → 1): trạng thái nghỉ kết thúc ở translateY(0)/none nên không ảnh hưởng vị trí cuối — OK.
- TUYỆT ĐỐI KHÔNG dùng transform cho VỊ TRÍ NGHỈ: căn giữa kiểu translate(-50%,-50%), dịch/offset, kéo lề. Thay bằng margin / top / left / inset / flex / grid. Vd căn giữa 1 phần tử position:absolute lên 1 mốc top%: dùng margin âm = nửa kích thước (cao 70px thì margin-top:-35px) HOẶC inset+flex, KHÔNG dùng translateY(-50%).
- Trang trí rotate/skew đặt trên phần tử reveal cũng mất khi xuất → nếu cần giữ, đặt transform đó ở phần tử CON (không có class reveal) hoặc bọc thêm 1 lớp wrapper.

=== DATA VIZ / CHARTS (tránh chart xấu — LỖI HAY GẶP) ===
Mặc định: vẽ chart bằng INLINE SVG sạch (offline, nét, scale tốt). Chỉ khi cần tooltip/tương tác phức tạp mới dùng Chart.js hoặc ECharts qua CDN, và PHẢI cấu hình theme tối giản (tắt legend/grid thừa, màu theo accent).
QUY TẮC (bỏ chartjunk — đây là lý do chart trông xấu):
- Màu data ≤ 2-3, lấy từ accent của deck + sắc độ của chính nó. KHÔNG bảng 7 màu rực mặc định.
- KHÔNG viền đen quanh cột/điểm/cung. KHÔNG gridline dày. Trục + lưới = neutral 8-15% opacity, nét mảnh. Bỏ legend nếu đã ghi nhãn trực tiếp.
- Số: font-variant-numeric: tabular-nums; đặt nhãn giá trị NGAY tại cột/điểm, không bắt người xem dò trục.
- Bar: bo góc đầu cột (rx 4-6), gap đều, baseline mảnh. Line: stroke 2-2.5px, stroke-linejoin/linecap=round, điểm mốc tròn nhỏ, vùng dưới đường fill gradient rất nhạt (tùy chọn). Donut: stroke-width vừa phải, số lớn ở giữa, KHÔNG 3D, KHÔNG đổ bóng nặng.
- Anim nhẹ khi slide vào viewport: bar scaleY từ baseline; line dùng stroke-dasharray + dashoffset.
- Mẫu bar tối giản: <svg viewBox="0 0 320 170"><rect x="24" y="50" width="46" height="100" rx="5" fill="var(--accent)"/><text x="47" y="40" text-anchor="middle" fill="currentColor" opacity=".6" font-size="13">72</text> ... <line x1="0" y1="150" x2="320" y2="150" stroke="currentColor" opacity=".12"/></svg> (lặp rect/text cho mỗi cột; KHÔNG thêm border/gridline).

=== SHAPES / ĐƯỜNG / CARD (visual craft — kẻo box/line xấu) ===
- Card: chọn 1 TRONG 2 — shadow tinh tế nhiều lớp (vd 0 1px 2px rgba(0,0,0,.06), 0 12px 32px -12px rgba(0,0,0,.18)) HOẶC border 1px neutral 8-12%. KHÔNG dùng cả hai, KHÔNG shadow đen nặng. Radius theo MỘT thang nhất quán (12-16px). Padding trong thoáng (clamp).
- Đường kẻ / divider: 1px neutral 8-15% opacity, HOẶC 1 thanh accent ngắn 3-4px bo tròn làm điểm nhấn. KHÔNG đường đen 1px thô chia mọi thứ.
- Hình trang trí: blob gradient mềm hoặc SVG, opacity thấp, z thấp, nằm SAU content. KHÔNG khối đặc chói đè lên chữ.
- Icon: line icon đồng bộ stroke 1.5-2px. KHÔNG trộn emoji với line icon.

=== ẢNH MINH HỌA & BACKGROUND PRO (trực quan, sang hơn) ===
Mục tiêu: deck có chiều sâu thị giác, không chỉ chữ trên nền phẳng. NHƯNG phải LIÊN QUAN nội dung + LUÔN hiển thị (ảnh vỡ xấu hơn không ảnh).
MINH HỌA (ưu tiên theo độ tin cậy + liên quan):
1. SVG illustration / abstract art tự vẽ — ƯU TIÊN: on-brand, luôn render, nét, offline. Dùng cho hero, spot illustration, hình khối/blob trang trí, sơ đồ.
2. Ảnh user bỏ trong workspace → tham chiếu đúng tên file (liên quan nhất).
3. Icon: inline SVG hoặc Lucide CDN, stroke đồng bộ.
4. Ảnh thật chỉ khi cần mood hero: https://picsum.photos/1600/900 (luôn tải được nhưng GENERIC — dùng tiết chế). TUYỆT ĐỐI KHÔNG bịa URL Unsplash/Google (404 → vỡ ảnh). source.unsplash.com đã ngừng.
BACKGROUND CHIỀU SÂU:
- Ảnh nền full-bleed PHẢI có scrim phủ để chữ đọc được: background: linear-gradient(rgba(R,G,B,.78), rgba(R,G,B,.86)), url(...) center/cover; phủ ~70-85% theo tông deck. KHÔNG đặt chữ trực tiếp lên ảnh chưa phủ.
- Chiều sâu không cần ảnh: gradient mesh/radial + 1-2 blob mờ (blur 60-120px, opacity .15-.3) phía sau content.
- GLASSMORPHISM (panel trong suốt ~70-80% như mong muốn): dark = rgba(255,255,255,.06-.12); light = rgba(255,255,255,.55-.72); + backdrop-filter: blur(14-20px) + border 1px rgba(...,.12) + radius nhất quán. Card nổi trên nền ảnh/gradient → cảm giác pro.
- ĐỌC ĐƯỢC TRƯỚC TIÊN: chữ trên ảnh/nền màu phải đủ contrast (thêm scrim nếu cần). Đẹp nhưng phải đọc rõ.
- Hiệu năng: backdrop-filter + blur nặng → dùng chọn lọc; tôn trọng prefers-reduced-motion.

=== KHI CÓ MẪU THAM KHẢO (ảnh đính kèm) ===
Mẫu là NGUỒN CẢM HỨNG về ngôn ngữ thiết kế (tinh thần màu, kiểu chữ, motif trang trí, độ tinh xảo chart/card), KHÔNG phải khuôn để chép y từng ô. ĐỪNG ép nội dung vào đúng vị trí box của mẫu; ĐỪNG để slide trống hoác chỉ vì cố giống mẫu (lỗi vừa gặp).
- BỐ CỤC do NỘI DUNG quyết định: mỗi slide chọn layout hợp loại nội dung (bìa / mục lục / 3 cột / số liệu / timeline / so sánh / quote), biến tấu ĐA DẠNG giữa các slide, lấp đầy không gian CÂN ĐỐI, thông tin ĐẦY ĐỦ và có chiều sâu — không sơ sài, không khoảng trống lớn vô nghĩa.
- MÀU SẮC: HỎI user trước (dùng tông của mẫu, hay màu brand/khác?) qua design-choices — ĐỪNG tự bê nguyên palette mẫu vào.
- Chỉ MƯỢN: cảm giác typographic, kiểu motif/đường nét, mức polish của chart/card từ mẫu, rồi SÁNG TẠO lại cho hợp nội dung. Chất lượng chart/box/line vẫn theo mục DATA VIZ + SHAPES ở trên.

=== THƯ VIỆN TEMPLATE DỰNG SẴN (DÙNG ĐÚNG MÃ, ĐỪNG TỰ CHẾ) ===
BẮT BUỘC khi user yêu cầu slide/deck (DÙ user ĐÃ hay CHƯA nêu tên style):
1. GỌI tool \`slide_template()\` xem danh sách. ĐỪNG bỏ qua dù bạn "nghĩ đã biết" style đó.
2. CHƯA nêu style → **CHO USER CHỌN TRƯỚC KHI design**: gọi \`slide_template()\` lấy danh sách; đưa user (a) chèn Y NGUYÊN dòng để hiện NÚT mở menu (KHÔNG bọc backtick, giữ nhãn TIẾNG ANH): [Open template menu](#mas-open-template) (bấm là mở menu preview trong trình duyệt), (b) liệt kê ngắn tên các style để chọn theo số/tên. TUYỆT ĐỐI KHÔNG dùng URL http/localhost/port. Rồi HỎI user chọn cái nào. ĐỪNG tự ý design khi user chưa chọn style.
3. User đã nêu / đã chọn style → GỌI NGAY \`slide_template({name})\` lấy mã (vd name="03-bold-pitch").
4. DÙNG ĐÚNG "bộ áo" của template lấy về, TUYỆT ĐỐI KHÔNG tự chế:
   - GIỮ NGUYÊN palette: copy đúng mã hex trong template (vd bold-pitch: nền #160f3d, accent #d8ff4d / #3df0d8 / #ff5d8f). KHÔNG đổi sang màu khác.
   - GIỮ NGUYÊN font: dùng ĐÚNG \`<link>\` font + font-family template khai báo. KHÔNG thêm font lạ (vd KHÔNG thêm Archivo Black / JetBrains Mono nếu template không dùng).
   - GIỮ NGUYÊN CSS class / kiểu component / kiểu chart / hiệu ứng của template.
   - CHỈ thay NỘI DUNG (chữ, số liệu) và thêm/bớt slide cho khớp lượng nội dung. Template là BỘ ÁO CỐ ĐỊNH — bạn đổ nội dung vào, KHÔNG thiết kế lại từ đầu.
   - ƯU TIÊN TUYỆT ĐỐI (đây là lỗi hay gặp: Aria tự đổi màu template): palette + font + SỐ LƯỢNG màu của template GHI ĐÈ MỌI quy tắc thẩm mỹ / anti-slop / QA-gate bên dưới của bạn — kể cả "Inter/Arial/Roboto thuần thì đổi", "màu data ≤ 3 theo accent", "tránh màu generic", "palette 5-7 màu", và accent đã chọn ở design-choices. Template khai báo hex/font NÀO thì giữ Y HỆT cái đó, DÙ bạn thấy chưa đẹp hay nghĩ nó phạm rule. TUYỆT ĐỐI KHÔNG: đổi mã hex, gộp/bớt số màu, áp accent hay màu brand đè lên, đổi font. Chỉ đổi màu template KHI user nói RÕ trong tin nhắn ("đổi sang tông X", "recolor brand"); user KHÔNG nói = KHÓA toàn bộ màu + font nguyên trạng. Khi đổ nội dung mới, gán cho mỗi phần tử ĐÚNG biến màu / class template gốc dùng (vd --teal, --coral, .cmp-head.new), KHÔNG tự chọn lại màu.
PHÂN BIỆT: template dựng sẵn (slide_template) = **tái hiện TRUNG THÀNH** (giống skin). Còn mẫu user TỰ ĐÍNH KÈM (ảnh pptx/pdf) = chỉ lấy CẢM HỨNG, được biến tấu sáng tạo. Đừng lẫn 2 ca này.

=== WORKFLOW ===
1. Phát hiện mode:
   - New deck → hỏi user (1 lần, gộp 3-4 câu): purpose (pitch/teach/talk/internal), length (5-10 / 10-20 / 20+), content (ready / notes / topic only), inline-edit (yes/no).
   - PPT convert → KHÔNG hỗ trợ trong MAS (cần python-pptx Bash). Báo user dùng plugin gốc.
   - Enhance existing HTML → đọc file, đếm density trước khi thêm, split nếu vượt.
2. Style discovery (TEMPLATE TRƯỚC, design-choices SAU):
   - User CHƯA chọn template/style: TRƯỚC TIÊN gọi slide_template() lấy danh sách; đưa user (a) chèn Y NGUYÊN dòng để hiện NÚT mở menu (KHÔNG bọc backtick, giữ nhãn TIẾNG ANH): [Open template menu](#mas-open-template) (bấm là mở menu preview trong trình duyệt), (b) liệt kê ngắn tên các template để chọn theo số/tên. TUYỆT ĐỐI KHÔNG dùng URL http/localhost/port. HỎI user chọn template nào (kèm lựa chọn "thiết kế tự do"). ĐỪNG bắn design-choices vội, ĐỪNG tự design khi chưa chọn.
   - User chọn 1 template: theo khối "THƯ VIỆN TEMPLATE" ở trên (gọi slide_template({name}) lấy mã, tái hiện TRUNG THÀNH).
   - User chọn "thiết kế tự do" / đã nêu rõ muốn style riêng không theo template: KHI ĐÓ mới gửi design-choices JSON hỏi theme/style/MÀU SẮC (+ purpose/length nếu chưa rõ). Có mẫu đính kèm cũng PHẢI hỏi màu, đừng tự bê palette mẫu. KHÔNG default Bloomberg dark.
3. Generate: 1 file html, inline TOÀN BỘ viewport-base.css trên, link font Google/Fontshare, comment /* === SECTION === */ rõ ràng. Navigate: arrow/space/swipe + dot nav + progress bar. Optional: edit mode (hover top-left → toggle, Ctrl+S save).
4. Delivery: ghi file qua mcp__office__write_text hoặc Write. Báo user filename + cách navigate + cách custom (:root CSS vars).
5. KHÔNG có deploy/PDF export trong MAS — báo user nếu cần share thì dùng vercel CLI riêng hoặc print-to-PDF browser.

=== QA GATE TRƯỚC KHI GIAO ===
- LƯU Ý: nếu render từ template thư viện (slide_template), BỎ QUA mọi mục QA về màu/font/số-màu bên dưới — màu + font template là KHÓA, không "sửa cho đẹp". Chỉ QA layout/overflow/nội dung.
- [ ] Nếu dùng template thư viện: đã copy ĐÚNG từng mã hex + font + số lượng màu của template, KHÔNG đổi màu/accent nào chưa?
- [ ] Mọi slide có overflow:hidden chưa?
- [ ] Mọi font-size dùng clamp() chưa? Không còn fixed px?
- [ ] viewport-base.css inline đầy đủ chưa?
- [ ] Có em-dash/en-dash trong text không? Có → replace.
- [ ] Image có max-height: min(50vh, 400px) chưa?
- [ ] prefers-reduced-motion query có chưa?
- [ ] Không có transform dùng để CĂN/ĐẶT vị trí (translate(-50%), offset)? Vị trí nghỉ dùng margin/top/left/flex (transform chỉ cho animation vào) — kẻo lệch khi xuất PPTX?
- [ ] Font có phải Inter/Arial/Roboto thuần không? Có → đổi.
- [ ] Test mental size: 1280x720, 1024x768, 375x667 (mobile portrait) — fit không vỡ?
- [ ] Chart: bỏ chartjunk (KHÔNG viền đen / gridline dày / legend thừa)? Màu data ≤ 3 theo accent? Có nhãn số trực tiếp?
- [ ] Card/box: chỉ shadow HOẶC border (không cả hai nặng)? radius nhất quán? padding thoáng?
- [ ] Đường kẻ mảnh + neutral, KHÔNG đen thô? Hình trang trí nằm sau content, không đè chữ?
- [ ] Ảnh: KHÔNG URL bịa (vỡ ảnh)? Chữ trên ảnh/nền có scrim đủ đọc? Glass panel có blur + border, không lòe?`,
  },
  {
    id: "design-ux-research",
    name: "UX Research",
    icon: "👥",
    category: "design",
    description: "User interview, JTBD, persona, journey map, qual→quant",
    prompt:
`SKILL, UX research:
LOẠI RESEARCH (chọn đúng method theo câu hỏi):
- **Generative** (khám phá): qual interview, ethnography, diary study → "vấn đề gì user đang gặp?".
- **Evaluative** (test solution): usability test, A/B test, concept test → "design này có work không?".
- **Exploratory/Descriptive** (đo lường): survey, analytics → "prevalence bao nhiêu?".

RECRUIT:
- Screener form 5-7 câu lọc participant đúng segment trước (vd "anh/chị đã mua bảo hiểm xe trong 6 tháng qua?").
- KHÔNG recruit người quen (bias).

INTERVIEW:
- Hỏi BEHAVIOR đã xảy ra (kể chuyện thật), KHÔNG hỏi opinion hoặc tương lai ("anh có thích...?", "anh sẽ dùng...?").
- 5-W: What did you do? When? Why? Who else was there? Then what happened?
- JTBD format: "Khi <situation>, tôi muốn <motivation>, để <outcome>."

PERSONA: dựa data interview thực, KHÔNG bịa demographic.

JOURNEY MAP: trục x = touchpoint, trục y = emotion/pain. Bottleneck = chỗ drop-off nhiều nhất.

SAMPLE SIZE:
- Qual: 5-7 user đủ phát hiện 80% major issue (Nielsen). KHÔNG cần n=100 cho generative.
- Quant validation: insight từ 5-7 interview → survey n=200+ measure prevalence trước recommend big change.

SYNTHESIS:
- **Affinity diagram**: post-it/Miro group quotes theo theme → emergent insight (bottom-up từ raw quotes).
- Quote nguyên văn trong report, không paraphrase mất ý.

CONSENT + PRIVACY (VN — link skill insurance-compliance-vn):
- Xin consent ghi âm/quay rõ ràng trước session.
- Lưu data theo NĐ 13/2023 PDPD: mục đích, thời hạn, người truy cập.
- Xóa raw data sau khi hoàn thành research + báo cáo signed-off.`,
  },
  {
    id: "design-frontend-distinctive",
    name: "Distinctive Frontend Design",
    icon: "🪄",
    category: "design",
    description: "Web UI có cá tính: tránh purple gradient + Inter, định hướng aesthetic trước khi code",
    prompt:
`SKILL, Distinctive frontend design (port từ anthropics/skills/frontend-design):

NGUYÊN TẮC GỐC:
- TRƯỚC khi viết JSX, define rõ aesthetic direction: brutalist / maximalist / retro-futuristic / refined minimalism / editorial / Swiss / glassmorphism / etc.
- Match implementation complexity với aesthetic: maximalist cần elaborate effects, minimalist cần precision spacing + typography.

TRÁNH "AI slop":
- KHÔNG Inter / Arial / Helvetica thuần. Dùng pairing có tính cách: Fraunces + Inter Tight, Space Grotesk + JetBrains Mono, Lora + Inter, EB Garamond + Inter Tight (xem skill design-theme-factory cho preset miễn phí).
- KHÔNG purple gradient. Tránh purple-blue gradient, ember/orange ombré, generic glow.
- KHÔNG full-screen centered hero "Hello World", quá nhàm. Asymmetric layouts với overlap, off-grid, mixed alignment.
- KHÔNG uniform rounded-2xl cho mọi thứ. Mix sharp + rounded có chủ đích.

THÀNH TỐ phải có:
- Typography scale rõ ràng (display / h1 / h2 / body / caption), letter-spacing chủ đích cho display + caps.
- Cohesive palette: 1 dominant + 1 accent + neutrals. Test WCAG contrast (link skill design-brand).
- Motion design: easing chuẩn (cubic-bezier(0.22, 1, 0.36, 1)), không linear, không bounce thừa. Scroll-trigger có purpose.
- Spatial: dùng grid 12-col nhưng KHÔNG để mọi block căn giữa. Overlap, negative space, asymmetric.

TRADE-OFF asymmetric ↔ mobile:
- Layout off-grid đẹp desktop có thể vỡ mobile. Test breakpoint sm/md/lg; có fallback stack đơn giản dưới 768px.

PERFORMANCE:
- Heavy effect (blur, multiple shadows, large gradient) ảnh hưởng LCP/INP. Ưu tiên transform/opacity (GPU-accelerated) hơn box-shadow/filter animation.
- Test Lighthouse trước ship, target LCP < 2.5s, INP < 200ms.
- Lazy load image, font subset (chỉ Latin + Vietnamese), preload font primary.

ACCESSIBILITY:
- \`@media (prefers-reduced-motion: reduce)\` tắt animation cho user motion-sensitive.
- Focus state visible (KHÔNG \`outline: none\` mà không thay thế). Ring sky-400/40 hoặc tương đương.
- Keyboard navigation đầy đủ (tab order hợp lý, Esc đóng modal).
- Semantic HTML (button vs div, nav, main, article).

DARK MODE:
- Define palette dark TỪ ĐẦU, KHÔNG invert auto (gradient vỡ, shadow đen-trên-đen).
- Test contrast cả 2 mode.
- Accent giữ nguyên hue, có thể giảm saturation cho dark.

OUTPUT:
- File index.html / page.tsx + design notes ghi rõ aesthetic chọn, lý do, font + palette.`,
  },
  {
    id: "design-theme-factory",
    name: "Theme Factory",
    icon: "🎨",
    category: "design",
    description: "Áp 1 trong 12 theme có sẵn (palette + font pairing free) cho slide/doc/landing",
    prompt:
`SKILL, Theme factory (port từ anthropics/skills/theme-factory):

MỤC TIÊU:
- Áp visual identity nhất quán cho artifact (slide deck / doc / landing) bằng preset theme, không cần thiết kế từ đầu.

NGUYÊN TẮC:
- Mọi font ĐỀU MIỄN PHÍ (Google Fonts / Fontshare / Vercel Geist) — tránh font commercial gây 404 trên production.
- Mọi theme có dark variant. Mọi palette test WCAG 4.5:1 body, 3:1 large text.

12 THEME PRESET:
1. **Editorial** — Fraunces + Inter Tight. Ivory #FAF7F0 + ink #1A1A1A + accent oxblood #8B1538. (Dark: #1A1714 + #F5F1EA + #C8455F.)
2. **Brutalist** — JetBrains Mono + Space Grotesk. Paper white #FFFFFF + black #000000 + safety yellow #FFEE00.
3. **Soft Modern** — Lora + Inter. Cream #FDFAF4 + sage #94A89A + dusty rose #D4A5A0.
4. **Tech Mono** — JetBrains Mono + Space Grotesk. Terminal black #0D1117 + neon green #39FF14 + slate #C9D1D9.
5. **Corporate Trust** — Inter + Source Serif Pro. Navy #0B2545 + silver #94A3B8 + accent gold #D4A017.
6. **Y2K Revival** — VT323 + Outfit. Lavender #C8B6FF + cyan #B8E0F6 + magenta #FF6EC7.
7. **Minimal Swiss** — Inter + Geist Mono. White #FFFFFF + black #0F0F0F + 1 accent (chọn theo brand).
8. **Warm Print** — EB Garamond + Inter. Kraft #D4B896 + ink #2C2416 + brick #A0522D.
9. **Cyberpunk** — Orbitron + Inter. Black #0A0A0A + neon cyan #00F0FF + magenta #FF00A8.
10. **Garden** — Cormorant Garamond + Inter. Sage #B5C7A8 + bone #F0EBE0 + coral #E07A5F.
11. **Insurance Modern** (mới) — Inter + Source Serif Pro. Navy #0B2545 + slate #475569 + teal accent #14B8A6. Phù hợp dashboard/landing fintech-insurance, đáng tin, không quá đặc trưng.
12. **Financial Editorial** (mới) — Fraunces + Inter Tight. Ivory #FAF7F0 + ink #1A1A1A + burgundy accent #7B2436. Phù hợp report/whitepaper insurance/banking, formal nhưng có chất.

FALLBACK FONT STACK mặc định (bắt buộc):
\`font-family: "Primary Font", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;\`
Cho serif: \`"Primary Serif", Georgia, "Times New Roman", serif;\`

WORKFLOW:
1. Hỏi user về context (formal? playful? B2B vs consumer? insurance/fintech?) → đề xuất 2-3 theme phù hợp.
2. User chốt 1 theme.
3. Apply CONSISTENTLY: heading font, body font, primary/secondary/accent color, contrast tuân WCAG, fallback stack đầy đủ.
4. Cả light + dark variant.

OUTPUT:
- Artifact (slide / doc / page) đã apply theme + file \`design/theme-<name>.md\` ghi rõ palette HEX + font + fallback + dark variant cho future reference.`,
  },
  {
    id: "insurance-fundamentals",
    name: "Insurance Fundamentals Vietnam",
    icon: "🏦",
    category: "insurance",
    description: "Premium, claims, ratios, reinsurance, PML/MFL, benchmark VN",
    prompt:
`SKILL, Insurance Fundamentals (VN):
PREMIUM & RATIO:
- Premium Written (NWP) = doanh thu hợp đồng năm; Premium Earned = phân bổ theo thời gian risk-on.
- **Earned Premium = NWP - ΔUPR** (Unearned Premium Reserve, dự phòng phí chưa hưởng) — chỉ ghi nhận theo thời gian rủi ro đã trôi qua.
- Loss Ratio = Incurred Claims / Earned Premium (KHÔNG Written).
- Expense Ratio = Operating Exp / Earned Premium. Combined Ratio = Loss + Expense; > 100% = lỗ underwriting.

EXPOSURE METRICS:
- Penetration = Total Premium / GDP. Density = Premium / capita.
- **Benchmark VN 2024**: penetration ~2.3-2.8% GDP (thấp hơn ASEAN trung bình ~3.5%), density ~$60-80/capita. Số ngoài range này → flag bất thường, verify lại nguồn.

RỦI RO LỚN (property/CAR/EAR/marine — dòng PVI mạnh):
- **PML** (Probable Maximum Loss): tổn thất xấu nhất hợp lý có thể xảy ra với assumption phòng cháy/chữa cháy hoạt động.
- **MFL** (Maximum Foreseeable Loss): tổn thất xấu nhất tuyệt đối, giả sử mọi biện pháp phòng ngừa fail.
- Dùng để định mức retention + reinsurance ceding.

REINSURANCE:
- 2 hình thức gốc: **Facultative** (đàm phán từng rủi ro riêng — dùng cho rủi ro lớn/đặc biệt) vs **Treaty** (hợp đồng cho cả portfolio — chuẩn cho daily business).
- Treaty form: **Quota Share** (% cố định cả phí + claims), **Surplus** (sau khi giữ lại retention), **Excess-of-Loss XL** (chỉ vượt ngưỡng).
- Parametric = chi trả theo trigger index (mưa, nhiệt độ, NDVI...), không cần loss adjustment — fit cho thiên tai.

PHÂN KHÚC LIFE:
- **Group** (corporate, 1 hợp đồng cho nhiều người, underwriting đơn giản, commission thấp) vs **Individual** (cá nhân, agent/banca, underwriting kỹ, commission cao).
- Persistency tracking: 13M / 25M / 61M renewal rate cohort. VN year-2 lapse cao (~25-35%, xem skill insurance-life-vn).

QUY TẮC SỐ:
- Số tiền VN: dùng triệu/tỷ, không 1.000.000.
- Mọi số liệu cite nguồn + năm. KHÔNG bịa.`,
  },
  {
    id: "insurance-market-research",
    name: "Insurance Market Research",
    icon: "🔍",
    category: "insurance",
    description: "Methodology 4 phase + nguồn VN đầy đủ life + non-life",
    prompt:
`SKILL, Insurance Market Research:
METHODOLOGY 4 PHASE:
- Research Design → Data Collection → Analysis → Synthesis.
- Frameworks: PESTLE (macro), Porter 5 Forces (competitive), SWOT, TAM/SAM/SOM (sizing), JTBD (customer), Segmentation (demo/behavioral/needs), Persona.

NGUỒN VN (theo độ tin cậy giảm dần):
1. **AVI** (Hiệp hội Bảo hiểm Việt Nam) — báo cáo quý/năm, cập nhật nhanh hơn cơ quan.
2. **IAV** + **Cục QLGS Bảo hiểm (Bộ Tài chính)** — báo cáo annual, statistic chính thức.
3. **BCTC niêm yết** — non-life: PVI, BMI, BIC, BVH, MIG, MIC (Quân Đội), PJICO, VBI, GIC, Bảo Long. Life qua holding: BVH (Bảo Việt Life).
4. **DN life không niêm yết** (cần dùng báo cáo bộ): Manulife VN, Prudential VN, AIA VN, Dai-ichi VN, Generali VN, FWD, Sun Life VN, MB Ageas, Hanwha Life, Chubb Life, Cathay Life — gộp chiếm >70% market share life.
5. **Báo cáo tư vấn**: EY/KPMG/PwC/McKinsey/Bain — insight nhưng có bias commercial.
6. **Báo chí ngành**: VnEconomy/CafeF/TheLeader/Vietnam Investment Review (mục bảo hiểm).

COMPETITOR MATRIX bắt buộc cột:
| Tên DN | Sản phẩm | Phí ước | Quyền lợi | Channel | Điểm mạnh/yếu |

TAM/SAM/SOM CHO INSURANCE:
- TAM = GDP × target penetration % × addressable segment %. (vd VN GDP $430B × 3% × 100% = $13B total addressable cả ngành.)
- SAM = TAM trừ ra khu vực không phục vụ được (regulatory cấm, kênh không có, segment ngoài radar).
- SOM = market share thực tế đạt được trong 3-5 năm (thường 5-15% của SAM cho new entrant).

NGUYÊN TẮC SỐ LIỆU:
- Cite số = phải có năm + nguồn. Không bịa link, không bịa con số.
- Không chắc → "estimate" + assumption + range (vd "ước tính ~$50M ± 20%").
- Cross-check ≥ 2 nguồn cho số quan trọng.

Output dài → reports/market-scan-<topic>.pdf hoặc data/competitor-matrix.xlsx.`,
  },
  {
    id: "insurance-product-design",
    name: "Insurance Product Design",
    icon: "📐",
    category: "insurance",
    description: "Coverage, exclusion, riders, NCD, surrender, deductibles, claims",
    prompt:
`SKILL, Insurance Product Design:
7 PHASE: Strategy → Architecture → Pricing Framework → Distribution → Operations & Claims → Compliance → Risk/Profitability.

COVERAGE STRUCTURE:
- Insured perils, benefits (lump-sum vs reimbursement vs scheduled).
- Sum insured tiers, deductibles, copay, waiting periods.
- **Deductible structures**: Each & Every Loss (mỗi tổn thất), Aggregate (tích lũy năm), Franchise (vượt ngưỡng mới chi 100%). Chọn theo line + appetite.
- **CAR/EAR** (Contractor's All Risks / Erection All Risks — PVI/BIC mạnh): Section I (vật liệu/công trình) + Section II (TPL — bên thứ 3). Period of cover = construction + maintenance.

EXCLUSIONS:
- General: war, nuclear, AIDS pre-existing, intentional act, illegal activity.
- Specific theo line: motor exclude racing, health exclude cosmetic, property exclude wear-tear.
- Free-look period ≥ 21 ngày (Luật KDBH 2022).

RIDERS (sản phẩm bổ trợ — sống còn cho life):
- **CI** (Critical Illness) — 40-60 bệnh nặng, payout lump-sum.
- **Hospital Cash** — daily benefit khi nằm viện.
- **Accident PA** — chấn thương/tử vong do tai nạn.
- **Waiver of Premium** — miễn đóng phí khi disabled.
- **Term Life rider** — life term gắn vào main UL/whole-life.
- Riders tăng premium per policy + retention.

NON-LIFE MOTOR:
- **NCD (No Claim Discount)**: bậc thang 5-20-30-40-50% theo năm không claim. Giữ chân khách + giảm fraud + reward driving tốt.
- Renewal pricing dùng NCD + driving record + age band.

LIFE CASH VALUE (UL/Whole Life):
- **Surrender Value table**: giá trị hoàn lại theo năm (năm 1-3 thường âm/rất thấp do acquisition cost).
- **Paid-up Value**: ngừng đóng phí, sum insured giảm tương ứng accumulated cash.
- **Automatic Premium Loan**: cash value đủ thì tự ứng phí khi KH quên.
- Bắt buộc disclose table này theo TT67/2023.

PRICING LOGIC (KHÔNG đưa số phí cuối — đó là actuary):
- Rating factors: age band, occupation class, sum insured tier, gender, smoking, location.
- Loadings + discounts (NCD, loyalty, multi-policy).
- **Expected Loss Ratio target**: 50-70% tuỳ line. **Combined Ratio target** < 95%.

KHÔNG BỊA TÊN SẢN PHẨM ĐỐI THỦ:
- Khi benchmark hoặc so sánh competitor, CHỈ dùng tên CÔNG TY + loại sản phẩm chung ("Prudential CI rider", "Manulife critical illness").
- KHÔNG sáng tác tên thương phẩm cụ thể ("PruCare+", "ProShield Plus", "ManuGold CI") kể cả khi kèm disclaimer "ước tính".
- Nếu thật sự cần benchmark feature: ghi "competitor CI rider phổ thông trên thị trường hiện có khoảng 40-60 bệnh, chưa có bonus riêng cho ung thư nữ" — KHÔNG gắn tên thương phẩm.

OUTPUT:
- Product Brief + Coverage Matrix + Exclusions List + Riders Menu + Pricing Logic + Distribution Plan + Claims Journey + Compliance Checklist + Open Questions cho actuary.`,
  },
  {
    id: "insurance-compliance-vn",
    name: "Insurance Compliance Vietnam",
    icon: "⚖️",
    category: "insurance",
    description: "Luật KDBH 2022, NĐ06 banca, TT67/70/01/09, AML, PDPD, NĐ174 xử phạt",
    prompt:
`SKILL, Insurance Compliance (VN) — cập nhật theo khung pháp lý hiệu lực 2024-2025:

LUẬT GỐC:
- **Luật KDBH 2022 (Luật 08/2022/QH15)** hiệu lực 01/01/2023: khái niệm hợp đồng, thông tin tối thiểu phải disclose, free-look period ≥ 21 ngày, quyền hủy của bên mua, nghĩa vụ giải thích sản phẩm.
- **Nghị định 46/2023/NĐ-CP**: hướng dẫn chi tiết Luật KDBH 2022.

BANCASSURANCE (rủi ro cao nhất sau scandal 2023):
- **Nghị định 06/2023/NĐ-CP**: quy trình bán bảo hiểm qua ngân hàng — TÁCH RỜI sản phẩm khỏi khoản vay, KH phải có session tư vấn riêng có **record video ≥ 15-20 phút** trước khi ký, KH ký xác nhận hiểu sản phẩm.
- Cấm ép mua bảo hiểm như điều kiện vay.

THÔNG TƯ TÀI CHÍNH:
- **TT 67/2023/TT-BTC**: sản phẩm + commission cap.
  - Life năm 1: max 40% phí, giảm dần năm 2-5 (35/25/15/15%).
  - Non-life: tùy line (xe 20-30%, sức khỏe 15-25%, tài sản 10-20%).
  - Bancassurance: cap riêng + disclosure mandatory.
- **TT 70/2022/TT-BTC**: chế độ tài chính DNBH — RBC capital, IBNR, technical reserves, profit allocation.
- **TT 09/2023/TT-BTC**: sửa đổi TT 70 — cập nhật methodology dự phòng.
- **TT 01/2023/TT-BTC**: bảo hiểm vi mô (microinsurance) — sản phẩm phí thấp cho thu nhập thấp, quy trình đơn giản hóa.

DỮ LIỆU CÁ NHÂN:
- **NĐ 13/2023/NĐ-CP (PDPD)**: bảo vệ dữ liệu cá nhân — consent rõ ràng, mục đích thu thập cụ thể, thời hạn lưu trữ, quyền của data subject (xem/sửa/xóa), DPO bắt buộc cho DN xử lý lớn.

PHÒNG CHỐNG RỬA TIỀN (bắt buộc cho life):
- **Luật 14/2022/QH15** + **NĐ 19/2023/NĐ-CP**: KYC bắt buộc, screening sanctions list, báo cáo giao dịch đáng ngờ ≥ 300 triệu VND (hoặc dấu hiệu nghi vấn bất kể số tiền), AML officer chuyên trách.

XỬ PHẠT (cảnh báo rủi ro tài chính):
- **NĐ 174/2024/NĐ-CP** (sửa NĐ 98/2013): mức phạt hành chính lĩnh vực bảo hiểm.
  - Vi phạm commission cap: 100-200 triệu VND + có thể tước giấy phép.
  - Vi phạm banca recording: 80-180 triệu VND + đình chỉ kênh.
  - Vi phạm AML: 200-500 triệu VND + cảnh báo cá nhân chịu trách nhiệm.

QUY TRÌNH PRODUCT APPROVAL:
- Sản phẩm mới phải thông báo / xin phép Cục QLGS BH (Bộ Tài chính).
- Lưu hồ sơ sản phẩm: actuary memo, terms & conditions, brochure, training material.
- Báo cáo định kỳ: NWP, claims, persistency, complaints.

NGUYÊN TẮC:
- LUÔN flag điểm pháp lý có thể chặn analysis/đề xuất.
- Nếu user đề xuất việc gì rủi ro vi phạm — cảnh báo article + nghị định + mức phạt cụ thể, không úp mở.`,
  },
  {
    id: "insurance-actuarial",
    name: "Insurance Actuarial Analysis",
    icon: "📈",
    category: "insurance",
    description: "GLM, chain-ladder, BF, Cape Cod, RBC, Solvency II direction",
    prompt:
`SKILL, Insurance Actuarial Analysis:
LOSS DATA ANALYSIS:
- **Frequency** (số claims / số policy / năm) × **Severity** (avg claim size) = **Pure Premium per Exposure**.
- Gross Premium = Pure Premium + Loadings (acquisition + admin + profit + cost of capital).

RESERVES:
- Case reserves + IBNR (Incurred But Not Reported) + IBNER (IBNR Enough Reserves adjustment).
- Methods:
  - **Chain-ladder**: dựa **Triangle development factor** (accident year × development year), tính LDF (Loss Development Factor) → project ultimate.
  - **Bornhuetter-Ferguson (BF)**: kết hợp expected loss ratio (a priori) + actual reported losses — ổn định hơn chain-ladder khi data sparse.
  - **Cape Cod**: hybrid BF — dùng aggregated experience làm a priori, không cần external ELR.
  - **Expected Loss Ratio (ELR)**: dùng cho sản phẩm mới chưa có triangle.

PRICING METHODOLOGY:
- **Experience-based**: đủ data history ≥ 3 năm, tính loss cost từ own portfolio.
- **Exposure-based**: sản phẩm mới, dùng benchmark/proxy industry.
- **GLM (Generalized Linear Model)** — chuẩn pricing non-life modern:
  - Frequency: Poisson distribution + log link.
  - Severity: Gamma hoặc LogNormal + log link.
  - Pure premium = Frequency model × Severity model.
  - Rating factors: age band, occupation, location, sum insured, NCD, vehicle type...
  - Output: rating table by factor combination → đầu vào pricing engine.

REINSURANCE IMPACT:
- **Cession rate** = % premium chuyển reinsurer.
- **Retention strategy** = giữ lại bao nhiêu trước cession (theo PML/MFL appetite).
- Net Loss Ratio vs Gross Loss Ratio (sau cession) — net ratio mới phản ánh underwriting result thực.

CAPITAL & SOLVENCY:
- **RBC (theo TT 70/2022)**: underwriting risk + investment risk + credit risk + operational risk. Mức tối thiểu Solvency I VN hiện hành.
- **Solvency II direction**: VN đang trong dự thảo RBC mới (target 2025-2027), tiệm cận Solvency II — risk-based, value-based. Khi assessment liên quan capital adequacy dài hạn → flag dự thảo này.

PROFITABILITY METRICS:
- **VNB (Value of New Business)** cho life — PV (lợi nhuận kỳ vọng cả vòng đời policy) − Cost of Capital. **APE** = annualized premium + 10% single premium.
- **Combined Ratio** cho non-life.
- **IRR / NPV / EV (Embedded Value)** cho project view.

NGUYÊN TẮC:
- KHÔNG bịa con số. Khi không có data → nói thẳng "cần actuary tính chính thức, đây là estimate dùng method X với assumption Y".`,
  },
  {
    id: "insurance-distribution",
    name: "Insurance Distribution & Channels",
    icon: "🏪",
    category: "insurance",
    description: "Channel strategy, commission TT67, productivity post-2023, InsurTech",
    prompt:
`SKILL, Insurance Distribution:
KÊNH PHÂN PHỐI VN:
- **Agent**: tied (gắn 1 DN) / independent. Phổ biến cho life + motor non-life.
- **Bancassurance**: exclusive (1 DN-1 bank) / non-exclusive. **Sau scandal 2023 + NĐ06/2023 + TT67/2023, quy định chặt: tách rời sản phẩm khỏi vay, video tư vấn ≥ 15-20 phút**.
- **Broker**: corporate B2B (Aon, Marsh, WTW), retail nhỏ.
- **Direct/Online (D2C)**: web/app DN — cost thấp nhưng conversion thấp.
- **CTV (Cộng tác viên)**: kênh non-life phổ biến VN, không cần code agent đầy đủ, thường partner với garage/showroom/clinic cho motor/health.
- **Embedded**: B2B2C qua e-commerce/ride-hailing/utility, micro-policy phí <100k VND, gắn vào checkout — conversion cao.
- **Affinity**: bán qua hiệp hội/cộng đồng (vd hội xe).
- **InsurTech aggregators VN**: eBaohiem, Papaya, MEDDI, Inon, Lina, Bihaco, MoMo Insurance — kênh online compare/buy, cost acquisition thấp, conversion ~1-3%, lead generation channel.

PRODUCTIVITY BENCHMARK (cập nhật post-2023):
- **Agent life**: ~15-25 policies/agent/năm (tied), tied agent productivity giảm sau giai đoạn dồn nén banca.
- **Banca life**: **post-2023 reality ~3-8 policies/teller/năm** (giảm mạnh từ ~8-15 trước scandal do compliance chặt + KH e ngại).
- **Online D2C**: ~1-3 policies/visitor/năm (conversion thấp nhưng cost thấp).
- **Broker corporate**: ít deal, ticket lớn.

COMMISSION (TT 67/2023 — bắt buộc compliant):
- **Life**: max 40% phí năm 1 cho cá nhân, giảm dần năm 2-5 (35/25/15/15%). Bonus thưởng riêng nhưng cap tổng.
- **Non-life** tùy line:
  - Xe cơ giới: 20-30%.
  - Sức khỏe: 15-25%.
  - Tài sản (P&C): 10-20%.
  - Marine/Aviation/Energy: 5-15%.
- **Bancassurance**: cap riêng + disclosure mandatory + tách khỏi vay.

LAPSE RATE BENCHMARK (life VN — quan trọng cho economic model):
- Year-1 lapse: 10-15%.
- Year-2 lapse: **25-35%** (CAO so APAC ~15-20%).
- Persistency 25M cohort: 50-60% (vs APAC ~70-75%).
- Driver lapse: banca pressure-selling, mis-selling, KH không hiểu surrender value năm đầu.

SALES ENABLEMENT plan chuẩn:
- Training: sản phẩm + compliance (NĐ06 + TT67 + AML).
- Sales script approved (không tự ý promise return).
- Brochure + leave-behind material.
- Demo tool (cash value projection).
- Objection handling guide.

CHANNEL KPI:
- **NWP** (new business premium).
- **Persistency 13M/25M/61M**.
- **Productivity per agent/teller**.
- **Lapse rate** + **Complaint rate**.
- **CAC** (Customer Acquisition Cost) per policy.

NGUYÊN TẮC:
- Khi recommend channel mix → luôn check compliance (NĐ06 banca), commission cap (TT67), persistency target.
- Cite số benchmark phải có nguồn + năm (AVI/IAV/báo cáo DN).`,
  },
  {
    id: "web-research",
    name: "Cited Web Research",
    icon: "🌐",
    category: "ops",
    description: "WebFetch/WebSearch, đánh giá nguồn, trích dẫn",
    prompt:
`SKILL, Web research:
- WebSearch trước để tìm nguồn tốt, WebFetch để đọc.
- Phân loại nguồn theo độ tin cậy:
  - PRIMARY (ưu tiên cao nhất): báo cáo chính DN, công bố chính phủ, dataset gốc, peer-reviewed paper.
  - SECONDARY: báo lớn (Reuters/FT/VnExpress chuyên mục), think-tank, analyst report.
  - TERTIARY (skeptical): Wikipedia (làm starting point, tra ref gốc), blog, social.
- Trích dẫn: nêu nguồn + ngày + URL. VD: "Theo PVI báo cáo Q1/2026 (link)".
- Cross-check ≥ 2 nguồn ĐỘC LẬP khi số liệu nhạy cảm (không phải 2 trang quote nhau).
- KHÔNG bịa số liệu khi không tìm thấy, báo "không tìm thấy nguồn xác thực", không guess.
- Cẩn thận số tròn đẹp (1B, 50%, 80%) → thường là rough estimate, cite thẳng "estimate" không đưa decimal giả vờ chính xác.
- AI-generated content (ChatGPT/Gemini answer) KHÔNG phải nguồn, luôn tra primary.
- Outdated info: check ngày publish vs ngày hôm nay; data > 2 năm cũ phải flag rõ.`,
  },
];

/** Partial override applied on top of a built-in skill resolved by id.
 *  Keys that are `null`/missing fall through to the library default. */
export type SkillOverrideMap = Record<string, { name?: string | null; description?: string | null; prompt?: string | null }>;

export function getSkillById(
  id: string,
  customSkills?: Skill[],
  overrides?: SkillOverrideMap,
): Skill | undefined {
  const base = SKILLS_LIBRARY.find(s => s.id === id) ?? customSkills?.find(s => s.id === id);
  if (!base) return undefined;
  const ovr = overrides?.[id];
  if (!ovr) return base;
  return {
    ...base,
    name: ovr.name ?? base.name,
    description: ovr.description ?? base.description,
    prompt: ovr.prompt ?? base.prompt,
  };
}

export function buildSkillsPrompt(
  skillIds: string[],
  customSkills?: Skill[],
  overrides?: SkillOverrideMap,
): string {
  if (!skillIds || skillIds.length === 0) return "";
  const skills = skillIds
    .map(id => getSkillById(id, customSkills, overrides))
    .filter((s): s is Skill => !!s);
  if (skills.length === 0) return "";
  return `\n\n=== SKILLS ĐƯỢC CÀI ĐẶT (${skills.length}) ===\n` +
    skills.map(s => `[${s.name}] ${s.prompt}`).join("\n\n") +
    `\n=== HẾT SKILLS ===`;
}

