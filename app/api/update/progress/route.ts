import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getDownloadProgress } from "@/lib/update-progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  const p = getDownloadProgress();
  if (!p) return NextResponse.json({ active: false });
  return NextResponse.json({
    active: true,
    downloaded: p.downloaded,
    total: p.total,
    elapsedMs: Date.now() - p.startedAt,
  });
}
