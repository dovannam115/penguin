import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
} from "docx";
import { marked, type Token, type Tokens } from "marked";
import { writeFile, statSync } from "node:fs";
import { promisify } from "node:util";

const writeFileAsync = promisify(writeFile);

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

// Calibri ships with Word + has full Vietnamese coverage. Forcing it on every
// run keeps diacritics rendering correctly even if the viewer's default font
// fallback is missing combining marks.
const DEFAULT_FONT = "Calibri";

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  font?: string;
  size?: number;
}

// Convert a marked inline-token list into TextRun[], respecting nested
// strong/em/code formatting. The previous version used the parent token's raw
// `.text` field which left "**bold**" markers as literal characters in the
// docx output. This walks tokens.tokens recursively so formatting actually
// applies.
function tokensToRuns(tokens: Token[] | undefined, base: RunStyle = {}): TextRun[] {
  if (!tokens || tokens.length === 0) return [];
  return tokens.flatMap((t): TextRun[] => {
    if (t.type === "strong") {
      const tk = t as Tokens.Strong;
      return tokensToRuns(tk.tokens, { ...base, bold: true });
    }
    if (t.type === "em") {
      const tk = t as Tokens.Em;
      return tokensToRuns(tk.tokens, { ...base, italics: true });
    }
    if (t.type === "codespan") {
      const tk = t as Tokens.Codespan;
      return [new TextRun({ text: tk.text, font: "Consolas", bold: base.bold, italics: base.italics, size: base.size })];
    }
    if (t.type === "link") {
      const tk = t as Tokens.Link;
      return tokensToRuns(tk.tokens, base);
    }
    if (t.type === "text") {
      const tk = t as Tokens.Text;
      // Inline text tokens sometimes contain nested tokens (strong inside text)
      if (tk.tokens && tk.tokens.length > 0) return tokensToRuns(tk.tokens, base);
      return [new TextRun({ text: tk.text, font: base.font ?? DEFAULT_FONT, bold: base.bold, italics: base.italics, size: base.size })];
    }
    if (t.type === "br") return [new TextRun({ text: "\n", font: base.font ?? DEFAULT_FONT, ...base })];
    if (t.type === "escape") {
      const tk = t as Tokens.Escape;
      return [new TextRun({ text: tk.text, font: base.font ?? DEFAULT_FONT, ...base })];
    }
    if (t.type === "del") {
      const tk = t as Tokens.Del;
      return tokensToRuns(tk.tokens, base);
    }
    // Fallback for unknown inline types (preserves the visible text)
    const any = t as { text?: string; raw?: string };
    return [new TextRun({ text: any.text ?? any.raw ?? "", font: base.font ?? DEFAULT_FONT, ...base })];
  });
}

export async function exportMarkdownToDocx(
  markdown: string,
  outputPath: string,
  title?: string,
): Promise<{ path: string; size: number }> {
  const tokens = marked.lexer(markdown);
  const children: Paragraph[] = [];

  if (title) {
    children.push(new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: title, bold: true, size: 36, font: DEFAULT_FONT })],
    }));
  }

  for (const t of tokens) {
    if (t.type === "heading") {
      const tk = t as Tokens.Heading;
      // Use the parsed inline tokens so any **bold**/*italic* within the
      // heading renders correctly; fall back to plain text if no inline tree.
      const runs = tokensToRuns(tk.tokens, { bold: true });
      children.push(new Paragraph({
        heading: HEADING_LEVELS[Math.min(tk.depth, 6) - 1],
        children: runs.length > 0
          ? runs
          : [new TextRun({ text: tk.text, bold: true, font: DEFAULT_FONT })],
      }));
    } else if (t.type === "paragraph") {
      const tk = t as Tokens.Paragraph;
      const runs = tokensToRuns(tk.tokens);
      children.push(new Paragraph({
        children: runs.length > 0
          ? runs
          : [new TextRun({ text: tk.text, font: DEFAULT_FONT })],
      }));
    } else if (t.type === "code") {
      const tk = t as Tokens.Code;
      const lines = tk.text.split(/\r?\n/);
      for (const ln of lines) {
        children.push(new Paragraph({
          children: [new TextRun({ text: ln, font: "Consolas", size: 20 })],
          shading: { type: "clear", color: "auto", fill: "F1F5F9" },
        }));
      }
    } else if (t.type === "list") {
      const tk = t as Tokens.List;
      for (let i = 0; i < tk.items.length; i++) {
        const item = tk.items[i];
        const bullet = tk.ordered ? `${(Number(tk.start) || 1) + i}. ` : "• ";
        // Parse list item content via inline tokenizer so **bold**, *italic*,
        // `code` inside bullets render — previously the `.text` field was used
        // verbatim, leaking markdown markers like "**Điều khoản**" into the
        // docx output.
        const inlineTokens = marked.lexer(item.text);
        const itemRuns: TextRun[] = [new TextRun({ text: bullet, font: DEFAULT_FONT })];
        for (const sub of inlineTokens) {
          if (sub.type === "paragraph") {
            itemRuns.push(...tokensToRuns((sub as Tokens.Paragraph).tokens));
          } else if (sub.type === "text") {
            const sx = sub as Tokens.Text;
            itemRuns.push(...(sx.tokens ? tokensToRuns(sx.tokens) : [new TextRun({ text: sx.text, font: DEFAULT_FONT })]));
          }
        }
        children.push(new Paragraph({
          indent: { left: 360 },
          children: itemRuns.length > 1 ? itemRuns : [new TextRun({ text: bullet + item.text, font: DEFAULT_FONT })],
        }));
      }
    } else if (t.type === "blockquote") {
      const tk = t as Tokens.Blockquote;
      const runs = tokensToRuns(tk.tokens, { italics: true });
      children.push(new Paragraph({
        indent: { left: 360 },
        children: runs.length > 0
          ? runs
          : [new TextRun({ text: tk.text, italics: true, font: DEFAULT_FONT })],
      }));
    } else if (t.type === "hr") {
      children.push(new Paragraph({
        border: { bottom: { color: "888888", space: 1, style: "single", size: 6 } },
        children: [],
      }));
    } else if (t.type === "space") {
      children.push(new Paragraph({ children: [] }));
    } else if (t.type === "table") {
      const tk = t as Tokens.Table;
      // Plain-text table rendering (proper docx Table API is a future upgrade).
      const headerRuns: TextRun[] = [];
      tk.header.forEach((h, i) => {
        if (i > 0) headerRuns.push(new TextRun({ text: " | ", bold: true, font: DEFAULT_FONT }));
        headerRuns.push(...tokensToRuns(h.tokens, { bold: true }));
      });
      children.push(new Paragraph({ children: headerRuns.length > 0 ? headerRuns : [new TextRun({ text: tk.header.map(h => h.text).join(" | "), bold: true, font: DEFAULT_FONT })] }));
      for (const row of tk.rows) {
        const rowRuns: TextRun[] = [];
        row.forEach((c, i) => {
          if (i > 0) rowRuns.push(new TextRun({ text: " | ", font: DEFAULT_FONT }));
          rowRuns.push(...tokensToRuns(c.tokens));
        });
        children.push(new Paragraph({
          children: rowRuns.length > 0 ? rowRuns : [new TextRun({ text: row.map(c => c.text).join(" | "), font: DEFAULT_FONT })],
        }));
      }
    }
  }

  const doc = new Document({
    // Default run/paragraph style so any missed TextRun still picks up the
    // Vietnamese-safe Calibri font.
    styles: {
      default: {
        document: {
          run: { font: DEFAULT_FONT },
        },
      },
    },
    sections: [{ properties: {}, children }],
  });
  const buf = await Packer.toBuffer(doc);
  await writeFileAsync(outputPath, buf);
  return { path: outputPath, size: statSync(outputPath).size };
}
