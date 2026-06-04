import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { settings } from "@/lib/db";
import { readFileSync } from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read package.json from disk at module load instead of `import pkg from
// "../../../../package.json"`. The static import gets baked into the compiled
// .next bundle at build time — if a future update has a partial .next swap or
// a build was packed with an unbumped version, this route would forever report
// the OLD version and Settings → Update would falsely show "Update available"
// after the user already installed the latest. Reading from disk means
// whatever package.json the install dir has right now is what we report.
function readCurrentVersion(): string {
  try {
    const raw = readFileSync(path.join(process.cwd(), "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const CURRENT_VERSION = readCurrentVersion();
// Default update source: set PENGUIN_UPDATE_REPO=owner/repo in .env.local before
// packing to ship a pre-configured update source. End users never need to know
// it's GitHub under the hood — they just see "Update available" and click.
const DEFAULT_REPO = (process.env.PENGUIN_UPDATE_REPO || process.env.AGENT_P_UPDATE_REPO || "").trim();

/** Strip leading 'v' and compare semver-style (major.minor.patch). Returns 1
 *  if a > b, -1 if a < b, 0 if equal. Pre-release suffixes are ignored. */
function cmpVersion(a: string, b: string): number {
  const norm = (v: string) => v.replace(/^v/i, "").split(/[^\d]/).map(Number).filter(n => !isNaN(n));
  const pa = norm(a);
  const pb = norm(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const repo = ((settings.get("update_repo") || DEFAULT_REPO) || "").trim();
  const token = (settings.get("update_github_token") || "").trim();
  if (!repo || !repo.includes("/")) {
    return NextResponse.json({ configured: false, currentVersion: CURRENT_VERSION });
  }

  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Penguin",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let resp: Response;
  try {
    resp = await fetch(url, { headers, cache: "no-store" });
  } catch (e) {
    return NextResponse.json({
      configured: true, currentVersion: CURRENT_VERSION,
      error: `Cannot reach GitHub: ${(e as Error).message}`,
    });
  }
  if (!resp.ok) {
    return NextResponse.json({
      configured: true, currentVersion: CURRENT_VERSION,
      error: `GitHub returned ${resp.status} — check the repo path${resp.status === 404 ? " (or your token if the repo is private)" : ""}.`,
    });
  }

  const data = await resp.json() as {
    tag_name?: string;
    name?: string;
    body?: string;
    html_url?: string;
    assets?: Array<{ name: string; browser_download_url: string; url: string; size: number }>;
  };
  const latestVersion = (data.tag_name || data.name || "").replace(/^v/i, "");
  if (!latestVersion) {
    return NextResponse.json({
      configured: true, currentVersion: CURRENT_VERSION,
      error: "GitHub release has no tag_name.",
    });
  }

  // Prefer Penguin_v*.zip (current) or AGENT-P_v*.zip (legacy); fall back to any .zip.
  const assets = data.assets || [];
  const zipAsset = assets.find(a => /Penguin_v.*\.zip$/i.test(a.name))
    ?? assets.find(a => /AGENT-P_v.*\.zip$/i.test(a.name))
    ?? assets.find(a => /\.zip$/i.test(a.name));
  if (!zipAsset) {
    return NextResponse.json({
      configured: true, currentVersion: CURRENT_VERSION, latestVersion,
      error: "Release has no .zip asset.",
    });
  }

  const available = cmpVersion(latestVersion, CURRENT_VERSION) > 0;
  return NextResponse.json({
    configured: true,
    currentVersion: CURRENT_VERSION,
    latestVersion,
    available,
    notes: data.body || "",
    releaseUrl: data.html_url || "",
    // For private repos the browser_download_url still requires auth; the
    // backend download endpoint uses the asset API URL with Accept: octet-stream.
    assetUrl: token ? zipAsset.url : zipAsset.browser_download_url,
    assetSize: zipAsset.size,
    assetName: zipAsset.name,
  });
}
