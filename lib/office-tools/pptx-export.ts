/**
 * pptx-export — tạo file .pptx bám theo template bất kỳ, bằng cách gọi engine
 * Python `scripts/pptx_gen.py`. Python được giải quyết theo thứ tự ưu tiên:
 *
 *   1. Python NHÚNG trong app:  <appRoot>/python-embed/python.exe
 *      (đi kèm khi đóng gói -> bạn của bạn không cần cài Python)
 *   2. py launcher:             py -3.13  (máy dev có sẵn)
 *   3. python3 / python trên PATH
 *
 * Engine không cần gì ngoài python-pptx (đã cài sẵn trong bản nhúng).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { existsSync, statSync } from "node:fs";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";

function appRoot(): string {
  return process.cwd();
}

function scriptPath(): string {
  return path.join(appRoot(), "scripts", "pptx_gen.py");
}

/** Trả về { file, baseArgs } cho interpreter Python sẽ dùng. */
function resolvePython(): { file: string; baseArgs: string[] } {
  const embedded = path.join(appRoot(), "python-embed", "python.exe");
  if (existsSync(embedded)) return { file: embedded, baseArgs: [] };
  // Windows py launcher với version cố định (máy dev có python-pptx ở 3.13).
  if (process.platform === "win32") return { file: "py", baseArgs: ["-3.13"] };
  return { file: "python3", baseArgs: [] };
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runPython(args: string[]): Promise<RunResult> {
  const { file, baseArgs } = resolvePython();
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...baseArgs, scriptPath(), ...args], {
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (err) =>
      reject(new Error(`Không chạy được Python (${file}): ${err.message}`)),
    );
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

function parseJsonOut(r: RunResult): any {
  const text = r.stdout.trim();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Engine pptx trả về dữ liệu không hợp lệ (code ${r.code}). ` +
        `stderr: ${r.stderr.slice(0, 500)} | stdout: ${text.slice(0, 500)}`,
    );
  }
  if (data && data.error) {
    throw new Error(`Engine pptx lỗi: ${data.error}`);
  }
  return data;
}

/** Đọc cấu trúc template: layouts + demo slides (để agent biết bám vào đâu). */
export async function inspectTemplate(templatePath: string): Promise<string> {
  const r = await runPython(["inspect", templatePath]);
  const data = parseJsonOut(r);
  return JSON.stringify(data);
}

export interface PptxOutline {
  n_slides: number;
  slides: { index: number; blocks: string[] }[];
}

/** Trích text đầy đủ từng slide (cho PREVIEW dạng text). */
export async function outlinePptx(pptxPath: string): Promise<PptxOutline> {
  const r = await runPython(["outline", pptxPath]);
  return parseJsonOut(r) as PptxOutline;
}

export interface PreviewRun {
  text?: string;
  br?: number;
  size_pt?: number | null;
  color?: string | null;
  bold?: boolean;
  italic?: boolean;
}
export interface PreviewShape {
  x: number; y: number; w: number; h: number; // phân số 0..1 của slide
  fill?: string;
  line?: string;
  line_w?: number;
  radius?: number;
  img?: string;
  runs?: PreviewRun[];
  align?: string;
  valign?: string;
}
export interface PptxPreview {
  w_emu: number;
  h_emu: number;
  aspect: number;
  n_slides: number;
  slides: { shapes: PreviewShape[] }[];
}

/** Trích shape (vị trí/màu/viền/text/ảnh) từng slide cho PREVIEW TRỰC QUAN. */
export async function previewPptx(pptxPath: string): Promise<PptxPreview> {
  const r = await runPython(["preview", pptxPath]);
  return parseJsonOut(r) as PptxPreview;
}

export interface PptxSlideSpec {
  from_layout?: string;
  title?: string;
  subtitle?: string;
  body?: string[] | string;
  body_right?: string[] | string;
  clone_slide?: number;
  replace?: { find: string; with: string }[];
}

export interface PptxSpec {
  template: string;
  output: string;
  slides: PptxSlideSpec[];
  keep_template_slides?: boolean;
}

export interface PptxResult {
  path: string;
  size: number;
  n_slides: number;
}

/** Build a .pptx with one full-bleed image per slide (16:9 default). Used by the
 *  "HTML deck → PowerPoint" export (rendered slide screenshots → pptx). */
export async function imagesToPptx(
  images: string[],
  output: string,
  opts: { widthIn?: number; heightIn?: number } = {},
): Promise<PptxResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pptximg-"));
  const specPath = path.join(dir, "spec.json");
  await writeFile(specPath, JSON.stringify({
    images,
    output,
    width_in: opts.widthIn ?? 13.333,
    height_in: opts.heightIn ?? 7.5,
  }), "utf8");
  try {
    const r = await runPython(["images", specPath]);
    const data = parseJsonOut(r);
    const size = existsSync(data.path) ? statSync(data.path).size : data.size ?? 0;
    return { path: data.path, size, n_slides: data.n_slides };
  } finally {
    unlink(specPath).catch(() => {});
  }
}

/** Spec cho chế độ `native` (HTML deck -> shape/textbox thật, sửa được). */
export interface NativePptxSpec {
  output: string;
  slide_w_px: number;
  slide_h_px: number;
  width_in?: number;
  height_in?: number;
  /** "none" = textbox giữ đúng pt (không shrink-to-fit). Mặc định "shrink". */
  autofit?: string;
  /** "fade" = fade nhẹ khi chuyển slide. Mặc định "none". */
  transition?: string;
  /** "reveal" = entrance fade+stagger từng phần tử theo .reveal. Mặc định "none". */
  anim?: string;
  fonts?: unknown[];
  slides: unknown[];
}

/** Dựng .pptx native từ spec do DOM-walker trích ra (xem html-to-pptx-native.ts). */
export async function nativePptx(
  spec: NativePptxSpec,
): Promise<PptxResult & { fonts_embedded?: number }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pptxnative-"));
  const specPath = path.join(dir, "spec.json");
  await writeFile(specPath, JSON.stringify(spec), "utf8");
  try {
    const r = await runPython(["native", specPath]);
    const data = parseJsonOut(r);
    const size = existsSync(data.path) ? statSync(data.path).size : data.size ?? 0;
    return {
      path: data.path,
      size,
      n_slides: data.n_slides,
      fonts_embedded: data.fonts_embedded,
    };
  } finally {
    unlink(specPath).catch(() => {});
  }
}

/** Sinh file .pptx theo spec. Ghi spec ra file tạm rồi đưa cho engine. */
export async function generatePptx(spec: PptxSpec): Promise<PptxResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pptxspec-"));
  const specPath = path.join(dir, "spec.json");
  await writeFile(specPath, JSON.stringify(spec), "utf8");
  try {
    const r = await runPython(["generate", specPath]);
    const data = parseJsonOut(r);
    const size = existsSync(data.path) ? statSync(data.path).size : data.size ?? 0;
    return { path: data.path, size, n_slides: data.n_slides };
  } finally {
    unlink(specPath).catch(() => {});
  }
}
