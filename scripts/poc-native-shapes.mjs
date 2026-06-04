/**
 * POC v2: HTML deck -> NATIVE SHAPES pptx (box/chart/text Ä‘á»u lÃ  object tháº­t).
 *
 * KhÃ¡c báº£n hybrid (poc-native.mjs): KHÃ”NG dÃ¹ng 1 áº£nh ná»n pháº³ng. Thay vÃ o Ä‘Ã³:
 *   - boxes  -> rounded-rect / oval native (fill/gradient/border/radius + SHADOW)
 *   - charts -> má»—i <svg>/<canvas> chá»¥p riÃªng 1 áº£nh-khá»‘i, Ä‘áº·t Ä‘Ãºng vá»‹ trÃ­
 *               (animate Ä‘Æ°á»£c cáº£ khá»‘i, váº«n faithful 100% pháº§n váº½ phá»©c táº¡p)
 *   - texts  -> textbox native (giá»¯ font/size/mÃ u), KHÃ”NG shrink-to-fit
 * Má»¥c tiÃªu: tá»«ng box/chart lÃ  object riÃªng -> thÃªm hiá»‡u á»©ng/animation trong PPT.
 *
 * DÃ¹ng:  node scripts/poc-native-shapes.mjs <input.html> <output.pptx>
 */
import puppeteer from "puppeteer-core";
import path from "node:path";
import os from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { writeFile, mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";

// Giá»‘ng resolveDeckFonts trong app: tÃ¬m TTF full trong public/fonts theo family.
function resolveDeckFonts(families) {
  const dir = path.resolve("public/fonts");
  if (!existsSync(dir)) return [];
  let files = [];
  try { files = readdirSync(dir).filter((f) => /\.ttf$/i.test(f)); } catch { return []; }
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const out = [];
  for (const fam of families) {
    if (!fam) continue;
    const key = norm(fam);
    const pick = (variants) => {
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
    if (regular || bold || italic || boldItalic) out.push({ family: fam, regular, bold, italic, boldItalic });
  }
  return out;
}

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const findEdge = () => EDGE_CANDIDATES.find((p) => existsSync(p)) ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VW = 1280, VH = 720;

/* eslint-disable */
function extractInBrowser() {
  const toHex = (n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, "0");
  const parseColor = (s) => {
    if (!s) return { hex: null, a: 0 };
    const m = s.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i);
    if (!m) return { hex: null, a: 0 };
    const a = m[4] === undefined ? 1 : parseFloat(m[4]);
    return { hex: "#" + toHex(+m[1]) + toHex(+m[2]) + toHex(+m[3]), a };
  };
  const gradColors = (bgImg) => {
    if (!bgImg || bgImg === "none" || !/gradient/i.test(bgImg)) return null;
    const cols = [];
    const re = /rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi;
    let m;
    while ((m = re.exec(bgImg))) {
      const c = parseColor(m[0]);
      if (c.hex) cols.push(c.hex);
    }
    if (cols.length < 2) return null;
    if (/radial-gradient/i.test(bgImg)) {
      let fx = 50, fy = 50;
      const at = bgImg.match(/at\s+([\d.]+)%\s+([\d.]+)%/i);
      if (at) { fx = parseFloat(at[1]); fy = parseFloat(at[2]); }
      return { type: "radial", colors: cols, fx, fy };
    }
    const am = bgImg.match(/(-?\d+(?:\.\d+)?)deg/);
    return { type: "linear", colors: cols, angle: am ? parseFloat(am[1]) : 90 };
  };
  // box-shadow (computed) -> { dx, dy, blur, color, alpha }. Láº¥y shadow NGOÃ€I
  // Ä‘áº§u tiÃªn (bá» qua inset). Computed tráº£: "rgba(..) Xpx Ypx Bpx Spx".
  const parseShadow = (s) => {
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
  const isBoxRoot = (el) => {
    const d = getComputedStyle(el).display;
    return d !== "inline" && d !== "contents" && d !== "none";
  };
  const colorOf = (cs) => {
    // Màu chữ THỰC = -webkit-text-fill-color (mặc định = color). Chữ tô gradient
    // (background-clip:text + text-fill-color:transparent) -> fill trong suốt ->
    // lấy màu đầu gradient nền làm màu chữ. Nếu không, dùng fill/color như thường.
    const eff = parseColor(cs.webkitTextFillColor || cs.color);
    if (eff.a >= 0.1) return eff.hex;
    const g = gradColors(cs.backgroundImage);
    if (g) return g.colors[0];
    return parseColor(cs.color).hex;
  };
  // weight -> family riÃªng cho nÃ©t Náº¶NG (PowerPoint embeddedFont chá»‰ 4 slot/family):
  // >=850 -> "<Fam> Black", 750-849 -> "<Fam> ExtraBold" (bold=false vÃ¬ family Ä‘Ã£ náº·ng);
  // 600-749 -> dÃ¹ng slot bold (700); <600 -> regular.
  // letter-spacing (computed px) -> spc PowerPoint (centipoints, 1/100 pt). Ã‚m = siáº¿t.
  const spcOf = (cs) => {
    const ls = cs.letterSpacing;
    if (!ls || ls === "normal") return 0;
    return Math.round((parseFloat(ls) || 0) * 75); // px*0.75pt*100
  };
  const famWeight = (cs) => {
    const fw = parseInt(cs.fontWeight, 10) || 400;
    let fam = (cs.fontFamily || "").split(",")[0].replace(/["']/g, "").trim() || null;
    let bold = false;
    if (fam && fw >= 850) fam = fam + " Black";
    else if (fam && fw >= 750) fam = fam + " ExtraBold";
    else bold = fw >= 600;
    return { fam, bold };
  };
  // text-transform: PowerPoint textbox khong co thuoc tinh nay -> bien doi chuoi
  // ngay luc trich (uppercase cho kicker/badge/label/th deck; lowercase/capitalize hiem).
  const txTransform = (text, cs) => {
    switch (cs.textTransform) {
      case "uppercase": return text.toUpperCase();
      case "lowercase": return text.toLowerCase();
      case "capitalize": return text.replace(/(^|\s)(\S)/g, (_m, p, c) => p + c.toUpperCase());
      default: return text;
    }
  };
  const mkRun = (text, cs) => {
    const fsz = parseFloat(cs.fontSize) || 16;
    const { fam, bold } = famWeight(cs);
    return {
      text: txTransform(text, cs), font: fam, size_pt: +(fsz * 0.75).toFixed(1),
      color: colorOf(cs), bold, italic: cs.fontStyle === "italic", spc: spcOf(cs),
    };
  };
  const collectRuns = (block) => {
    const runs = [];
    const pushBreak = () => { if (runs.length && !runs[runs.length - 1].br) runs.push({ br: true }); };
    (function rec(node) {
      node.childNodes.forEach((ch) => {
        if (ch.nodeType === 3) {
          const t = (ch.textContent || "").replace(/ /g, " ").replace(/\s+/g, " ");
          if (t.trim()) runs.push(mkRun(t, getComputedStyle(ch.parentElement)));
        } else if (ch.nodeType === 1) {
          if (ch.tagName === "BR") { pushBreak(); return; }
          if (SKIP_TAGS.has(ch.tagName)) return;
          if (getComputedStyle(ch).display === "none") return;
          if (ch !== block && isBoxRoot(ch)) return;
          rec(ch);
        }
      });
    })(block);
    const real = [];
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
  const alignOf = (cs) => {
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
  // Bounds cá»§a RIÃŠNG text node trong el (bá» icon/cháº¥m dáº«n Ä‘áº§u) -> chá»¯ leaf bÃ¡m
  // Ä‘Ãºng vá»‹ trÃ­ chá»¯, khÃ´ng trÃ¹m lÃªn box trang trÃ­ (vd cháº¥m legend).
  const leafTextRect = (el) => {
    let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
    (function rec(node) {
      node.childNodes.forEach((ch) => {
        if (ch.nodeType === 3) {
          if (!(ch.textContent || "").trim()) return;
          const rng = document.createRange(); rng.selectNode(ch);
          const r = rng.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { L = Math.min(L, r.left); T = Math.min(T, r.top); R = Math.max(R, r.right); B = Math.max(B, r.bottom); }
        } else if (ch.nodeType === 1 && !SKIP_TAGS.has(ch.tagName) && getComputedStyle(ch).display !== "none") {
          rec(ch);
        }
      });
    })(el);
    if (R <= L || B <= T) return null;
    return { left: L, top: T, right: R, bottom: B, width: R - L, height: B - T };
  };

  const slides = [];
  const slideEls = document.querySelectorAll(".slide");
  for (let sIdx = 0; sIdx < slideEls.length; sIdx++) {
    const slide = slideEls[sIdx];
    const sr = slide.getBoundingClientRect();
    const boxes = [], texts = [], charts = [];
    const boxKeys = new Set();
    const inChart = (el) => el.closest("svg, canvas");
    // Äá»c ÄÃšNG tham sá»‘ reveal cá»§a Aria: delay (transition-delay), dur
    // (transition-duration), rise (transition cÃ³ transform/all = trÆ°á»£t lÃªn).
    const revealOrder = new Map(); let revealSeq = 0;
    const animSpec = (el) => {
      const rv = el.closest && el.closest('[class*="reveal"]');
      if (!rv) return null;
      if (!revealOrder.has(rv)) revealOrder.set(rv, revealSeq++);
      const idx = revealOrder.get(rv);
      const ms = (s) => { s = (s || "0s").split(",")[0].trim(); const v = parseFloat(s) || 0; return /ms$/.test(s) ? v : v * 1000; };
      let d = Math.round(ms(rv.getAttribute("data-anim-d")));
      if (!d) d = idx * 130;
      const dur = Math.round(ms(rv.getAttribute("data-anim-dur"))) || 500;
      const rise = /transform|all/.test(rv.getAttribute("data-anim-prop") || "");
      return { d, dur, rise };
    };

    const pushText = (rect, runs, cs, anim) => {
      if (!runs.length || rect.width <= 1 || rect.height <= 1) return;
      const fsz = parseFloat(cs.fontSize) || 16;
      const lh = cs.lineHeight === "normal" ? null : (parseFloat(cs.lineHeight) || null);
      const { fam, bold } = famWeight(cs);
      const { align, valign } = alignOf(cs);
      // PowerPoint dÃ n chá»¯ rá»™ng hÆ¡n Chrome vÃ i % -> ná»›i nháº¹ bá» ngang chá»‘ng wrap
      // thá»«a (giá»¯ cÄƒn lá»: center ná»›i 2 bÃªn, right dá»‹ch trÃ¡i, left ná»›i pháº£i).
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

    // CSS pseudo (::before/::after) absolute co nen -> line/dot trang tri (vd
    // .roadmap::before = line, .rm::before = dot). DOM-walker khong thay pseudo.
    const pushPseudo = (el, which) => {
      const cs = getComputedStyle(el, which);
      if (!cs) return;
      const content = cs.content;
      if (!content || content === "none" || content === "normal") return;
      if (cs.display === "none" || cs.visibility === "hidden") return;
      if (cs.position !== "absolute" && cs.position !== "fixed") return;
      const bg = parseColor(cs.backgroundColor);
      // Gradient cắt theo CHỮ (background-clip:text) = chữ tô gradient, không phải
      // nền box -> bỏ, đừng vẽ hộp gradient (màu chữ xử lý ở colorOf).
      const bgClipText = /text/.test((cs.getPropertyValue("-webkit-background-clip") || "") + " " + (cs.backgroundClip || ""));
      const grad = bgClipText ? null : gradColors(cs.backgroundImage);
      if (!grad && bg.a <= 0.02) return;
      const ecs = getComputedStyle(el);
      if (ecs.position === "static") return;
      const er = el.getBoundingClientRect();
      const bl = parseFloat(ecs.borderLeftWidth) || 0, bt = parseFloat(ecs.borderTopWidth) || 0;
      const brw = parseFloat(ecs.borderRightWidth) || 0, bbw = parseFloat(ecs.borderBottomWidth) || 0;
      const cbL = er.left + bl, cbT = er.top + bt;
      const cbW = er.width - bl - brw, cbH = er.height - bt - bbw;
      const num = (v) => (v === "auto" ? null : parseFloat(v));
      const left = num(cs.left), right = num(cs.right), top = num(cs.top), bottom = num(cs.bottom);
      let w = num(cs.width), h = num(cs.height);
      if (w == null) w = (left != null && right != null) ? cbW - left - right : null;
      if (h == null) h = (top != null && bottom != null) ? cbH - top - bottom : null;
      if (w == null || h == null || w <= 0.5 || h <= 0.5) return;
      let x, y;
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
      // Pseudo là DẢI mỏng dọc 1 cạnh card bo góc + overflow:hidden (vd .kpi::before
      // = thanh accent trái). HTML clip dải ôm góc -> export dựng dải accent CONG.
      const pcrv = (ecs.borderTopLeftRadius || "0px").split(" ")[0];
      const Rp = pcrv.includes("%") ? (parseFloat(pcrv) || 0) / 100 * Math.min(er.width, er.height) : (parseFloat(pcrv) || 0);
      const ov = (ecs.overflow || "") + (ecs.overflowX || "") + (ecs.overflowY || "");
      if (!grad && Rp >= 1 && /hidden|clip/.test(ov)) {
        const eps = 2, spansV = h >= er.height - 2.5, spansH = w >= er.width - 2.5;
        const thinW = w <= er.width * 0.35, thinH = h <= er.height * 0.35;
        let aside = null;
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

    // CHART/ICON: má»—i <svg>/<canvas> top-level -> áº£nh-khá»‘i riÃªng. Gáº¯n data-pcx
    // Ä‘á»ƒ Node chá»¥p THáº²NG element (handle.screenshot tá»± cuá»™n Ä‘Ãºng chá»—, khÃ´ng lá»‡ch).
    // COMPLEX SHAPE: element co transform xoay/nghieng/scale hoac clip-path ->
    // native khong dung noi -> chup anh-khoi nguyen ven (bo qua container qua lon).
    const cpxRects = [];
    const coveredByCpx = (ex, ey, ew, eh) => {
      const area = ew * eh; if (area <= 0) return false;
      const cx = ex + ew / 2, cy = ey + eh / 2;
      for (const c of cpxRects) {
        const ix = Math.max(0, Math.min(ex + ew, c.x + c.w) - Math.max(ex, c.x));
        const iy = Math.max(0, Math.min(ey + eh, c.y + c.h) - Math.max(ey, c.y));
        if (ix * iy / area > 0.4) return true;                                  // phủ >40%
        if (cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h) return true; // tâm trong ảnh
      }
      return false;
    };
    let xIdx = 0;
    for (const el of slide.querySelectorAll("*")) {
      if (SKIP_TAGS.has(el.tagName) || el.closest("svg") || el.closest("[data-cpximg]")) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || cs.position === "fixed") continue;
      const tr = cs.transform || "none";
      let complex = !!(cs.clipPath && cs.clipPath !== "none");
      if (!complex && tr.startsWith("matrix")) {
        const m = tr.match(/matrix\(([^)]+)\)/);
        if (m) { const p = m[1].split(",").map(parseFloat); if (Math.abs(p[0] - 1) > 0.01 || Math.abs(p[1]) > 0.01 || Math.abs(p[2]) > 0.01 || Math.abs(p[3] - 1) > 0.01) complex = true; }
      }
      if (!complex) continue;
      const rb = el.getBoundingClientRect();
      if (rb.width <= 4 || rb.height <= 4) continue;
      if (rb.width * rb.height > sr.width * sr.height * 0.55) continue;
      const id = "x" + sIdx + "_" + (xIdx++);
      el.setAttribute("data-pcx", id);
      el.setAttribute("data-cpximg", "1");
      const cx = rb.left - sr.left, cy = rb.top - sr.top;
      cpxRects.push({ x: cx, y: cy, w: rb.width, h: rb.height });
      charts.push({ id, x: cx, y: cy, w: rb.width, h: rb.height, anim: animSpec(el) });
    }

    let cIdx = 0;
    for (const el of slide.querySelectorAll("svg, canvas")) {
      if (el.closest("[data-cpximg]")) continue;
      if (el.tagName === "SVG" && el.parentElement && el.parentElement.closest("svg")) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const rb = el.getBoundingClientRect();
      if (rb.width <= 3 || rb.height <= 3) continue;
      const id = sIdx + "_" + (cIdx++);
      el.setAttribute("data-pcx", id);
      charts.push({ id, x: rb.left - sr.left, y: rb.top - sr.top, w: rb.width, h: rb.height, anim: animSpec(el) });
    }

    for (const el of [slide, ...slide.querySelectorAll("*")]) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (inChart(el) || el.closest("[data-cpximg]")) continue; // ná»™i dung trong chart -> Ä‘Ã£ chá»¥p áº£nh
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || cs.position === "fixed") continue;
      pushPseudo(el, "::before");
      pushPseudo(el, "::after");
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      if (coveredByCpx(r.left - sr.left, r.top - sr.top, r.width, r.height)) continue; // bị ảnh-khối phủ
      if (el.tagName === "IMG") continue; // (deck nÃ y khÃ´ng cÃ³ <img>; xá»­ lÃ½ sau)

      // --- BOX ---
      const bg = parseColor(cs.backgroundColor);
      // Gradient cắt theo CHỮ (background-clip:text) = chữ tô gradient, không phải
      // nền box -> bỏ, đừng vẽ hộp gradient (màu chữ xử lý ở colorOf).
      const bgClipText = /text/.test((cs.getPropertyValue("-webkit-background-clip") || "") + " " + (cs.backgroundClip || ""));
      const grad = bgClipText ? null : gradColors(cs.backgroundImage);
      // Viền TỪNG CẠNH: đều 4 cạnh -> line quanh box; chỉ 1 vài cạnh (vd
      // border-top) -> KHÔNG line full mà vẽ THANH ACCENT mỏng ở cạnh đó (3D look).
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
      // Chrome tráº£ border-radius computed cÃ³ thá»ƒ lÃ  "%" hoáº·c "px". Pháº£i xá»­ lÃ½
      // Cáº¢ HAI: bo theo % >= ~49% = oval/trÃ²n Láº¤P Äáº¦Y box (báº¥t ká»ƒ kÃ­ch thÆ°á»›c);
      // cÃ²n px-radius lá»›n trÃªn box gáº§n vuÃ´ng = hÃ¬nh trÃ²n. Pill (px lá»›n, khÃ´ng
      // vuÃ´ng) -> roundRect (stadium), KHÃ”NG oval.
      const cornerStr = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius];
      let radiusPx = 0, radPct = 0;
      const cornerPx = [0, 0, 0, 0]; // [TL, TR, BR, BL] px
      for (let ci = 0; ci < 4; ci++) {
        const v = (cornerStr[ci] || "0px").split(" ")[0].trim();
        let px;
        if (v.includes("%")) { const p = parseFloat(v) || 0; radPct = Math.max(radPct, p); px = (p / 100) * Math.min(r.width, r.height); }
        else px = parseFloat(v) || 0;
        cornerPx[ci] = px;
        radiusPx = Math.max(radiusPx, px);
      }
      const cornersUniform = cornerPx.every((c) => Math.abs(c - cornerPx[0]) < 0.6);
      const minSide = Math.min(r.width, r.height), maxSide = Math.max(r.width, r.height);
      const ellipse = (radPct >= 49) || (radPct === 0 && minSide >= maxSide * 0.82 && radiusPx >= minSide * 0.45);
      if (hasFill || hasBorder || accentSides.length) {
        const bx = r.left - sr.left, by = r.top - sr.top;
        if (hasFill || hasBorder) {
          // Dedup box TRÙNG y hệt -> bớt box lồng chồng gây "dính" khi kéo.
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
        // Thanh accent cho viền không đều (vd border-top). Card bo góc -> dải đi
        // VÒNG theo 2 góc kề (custom geometry python) để cong ôm như HTML.
        for (const s of accentSides) {
          const horiz = s.e === "top" || s.e === "bottom";
          if (radiusPx >= 1) {
            boxes.push({ x: bx, y: by, w: r.width, h: r.height, fill: s.c.hex, fill_alpha: s.c.a, gradient: null, line: null, line_w: 0, radius: 0, corners: null, ellipse: false, shadow: null, accent: { side: s.e, t: s.w, r: radiusPx }, anim: animSpec(el) });
          } else {
            const aw = horiz ? r.width : s.w;
            const ah = horiz ? s.w : r.height;
            const ax = s.e === "right" ? bx + r.width - s.w : bx;
            const ay = s.e === "bottom" ? by + r.height - s.w : by;
            boxes.push({ x: ax, y: ay, w: aw, h: ah, fill: s.c.hex, fill_alpha: s.c.a, gradient: null, line: null, line_w: 0, radius: 0, corners: null, ellipse: false, shadow: null, anim: animSpec(el) });
          }
        }
      }

      // --- TEXT ---
      if (!(el.innerText || "").trim() || !isBoxRoot(el)) continue;
      const hasInnerBoxText = Array.from(el.querySelectorAll("*")).some(
        (c) => c.tagName !== "IMG" && !c.closest("svg") && isBoxRoot(c) && (c.innerText || "").trim());
      const ag = animSpec(el);
      if (!hasInnerBoxText) {
        pushText(leafTextRect(el) || r, collectRuns(el), cs, ag);
      } else {
        for (const node of el.childNodes) {
          if (node.nodeType !== 3) continue;
          const t = (node.textContent || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
          if (!t) continue;
          const range = document.createRange();
          range.selectNode(node);
          pushText(range.getBoundingClientRect(), [mkRun(t, cs)], cs, ag);
        }
      }
    }

    slides.push({ boxes, texts, charts });
  }
  return slides;
}
/* eslint-enable */

async function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error("usage: node scripts/poc-native-shapes.mjs <input.html> <output.pptx>");
    process.exit(2);
  }
  const edge = findEdge();
  if (!edge) throw new Error("KhÃ´ng tÃ¬m tháº¥y Microsoft Edge (set EDGE_PATH).");

  const browser = await puppeteer.launch({
    executablePath: edge, headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb"],
  });
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pocnative2-"));
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: VW, height: VH, deviceScaleFactor: 2 });
    const fileUrl = "file:///" + path.resolve(inPath).replace(/\\/g, "/").replace(/^\/+/, "");
    await page.goto(fileUrl, { waitUntil: "networkidle0", timeout: 45000 });
    // Doc tham so reveal (transition-delay/duration/property) TRUOC khi freeze
    // (style freeze ben duoi co transition:none se xoa cac gia tri nay).
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
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.evaluate(() =>
      document.querySelectorAll(".slide").forEach((s) => s.classList.add("visible")));
    await sleep(250);

    const slides = await page.evaluate(extractInBrowser);
    // Bo nen slide/body -> chup chart NEN TRONG SUOT (omitBackground) tranh "hop" nen lech mau.
    // Nền trong suốt để chụp chart. Đồng thời BỎ box-shadow + filter trên MỌI
    // element trong lúc chụp ảnh-khối: handle.screenshot cắt theo bounding-box từ
    // ảnh CẢ TRANG nên bóng của element kế bên (vd card phía trên lục giác) lọt
    // vào ảnh -> thành "hộp/bóng" lạ. Bóng của box đã trích vào spec, pptx_gen tự
    // vẽ lại, nên ảnh-khối KHÔNG cần mang bóng. (Chạy sau khi đã trích xong.)
    await page.addStyleTag({ content: "html,body,.slide{background:transparent!important} *{box-shadow:none!important;filter:none!important}" });
    if (!slides.length) throw new Error("KhÃ´ng cÃ³ .slide nÃ o.");

    // Chá»¥p THáº²NG tá»«ng chart/icon element (tá»± cuá»™n tá»›i Ä‘Ãºng element -> khÃ´ng lá»‡ch).
    for (let i = 0; i < slides.length; i++) {
      const imgs = [];
      for (const c of (slides[i].charts || [])) {
        const handle = await page.$(`[data-pcx="${c.id}"]`);
        if (!handle) continue;
        const p = path.join(tmpDir, `chart-${c.id}.png`);
        try {
          // Bỏ filter (drop-shadow) trên chart trước khi chụp: screenshot cắt
          // theo bounding-box element -> shadow bị clip cứng thành "hộp vuông"
          // mờ bao quanh chart (vd donut). Shadow chỉ trang trí, bỏ là sạch.
          await handle.evaluate((el) => { el.style.filter = "none"; });
          await handle.screenshot({ path: p, omitBackground: true });
          imgs.push({ x: c.x, y: c.y, w: c.w, h: c.h, path: p });
        } catch { /* bá» qua element khÃ´ng chá»¥p Ä‘Æ°á»£c */ }
        await handle.dispose();
      }
      slides[i].images = imgs;
    }
    await browser.close();

    // Font: gom family deck dÃ¹ng -> táº£i TTF (400/700) Ä‘á»ƒ nhÃºng.
    const families = new Set();
    for (const s of slides) for (const t of s.texts) {
      if (t.font) families.add(t.font);
      for (const r of (t.runs || [])) if (r.font) families.add(r.font);
    }
    const fonts = resolveDeckFonts([...families]);

    const specSlides = slides.map((s) => ({
      boxes: s.boxes || [],
      images: s.images || [],
      texts: s.texts || [],
    }));
    const spec = {
      output: path.resolve(outPath),
      slide_w_px: VW, slide_h_px: VH, width_in: 13.333, height_in: 7.5,
      autofit: "none",
      transition: "fade",
      anim: "reveal",
      fonts,
      slides: specSlides,
    };
    const specPath = path.join(tmpDir, "spec.json");
    await writeFile(specPath, JSON.stringify(spec), "utf8");
    if (process.env.DUMP_SPEC) await writeFile(path.resolve(outPath) + ".spec.json", JSON.stringify(spec, null, 1), "utf8");

    const py = path.resolve("python-embed/python.exe");
    const script = path.resolve("scripts/pptx_gen.py");
    const usePy = existsSync(py);
    const out = await new Promise((resolve, reject) => {
      const ch = spawn(usePy ? py : "py", usePy ? [script, "native", specPath] : ["-3.13", script, "native", specPath], {
        env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      });
      let so = "", se = "";
      ch.stdout.on("data", (d) => (so += d));
      ch.stderr.on("data", (d) => (se += d));
      ch.on("close", () => resolve({ so, se }));
      ch.on("error", reject);
    });
    const counts = specSlides.map((s, i) =>
      `  slide ${i + 1}: ${s.boxes.length} box, ${s.images.length} chart-img, ${s.texts.length} text`).join("\n");
    console.log("=== extracted ===\n" + counts);
    console.log("=== fonts ===\n  " + (fonts.length ? fonts.map(f => f.family).join(", ") : "(none embedded)"));
    console.log("=== engine ===\n" + (out.so.trim() || out.se.trim()));
  } finally {
    await browser.close().catch(() => {});
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
