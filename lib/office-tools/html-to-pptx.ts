/**
 * html-to-pptx — render an HTML slide deck to a .pptx where each `.slide`
 * becomes one full-bleed 16:9 image. Uses the system Microsoft Edge (Chromium)
 * via puppeteer-core (no bundled Chromium), then assembles the screenshots into
 * a deck with the Python engine (imagesToPptx).
 *
 * Slides are IMAGES — pixel-perfect to the HTML, but not text-editable in
 * PowerPoint. Designed for Aria's `.slide` HTML decks (design-slides skill).
 */
import puppeteer from "puppeteer-core";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { imagesToPptx, type PptxResult } from "./pptx-export";

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter((p): p is string => !!p);

function findEdge(): string | null {
  return EDGE_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Render the HTML file at `htmlPath` to `outputPath` (.pptx). Returns the
 *  pptx result. Throws a clear error if Edge isn't found or no slides render. */
export async function renderHtmlToPptx(htmlPath: string, outputPath: string): Promise<PptxResult> {
  const edge = findEdge();
  if (!edge) {
    throw new Error(
      "Không tìm thấy Microsoft Edge để render slide. Cài Edge (hoặc set biến môi trường EDGE_PATH trỏ tới msedge.exe).",
    );
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "htmlpptx-"));
  const browser = await puppeteer.launch({
    executablePath: edge,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb"],
  });
  try {
    const page = await browser.newPage();
    // 16:9 @2x for crisp screenshots.
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
    const fileUrl = "file:///" + htmlPath.replace(/\\/g, "/").replace(/^\/+/, "");
    await page.goto(fileUrl, { waitUntil: "networkidle0", timeout: 45000 });

    // Freeze animations + disable scroll-snap/smooth so each navigation lands
    // exactly on a slide, and force every reveal visible (decks gate reveals
    // behind a `.visible` class added by IntersectionObserver, which doesn't
    // fire reliably under scripted scrolling).
    await page.addStyleTag({
      content:
        "html{scroll-snap-type:none!important;scroll-behavior:auto!important}" +
        "*,*::before,*::after{animation:none!important;animation-duration:0s!important;transition:none!important}" +
        ".reveal,[class*='reveal']{opacity:1!important;transform:none!important;filter:none!important}",
    });
    await page.evaluate(() => (document as Document).fonts?.ready).catch(() => {});
    await page.evaluate(() =>
      document.querySelectorAll(".slide").forEach((s) => s.classList.add("visible")),
    );
    await sleep(150);

    const pngs: string[] = [];
    const count = await page.$$eval(".slide", (els) => els.length);
    if (count === 0) {
      // No `.slide` convention — capture the whole page as a single image.
      const p = path.join(tmpDir, "slide-000.png");
      await page.screenshot({ path: p as `${string}.png`, fullPage: false });
      pngs.push(p);
    } else {
      for (let i = 0; i < count; i++) {
        // Navigate the deck's own way (scroll slide i to top) then capture the
        // VIEWPORT — what the audience sees. element.screenshot mis-captures
        // keyboard/scroll-snap decks where slides stack one screen at a time.
        await page.evaluate((idx) => {
          const slides = document.querySelectorAll<HTMLElement>(".slide");
          slides[idx]?.scrollIntoView({ block: "start" });
        }, i);
        await sleep(200);
        const p = path.join(tmpDir, `slide-${String(i).padStart(3, "0")}.png`);
        await page.screenshot({ path: p as `${string}.png` });
        pngs.push(p);
      }
    }

    await browser.close();

    if (pngs.length === 0) throw new Error("Không chụp được slide nào từ file HTML.");
    return await imagesToPptx(pngs, outputPath);
  } finally {
    await browser.close().catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
