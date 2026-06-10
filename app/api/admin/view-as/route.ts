import { NextResponse } from "next/server";
import { spaces } from "@/lib/db";
import { requireAuth, currentAccountId } from "@/lib/api-auth";
import { VIEW_AS_COOKIE } from "@/lib/space";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-only: enter or exit "view-as" mode. POST { accountId } to view that
// account's workspace (read-only — chat is blocked while viewing); POST
// { accountId: null } to return to your own.
export async function POST(req: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const adminId = await currentAccountId();
  if (!adminId || !spaces.isAdmin(adminId)) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { accountId } = await req.json().catch(() => ({})) as { accountId?: string | null };

  // Exit view-as.
  if (!accountId) {
    const res = NextResponse.json({ ok: true, viewing: false });
    res.cookies.set(VIEW_AS_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    return res;
  }

  // Enter view-as: target must be an existing, approved account.
  const target = spaces.get(accountId);
  if (!target) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  if (!spaces.isApproved(accountId)) {
    return NextResponse.json({ error: "Account is not active" }, { status: 400 });
  }

  const res = NextResponse.json({ ok: true, viewing: accountId !== adminId, name: target.name });
  res.cookies.set(VIEW_AS_COOKIE, accountId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 7 * 24 * 3600 });
  return res;
}
