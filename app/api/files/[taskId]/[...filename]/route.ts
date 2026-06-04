import { NextResponse } from "next/server";
import path from "node:path";
import { readFile, saveFile } from "@/lib/upload";
import { requireAuth } from "@/lib/api-auth";

const EDITABLE_EXTS = new Set([".html", ".htm", ".md", ".css", ".js", ".json", ".txt", ".csv", ".tsv", ".xml", ".log", ".svg"]);
const MAX_EDIT_BYTES = 1_000_000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm":  "text/html; charset=utf-8",
  ".pdf":  "application/pdf",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".svg":  "image/svg+xml",
  ".txt":  "text/plain; charset=utf-8",
  ".md":   "text/markdown; charset=utf-8",
  ".csv":  "text/csv; charset=utf-8",
  ".tsv":  "text/tab-separated-values; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml":  "application/xml; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls":  "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc":  "application/msword",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip":  "application/zip",
};

export async function GET(_req: Request, ctx: { params: Promise<{ taskId: string; filename: string[] }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { taskId, filename } = await ctx.params;
  // Catch-all gives each path segment separately. Decode each, then rejoin
  // with forward slashes so the upload helper sees a clean relative path.
  const decoded = filename.map(decodeURIComponent).join("/");
  const data = readFile(taskId, decoded);
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ext = path.extname(decoded).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  // For Content-Disposition, browsers ignore any path — only the leaf name
  // matters. URL-encode it for unicode safety.
  const leaf = decoded.split("/").pop() ?? decoded;
  const safeName = encodeURIComponent(leaf);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename*=UTF-8''${safeName}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

export async function PUT(req: Request, ctx: { params: Promise<{ taskId: string; filename: string[] }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { taskId, filename } = await ctx.params;
  const decoded = filename.map(decodeURIComponent).join("/");
  const ext = path.extname(decoded).toLowerCase();
  if (!EDITABLE_EXTS.has(ext)) {
    return NextResponse.json({ error: `File type ${ext || "(none)"} not editable` }, { status: 400 });
  }
  const body = (await req.json().catch(() => null)) as { content?: string } | null;
  if (!body || typeof body.content !== "string") {
    return NextResponse.json({ error: "Missing content" }, { status: 400 });
  }
  const buf = Buffer.from(body.content, "utf8");
  if (buf.byteLength > MAX_EDIT_BYTES) {
    return NextResponse.json({ error: `File too large (>${MAX_EDIT_BYTES} bytes)` }, { status: 413 });
  }
  const info = saveFile(taskId, decoded, buf);
  return NextResponse.json(info);
}
