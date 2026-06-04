import { NextResponse } from "next/server";
import { listFiles, saveFile, deleteFile } from "@/lib/upload";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await ctx.params;
  return NextResponse.json(listFiles(id));
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await ctx.params;
  const form = await req.formData();
  const saved: ReturnType<typeof saveFile>[] = [];
  for (const value of form.values()) {
    if (value instanceof File) {
      const buf = Buffer.from(await value.arrayBuffer());
      saved.push(saveFile(id, value.name, buf));
    }
  }
  return NextResponse.json({ files: listFiles(id), saved });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const name = url.searchParams.get("name");
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const ok = deleteFile(id, name);
  return NextResponse.json({ ok, files: listFiles(id) });
}
