import { NextResponse } from "next/server";
import { customSkills } from "@/lib/db";
import { requireAuth } from "@/lib/api-auth";
import { shortId } from "@/lib/utils";
import { invalidateCustomSkillsCache } from "@/lib/employee-prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const denied = await requireAuth(); if (denied) return denied;
  return NextResponse.json(customSkills.list());
}

export async function POST(req: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const body = await req.json() as {
    name: string;
    icon?: string;
    category?: string;
    description?: string;
    prompt: string;
    source?: string;
  };

  if (!body.name?.trim() || !body.prompt?.trim()) {
    return NextResponse.json({ error: "name and prompt required" }, { status: 400 });
  }

  const skill = customSkills.create({
    id: `custom-${shortId("sk")}`,
    name: body.name.trim(),
    icon: body.icon?.trim() || "🔧",
    category: body.category?.trim() || "ops",
    description: body.description?.trim() || "",
    prompt: body.prompt.trim(),
    source: body.source?.trim() || "manual",
  });
  invalidateCustomSkillsCache();
  return NextResponse.json(skill, { status: 201 });
}

export async function DELETE(req: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  customSkills.remove(id);
  invalidateCustomSkillsCache();
  return NextResponse.json({ ok: true });
}
