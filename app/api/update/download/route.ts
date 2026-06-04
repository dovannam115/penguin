import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { settings } from "@/lib/db";
import { mkdir, rm, stat, open } from "fs/promises";
import { createWriteStream } from "fs";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as WebReadableStream } from "stream/web";
import path from "path";
import { startDownload, bumpDownload, finishDownload } from "@/lib/update-progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STAGING_DIR = path.join(process.cwd(), ".update-staging");
const ZIP_PATH = path.join(STAGING_DIR, "incoming.zip");

export async function POST(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { url } = (await req.json()) as { url?: string };
  if (!url) return NextResponse.json({ error: "Missing 'url' in body." }, { status: 400 });

  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return NextResponse.json({ error: "Invalid URL." }, { status: 400 }); }
  if (!/(^|\.)github\.com$/i.test(parsed.hostname) && !/(^|\.)githubusercontent\.com$/i.test(parsed.hostname)) {
    return NextResponse.json({ error: "Only github.com / githubusercontent.com URLs are allowed." }, { status: 400 });
  }

  const token = (settings.get("update_github_token") || "").trim();
  const headers: Record<string, string> = {
    "User-Agent": "Agent-P",
    Accept: "application/octet-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let resp: Response;
  try {
    resp = await fetch(url, { headers, redirect: "follow", cache: "no-store" });
  } catch (e) {
    return NextResponse.json({ error: `Download failed: ${(e as Error).message}` }, { status: 502 });
  }
  if (!resp.ok) {
    return NextResponse.json({ error: `Download returned ${resp.status}.` }, { status: 502 });
  }
  if (!resp.body) {
    return NextResponse.json({ error: "Download response had no body." }, { status: 502 });
  }

  try { await rm(STAGING_DIR, { recursive: true, force: true }); } catch {}
  await mkdir(STAGING_DIR, { recursive: true });

  const expected = Number(resp.headers.get("content-length") || 0);
  startDownload(expected);

  // Stream the response body straight to disk. Buffer.from(arrayBuffer()) was
  // truncating at ~10 MB on Next.js' nodejs runtime — likely the framework's
  // built-in fetch wrapper applies a response body cap. The stream path bypasses
  // it entirely and uses no extra memory either.
  // The Transform in the middle just counts bytes for the progress endpoint.
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bumpDownload(chunk.length);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(resp.body as unknown as WebReadableStream<Uint8Array>),
      counter,
      createWriteStream(ZIP_PATH),
    );
  } catch (e) {
    finishDownload();
    return NextResponse.json({ error: `Write to disk failed: ${(e as Error).message}` }, { status: 500 });
  }
  finishDownload();

  const written = await stat(ZIP_PATH);
  // GitHub asset Content-Length tells us how big it should be. If we wrote
  // less, the connection was cut mid-download — surface that as a hard error.
  if (expected > 0 && Math.abs(written.size - expected) > 1024) {
    return NextResponse.json({
      error: `Download truncated: wrote ${written.size} bytes, expected ${expected}.`,
    }, { status: 502 });
  }
  if (written.size < 1024 * 100) {
    return NextResponse.json({ error: "Downloaded file too small to be a zip." }, { status: 502 });
  }

  const fh = await open(ZIP_PATH, "r");
  const magic = Buffer.alloc(4);
  await fh.read(magic, 0, 4, 0);
  await fh.close();
  if (magic[0] !== 0x50 || magic[1] !== 0x4b) {
    return NextResponse.json({ error: "Downloaded file is not a zip (bad header)." }, { status: 502 });
  }

  return NextResponse.json({ ok: true, size: written.size });
}
