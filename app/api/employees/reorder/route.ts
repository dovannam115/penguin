import { NextResponse } from "next/server";
import { employees } from "@/lib/db";
import { requireAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ReorderBody {
  ids: string[];
}

export async function POST(req: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const body = (await req.json()) as Partial<ReorderBody>;
  if (!Array.isArray(body.ids) || body.ids.some(id => typeof id !== "string")) {
    return NextResponse.json({ error: "ids must be a string[]" }, { status: 400 });
  }
  employees.reorder(body.ids);
  return NextResponse.json({ ok: true });
}
