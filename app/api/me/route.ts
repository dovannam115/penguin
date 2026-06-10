import { NextResponse } from "next/server";
import { spaces } from "@/lib/db";
import { requireAuth } from "@/lib/api-auth";
import { currentView } from "@/lib/space";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lightweight status poll. The client checks this on an interval so approval
// changes take effect live: a freshly-approved account auto-enters the app, and
// a revoked one gets bounced out — neither needs a manual refresh. `pending` is
// based on the REAL logged-in account (not the viewed one), so an admin in
// view-as mode is never bounced.
export async function GET() {
  const denied = await requireAuth(); if (denied) return denied;
  const view = await currentView();
  const authId = view.authId;
  const approved = !!authId && spaces.isApproved(authId);
  return NextResponse.json({
    pending: !approved,
    isAdmin: !!authId && spaces.isAdmin(authId),
    isViewing: view.viewing,
  });
}
