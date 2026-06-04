/**
 * deck-to-images — render an attached .pptx or .pdf into per-page PNGs so an
 * agent can SEE the slides (palette / layout / presentation style) as vision
 * input, instead of only reading their extracted text. The chat route feeds the
 * resulting PNGs into the SAME pipeline as uploaded images (attachedImages →
 * image content blocks), so Aria looks at the deck and can rebuild its style.
 *
 *   .pptx → PowerPoint COM via scripts/pptx-to-png.vbs (PowerPoint must be
 *           installed; exports 1280x720 PNG per slide).
 *   .pdf  → poppler `pdftoppm` (resolved from PATH or a few known install dirs).
 *
 * Output PNGs land in <wsDir>/_ref/<base>/ and are returned RELATIVE to wsDir,
 * so they slot straight into the vision pipeline (which builds `${wsDir}/${n}`).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";

// Keep in sync with the per-turn image cap in lib/claude.ts (MAX_IMAGES = 10).
const MAX_PAGES = 10;

function appRoot(): string {
  return process.cwd();
}

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: NodeJS.ErrnoException;
}

function runProc(file: string, args: string[], timeoutMs: number): Promise<ProcResult> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", done = false;
    const child = spawn(file, args, { windowsHide: true, env: { ...process.env } });
    const finish = (r: ProcResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish({ code: null, stdout, stderr: stderr + "\n[timeout]" });
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => finish({ code: null, stdout, stderr, spawnError: err as NodeJS.ErrnoException }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

/** PNG files in `absDir`, natural-sorted and capped, returned as `<subdir>/name`. */
function collectPngs(absDir: string, subdir: string): string[] {
  if (!existsSync(absDir)) return [];
  return readdirSync(absDir)
    .filter((f) => /\.png$/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, MAX_PAGES)
    .map((f) => `${subdir}/${f}`);
}

// poppler's pdftoppm: PATH first, then a few common Windows install locations
// (MiKTeX ships it; poppler-for-windows is the other common source).
const PDFTOPPM_CANDIDATES = [
  "pdftoppm",
  path.join(process.env.LOCALAPPDATA || "", "Programs", "MiKTeX", "miktex", "bin", "x64", "pdftoppm.exe"),
  "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\pdftoppm.exe",
  "C:\\Program Files\\poppler\\Library\\bin\\pdftoppm.exe",
  "C:\\Program Files\\poppler\\bin\\pdftoppm.exe",
];

async function renderPdf(srcAbs: string, outAbs: string): Promise<{ ok: boolean; err?: string }> {
  let lastErr = "";
  for (const bin of PDFTOPPM_CANDIDATES) {
    if (bin !== "pdftoppm" && !existsSync(bin)) continue;
    const r = await runProc(
      bin,
      ["-png", "-r", "130", "-f", "1", "-l", String(MAX_PAGES), srcAbs, path.join(outAbs, "page")],
      60_000,
    );
    if (r.spawnError) {
      if (r.spawnError.code === "ENOENT") continue; // not this binary — try next
      lastErr = r.spawnError.message;
      continue;
    }
    if (r.code === 0 || readdirSync(outAbs).some((f) => /\.png$/i.test(f))) return { ok: true };
    lastErr = (r.stderr || r.stdout).slice(0, 300);
  }
  return { ok: false, err: lastErr || "pdftoppm không tìm thấy (cài poppler/MiKTeX hoặc thêm vào PATH)" };
}

async function renderPptx(srcAbs: string, outAbs: string): Promise<{ ok: boolean; err?: string }> {
  const vbs = path.join(appRoot(), "scripts", "pptx-to-png.vbs");
  if (!existsSync(vbs)) return { ok: false, err: "thiếu scripts/pptx-to-png.vbs" };
  const r = await runProc("cscript", ["//nologo", vbs, srcAbs, outAbs], 120_000);
  if (r.spawnError) return { ok: false, err: r.spawnError.message };
  if (readdirSync(outAbs).some((f) => /\.png$/i.test(f))) return { ok: true };
  return { ok: false, err: (r.stderr || r.stdout).slice(0, 300) || "PowerPoint COM render thất bại (PowerPoint đã cài chưa?)" };
}

export interface DeckRenderResult {
  source: string;    // original attached filename
  images: string[];  // rendered PNG paths RELATIVE to the workspace dir
  error?: string;    // set when rendering failed (or "unsupported")
}

/**
 * Render one attached deck file (relative `name`, already saved under `wsDir`)
 * into per-page PNGs. Cached: if the output dir already holds PNGs, reuse them
 * so continuation turns don't re-render. Returns relative PNG paths for vision.
 */
export async function renderDeckToImages(wsDir: string, name: string): Promise<DeckRenderResult> {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext !== "pptx" && ext !== "pdf") return { source: name, images: [], error: "unsupported" };

  const base = name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
  const subdir = `_ref/${base}`;
  const outAbs = path.join(wsDir, "_ref", base);
  const srcAbs = path.join(wsDir, name);
  if (!existsSync(srcAbs)) return { source: name, images: [], error: "không thấy file trong workspace" };

  const cached = collectPngs(outAbs, subdir);
  if (cached.length > 0) return { source: name, images: cached };

  mkdirSync(outAbs, { recursive: true });
  const res = ext === "pdf" ? await renderPdf(srcAbs, outAbs) : await renderPptx(srcAbs, outAbs);
  if (!res.ok) return { source: name, images: [], error: res.err };
  return { source: name, images: collectPngs(outAbs, subdir) };
}
