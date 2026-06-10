import { NextResponse } from "next/server";
import { listFiles, saveFile, deleteFile } from "@/lib/upload";
import { tasks } from "@/lib/db";
import { requireAuth } from "@/lib/api-auth";
import { currentSpaceId, denyIfViewing } from "@/lib/space";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Block file access to a task owned by another space. A not-yet-created task
// (optimistic client id, no DB row) has no owner yet, so it's allowed through.
async function spaceDenied(id: string): Promise<boolean> {
  const t = tasks.get(id);
  return !!t && t.ownerId !== await currentSpaceId();
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await ctx.params;
  if (await spaceDenied(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(listFiles(id));
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const ro = await denyIfViewing(); if (ro) return ro;
  const { id } = await ctx.params;
  if (await spaceDenied(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
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
  const ro = await denyIfViewing(); if (ro) return ro;
  const { id } = await ctx.params;
  if (await spaceDenied(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const url = new URL(req.url);
  const name = url.searchParams.get("name");
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const ok = deleteFile(id, name);
  return NextResponse.json({ ok, files: listFiles(id) });
}
