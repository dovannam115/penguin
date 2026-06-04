import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { requireAuth } from "@/lib/api-auth";

// Opens the slide-template menu (templates/index.html) in the user's default
// browser. The app runs locally on the user's machine, so the server can shell
// out to open the file — this lets the chat show a clickable button instead of
// a localhost URL. Target is HARDCODED (no path param) so there is no way to
// open an arbitrary file, even though the route is auth-gated.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const denied = await requireAuth(); if (denied) return denied;
  const target = path.join(process.cwd(), "templates", "index.html");
  if (!existsSync(target)) {
    return NextResponse.json({ error: "Template menu file not found." }, { status: 404 });
  }
  try {
    if (process.platform === "win32") {
      // `start` needs an empty title arg first; detached so it doesn't block.
      spawn("cmd.exe", ["/c", "start", "", target], { windowsHide: true, detached: true }).unref();
    } else {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      spawn(opener, [target], { detached: true }).unref();
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
