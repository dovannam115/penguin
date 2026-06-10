import { NextResponse } from "next/server";
import { spaces } from "@/lib/db";
import { requireAuth, currentAccountId } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-only: returns the current account id if the caller is an admin, else a
// 403 response to return immediately.
async function requireAdmin(): Promise<{ id: string } | NextResponse> {
  const denied = await requireAuth(); if (denied) return denied;
  const id = await currentAccountId();
  if (!id || !spaces.isAdmin(id)) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }
  return { id };
}

// List all accounts (name + approval/admin status) for the access panel.
export async function GET() {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ accounts: spaces.listAccounts() });
}

// Approve or revoke a pending/active account.
export async function POST(req: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id, action } = await req.json().catch(() => ({})) as {
    id?: string; action?: "approve" | "revoke";
  };
  if (!id || (action !== "approve" && action !== "revoke")) {
    return NextResponse.json({ error: "id and action (approve|revoke) required" }, { status: 400 });
  }
  // Never revoke an admin account (prevents locking out the owner).
  if (action === "revoke" && spaces.isAdmin(id)) {
    return NextResponse.json({ error: "Cannot revoke an admin account" }, { status: 400 });
  }
  spaces.setApproved(id, action === "approve");
  return NextResponse.json({ ok: true, accounts: spaces.listAccounts() });
}
