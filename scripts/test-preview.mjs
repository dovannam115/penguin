import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";
const BASE = "http://localhost:3100";
const PW = "2101";

const a = await fetch(BASE + "/api/auth", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: PW }),
});
const cookie = (a.headers.get("set-cookie") || "").split(";")[0];
const r = await fetch(BASE + "/api/preview/task_nativetest/preview-test.pptx", { headers: { Cookie: cookie } });
const html = await r.text();
console.log("preview:", r.status, "len", html.length);
await writeFile("test-output/preview.html", html, "utf8");

const edge = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => existsSync(p));
const b = await puppeteer.launch({ executablePath: edge, headless: true, args: ["--no-sandbox"] });
const pg = await b.newPage();
await pg.setViewport({ width: 960, height: 1400, deviceScaleFactor: 1 });
await pg.setContent(html, { waitUntil: "networkidle0" });
await pg.screenshot({ path: "test-output/preview-shot.png" });
await b.close();
console.log("shot saved");
