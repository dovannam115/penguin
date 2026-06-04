import { readFile } from "@/lib/upload";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; name: string[] }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id, name } = await ctx.params;
  const filename = name.join("/");
  const buf = readFile(id, filename);
  if (!buf) return new Response("Not found", { status: 404 });
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const contentType = MIME[ext] ?? "application/octet-stream";
  // Copy the Node Buffer into a fresh ArrayBuffer-backed Uint8Array — a valid
  // BodyInit (the Buffer's own .buffer is ArrayBufferLike, which TS rejects).
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
