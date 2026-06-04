import { NextResponse } from "next/server";
import { messages, tasks } from "@/lib/db";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id: taskId } = await ctx.params;
  const body = await req.json() as { messageId: string; content: string };

  if (!body.messageId || !body.content?.trim()) {
    return NextResponse.json({ error: "messageId and content required" }, { status: 400 });
  }

  const task = tasks.get(taskId);
  if (!task) return NextResponse.json({ error: "task not found" }, { status: 404 });

  const msg = messages.get(body.messageId);
  if (!msg || msg.taskId !== taskId) {
    return NextResponse.json({ error: "message not found in this task" }, { status: 404 });
  }

  messages.deleteAfterInTask(taskId, msg.createdAt);
  messages.updateContent(body.messageId, body.content.trim());

  const remaining = messages.listByTask(taskId);
  return NextResponse.json({ messages: remaining });
}
