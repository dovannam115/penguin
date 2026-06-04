import { NextResponse } from "next/server";
import { customSkills, skillOverrides } from "@/lib/db";
import { requireAuth } from "@/lib/api-auth";
import { invalidateCustomSkillsCache, invalidateSkillOverridesCache } from "@/lib/employee-prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH handles BOTH skill kinds with the same shape:
 *  - id starts with "custom-" → full update on the custom_skills row
 *  - else                     → upsert into skill_overrides (built-in override)
 *  Body: { name?, description?, prompt?, icon?, category? }
 *  For built-in: only name / description / prompt are honored (others come from the library). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await ctx.params;
  const body = await req.json() as {
    name?: string;
    description?: string;
    prompt?: string;
    icon?: string;
    category?: string;
  };

  if (id.startsWith("custom-")) {
    const updated = customSkills.update(id, body);
    if (!updated) return NextResponse.json({ error: "Custom skill not found" }, { status: 404 });
    invalidateCustomSkillsCache();
    return NextResponse.json(updated);
  }

  // Built-in skill override. Empty string in any field = reset that field to default.
  const patch: { name?: string | null; description?: string | null; prompt?: string | null } = {};
  if (body.name !== undefined) patch.name = body.name.trim() === "" ? null : body.name;
  if (body.description !== undefined) patch.description = body.description.trim() === "" ? null : body.description;
  if (body.prompt !== undefined) patch.prompt = body.prompt.trim() === "" ? null : body.prompt;
  skillOverrides.set(id, patch);
  invalidateSkillOverridesCache();
  return NextResponse.json({ id, override: skillOverrides.get(id) });
}

/** DELETE removes a custom skill OR resets a built-in override to library default. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await ctx.params;
  if (id.startsWith("custom-")) {
    customSkills.remove(id);
    invalidateCustomSkillsCache();
  } else {
    skillOverrides.remove(id);
    invalidateSkillOverridesCache();
  }
  return NextResponse.json({ ok: true });
}
