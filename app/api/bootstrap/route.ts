import { NextResponse } from "next/server";
import { employees, messages, tasks, spaces, getUserProfile, customSkills, skillOverrides } from "@/lib/db";
import { ensureSeed, syncAriaPrompt, syncExcelSkillToAll } from "@/lib/seed";
import { requireAuth } from "@/lib/api-auth";
import { currentView } from "@/lib/space";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const denied = await requireAuth(); if (denied) return denied;
  const view = await currentView();
  const spaceId = view.spaceId;

  // Pending accounts (awaiting admin approval) get no app data — the client
  // shows a "waiting for approval" screen instead.
  if (!spaces.isApproved(spaceId)) {
    return NextResponse.json({
      pending: true,
      currentSpaceName: spaces.get(spaceId)?.name ?? "",
    });
  }

  ensureSeed();
  syncAriaPrompt();
  syncExcelSkillToAll();
  // Admin status reflects the REAL logged-in account, so an admin keeps the
  // admin tools even while viewing someone else's workspace.
  const isAdmin = spaces.isAdmin(view.authId ?? spaceId);
  return NextResponse.json({
    employees: employees.list(),
    recentMessages: messages.listRecentByOwner(spaceId, 200, view.viewing),
    tasks: tasks.list(spaceId, view.viewing),
    profile: getUserProfile(),
    customSkills: customSkills.list(),
    skillOverrides: skillOverrides.list(),
    // Identity / context for the sidebar label + optimistic task ownership.
    currentSpaceId: spaceId,
    currentSpaceName: spaces.get(spaceId)?.name ?? "",
    isAdmin,
    // View-as banner: when an admin is browsing another account.
    isViewing: view.viewing,
    viewingName: view.viewing ? (spaces.get(spaceId)?.name ?? "") : "",
  });
}
