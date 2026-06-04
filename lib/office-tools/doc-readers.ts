import { readFileSync } from "node:fs";

export interface ReadPdfResult {
  text: string;
  pages: number;
}

export async function readPdf(filePath: string): Promise<ReadPdfResult> {
  const buf = readFileSync(filePath);
  // pdf-parse 2.x exports a PDFParse class. `new PDFParse({ data }).getText()`
  // returns { text: string, pages: PageInfo[] }.
  const mod = await import("pdf-parse") as unknown as {
    PDFParse: new (opts: { data: Buffer }) => {
      getText(): Promise<{ text?: string; pages?: unknown[] }>;
      destroy?(): Promise<void> | void;
    };
  };
  const parser = new mod.PDFParse({ data: buf });
  try {
    const r = await parser.getText();
    return { text: (r.text ?? "").trim(), pages: r.pages?.length ?? 0 };
  } finally {
    try { await parser.destroy?.(); } catch { /* best-effort */ }
  }
}

export interface ReadDocxResult {
  text: string;
  warnings: string[];
}

export async function readDocx(filePath: string): Promise<ReadDocxResult> {
  const mammoth = await import("mammoth");
  const { value, messages } = await mammoth.extractRawText({ path: filePath });
  return {
    text: (value ?? "").trim(),
    warnings: (messages ?? []).map((m) => m.message),
  };
}
