/**
 * fonts.mjs — tải TTF của Google Fonts cho các family deck dùng, để NHÚNG vào
 * .pptx (PowerPoint embeddedFontLst). Dùng endpoint v1 `css?family=` (không gửi
 * User-Agent hiện đại) -> trả URL .ttf đầy đủ (không phải woff2 subset).
 *
 * fetchFonts(families, dir) -> [{ family, regular, bold, italic, boldItalic }]
 *   mỗi giá trị là đường dẫn file .ttf đã tải (hoặc null nếu không có style đó).
 *   Bỏ qua font generic/hệ thống. Lỗi mạng -> trả [] (deck vẫn xuất, chỉ không nhúng).
 */
import path from "node:path";
import { writeFile } from "node:fs/promises";

const GENERIC = new Set([
  "serif", "sans-serif", "monospace", "system-ui", "-apple-system", "cursive",
  "fantasy", "ui-sans-serif", "ui-serif", "ui-monospace", "Arial", "Helvetica",
  "Times New Roman", "Times", "Georgia", "Courier New", "Courier", "Verdana",
  "Tahoma", "Segoe UI", "Calibri", "Cambria", "Consolas", "monospace",
]);

// Tách @font-face -> { style, weight, ttf }
function parseFaces(css) {
  const faces = [];
  for (const block of css.split("@font-face")) {
    const styleM = block.match(/font-style:\s*(\w+)/);
    const weightM = block.match(/font-weight:\s*(\d+)/);
    const ttfM = block.match(/url\(([^)]+\.ttf)\)/);
    if (ttfM) {
      faces.push({
        style: styleM ? styleM[1] : "normal",
        weight: weightM ? parseInt(weightM[1], 10) : 400,
        ttf: ttfM[1].replace(/['"]/g, ""),
      });
    }
  }
  return faces;
}

const near = (faces, style, target) => {
  const cand = faces.filter((f) => f.style === style);
  if (!cand.length) return null;
  cand.sort((a, b) => Math.abs(a.weight - target) - Math.abs(b.weight - target));
  return cand[0].ttf;
};

export async function fetchFonts(families, dir) {
  const uniq = [...new Set(families)].filter((f) => f && !GENERIC.has(f));
  const cache = new Map(); // ttf url -> local path
  let n = 0;
  const dl = async (url) => {
    if (!url) return null;
    if (cache.has(url)) return cache.get(url);
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const p = path.join(dir, `font-${n++}.ttf`);
    await writeFile(p, buf);
    cache.set(url, p);
    return p;
  };
  const out = [];
  for (const fam of uniq) {
    try {
      const url = "https://fonts.googleapis.com/css?family=" +
        encodeURIComponent(fam + ":400,700,400i,700i");
      const r = await fetch(url); // KHÔNG set UA hiện đại -> nhận .ttf
      if (!r.ok) continue;
      const faces = parseFaces(await r.text());
      if (!faces.length) continue;
      const entry = {
        family: fam,
        regular: await dl(near(faces, "normal", 400)),
        bold: await dl(near(faces, "normal", 700)),
        italic: await dl(near(faces, "italic", 400)),
        boldItalic: await dl(near(faces, "italic", 700)),
      };
      if (entry.regular || entry.bold || entry.italic || entry.boldItalic) out.push(entry);
    } catch {
      /* bỏ qua font lỗi mạng */
    }
  }
  return out;
}
