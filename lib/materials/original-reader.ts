import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { preprocessFile } from "./preprocess";
import { resolveMaterialFile } from "./store";

// 原件核对（v1.3 §5.5 / §7.4）：直接打开原件，读来源指向的单元格或页。
// 只经 resolveMaterialFile 读取（与网页预览同一授权），不接受任何路径；调用方负责确认文件属于该 Run。

export interface OriginalLocation {
  page?: number | null;
  sheet?: string | null;
  row?: number | null;
  column?: string | null;
  rawText?: string | null;
}

const norm = (s: string) => s.replace(/\s+/g, "");

/** 列号或列字母统一成列字母（A、B…） */
function colLetter(col: string): string | null {
  if (/^[A-Z]+$/i.test(col)) return col.toUpperCase();
  const n = Number(col);
  return Number.isInteger(n) && n > 0 ? XLSX.utils.encode_col(n - 1) : null;
}

function cellText(ws: XLSX.WorkSheet, addr: string): string | null {
  const c = ws[addr] as XLSX.CellObject | undefined;
  if (!c) return null;
  return c.w ?? (c.v === undefined || c.v === null ? null : String(c.v));
}

function excelAt(wb: XLSX.WorkBook, loc: OriginalLocation) {
  const name = loc.sheet && wb.SheetNames.includes(loc.sheet) ? loc.sheet : !loc.sheet && wb.SheetNames.length === 1 ? wb.SheetNames[0] : null;
  if (!name) return { found: false, reason: `原件里没有 Sheet「${loc.sheet ?? "（未指明）"}」`, sheets_in_original: wb.SheetNames };
  const ws = wb.Sheets[name];
  if (loc.row == null) return { found: false, reason: "来源没有行号，无法定位单元格", sheet: name, sheets_in_original: wb.SheetNames };
  const range = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : null;
  const rowValues: Record<string, string> = {};
  if (range)
    for (let c = range.s.c; c <= range.e.c; c++) {
      const v = cellText(ws, `${XLSX.utils.encode_col(c)}${loc.row}`);
      if (v !== null && v !== "") rowValues[XLSX.utils.encode_col(c)] = v;
    }
  const col = loc.column ? colLetter(loc.column) : null;
  let addr = col ? `${col}${loc.row}` : null;
  let value = addr ? cellText(ws, addr) : null;
  // 合并单元格：值只存在左上角
  let mergedFrom: string | null = null;
  if (col && value === null) {
    const r = loc.row - 1;
    const c = XLSX.utils.decode_col(col);
    const m = (ws["!merges"] ?? []).find((x) => r >= x.s.r && r <= x.e.r && c >= x.s.c && c <= x.e.c);
    if (m) {
      mergedFrom = addr = XLSX.utils.encode_cell(m.s);
      value = cellText(ws, mergedFrom);
    }
  }
  return {
    found: col ? value !== null : Object.keys(rowValues).length > 0,
    kind: "SHEET_CELL",
    sheet: name,
    row: loc.row,
    column: col,
    /** 显示文本（带 Excel 格式，如千分位）；raw_value 是单元格底层值 */
    value_at_location: value,
    raw_value: addr ? ((ws[addr] as XLSX.CellObject | undefined)?.v ?? null) : null,
    merged_from: mergedFrom,
    raw_text_matches: loc.rawText && value !== null ? norm(value).includes(norm(loc.rawText)) : null,
    row_values: rowValues,
  };
}

type PdfText = { pages: { page: number; text: string }[]; warning: string | null; extractor: string };

function pdfAt(pdf: PdfText, loc: OriginalLocation) {
  const { pages } = pdf;
  if (!pages.length) return { found: false, reason: pdf.warning ?? "原件没有可抽取的文字层（可能是扫描件），只能在网页预览里看图" };
  if (loc.page == null) return { found: false, reason: "来源没有页码，无法定位到页", total_pages: pages.length };
  const pg = pages.find((p) => p.page === loc.page);
  if (!pg) return { found: false, reason: `原件只有 ${pages.length} 页，没有第 ${loc.page} 页`, total_pages: pages.length };
  const at = loc.rawText ? pg.text.indexOf(loc.rawText) : -1;
  const start = Math.max(0, at - 200);
  return {
    found: true,
    kind: "PAGE_TEXT",
    page: loc.page,
    total_pages: pages.length,
    raw_text_found_on_page: loc.rawText ? norm(pg.text).includes(norm(loc.rawText)) : null,
    text: pg.text.slice(start, start + 800),
    text_offset: start,
    page_chars: pg.text.length,
    extractor: pdf.extractor,
  };
}

/**
 * 打开一个原件，之后可以反复按位置读取（同一文件只解析一次）。
 * expectedSha256 是运行 / 快照记录的原件 Hash：不一致说明原件在运行后被换过，结果要谨慎对待。
 */
export async function openOriginal(fileId: string, expectedSha256: string | null) {
  const f = await resolveMaterialFile(fileId);
  const buf = readFileSync(f.absolutePath);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const file = { file_id: fileId, file_name: f.fileName, media_type: f.mediaType, sha256, recorded_sha256: expectedSha256, hash_matches_record: expectedSha256 ? sha256 === expectedSha256 : null };
  if (/spreadsheet|excel/.test(f.mediaType) || /\.xlsx?$/i.test(f.fileName)) {
    const wb = XLSX.read(buf, { type: "buffer", cellFormula: false, cellHTML: false });
    return { file, at: (loc: OriginalLocation) => excelAt(wb, loc) };
  }
  if (f.mediaType === "application/pdf" || /\.pdf$/i.test(f.fileName)) {
    const pre = await preprocessFile(buf, f.fileName);
    const pdf: PdfText = { pages: (pre.content as { pages?: { page: number; text: string }[] } | null)?.pages ?? [], warning: pre.warnings[0] ?? null, extractor: pre.preprocessor_version };
    return { file, at: (loc: OriginalLocation) => pdfAt(pdf, loc) };
  }
  return { file, at: (_loc: OriginalLocation) => ({ found: false, reason: "图片原件没有文字层，无法按文字核对；请在网页预览里看图" }) };
}

/** 读原件中来源指向的一个位置 */
export async function readOriginalAt(fileId: string, loc: OriginalLocation, expectedSha256: string | null) {
  const o = await openOriginal(fileId, expectedSha256);
  return { file: o.file, original_at_location: o.at(loc) };
}
