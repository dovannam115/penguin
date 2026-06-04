import { NextResponse } from "next/server";
import { employees, taskSessions } from "@/lib/db";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await ctx.params;
  const patch = await req.json();

  // If any identity / capability field changed, drop the SDK session so the
  // agent starts fresh and immediately picks up the new persona / skills.
  const current = employees.get(id);
  const skillsChanged = patch.skills !== undefined &&
    JSON.stringify(patch.skills) !== JSON.stringify(current?.skills ?? []);
  const modelChanged = patch.model !== undefined &&
    current !== null && patch.model !== current.model;
  if (current && (
    (patch.name !== undefined && patch.name !== current.name) ||
    (patch.role !== undefined && patch.role !== current.role) ||
    (patch.systemPrompt !== undefined && patch.systemPrompt !== current.systemPrompt) ||
    skillsChanged ||
    modelChanged
  )) {
    patch.sessionId = null;
  }

  // Model change is special: the Claude CLI session that buildEmployeeMemory
  // would otherwise resume from is pinned to the old model — resuming it would
  // silently keep using the OLD model even though employees.model now shows
  // the new one. Wipe every task_sessions resume id for this employee so the
  // next chat turn spawns a fresh CLI subprocess on the chosen model.
  if (modelChanged) {
    taskSessions.clearAllForEmployee(id);
  }

  const updated = employees.update(id, patch);
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await ctx.params;
  employees.remove(id);
  return NextResponse.json({ ok: true });
}
