import { NextResponse } from "next/server";
import { employees, messages, tasks, getUserProfile, customSkills, skillOverrides } from "@/lib/db";
import { ensureSeed, syncAriaPrompt, syncExcelSkillToAll } from "@/lib/seed";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const denied = await requireAuth(); if (denied) return denied;
  ensureSeed();
  syncAriaPrompt();
  syncExcelSkillToAll();
  return NextResponse.json({
    employees: employees.list(),
    recentMessages: messages.listRecent(200),
    tasks: tasks.list(),
    profile: getUserProfile(),
    customSkills: customSkills.list(),
    skillOverrides: skillOverrides.list(),
  });
}
