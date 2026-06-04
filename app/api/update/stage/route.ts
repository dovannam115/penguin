import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { spawn } from "child_process";
import { mkdir, rm, readFile, writeFile, access, readdir } from "fs/promises";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STAGING_DIR = path.join(process.cwd(), ".update-staging");
const ZIP_PATH = path.join(STAGING_DIR, "incoming.zip");
const EXTRACTED_DIR = path.join(STAGING_DIR, "extracted");
const SKIP_NM_MARKER = path.join(STAGING_DIR, ".skip-node-modules");

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: false, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("exit", (code) => resolve({ code: code ?? -1, stderr }));
    child.on("error", (err) => resolve({ code: -1, stderr: err.message }));
  });
}

export async function POST() {
  const denied = await requireAuth();
  if (denied) return denied;

  try { await access(ZIP_PATH); }
  catch {
    return NextResponse.json({ error: "Chưa có file zip để cài. Hãy upload trước." }, { status: 400 });
  }

  try { await rm(EXTRACTED_DIR, { recursive: true, force: true }); } catch {}
  await mkdir(EXTRACTED_DIR, { recursive: true });

  // tar.exe (bsdtar, shipped with Windows 10+) handles zip and is ~3-5x faster
  // than PowerShell's Expand-Archive on multi-MB packs. Empty-dir check stays
  // as a second line of defense in case the zip is corrupted.
  const extractRes = await run("tar.exe", ["-xf", ZIP_PATH, "-C", EXTRACTED_DIR]);
  if (extractRes.code !== 0) {
    return NextResponse.json({ error: `Giải nén thất bại: ${extractRes.stderr || "unknown"}` }, { status: 500 });
  }
  const entries = await readdir(EXTRACTED_DIR).catch(() => []);
  if (entries.length === 0) {
    return NextResponse.json({
      error: "Giải nén ra rỗng — file zip có thể bị hỏng hoặc download bị cắt ngang. Thử lại.",
    }, { status: 400 });
  }

  let pkg: { name?: string; version?: string };
  try {
    const pkgRaw = await readFile(path.join(EXTRACTED_DIR, "package.json"), "utf8");
    pkg = JSON.parse(pkgRaw);
  } catch {
    return NextResponse.json({
      error: `File zip không hợp lệ — thiếu package.json ở root. Extracted contents: ${entries.slice(0, 5).join(", ")}${entries.length > 5 ? ", ..." : ""}.`,
    }, { status: 400 });
  }
  // Accept both "penguin" (current) and "agent-p" (legacy zips) so a user on
  // an older install can still update via this route.
  if (pkg.name !== "penguin" && pkg.name !== "agent-p") {
    return NextResponse.json({ error: `File zip không phải Penguin (package name = ${pkg.name}).` }, { status: 400 });
  }

  // Compare only the third-party deps in package-lock.json. The root entry
  // (`packages[""]`) holds the project's OWN name + version, which bumps on
  // every release even when no real dependency changed — including it would
  // always force a slow fresh npm install. Exclude it.
  let depsUnchanged = false;
  try {
    const installLock = JSON.parse(await readFile(path.join(process.cwd(), "package-lock.json"), "utf8"));
    const stagedLock = JSON.parse(await readFile(path.join(EXTRACTED_DIR, "package-lock.json"), "utf8"));
    const a = { ...(installLock.packages || {}) }; delete a[""];
    const b = { ...(stagedLock.packages || {}) }; delete b[""];
    depsUnchanged = JSON.stringify(a) === JSON.stringify(b);
  } catch { /* one of the lock files missing or unparseable — fall back to full install */ }

  if (depsUnchanged) {
    // Fast path: no real dep changes → skip npm install entirely (~30-60s) and
    // skip copying node_modules during swap (~10-30s). Marker tells swap script.
    await writeFile(SKIP_NM_MARKER, `package-lock unchanged at ${new Date().toISOString()}`);
  } else {
    try { await rm(SKIP_NM_MARKER, { force: true }); } catch {}
    // Pre-populate the staged node_modules from the install dir so npm install
    // runs incrementally (fetches only diffs) — matches `apply-update.bat`
    // behavior, which is fast because it extracts over an already-populated
    // tree. Without this, npm starts from an empty dir and re-downloads
    // every package (~60-90s for 500+ deps).
    const installNm = path.join(process.cwd(), "node_modules");
    const stagedNm = path.join(EXTRACTED_DIR, "node_modules");
    if (await access(installNm).then(() => true).catch(() => false)) {
      await run("robocopy.exe", [
        installNm, stagedNm, "/E", "/MT:16", "/R:1", "/W:1",
        "/NFL", "/NDL", "/NJH", "/NJS", "/NP",
      ]);
      // robocopy exits 0-7 = success; we don't gate on it because partial
      // copy is still useful (npm install fills in the rest).
    }
    const installRes = await run("cmd.exe", ["/c", "npm", "install", "--no-audit", "--no-fund"], EXTRACTED_DIR);
    if (installRes.code !== 0) {
      return NextResponse.json({ error: `npm install thất bại: ${installRes.stderr.slice(-500) || "unknown"}` }, { status: 500 });
    }
  }

  try { await rm(ZIP_PATH); } catch {}

  return NextResponse.json({ ok: true, version: pkg.version, depsUnchanged });
}
