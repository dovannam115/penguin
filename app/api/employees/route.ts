import { NextResponse } from "next/server";
import { employees } from "@/lib/db";
import { shortId } from "@/lib/utils";
import type { Employee } from "@/lib/types";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const denied = await requireAuth(); if (denied) return denied;
  return NextResponse.json(employees.list());
}

export async function POST(req: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const body = (await req.json()) as Partial<Employee>;
  if (!body.name || !body.role || !body.systemPrompt) {
    return NextResponse.json({ error: "name, role, systemPrompt required" }, { status: 400 });
  }
  const created = employees.create({
    id: shortId("emp"),
    name: body.name,
    role: body.role,
    systemPrompt: body.systemPrompt,
    model: body.model ?? "claude-sonnet-4-6",
    avatarColor: body.avatarColor ?? "#7dd3fc",
    emoji: body.emoji ?? "👤",
    x: body.x ?? 200 + Math.random() * 400,
    y: body.y ?? 200 + Math.random() * 200,
    isPromptEngineer: body.isPromptEngineer ?? 0,
    skills: body.skills ?? [],
    sessionId: null,
  });
  return NextResponse.json(created);
}
