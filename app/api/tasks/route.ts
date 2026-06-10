import { NextResponse } from "next/server";
import { tasks, messages } from "@/lib/db";
import { requireAuth } from "@/lib/api-auth";
import { currentSpaceId, currentView } from "@/lib/space";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const denied = await requireAuth(); if (denied) return denied;
  return NextResponse.json(tasks.list(await currentSpaceId()));
}

export async function POST(req: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const url = new URL(req.url);
  const taskId = url.searchParams.get("taskId");
  if (!taskId) return NextResponse.json({ error: "taskId required" }, { status: 400 });
  // Don't leak another space's messages even if its task id is guessed; and in
  // admin view-as mode keep the live in_progress task hidden.
  const task = tasks.get(taskId);
  if (task) {
    const view = await currentView();
    if (task.ownerId !== view.spaceId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (view.viewing && task.status === "in_progress") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(messages.listByTask(taskId));
}
