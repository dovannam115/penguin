import { NextResponse } from "next/server";
import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { requireAuth } from "@/lib/api-auth";

// Serves the slide-template library (templates/ folder) so users can browse the
// visual menu (index.html) and preview each style in the browser. Read-only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export async function GET(_req: Request, ctx: { params: Promise<{ slug?: string[] }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { slug } = await ctx.params;
  const rel = slug && slug.length ? slug.map(decodeURIComponent).join("/") : "index.html";
  const base = path.join(process.cwd(), "templates");
  const target = path.normalize(path.join(base, rel));
  // Prevent path traversal: the resolved path must stay inside templates/.
  if (target !== base && !target.startsWith(base + path.sep)) {
    return NextResponse.json({ error: "Bad path" }, { status: 400 });
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const ext = path.extname(target).toLowerCase();
  let bytes = readFileSync(target);
  // For the menu, inject <base> so the relative card links resolve under this
  // route regardless of a trailing slash.
  if (path.basename(target).toLowerCase() === "index.html") {
    let html = bytes.toString("utf8");
    if (!/<base\s/i.test(html)) html = html.replace(/<head>/i, '<head><base href="/api/templates/">');
    bytes = Buffer.from(html, "utf8");
  }
  return new NextResponse(new Uint8Array(bytes), {
    headers: { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-store" },
  });
}
