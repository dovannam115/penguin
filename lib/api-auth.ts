import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { verifyToken } from "./auth";

export async function requireAuth(): Promise<NextResponse | null> {
  const token = (await cookies()).get("mas-token")?.value;
  if (!token || !verifyToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
