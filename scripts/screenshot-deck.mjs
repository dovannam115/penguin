// Quick: screenshot each .slide of an HTML deck to PNG (reference for fidelity).
// usage: node scripts/screenshot-deck.mjs <input.html> <outDir>
import puppeteer from "puppeteer-core";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const EDGE = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => p && existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [, , inPath, outDir] = process.argv;
mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: EDGE, headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
await page.goto("file:///" + path.resolve(inPath).replace(/\\/g, "/").replace(/^\/+/, ""), { waitUntil: "networkidle0", timeout: 45000 });
await page.addStyleTag({ content:
  "html{scroll-snap-type:none!important;scroll-behavior:auto!important}" +
  "*,*::before,*::after{animation:none!important;transition:none!important}" +
  ".reveal,[class*='reveal']{opacity:1!important;transform:none!important;filter:none!important}" });
await page.evaluate(() => document.fonts?.ready).catch(() => {});
await page.evaluate(() => document.querySelectorAll(".slide").forEach((s) => s.classList.add("visible")));
await sleep(200);
const n = await page.$$eval(".slide", (e) => e.length);
for (let i = 0; i < n; i++) {
  await page.evaluate((idx) => document.querySelectorAll(".slide")[idx]?.scrollIntoView({ block: "start" }), i);
  await sleep(150);
  await page.screenshot({ path: path.join(outDir, `slide-${String(i + 1).padStart(3, "0")}.png`) });
}
await browser.close();
console.log("captured", n, "slides");
