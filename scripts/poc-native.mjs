/**
 * POC: HTML deck -> NATIVE pptx (shape/textbox thật, sửa được).
 *
 * Render deck bằng Edge, duyệt DOM mỗi .slide lấy:
 *   - boxes: element có nền/viền  -> rounded-rect native (fill/gradient/line)
 *   - texts: emit ở "box-root thấp nhất chứa text"  -> textbox native
 *   - images: <img>               -> picture
 *
 * Mô hình text (box-root):
 *   box-root = element tự tạo content box (display != inline/contents/none).
 *   Lưu ý: trong flex/grid, con inline (vd <span>) BỊ blockify thành box-root ->
 *   chúng thành ô riêng đúng vị trí (label trái / value phải, ngày timeline...).
 *   Emit textbox ở box-root mà KHÔNG có box-root-con-có-text (leaf). Với leaf,
 *   gom run inline (giữ màu/nghiêng/font theo đoạn). Text-node TRẦN bị "mồ côi"
 *   trong flex (vd "$14.5B" cạnh <span>) được cứu riêng bằng Range rect.
 *
 * Dùng:  node scripts/poc-native.mjs <input.html> <output.pptx>
 */
import puppeteer from "puppeteer-core";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { writeFile, mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fetchFonts } from "./fonts.mjs";

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const findEdge = () => EDGE_CANDIDATES.find((p) => existsSync(p)) ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VW = 1280, VH = 720;

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
    const am = bgImg.match(/(-?\d+(?:\.\d+)?)deg/);
    return { colors: cols, angle: am ? parseFloat(am[1]) : 90 };
  };
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH", "CANVAS", "BR", "HR"]);
  const isInlineDisp = (d) => d.startsWith("inline") || d === "contents";
  const isBoxRoot = (el) => {
    const d = getComputedStyle(el).display;
    return d !== "inline" && d !== "contents" && d !== "none";
  };
  const colorOf = (cs) => {
    const c = parseColor(cs.color);
    if (c.a >= 0.1) return c.hex;
    const g = gradColors(cs.backgroundImage);
    if (g) return g.colors[0];
    return c.hex;
  };
  const mkRun = (text, cs) => {
    const fsz = parseFloat(cs.fontSize) || 16;
    const fam = (cs.fontFamily || "").split(",")[0].replace(/["']/g, "").trim();
    return {
      text, font: fam || null, size_pt: +(fsz * 0.75).toFixed(1),
      color: colorOf(cs),
      bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
      italic: cs.fontStyle === "italic",
    };
  };

  // Gom run trong 1 leaf box-root (giữ định dạng inline). KHÔNG đi vào box-root
  // con (chúng tự emit). <br> -> xuống dòng.
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
          if (ch !== block && isBoxRoot(ch)) return; // box-root con -> emit riêng
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

  // align/valign từ flex/grid centering (cho bong bóng, badge...).
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

  const slides = [];
  for (const slide of document.querySelectorAll(".slide")) {
    const sr = slide.getBoundingClientRect();
    const boxes = [], texts = [], images = [];
    const pushText = (rect, runs, cs) => {
      if (!runs.length || rect.width <= 1 || rect.height <= 1) return;
      const fsz = parseFloat(cs.fontSize) || 16;
      const lh = cs.lineHeight === "normal" ? null : (parseFloat(cs.lineHeight) || null);
      const fam = (cs.fontFamily || "").split(",")[0].replace(/["']/g, "").trim();
      const { align, valign } = alignOf(cs);
      texts.push({
        x: rect.left - sr.left, y: rect.top - sr.top, w: rect.width, h: rect.height,
        runs,
        font: fam || null, size_pt: +(fsz * 0.75).toFixed(1), color: colorOf(cs),
        bold: (parseInt(cs.fontWeight, 10) || 400) >= 600, italic: cs.fontStyle === "italic",
        align, valign, line_pct: lh ? +(lh / fsz).toFixed(2) : null,
      });
    };

    for (const el of [slide, ...slide.querySelectorAll("*")]) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || cs.position === "fixed") continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      const x = r.left - sr.left, y = r.top - sr.top;

      if (el.tagName === "IMG") {
        images.push({ x, y, w: r.width, h: r.height, src: el.currentSrc || el.src });
        continue;
      }

      // --- BOX: nền / gradient / viền ---
      const bg = parseColor(cs.backgroundColor);
      const grad = gradColors(cs.backgroundImage);
      const bw = Math.max(
        parseFloat(cs.borderTopWidth), parseFloat(cs.borderRightWidth),
        parseFloat(cs.borderBottomWidth), parseFloat(cs.borderLeftWidth),
      ) || 0;
      const bcol = parseColor(cs.borderTopColor);
      const hasBorder = bw > 0.3 && cs.borderTopStyle !== "none" && bcol.a > 0.05;
      const hasFill = grad || bg.a > 0.02;
      if (hasFill || hasBorder) {
        boxes.push({
          x, y, w: r.width, h: r.height,
          fill: grad ? null : (bg.a > 0.02 ? bg.hex : null),
          fill_alpha: grad ? 1 : bg.a,
          gradient: grad,
          line: hasBorder ? bcol.hex : null,
          line_w: hasBorder ? bw : 0,
          radius: parseFloat(cs.borderTopLeftRadius) || 0,
        });
      }

      // --- TEXT ---
      if (!(el.innerText || "").trim() || !isBoxRoot(el)) continue;
      const hasInnerBoxText = Array.from(el.querySelectorAll("*")).some(
        (c) => c.tagName !== "IMG" && isBoxRoot(c) && (c.innerText || "").trim());
      if (!hasInnerBoxText) {
        // leaf box-root -> gom run.
        pushText(r, collectRuns(el), cs);
      } else {
        // có box-root con -> chỉ cứu text-node TRẦN trực tiếp của el (vd "$14.5B").
        for (const node of el.childNodes) {
          if (node.nodeType !== 3) continue;
          const t = (node.textContent || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
          if (!t) continue;
          const range = document.createRange();
          range.selectNode(node);
          pushText(range.getBoundingClientRect(), [mkRun(t, cs)], cs);
        }
      }
    }

    slides.push({ boxes, texts, images });
  }
  return slides;
}

async function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error("usage: node scripts/poc-native.mjs <input.html> <output.pptx>");
    process.exit(2);
  }
  const edge = findEdge();
  if (!edge) throw new Error("Không tìm thấy Microsoft Edge (set EDGE_PATH).");

  const browser = await puppeteer.launch({
    executablePath: edge, headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb"],
  });
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pocnative-"));
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: VW, height: VH, deviceScaleFactor: 2 });
    const fileUrl = "file:///" + path.resolve(inPath).replace(/\\/g, "/").replace(/^\/+/, "");
    await page.goto(fileUrl, { waitUntil: "networkidle0", timeout: 45000 });
    await page.addStyleTag({
      content:
        "html{scroll-snap-type:none!important;scroll-behavior:auto!important}" +
        "*,*::before,*::after{animation:none!important;animation-duration:0s!important;transition:none!important}" +
        ".reveal,[class*='reveal']{opacity:1!important;transform:none!important;filter:none!important}",
    });
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.evaluate(() =>
      document.querySelectorAll(".slide").forEach((s) => s.classList.add("visible")));
    await sleep(200);

    // 1) trích text (chữ còn hiện để đo đúng)
    const extracted = await page.evaluate(extractInBrowser);

    // 2) ẩn glyph chữ -> chụp nền faithful (không đè chữ 2 lớp)
    await page.addStyleTag({
      content: "*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}",
    });
    await sleep(80);
    const slideCount = await page.$$eval(".slide", (els) => els.length);
    for (let i = 0; i < slideCount; i++) {
      await page.evaluate((idx) => document.querySelectorAll(".slide")[idx]?.scrollIntoView({ block: "start" }), i);
      await sleep(160);
      const bg = path.join(tmpDir, `bg-${String(i).padStart(3, "0")}.png`);
      await page.screenshot({ path: bg });
      if (extracted[i]) extracted[i]._bg = bg;
    }
    await browser.close();

    // 3) spec HYBRID: nền ảnh full-bleed + textbox sửa được; không box, không nhúng font
    const slides = extracted.map((s) => ({
      images: s._bg ? [{ x: 0, y: 0, w: VW, h: VH, path: s._bg }] : [],
      boxes: [],
      texts: s.texts || [],
    }));
    const spec = {
      output: path.resolve(outPath),
      slide_w_px: VW, slide_h_px: VH, width_in: 13.333, height_in: 7.5,
      slides,
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
    const counts = slides.map((s, i) => `  slide ${i + 1}: ${s.boxes.length} box, ${s.texts.length} text, ${s.images.length} img`).join("\n");
    console.log("=== extracted ===\n" + counts);
    console.log("=== engine ===\n" + (out.so.trim() || out.se.trim()));
  } finally {
    await browser.close().catch(() => {});
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
