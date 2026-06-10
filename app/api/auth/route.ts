import { NextResponse } from "next/server";
import { hasAnyAccount, signup, login } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "mas-token";
const COOKIE_OPTS = { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: 30 * 24 * 3600 };

// needsSetup = no account exists yet → first visitor creates the first account
// (which adopts any legacy tasks).
export async function GET() {
  return NextResponse.json({ needsSetup: !hasAnyAccount() });
}

export async function POST(req: Request) {
  const { name, password, mode } = await req.json().catch(() => ({})) as {
    name?: string; password?: string; mode?: "login" | "signup";
  };

  // First-ever account, or an explicit "create account" → signup. Otherwise login.
  const doSignup = mode === "signup" || !hasAnyAccount();
  const result = doSignup
    ? signup(name ?? "", password ?? "")
    : login(name ?? "", password ?? "");

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, name: result.name });
  res.cookies.set(COOKIE, result.token, COOKIE_OPTS);
  return res;
}

// Logout: clear the session cookie.
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 });
  return res;
}
