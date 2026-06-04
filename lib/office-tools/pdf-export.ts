import PDFDocument from "pdfkit";
import { marked, type Token, type Tokens } from "marked";
import { createWriteStream, statSync } from "node:fs";

// Use Windows-bundled fonts (the project's primary environment).
// Arial supports Vietnamese diacritics; Consolas covers code.
const FONT_REGULAR = "C:/Windows/Fonts/arial.ttf";
const FONT_BOLD = "C:/Windows/Fonts/arialbd.ttf";
const FONT_ITALIC = "C:/Windows/Fonts/ariali.ttf";
const FONT_MONO = "C:/Windows/Fonts/consola.ttf";

const HEADING_SIZES = [22, 18, 16, 14, 13, 12]; // h1..h6
const BODY_SIZE = 11;
const LINE_GAP = 2;

export async function exportMarkdownToPdf(
  markdown: string,
  outputPath: string,
  title?: string,
): Promise<{ path: string; size: number }> {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    info: title ? { Title: title } : undefined,
    autoFirstPage: true,
  });

  let regular = "Helvetica";
  let bold = "Helvetica-Bold";
  let italic = "Helvetica-Oblique";
  let mono = "Courier";
  try {
    doc.registerFont("Sans", FONT_REGULAR);
    doc.registerFont("Sans-Bold", FONT_BOLD);
    doc.registerFont("Sans-Italic", FONT_ITALIC);
    doc.registerFont("Mono", FONT_MONO);
    regular = "Sans"; bold = "Sans-Bold"; italic = "Sans-Italic"; mono = "Mono";
  } catch {
    // OS fonts missing — fall back to built-in PDF fonts (no Vietnamese diacritics).
  }

  const stream = createWriteStream(outputPath);
  doc.pipe(stream);

  if (title) {
    doc.font(bold).fontSize(24).text(title, { align: "center" });
    doc.moveDown(1.2);
  }

  doc.font(regular).fontSize(BODY_SIZE);
  const tokens = marked.lexer(markdown);
  renderTokens(doc, tokens, { regular, bold, italic, mono });

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on("finish", () => {
      try {
        const stats = statSync(outputPath);
        resolve({ path: outputPath, size: stats.size });
      } catch (e) { reject(e); }
    });
    stream.on("error", reject);
  });
}

interface Fonts { regular: string; bold: string; italic: string; mono: string }

function renderTokens(doc: PDFKit.PDFDocument, tokens: Token[], f: Fonts) {
  for (const t of tokens) {
    if (t.type === "heading") {
      const tk = t as Tokens.Heading;
      const size = HEADING_SIZES[Math.min(tk.depth, 6) - 1] ?? BODY_SIZE;
      doc.moveDown(0.4);
      doc.font(f.bold).fontSize(size).text(tk.text);
      doc.moveDown(0.4);
      doc.font(f.regular).fontSize(BODY_SIZE);
    } else if (t.type === "paragraph") {
      const tk = t as Tokens.Paragraph;
      renderInline(doc, tk.tokens ?? [{ type: "text", raw: tk.text, text: tk.text } as Tokens.Text], f);
      doc.moveDown(0.7);
    } else if (t.type === "code") {
      const tk = t as Tokens.Code;
      doc.font(f.mono).fontSize(10);
      const bg = doc.y;
      void bg;
      doc.text(tk.text, { align: "left", lineGap: 1 });
      doc.moveDown(0.6);
      doc.font(f.regular).fontSize(BODY_SIZE);
    } else if (t.type === "list") {
      const tk = t as Tokens.List;
      for (let i = 0; i < tk.items.length; i++) {
        const item = tk.items[i];
        const bullet = tk.ordered ? `${(Number(tk.start) || 1) + i}.` : "•";
        doc.font(f.regular).fontSize(BODY_SIZE)
          .text(`${bullet} ${item.text}`, { indent: 16, lineGap: LINE_GAP });
      }
      doc.moveDown(0.5);
    } else if (t.type === "blockquote") {
      const tk = t as Tokens.Blockquote;
      doc.font(f.italic).fontSize(BODY_SIZE)
        .text(tk.text, { indent: 16, lineGap: LINE_GAP });
      doc.moveDown(0.5);
      doc.font(f.regular);
    } else if (t.type === "hr") {
      doc.moveDown(0.3);
      doc.lineWidth(0.6)
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .strokeColor("#888").stroke();
      doc.moveDown(0.6);
    } else if (t.type === "space") {
      doc.moveDown(0.3);
    } else if (t.type === "table") {
      const tk = t as Tokens.Table;
      // Simple grid: header row bold, then rows
      const cols = tk.header.length;
      const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const colWidth = usable / cols;
      const startX = doc.page.margins.left;

      doc.font(f.bold).fontSize(10);
      tk.header.forEach((h, i) => {
        doc.text(h.text, startX + i * colWidth, doc.y, { width: colWidth, continued: i < cols - 1 });
      });
      doc.moveDown(0.4);
      doc.font(f.regular);
      for (const row of tk.rows) {
        row.forEach((cell, i) => {
          doc.text(cell.text, startX + i * colWidth, doc.y, { width: colWidth, continued: i < cols - 1 });
        });
        doc.moveDown(0.3);
      }
      doc.moveDown(0.5);
    }
  }
}

function renderInline(doc: PDFKit.PDFDocument, tokens: Token[], f: Fonts) {
  // Concatenate inline tokens; pdfkit's continued flag preserves run on same line.
  const parts = tokens.map(t => ({ text: tokenText(t), bold: t.type === "strong", italic: t.type === "em", code: t.type === "codespan" }));
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const isLast = i === parts.length - 1;
    if (p.code) doc.font(f.mono);
    else if (p.bold) doc.font(f.bold);
    else if (p.italic) doc.font(f.italic);
    else doc.font(f.regular);
    doc.fontSize(BODY_SIZE).text(p.text, { continued: !isLast, lineGap: LINE_GAP });
  }
}

function tokenText(t: Token): string {
  const any = t as { text?: string; raw?: string };
  return any.text ?? any.raw ?? "";
}
