import { NextResponse } from "next/server";
import path from "node:path";
import { statSync } from "node:fs";
import { ensureWorkspace, workspaceDir, saveFile, deleteFile, resolveFilePath } from "@/lib/upload";
import { renderHtmlToPptx } from "@/lib/office-tools/html-to-pptx";
import { renderHtmlToPptxNative } from "@/lib/office-tools/html-to-pptx-native";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Derive a safe flat `*.pptx` filename (keeps hyphens/spaces, strips only the
 *  OS-forbidden characters and path separators). */
function safePptxName(name: string): string {
  const base = (name || "slides").replace(/\\/g, "/").split("/").pop() || "slides";
  const cleaned = Array.from(base)
    .map((ch) => (ch.charCodeAt(0) < 0x20 || "<>:\"/\\|?*".includes(ch) ? "_" : ch))
    .join("")
    .trim() || "slides";
  return /\.pptx$/i.test(cleaned) ? cleaned : cleaned.replace(/\.[^.]*$/, "") + ".pptx";
}

/** Render an HTML deck (sent as `html`) to a .pptx in the task workspace.
 *  Each `.slide` becomes one full-bleed image (via Edge headless). */
export async function POST(req: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const body = (await req.json().catch(() => null)) as
    | { taskId?: string; html?: string; filename?: string; mode?: "image" | "native" }
    | null;
  if (!body || typeof body.taskId !== "string" || typeof body.html !== "string") {
    return NextResponse.json({ error: "Missing taskId/html" }, { status: 400 });
  }
  const { taskId, html } = body;
  const mode = body.mode === "native" ? "native" : "image";
  ensureWorkspace(taskId);

  const outName = safePptxName(body.filename || "slides.pptx");
  const tmpName = `.export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`;
  saveFile(taskId, tmpName, Buffer.from(html, "utf8"));
  const tmpPath = resolveFilePath(taskId, tmpName);
  if (!tmpPath) return NextResponse.json({ error: "Không tạo được file tạm." }, { status: 500 });

  const outPath = path.join(workspaceDir(taskId), outName);
  try {
    const result = mode === "native"
      ? await renderHtmlToPptxNative(tmpPath, outPath)
      : await renderHtmlToPptx(tmpPath, outPath);
    const st = statSync(result.path);
    return NextResponse.json({
      ok: true,
      mode,
      file: { name: outName, size: st.size, mtime: st.mtimeMs },
      n_slides: result.n_slides,
      fonts_embedded: (result as { fonts_embedded?: number }).fonts_embedded ?? 0,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  } finally {
    deleteFile(taskId, tmpName);
  }
}
