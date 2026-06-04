import ExcelJS from "exceljs";
import { statSync } from "node:fs";

export interface SheetStyle {
  headerBold?: boolean;
  /** Hex RGB without '#', e.g. "DCE6F1" (pale blue). */
  headerFill?: string;
  border?: boolean;
  freezeHeader?: boolean;
  /** Auto column width based on the longest cell content. */
  autoWidth?: boolean;
  /** Explicit column widths in character units; overrides autoWidth. */
  columnWidths?: number[];
  /** Alternating row background on data rows. */
  zebra?: boolean;
}

export interface SheetInput {
  name: string;
  /** Header row. Optional — omit for plain dumps with no header treatment. */
  headers?: string[];
  rows: (string | number | boolean | null)[][];
  style?: SheetStyle;
}

const DEFAULT_STYLE: Required<Omit<SheetStyle, "columnWidths">> = {
  headerBold: true,
  headerFill: "DCE6F1",
  border: true,
  freezeHeader: true,
  autoWidth: true,
  zebra: true,
};

function sanitizeSheetName(name: string): string {
  // Excel: max 31 chars, no [ ] : * ? / \
  return (name || "Sheet1").replace(/[\[\]:\*\?\/\\]/g, "_").slice(0, 31);
}

function sanitizeCell(v: unknown): string | number | boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  return String(v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function argb(hex: string): string {
  // ExcelJS expects 8-char ARGB. Default alpha FF if user passed RGB.
  const h = hex.replace(/^#/, "");
  return h.length === 6 ? "FF" + h.toUpperCase() : h.toUpperCase();
}

export async function writeXlsx(
  sheets: SheetInput[],
  outputPath: string,
): Promise<{ path: string; size: number; sheets: string[] }> {
  if (sheets.length === 0) throw new Error("Phải có ít nhất 1 sheet.");
  const wb = new ExcelJS.Workbook();
  const writtenNames: string[] = [];

  for (const s of sheets) {
    const style = { ...DEFAULT_STYLE, ...(s.style ?? {}) };
    const hasHeader = !!s.headers && s.headers.length > 0;
    const finalName = sanitizeSheetName(s.name);

    const ws = wb.addWorksheet(finalName, {
      views: style.freezeHeader && hasHeader
        ? [{ state: "frozen", ySplit: 1 }]
        : undefined,
    });

    if (hasHeader) {
      ws.addRow((s.headers as string[]).map(sanitizeCell));
    }
    for (const r of s.rows) {
      // A string starting with "=" is written as a REAL Excel formula
      // (Excel recomputes the result when the file is opened).
      ws.addRow(r.map((v) =>
        typeof v === "string" && v.length > 1 && v.startsWith("=")
          ? ({ formula: v.slice(1) } as ExcelJS.CellFormulaValue)
          : sanitizeCell(v),
      ));
    }

    const totalRows = ws.rowCount;
    const colCount = ws.columnCount;

    // Column widths
    if (style.columnWidths && style.columnWidths.length > 0) {
      for (let c = 0; c < style.columnWidths.length; c++) {
        ws.getColumn(c + 1).width = style.columnWidths[c];
      }
    } else if (style.autoWidth && colCount > 0) {
      for (let c = 1; c <= colCount; c++) {
        let max = 8;
        for (let r = 1; r <= totalRows; r++) {
          const v = ws.getCell(r, c).value;
          if (v === null || v === undefined) continue;
          const text = (v && typeof v === "object" && "formula" in v)
            ? "=" + (v as ExcelJS.CellFormulaValue).formula
            : String(v);
          if (text.length > max) max = text.length;
        }
        ws.getColumn(c).width = Math.min(max + 2, 50);
      }
    }

    const borderSide: Partial<ExcelJS.Border> | undefined = style.border
      ? { style: "thin", color: { argb: "FFBFBFBF" } }
      : undefined;
    const cellBorder = borderSide
      ? { top: borderSide, bottom: borderSide, left: borderSide, right: borderSide }
      : undefined;

    // Style header row
    if (hasHeader) {
      const headerRow = ws.getRow(1);
      headerRow.height = 22;
      headerRow.eachCell((cell) => {
        if (style.headerBold) {
          cell.font = { bold: true, color: { argb: "FF1F4E79" }, size: 11 };
        }
        if (style.headerFill) {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: argb(style.headerFill) },
          };
        }
        cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        if (cellBorder) cell.border = cellBorder;
      });
    }

    // Style data rows: border + zebra
    const dataStart = hasHeader ? 2 : 1;
    for (let r = dataStart; r <= totalRows; r++) {
      const row = ws.getRow(r);
      const isZebra = style.zebra && (r - dataStart) % 2 === 1;
      row.eachCell({ includeEmpty: true }, (cell) => {
        if (cellBorder) cell.border = cellBorder;
        if (isZebra) {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFF7F7F7" },
          };
        }
      });
    }

    writtenNames.push(finalName);
  }

  await wb.xlsx.writeFile(outputPath);
  return {
    path: outputPath,
    size: statSync(outputPath).size,
    sheets: writtenNames,
  };
}

/** A cell value. Formula cells become `{ f: "=…", v: <cached result> }` so the
 *  agent sees BOTH the formula and its computed value. */
export type XlsxCell =
  | string | number | boolean | null
  | { f: string; v: string | number | boolean | null };

export interface SheetOutput {
  name: string;
  rows: XlsxCell[][];
  rowCount: number;
  colCount: number;
}

export async function readXlsx(path: string): Promise<{ sheets: SheetOutput[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const sheets: SheetOutput[] = [];
  for (const ws of wb.worksheets) {
    const rows: XlsxCell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const arr: XlsxCell[] = [];
      const last = row.cellCount;
      for (let c = 1; c <= last; c++) {
        const v = row.getCell(c).value;
        if (v === null || v === undefined) arr.push(null);
        else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") arr.push(v);
        else if (v instanceof Date) arr.push(v.toISOString());
        else if (typeof v === "object" && ("formula" in v || "sharedFormula" in v)) {
          // Keep the formula AND its cached result.
          const f = (v as ExcelJS.CellFormulaValue).formula
            ?? (v as ExcelJS.CellSharedFormulaValue).sharedFormula;
          let res: unknown = (v as { result?: unknown }).result ?? null;
          if (res instanceof Date) res = res.toISOString();
          else if (res && typeof res === "object") res = (res as { error?: string }).error ?? String(res);
          arr.push({ f: "=" + f, v: res as string | number | boolean | null });
        }
        else if (typeof v === "object" && "text" in v) arr.push(String((v as { text: unknown }).text ?? ""));
        else if (typeof v === "object" && "result" in v) arr.push((v as { result: string | number | boolean | null }).result ?? null);
        else arr.push(String(v));
      }
      rows.push(arr);
    });
    const rowCount = rows.length;
    const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
    sheets.push({ name: ws.name, rows, rowCount, colCount });
  }
  return { sheets };
}
