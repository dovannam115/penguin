import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { verifyToken } from "./auth";

export async function requireAuth(): Promise<NextResponse | null> {
  const token = (await cookies()).get("mas-token")?.value;
  if (!verifyToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/** Account id the current request is authenticated as, or null. */
export async function currentAccountId(): Promise<string | null> {
  const token = (await cookies()).get("mas-token")?.value;
  return verifyToken(token);
}
