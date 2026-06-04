/**
 * html-to-pptx-native — NATIVE SHAPES (Canva-style, object thật, sửa + animate).
 *
 * KHÁC bản hybrid cũ (ảnh nền phẳng + chữ overlay): KHÔNG dùng 1 ảnh chụp full
 * slide nữa. Thay vào đó MỌI thứ là object riêng để trình chiếu animate được:
 *   - boxes  -> rounded-rect / oval native (fill / gradient / border / radius +
 *               box-shadow) — từng card animate được.
 *   - charts -> mỗi <svg>/<canvas> chụp THẲNG element thành 1 ảnh-khối, đặt đúng
 *               vị trí (donut/bar/icon vẫn faithful 100%, animate được cả khối).
 *   - texts  -> textbox native (font/size/màu/đoạn), KHÔNG shrink-to-fit (giữ pt).
 * FONT: nhúng full TTF từ public/fonts (resolveDeckFonts) -> đúng font mọi máy.
 *
 * Đánh đổi: hiệu ứng CSS rất phức tạp (filter/backdrop-blur) không tái hiện được;
 * deck dày đặc có thể lệch nhẹ. Bù lại từng phần tử là object để gắn animation.
 */
import puppeteer from "puppeteer-core";
import path from "node:path";
import os from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { nativePptx, type PptxResult } from "./pptx-export";

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter((p): p is string => !!p);

function findEdge(): string | null {
  return EDGE_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tìm TTF FULL cho các font deck dùng, trong public/fonts/. Đặt tên file theo
 *  <Family>-Regular/Bold/Italic/BoldItalic.ttf (vd BeVietnamPro-Bold.ttf). Trả về
 *  list cho embed_fonts() NHÚNG thẳng vào .pptx -> đúng font ở MỌI máy, không cần
 *  cài. Phải là TTF full (KHÔNG woff2/subset) thì PowerPoint mới nhận. */
function resolveDeckFonts(families: Set<string>): Array<Record<string, string | null>> {
  const dir = path.join(process.cwd(), "public", "fonts");
  if (!existsSync(dir)) return [];
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => /\.ttf$/i.test(f)); } catch { return []; }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const out: Array<Record<string, string | null>> = [];
  for (const fam of families) {
    if (!fam) continue;
    const key = norm(fam);
    const pick = (variants: string[]) => {
      for (const f of files) {
        const n = norm(f.replace(/\.ttf$/i, ""));
        if (n.startsWith(key) && variants.includes(n.slice(key.length))) return path.join(dir, f);
      }
      return null;
    };
    const regular = pick(["", "regular"]);
    const bold = pick(["bold"]);
    const italic = pick(["italic"]);
    const boldItalic = pick(["bolditalic"]);
    if (regular || bold || italic || boldItalic) {
      out.push({ family: fam, regular, bold, italic, boldItalic });
    }
  }
  return out;
}

const VW = 1280;
const VH = 720;

/* eslint-disable */
// Chạy TRONG browser (self-contained). Trích mỗi .slide:
//   boxes (nền/viền/gradient/radius/shadow), texts (box-root leaf + text mồ côi),
//   charts (mỗi <svg>/<canvas> -> gắn data-pcx để Node chụp thẳng element).
function extractInBrowser(): any {
  const toHex = (n: number) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, "0");
  const parseColor = (s: string) => {
    if (!s) return { hex: null as string | null, a: 0 };
    const m = s.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i);
    if (!m) return { hex: null as string | null, a: 0 };
    const a = m[4] === undefined ? 1 : parseFloat(m[4]);
    return { hex: "#" + toHex(+m[1]) + toHex(+m[2]) + toHex(+m[3]), a };
  };
  const gradColors = (bgImg: string) => {
    if (!bgImg || bgImg === "none" || !/gradient/i.test(bgImg)) return null;
    const cols: string[] = [];
    const re = /rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(bgImg))) {
      const c = parseColor(m[0]);
      if (c.hex) cols.push(c.hex);
    }
    if (cols.length < 2) return null;
    // Radial: giữ tâm (at X% Y%, mặc định 50% 50%) -> PowerPoint path="circle".
    if (/radial-gradient/i.test(bgImg)) {
      let fx = 50, fy = 50;
      const at = bgImg.match(/at\s+([\d.]+)%\s+([\d.]+)%/i);
      if (at) { fx = parseFloat(at[1]); fy = parseFloat(at[2]); }
      return { type: "radial", colors: cols, fx, fy };
    }
    const am = bgImg.match(/(-?\d+(?:\.\d+)?)deg/);
    return { type: "linear", colors: cols, angle: am ? parseFloat(am[1]) : 90 };
  };
  // box-shadow (computed: "rgba(..) Xpx Ypx Bpx Spx") -> {dx,dy,blur,color,alpha}.
  // Lấy shadow NGOÀI đầu tiên, bỏ qua inset.
  const parseShadow = (s: string) => {
    if (!s || s === "none") return null;
    const first = s.split(/,(?![^(]*\))/)[0].trim();
    if (!first || /inset/.test(first)) return null;
    const col = parseColor(first);
    if (!col.hex || col.a < 0.03) return null;
    const nums = (first.match(/-?[\d.]+px/g) || []).map(parseFloat);
    if (nums.length < 2) return null;
    return { dx: nums[0] || 0, dy: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0, color: col.hex, alpha: col.a };
  };
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH", "CANVAS", "BR", "HR"]);
  const isBoxRoot = (el: Element) => {
    const d = getComputedStyle(el).display;
    return d !== "inline" && d !== "contents" && d !== "none";
  };
  const colorOf = (cs: CSSStyleDeclaration) => {
    // Màu chữ THỰC = -webkit-text-fill-color (mặc định = color). Khi chữ tô
    // gradient (background-clip:text + text-fill-color:transparent) thì fill
    // trong suốt -> lấy MÀU ĐẦU của gradient nền làm màu chữ (PowerPoint không
    // tô gradient theo chữ được). Nếu không, dùng fill/color như thường.
    const eff = parseColor(cs.webkitTextFillColor || cs.color);
    if (eff.a >= 0.1) return eff.hex;
    const g = gradColors(cs.backgroundImage);
    if (g) return g.colors[0];
    return parseColor(cs.color).hex;
  };
  // letter-spacing (px) -> spc PowerPoint (centipoints). Âm = siết chữ.
  const spcOf = (cs: CSSStyleDeclaration) => {
    const ls = cs.letterSpacing;
    if (!ls || ls === "normal") return 0;
    return Math.round((parseFloat(ls) || 0) * 75);
  };
  // weight -> family riêng cho nét NẶNG (embeddedFont chỉ 4 slot/family):
  // >=850 -> "<Fam> Black", 750-849 -> "<Fam> ExtraBold" (bold=false), 600-749 -> bold 700.
  const famWeight = (cs: CSSStyleDeclaration) => {
    const fw = parseInt(cs.fontWeight, 10) || 400;
    let fam: string | null = (cs.fontFamily || "").split(",")[0].replace(/["']/g, "").trim() || null;
    let bold = false;
    if (fam && fw >= 850) fam = fam + " Black";
    else if (fam && fw >= 750) fam = fam + " ExtraBold";
    else bold = fw >= 600;
    return { fam, bold };
  };
  // text-transform: PowerPoint textbox không có thuộc tính này -> biến đổi chuỗi
  // ngay lúc trích (uppercase cho kicker/badge/label/th deck; lowercase/capitalize hiếm).
  const txTransform = (text: string, cs: CSSStyleDeclaration) => {
    switch (cs.textTransform) {
      case "uppercase": return text.toUpperCase();
      case "lowercase": return text.toLowerCase();
      case "capitalize": return text.replace(/(^|\s)(\S)/g, (_m, p, c) => p + c.toUpperCase());
      default: return text;
    }
  };
  const mkRun = (text: string, cs: CSSStyleDeclaration) => {
    const fsz = parseFloat(cs.fontSize) || 16;
    const { fam, bold } = famWeight(cs);
    return {
      text: txTransform(text, cs), font: fam, size_pt: +(fsz * 0.75).toFixed(1),
      color: colorOf(cs), bold, italic: cs.fontStyle === "italic", spc: spcOf(cs),
    };
  };
  const collectRuns = (block: Element): any[] => {
    const runs: any[] = [];
    const pushBreak = () => { if (runs.length && !runs[runs.length - 1].br) runs.push({ br: true }); };
    (function rec(node: Node) {
      node.childNodes.forEach((ch) => {
        if (ch.nodeType === 3) {
          const t = (ch.textContent || "").replace(/ /g, " ").replace(/\s+/g, " ");
          if (t.trim()) runs.push(mkRun(t, getComputedStyle(ch.parentElement as Element)));
        } else if (ch.nodeType === 1) {
          const e = ch as Element;
          if (e.tagName === "BR") { pushBreak(); return; }
          if (SKIP_TAGS.has(e.tagName)) return;
          if (getComputedStyle(e).display === "none") return;
          if (e !== block && isBoxRoot(e)) return;
          rec(e);
        }
      });
    })(block);
    const real: any[] = [];
    for (const r of runs) {
      if (r.br) { if (real.length && !real[real.length - 1].br) real.push(r); }
      else if (r.text && r.text.length) real.push(r);
    }
    while (real.length && real[0].br) real.shift();
    while (real.length && real[real.length - 1].br) real.pop();
    if (real.length) {
      const f = real.find((r) => !r.br);
      const l = [...real].reverse().find((r) => !r.br);
      if (f) f.text = f.text.replace(/^\s+/, "");
      if (l) l.text = l.text.replace(/\s+$/, "");
    }
    return real;
  };
  const alignOf = (cs: CSSStyleDeclaration) => {
    let align = cs.textAlign;
    if (align === "start") align = "left"; else if (align === "end") align = "right";
    let valign = "top";
    const d = cs.display;
    if (d === "flex" || d === "inline-flex") {
      const col = cs.flexDirection.startsWith("column");
      if ((col ? cs.justifyContent : cs.alignItems).includes("center")) valign = "middle";
      if ((col ? cs.alignItems : cs.justifyContent).includes("center")) align = "center";
    } else if (d === "grid" || d === "inline-grid") {
      if (cs.alignItems.includes("center")) valign = "middle";
      if (cs.justifyItems.includes("center") || cs.justifyContent.includes("center")) align = "center";
    }
    return { align: align || "left", valign };
  };

  const slides: any[] = [];
  const slideEls = document.querySelectorAll(".slide");
  for (let sIdx = 0; sIdx < slideEls.length; sIdx++) {
    const slide = slideEls[sIdx];
    const sr = slide.getBoundingClientRect();
    const boxes: any[] = [], texts: any[] = [], charts: any[] = [];
    const boxKeys = new Set<string>();
    const cpxRects: { x: number; y: number; w: number; h: number }[] = [];
    const coveredByCpx = (ex: number, ey: number, ew: number, eh: number) => {
      const area = ew * eh; if (area <= 0) return false;
      const cx = ex + ew / 2, cy = ey + eh / 2;
      for (const c of cpxRects) {
        const ix = Math.max(0, Math.min(ex + ew, c.x + c.w) - Math.max(ex, c.x));
        const iy = Math.max(0, Math.min(ey + eh, c.y + c.h) - Math.max(ey, c.y));
        if (ix * iy / area > 0.4) return true;
        if (cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h) return true;
      }
      return false;
    };
    const inChart = (el: Element) => el.closest("svg, canvas");
    // Đọc ĐÚNG tham số reveal của Aria: delay (transition-delay), dur
    // (transition-duration), rise (transition có transform/all = trượt lên).
    const revealOrder = new Map<Element, number>(); let revealSeq = 0;
    const animSpec = (el: Element): { d: number; dur: number; rise: boolean } | null => {
      const rv = el.closest && el.closest('[class*="reveal"]');
      if (!rv) return null;
      if (!revealOrder.has(rv)) revealOrder.set(rv, revealSeq++);
      const idx = revealOrder.get(rv)!;
      const ms = (s: string | null) => { s = (s || "0s").split(",")[0].trim(); const v = parseFloat(s) || 0; return /ms$/.test(s) ? v : v * 1000; };
      let d = Math.round(ms(rv.getAttribute("data-anim-d")));
      if (!d) d = idx * 130;  // CSS delay đọc 0 (shorthand ghi đè) -> stagger theo thứ tự
      const dur = Math.round(ms(rv.getAttribute("data-anim-dur"))) || 500;
      const rise = /transform|all/.test(rv.getAttribute("data-anim-prop") || "");
      return { d, dur, rise };
    };
    // Bounds RIÊNG của text node (bỏ icon/chấm dẫn đầu) -> chữ leaf bám đúng chữ.
    const leafTextRect = (el: Element): DOMRect | null => {
      let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
      (function rec(node: Node) {
        node.childNodes.forEach((ch) => {
          if (ch.nodeType === 3) {
            if (!(ch.textContent || "").trim()) return;
            const rng = document.createRange(); rng.selectNode(ch);
            const r = rng.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { L = Math.min(L, r.left); T = Math.min(T, r.top); R = Math.max(R, r.right); B = Math.max(B, r.bottom); }
          } else if (ch.nodeType === 1 && !SKIP_TAGS.has((ch as Element).tagName) && getComputedStyle(ch as Element).display !== "none") {
            rec(ch);
          }
        });
      })(el);
      if (R <= L || B <= T) return null;
      return { left: L, top: T, right: R, bottom: B, width: R - L, height: B - T, x: L, y: T } as DOMRect;
    };

    const pushText = (rect: DOMRect, runs: any[], cs: CSSStyleDeclaration, anim: { d: number; dur: number; rise: boolean } | null) => {
      if (!runs.length || rect.width <= 1 || rect.height <= 1) return;
      const fsz = parseFloat(cs.fontSize) || 16;
      const lh = cs.lineHeight === "normal" ? null : (parseFloat(cs.lineHeight) || null);
      const { fam, bold } = famWeight(cs);
      const { align, valign } = alignOf(cs);
      // PowerPoint dàn chữ rộng hơn Chrome vài % -> nới nhẹ bề ngang chống wrap thừa.
      const buf = Math.ceil(rect.width * 0.06) + 4;
      let bx = rect.left - sr.left;
      if (align === "center") bx -= buf / 2;
      else if (align === "right") bx -= buf;
      texts.push({
        x: bx, y: rect.top - sr.top, w: rect.width + buf, h: rect.height,
        runs,
        font: fam, size_pt: +(fsz * 0.75).toFixed(1), color: colorOf(cs),
        bold, italic: cs.fontStyle === "italic", spc: spcOf(cs),
        align, valign, line_pct: lh ? +(lh / fsz).toFixed(2) : null,
        anim: anim ?? null,
      });
    };

    // CSS pseudo (::before/::after) ABSOLUTE có nền -> dải/đường line + chấm tròn
    // trang trí (vd .roadmap::before = line gradient, .rm::before = dot). DOM-walker
    // không "thấy" pseudo nên phải đọc riêng. Chỉ xử lý position absolute/fixed (rect
    // tính được từ padding-box của el — cần el positioned — + top/left/width/height đã
    // resolve sang px). Pseudo in-flow (marker chữ) bỏ qua.
    const pushPseudo = (el: Element, which: "::before" | "::after") => {
      const cs = getComputedStyle(el, which);
      if (!cs) return;
      const content = cs.content;
      if (!content || content === "none" || content === "normal") return;
      if (cs.display === "none" || cs.visibility === "hidden") return;
      if (cs.position !== "absolute" && cs.position !== "fixed") return;
      const bg = parseColor(cs.backgroundColor);
      const grad = gradColors(cs.backgroundImage);
      if (!grad && bg.a <= 0.02) return; // không có nền nhìn thấy
      const ecs = getComputedStyle(el);
      if (ecs.position === "static") return; // CB của pseudo absolute != el -> bỏ
      const er = el.getBoundingClientRect();
      const bl = parseFloat(ecs.borderLeftWidth) || 0, bt = parseFloat(ecs.borderTopWidth) || 0;
      const brw = parseFloat(ecs.borderRightWidth) || 0, bbw = parseFloat(ecs.borderBottomWidth) || 0;
      const cbL = er.left + bl, cbT = er.top + bt;
      const cbW = er.width - bl - brw, cbH = er.height - bt - bbw;
      const num = (v: string) => (v === "auto" ? null : parseFloat(v));
      const left = num(cs.left), right = num(cs.right), top = num(cs.top), bottom = num(cs.bottom);
      let w = num(cs.width), h = num(cs.height);
      if (w == null) w = (left != null && right != null) ? cbW - left - right : null;
      if (h == null) h = (top != null && bottom != null) ? cbH - top - bottom : null;
      if (w == null || h == null || w <= 0.5 || h <= 0.5) return;
      let x: number, y: number;
      if (left != null) x = cbL + left;
      else if (right != null) x = cbL + cbW - right - w;
      else x = cbL;
      if (top != null) y = cbT + top;
      else if (bottom != null) y = cbT + cbH - bottom - h;
      else y = cbT;
      const crv = (cs.borderTopLeftRadius || "0px").split(" ")[0];
      const radPctP = crv.includes("%") ? (parseFloat(crv) || 0) : 0;
      const radiusPxP = crv.includes("%") ? (radPctP / 100) * Math.min(w, h) : (parseFloat(crv) || 0);
      const mn = Math.min(w, h), mx = Math.max(w, h);
      const ell = radPctP >= 49 || (radPctP === 0 && mn >= mx * 0.82 && radiusPxP >= mn * 0.45);
      // Pseudo là DẢI mỏng chạy dọc 1 cạnh của card bo góc + overflow:hidden (vd
      // .kpi::before = thanh accent trái). Trong HTML card CLIP dải ôm góc bo nên
      // nhìn cong; export phải dựng dải accent CONG ôm góc (accent:{side,t,r}) thay
      // vì thanh thẳng — giống path border-left CSS, nhưng đây là pseudo-bar.
      const pcrv = (ecs.borderTopLeftRadius || "0px").split(" ")[0];
      const Rp = pcrv.includes("%") ? (parseFloat(pcrv) || 0) / 100 * Math.min(er.width, er.height) : (parseFloat(pcrv) || 0);
      const ov = (ecs.overflow || "") + (ecs.overflowX || "") + (ecs.overflowY || "");
      if (!grad && Rp >= 1 && /hidden|clip/.test(ov)) {
        const eps = 2, spansV = h >= er.height - 2.5, spansH = w >= er.width - 2.5;
        const thinW = w <= er.width * 0.35, thinH = h <= er.height * 0.35;
        let aside: string | null = null;
        if (spansV && thinW && Math.abs(x - er.left) < eps) aside = "left";
        else if (spansV && thinW && Math.abs(x + w - er.right) < eps) aside = "right";
        else if (spansH && thinH && Math.abs(y - er.top) < eps) aside = "top";
        else if (spansH && thinH && Math.abs(y + h - er.bottom) < eps) aside = "bottom";
        if (aside) {
          boxes.push({
            x: er.left - sr.left, y: er.top - sr.top, w: er.width, h: er.height,
            fill: bg.hex, fill_alpha: bg.a, gradient: null, line: null, line_w: 0, line_alpha: 1,
            radius: 0, corners: null, ellipse: false, shadow: null,
            accent: { side: aside, t: (aside === "left" || aside === "right") ? w : h, r: Rp }, anim: animSpec(el),
          });
          return;
        }
      }
      boxes.push({
        x: x - sr.left, y: y - sr.top, w, h,
        fill: grad ? null : bg.hex, fill_alpha: grad ? 1 : bg.a,
        gradient: grad, line: null, line_w: 0, line_alpha: 1,
        radius: radiusPxP, corners: null, ellipse: ell,
        shadow: parseShadow(cs.boxShadow), anim: animSpec(el),
      });
    };

    // COMPLEX SHAPE: transform xoay/nghiêng/scale hoặc clip-path -> native không
    // dựng nổi -> chụp ảnh-khối nguyên vẹn (bỏ qua container quá lớn >55% slide).
    let xIdx = 0;
    slide.querySelectorAll("*").forEach((el) => {
      if (SKIP_TAGS.has(el.tagName) || el.closest("svg") || el.closest("[data-cpximg]")) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || cs.position === "fixed") return;
      const tr = cs.transform || "none";
      let complex = !!(cs.clipPath && cs.clipPath !== "none");
      if (!complex && tr.startsWith("matrix")) {
        const m = tr.match(/matrix\(([^)]+)\)/);
        if (m) { const p = m[1].split(",").map(parseFloat); if (Math.abs(p[0] - 1) > 0.01 || Math.abs(p[1]) > 0.01 || Math.abs(p[2]) > 0.01 || Math.abs(p[3] - 1) > 0.01) complex = true; }
      }
      if (!complex) return;
      const rb = el.getBoundingClientRect();
      if (rb.width <= 4 || rb.height <= 4) return;
      if (rb.width * rb.height > sr.width * sr.height * 0.55) return;
      const id = "x" + sIdx + "_" + (xIdx++);
      el.setAttribute("data-pcx", id);
      el.setAttribute("data-cpximg", "1");
      const cxx = rb.left - sr.left, cyy = rb.top - sr.top;
      cpxRects.push({ x: cxx, y: cyy, w: rb.width, h: rb.height });
      charts.push({ id, x: cxx, y: cyy, w: rb.width, h: rb.height, anim: animSpec(el) });
    });

    // CHART/ICON: mỗi <svg>/<canvas> top-level -> gắn data-pcx, Node chụp thẳng.
    let cIdx = 0;
    slide.querySelectorAll("svg, canvas").forEach((el) => {
      if (el.closest("[data-cpximg]")) return;
      if (el.tagName === "svg".toUpperCase() && el.parentElement && el.parentElement.closest("svg")) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return;
      const rb = el.getBoundingClientRect();
      if (rb.width <= 3 || rb.height <= 3) return;
      const id = sIdx + "_" + (cIdx++);
      el.setAttribute("data-pcx", id);
      charts.push({ id, x: rb.left - sr.left, y: rb.top - sr.top, w: rb.width, h: rb.height, anim: animSpec(el) });
    });

    const all: Element[] = [slide, ...Array.from(slide.querySelectorAll("*"))];
    for (const el of all) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (inChart(el) || el.closest("[data-cpximg]")) continue; // trong chart/complex-img -> đã chụp
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || cs.position === "fixed") continue;
      // Pseudo trang trí (line/dot) — đọc bất kể el có box riêng hay không.
      pushPseudo(el, "::before");
      pushPseudo(el, "::after");
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      if (coveredByCpx(r.left - sr.left, r.top - sr.top, r.width, r.height)) continue; // bị ảnh-khối phủ
      if (el.tagName === "IMG") continue; // deck slide hiếm dùng <img>; xử lý sau

      // --- BOX ---
      const bg = parseColor(cs.backgroundColor);
      // Gradient cắt theo CHỮ (background-clip:text) = chữ tô gradient, KHÔNG
      // phải nền box -> bỏ, đừng vẽ thành hộp gradient (màu chữ xử lý ở colorOf).
      const bgClipText = /text/.test((cs.getPropertyValue("-webkit-background-clip") || "") + " " + (cs.backgroundClip || ""));
      const grad = bgClipText ? null : gradColors(cs.backgroundImage);
      // Viền TỪNG CẠNH: đều 4 cạnh -> line quanh box; chỉ 1 vài cạnh (vd border-top)
      // -> KHÔNG line full mà vẽ THANH ACCENT mỏng ở cạnh đó (hiệu ứng 3D).
      const sd = [
        { w: parseFloat(cs.borderTopWidth) || 0, c: parseColor(cs.borderTopColor), st: cs.borderTopStyle, e: "top" },
        { w: parseFloat(cs.borderRightWidth) || 0, c: parseColor(cs.borderRightColor), st: cs.borderRightStyle, e: "right" },
        { w: parseFloat(cs.borderBottomWidth) || 0, c: parseColor(cs.borderBottomColor), st: cs.borderBottomStyle, e: "bottom" },
        { w: parseFloat(cs.borderLeftWidth) || 0, c: parseColor(cs.borderLeftColor), st: cs.borderLeftStyle, e: "left" },
      ];
      const bd = sd.filter((s) => s.w > 0.3 && s.st !== "none" && s.c.a > 0.05);
      const uniform = bd.length === 4 && bd.every((s) => Math.abs(s.w - bd[0].w) < 0.8 && s.c.hex === bd[0].c.hex);
      const hasBorder = uniform;
      const bcol = { hex: bd.length ? bd[0].c.hex : null };
      const bw = bd.length ? bd[0].w : 0;
      const accentSides = uniform ? [] : bd;
      const hasFill = grad || bg.a > 0.02;
      // Chrome trả border-radius computed có thể "%" hoặc "px" -> xử lý CẢ HAI.
      // Bo theo % >= ~49% = oval/tròn lấp đầy box (bất kể kích thước); px-radius
      // lớn trên box gần vuông = tròn. Pill (px lớn, không vuông) -> roundRect.
      // Lấy MAX 4 góc (vd "0 0 16px 16px" chỉ bo dưới -> vẫn nhận là bo góc,
      // không bị vuông vì góc trên-trái = 0).
      const cornerStr = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius];
      let radiusPx = 0, radPct = 0;
      const cornerPx = [0, 0, 0, 0]; // [TL, TR, BR, BL] px
      for (let ci = 0; ci < 4; ci++) {
        const v = (cornerStr[ci] || "0px").split(" ")[0].trim();
        let px: number;
        if (v.includes("%")) { const p = parseFloat(v) || 0; radPct = Math.max(radPct, p); px = (p / 100) * Math.min(r.width, r.height); }
        else px = parseFloat(v) || 0;
        cornerPx[ci] = px;
        radiusPx = Math.max(radiusPx, px);
      }
      // Bo góc KHÔNG đều (vd "0 0 16px 16px" = chỉ 2 góc dưới) -> giữ riêng từng góc.
      const cornersUniform = cornerPx.every((c) => Math.abs(c - cornerPx[0]) < 0.6);
      const minSide = Math.min(r.width, r.height), maxSide = Math.max(r.width, r.height);
      const ellipse = (radPct >= 49) || (radPct === 0 && minSide >= maxSide * 0.82 && radiusPx >= minSide * 0.45);
      if (hasFill || hasBorder || accentSides.length) {
        const bx = r.left - sr.left, by = r.top - sr.top;
        if (hasFill || hasBorder) {
          const key = [Math.round(bx / 3), Math.round(by / 3), Math.round(r.width / 3), Math.round(r.height / 3),
            hasBorder ? 1 : 0, grad ? "g" : (bg.a > 0.02 ? bg.hex : "n")].join(",");
          if (!boxKeys.has(key)) {
            boxKeys.add(key);
            boxes.push({
              x: bx, y: by, w: r.width, h: r.height,
              fill: grad ? null : (bg.a > 0.02 ? bg.hex : null),
              fill_alpha: grad ? 1 : bg.a,
              gradient: grad,
              line: hasBorder ? bcol.hex : null,
              line_w: hasBorder ? bw : 0,
              line_alpha: hasBorder && bd.length ? bd[0].c.a : 1,
              radius: radiusPx,
              corners: (!ellipse && !cornersUniform) ? cornerPx.map((c) => +c.toFixed(1)) : null,
              ellipse,
              shadow: parseShadow(cs.boxShadow),
              anim: animSpec(el),
            });
          }
        }
        for (const s of accentSides) {
          const horiz = s.e === "top" || s.e === "bottom";
          if (radiusPx >= 1) {
            // Card bo góc -> dải accent đi VÒNG theo 2 góc kề cạnh đó (custom
            // geometry trong python) để cong ôm sát mép như border-top của HTML.
            // bbox = nguyên card; chỉ tô dải mỏng dọc cạnh `side`.
            boxes.push({ x: bx, y: by, w: r.width, h: r.height, fill: s.c.hex, fill_alpha: s.c.a, gradient: null, line: null, line_w: 0, radius: 0, corners: null, ellipse: false, shadow: null, accent: { side: s.e, t: s.w, r: radiusPx }, anim: animSpec(el) });
          } else {
            // Card vuông -> thanh thẳng full cạnh như cũ.
            const aw = horiz ? r.width : s.w;
            const ah = horiz ? s.w : r.height;
            const ax = s.e === "right" ? bx + r.width - s.w : bx;
            const ay = s.e === "bottom" ? by + r.height - s.w : by;
            boxes.push({ x: ax, y: ay, w: aw, h: ah, fill: s.c.hex, fill_alpha: s.c.a, gradient: null, line: null, line_w: 0, radius: 0, corners: null, ellipse: false, shadow: null, anim: animSpec(el) });
          }
        }
      }

      // --- TEXT ---
      if (!(el as HTMLElement).innerText || !(el as HTMLElement).innerText.trim() || !isBoxRoot(el)) continue;
      const hasInnerBoxText = Array.from(el.querySelectorAll("*")).some(
        (c) => c.tagName !== "IMG" && !c.closest("svg") && isBoxRoot(c) && ((c as HTMLElement).innerText || "").trim());
      const ag = animSpec(el);
      if (!hasInnerBoxText) {
        pushText(leafTextRect(el) || r, collectRuns(el), cs, ag);
      } else {
        for (const node of Array.from(el.childNodes)) {
          if (node.nodeType !== 3) continue;
          const t = (node.textContent || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
          if (!t) continue;
          const range = document.createRange();
          range.selectNode(node);
          pushText(range.getBoundingClientRect(), [mkRun(t, cs)], cs, ag);
        }
      }
    }

    slides.push({ boxes, texts, charts, cover: slide.classList.contains("s-cover") });
  }
  return slides;
}
/* eslint-enable */

/** Render the HTML file at `htmlPath` to `outputPath` (.pptx) as native, editable
 *  objects (box/chart/text riêng) với font deck nhúng. Throws nếu thiếu Edge. */
export async function renderHtmlToPptxNative(
  htmlPath: string,
  outputPath: string,
): Promise<PptxResult & { fonts_embedded?: number }> {
  const edge = findEdge();
  if (!edge) {
    throw new Error(
      "Không tìm thấy Microsoft Edge để render slide. Cài Edge (hoặc set biến môi trường EDGE_PATH trỏ tới msedge.exe).",
    );
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "nativepptx-"));
  const browser = await puppeteer.launch({
    executablePath: edge,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: VW, height: VH, deviceScaleFactor: 2 });
    const fileUrl = "file:///" + htmlPath.replace(/\\/g, "/").replace(/^\/+/, "");
    await page.goto(fileUrl, { waitUntil: "networkidle0", timeout: 45000 });
    // Đọc tham số reveal TRƯỚC khi freeze (style freeze có transition:none xoá hết).
    await page.evaluate(() => {
      document.querySelectorAll('[class*="reveal"]').forEach((el) => {
        const c = getComputedStyle(el);
        el.setAttribute("data-anim-d", (c.transitionDelay || "").split(",")[0].trim());
        el.setAttribute("data-anim-dur", (c.transitionDuration || "").split(",")[0].trim());
        el.setAttribute("data-anim-prop", c.transitionProperty || "");
      });
    });
    await page.addStyleTag({
      content:
        "html{scroll-snap-type:none!important;scroll-behavior:auto!important}" +
        "*,*::before,*::after{animation:none!important;animation-duration:0s!important;transition:none!important}" +
        ".reveal,[class*='reveal']{opacity:1!important;transform:none!important;filter:none!important}",
    });
    await page.evaluate(() => (document as Document).fonts?.ready).catch(() => {});
    await page.evaluate(() =>
      document.querySelectorAll(".slide").forEach((s) => s.classList.add("visible")));
    await sleep(250);

    // 1) Trích boxes/texts/charts + gắn data-pcx cho chart element.
    const slides = (await page.evaluate(extractInBrowser)) as any[];
    if (!slides.length) throw new Error("Không tìm thấy slide (.slide) nào trong HTML.");

    // 2) Chụp THẲNG từng chart/icon element (tự cuộn tới đúng chỗ -> không lệch).
    // Bỏ nền slide/body (đã trích xong) để chụp chart NỀN TRONG SUỐT (omitBackground)
    // -> chart đặt lên nền PPTX không bị "hộp" nền HTML lệch màu (rõ ở deck nền tối/
    // gradient). Chỉ bỏ nền cấp slide; nền element phức tạp (data-cpximg) giữ nguyên.
    // BỎ box-shadow + filter trên MỌI element khi chụp ảnh-khối: handle.screenshot
    // cắt theo bounding-box từ ảnh CẢ TRANG nên bóng của element kế bên (vd card
    // phía trên lục giác) lọt vào ảnh -> "hộp/bóng" lạ. Bóng box đã trích vào spec,
    // pptx_gen tự vẽ lại; ảnh-khối không cần mang bóng. (Chạy sau khi đã trích.)
    await page.addStyleTag({ content: "html,body,.slide{background:transparent!important} *{box-shadow:none!important;filter:none!important}" });
    for (let i = 0; i < slides.length; i++) {
      const imgs: any[] = [];
      for (const c of (slides[i].charts || [])) {
        const handle = await page.$(`[data-pcx="${c.id}"]`);
        if (!handle) continue;
        const p = path.join(tmpDir, `chart-${c.id}.png`);
        try {
          // Bỏ filter (drop-shadow) trên chart trước khi chụp: screenshot cắt
          // theo bounding-box element -> shadow bị clip cứng thành "hộp vuông"
          // mờ bao quanh chart (vd donut). Shadow chỉ trang trí, bỏ là sạch.
          await handle.evaluate((el: any) => { el.style.filter = "none"; });
          // Isolate the chart before the bounding-box screenshot: hide every OTHER
          // element (keep only this chart's subtree + its ancestors). A full-bleed,
          // transparent chart svg (e.g. the S-curve line spanning the whole .scwrap)
          // otherwise bakes the overlapping cards/title into the image — which then
          // shows as duplicate text under the editable native textbox.
          await handle.evaluate((el: any) => {
            const keep = new Set<Element>();
            for (let a: Element | null = el; a; a = a.parentElement) keep.add(a);
            document.querySelectorAll("body *").forEach((n: any) => {
              if (keep.has(n) || el.contains(n)) return;
              n.setAttribute("data-pcx-vis", n.style.visibility || "__");
              n.style.visibility = "hidden";
            });
          });
          await handle.screenshot({ path: p as `${string}.png`, omitBackground: true });
          await page.evaluate(() => {
            document.querySelectorAll("[data-pcx-vis]").forEach((n: any) => {
              const v = n.getAttribute("data-pcx-vis");
              n.style.visibility = v === "__" ? "" : v;
              n.removeAttribute("data-pcx-vis");
            });
          });
          imgs.push({ x: c.x, y: c.y, w: c.w, h: c.h, path: p });
        } catch { /* element không chụp được -> bỏ */ }
        await handle.dispose();
      }
      slides[i].images = imgs;
    }
    await browser.close();

    // 3) Spec: mỗi slide = box thật + chart-ảnh + textbox (không shrink) + font nhúng.
    const specSlides = slides.map((s) => ({
      boxes: s.boxes || [],
      images: s.images || [],
      texts: s.texts || [],
    }));

    // Gom font deck dùng -> tìm TTF full trong public/fonts -> nhúng.
    const families = new Set<string>();
    for (const s of slides) for (const t of (s.texts || [])) {
      if (t.font) families.add(t.font);
      for (const r of (t.runs || [])) if (r && r.font) families.add(r.font);
    }
    const fonts = resolveDeckFonts(families);

    return await nativePptx({
      output: outputPath,
      slide_w_px: VW,
      slide_h_px: VH,
      width_in: 13.333,
      height_in: 7.5,
      autofit: "none",
      transition: "fade",
      anim: "none", // reveal animation tắt theo yêu cầu user (chỉ fade chuyển slide)
      slides: specSlides,
      fonts,
    });
  } finally {
    await browser.close().catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
