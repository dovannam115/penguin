import { NextResponse } from "next/server";
import { hasPassword, setPassword, verifyPassword } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ needsSetup: !hasPassword() });
}

export async function POST(req: Request) {
  const { password, isSetup } = await req.json() as { password: string; isSetup?: boolean };

  if (!password || password.length < 4) {
    return NextResponse.json({ error: "Password must be at least 4 characters" }, { status: 400 });
  }

  if (isSetup && !hasPassword()) {
    setPassword(password);
    const token = verifyPassword(password)!;
    const res = NextResponse.json({ ok: true });
    res.cookies.set("mas-token", token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 });
    return res;
  }

  const token = verifyPassword(password);
  if (!token) {
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set("mas-token", token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 });
  return res;
}
