import { NextResponse } from "next/server";
import { tasks, messages } from "@/lib/db";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const denied = await requireAuth(); if (denied) return denied;
  return NextResponse.json(tasks.list());
}

export async function POST(req: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const url = new URL(req.url);
  const taskId = url.searchParams.get("taskId");
  if (!taskId) return NextResponse.json({ error: "taskId required" }, { status: 400 });
  return NextResponse.json(messages.listByTask(taskId));
}
