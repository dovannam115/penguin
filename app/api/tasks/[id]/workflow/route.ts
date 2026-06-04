import { NextResponse } from "next/server";
import { tasks, messages, employees, settings } from "@/lib/db";
import { generateWorkflowMap, sanitize, type WorkflowNode } from "@/lib/workflow-map";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Stop Next.js 16 / Turbopack from trying to pre-generate static paths for this
// dynamic API route — the worker subprocess crashes ("Jest worker encountered
// 2 child process exceptions") and the response becomes a 500 HTML error page
// instead of the route's JSON. Returning [] explicitly skips that step.
export async function generateStaticParams() {
  return [];
}

const key = (id: string) => `workflow:${id}`;

/** GET — return the cached workflow map for a task (or null). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await ctx.params;
  const raw = settings.get(key(id));
  let map: WorkflowNode | null = null;
  if (raw) {
    try { map = JSON.parse(raw) as WorkflowNode; } catch { map = null; }
  }
  return NextResponse.json({ map });
}

/** POST — generate a fresh workflow map from the task transcript, cache it. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const denied = await requireAuth(); if (denied) return denied;
    const { id } = await ctx.params;
    const task = tasks.get(id);
    if (!task) return NextResponse.json({ error: "Task không tồn tại" }, { status: 404 });

    const msgs = messages.listByTask(id);
    if (msgs.length === 0) {
      return NextResponse.json({ error: "Task chưa có nội dung để tóm tắt" }, { status: 400 });
    }

    const map = await generateWorkflowMap(task, msgs, employees.list());
    settings.set(key(id), JSON.stringify(map));
    return NextResponse.json({ map });
  } catch (e) {
    console.error("[workflow POST] failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/** PUT — save the user-edited workflow map. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await ctx.params;
  const task = tasks.get(id);
  if (!task) return NextResponse.json({ error: "Task không tồn tại" }, { status: 404 });

  const body = (await req.json()) as { map?: WorkflowNode };
  if (!body.map || typeof body.map.label !== "string") {
    return NextResponse.json({ error: "Thiếu map hợp lệ" }, { status: 400 });
  }
  const map = sanitize(body.map);
  settings.set(key(id), JSON.stringify(map));
  return NextResponse.json({ map });
}
