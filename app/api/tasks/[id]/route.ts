import { NextResponse } from "next/server";
import { tasks, messages, compactDb } from "@/lib/db";
import { deleteWorkspace } from "@/lib/upload";
import { requireAuth } from "@/lib/api-auth";
import { dropSessionsByTask } from "@/lib/session-pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await ctx.params;
  const task = tasks.get(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ task, messages: messages.listByTask(id) });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await ctx.params;
  const body = await req.json() as { title?: string; pinned?: boolean };
  const existing = tasks.get(id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (body.title !== undefined) {
    if (!body.title.trim()) return NextResponse.json({ error: "title required" }, { status: 400 });
    tasks.setTitle(id, body.title.trim());
  }
  if (body.pinned !== undefined) {
    tasks.setPinned(id, !!body.pinned);
  }

  const updated = tasks.get(id);
  return NextResponse.json({ ok: true, task: updated });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await ctx.params;
  const existing = tasks.get(id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Order matters: close warm subprocesses BEFORE rm-rf the workspace, otherwise
  // on Windows the SDK's cwd handle blocks fs.rmSync with EBUSY/EPERM and we
  // crash the route after the SQLite row was already gone — UI sees "Delete
  // failed" but the task disappears on next restart. Anything below sqlite is
  // best-effort: log + swallow so the user always sees a clean response.
  tasks.remove(id);
  try { dropSessionsByTask(id); } catch (err) { console.warn("[task delete] drop sessions failed", err); }
  try { await deleteWorkspace(id); } catch (err) { console.warn("[task delete] workspace cleanup failed", err); }
  try { compactDb(); } catch (err) { console.warn("[task delete] vacuum failed", err); }
  return NextResponse.json({ ok: true, id });
}
