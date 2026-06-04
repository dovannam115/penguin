import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { access, writeFile } from "fs/promises";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INSTALL_DIR = process.cwd();
const STAGED_DIR = path.join(INSTALL_DIR, ".update-staging", "extracted");
const MARKER_PATH = path.join(INSTALL_DIR, ".update-pending");

export async function POST() {
  const denied = await requireAuth();
  if (denied) return denied;

  try { await access(STAGED_DIR); }
  catch {
    return NextResponse.json({ error: "Chua co ban update staged. Hay chay upload + stage truoc." }, { status: 400 });
  }

  // Supervisor pattern: instead of spawning a detached PowerShell from Node
  // (which is fundamentally unreliable on Windows - the child gets torn down
  // with the parent regardless of detached/unref/start /B tweaks), we just
  // drop a marker on disk and exit. launcher.ps1 checks for the marker on
  // its next startup and performs the swap inside its own splash window -
  // same WPF UI as a normal launch, no extra terminal flash, fully
  // independent process tree.
  await writeFile(MARKER_PATH, JSON.stringify({
    stagedDir: STAGED_DIR,
    queuedAt: new Date().toISOString(),
  }, null, 2), "utf8");

  // Flush the response back to the polling browser before exiting so the
  // Update tab can flip into its "please reopen" state instead of treating
  // the connection-reset as an error.
  setTimeout(() => { process.exit(0); }, 500);

  return NextResponse.json({ ok: true, queued: true });
}
