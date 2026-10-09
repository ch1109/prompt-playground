import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import * as XLSX from "xlsx";

// 上传原件的预处理：把 PDF / Excel 转成与九立 Demo extracted 同结构的文本内容。
// - Excel：{ sheets: [{ name, rows, columns, merged, cells: [{row, column, value}] }] }（行列从 1 开始）
// - PDF：{ pages: [{ page, text }] }（pdftotext 抽取文字层；扫描件没有文字层，不做 OCR）
// - 图片：没有文本，只能随请求附带原件图片
// 原文件不修改；结果连同 preprocessor_version 记入快照，保证同一样本可比。

export const FILE_IMPORT_VERSION = "file-import@1.0.0";
const exec = promisify(execFile);

export const MEDIA_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/** 文件头魔数：扩展名必须与内容一致，防止伪装文件 */
const MAGIC: Record<string, number[]> = {
  ".pdf": [0x25, 0x50, 0x44, 0x46],
  ".xlsx": [0x50, 0x4b, 0x03, 0x04],
  ".xls": [0xd0, 0xcf, 0x11, 0xe0],
  ".png": [0x89, 0x50, 0x4e, 0x47],
  ".jpg": [0xff, 0xd8, 0xff],
  ".jpeg": [0xff, 0xd8, 0xff],
};

export interface Preprocessed {
  ext: string;
  media_type: string;
  content: unknown;
  /** 是否有可直接发给文本模型的内容 */
  has_text: boolean;
  /** 与 P1/P2 请求 segments 对应的标识：page:N / sheet:名称 */
  segments: string[];
  warnings: string[];
  preprocessor_version: string;
}

let pdftotextVersion: string | null | undefined;
async function pdftotextVer(): Promise<string | null> {
  if (pdftotextVersion !== undefined) return pdftotextVersion;
  try {
    const r = await exec("pdftotext", ["-v"]);
    pdftotextVersion = /version\s+([\d.]+)/.exec(`${r.stdout}${r.stderr}`)?.[1] ?? "unknown";
  } catch (e) {
    const out = `${(e as { stdout?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? ""}`;
    pdftotextVersion = /version\s+([\d.]+)/.exec(out)?.[1] ?? null;
  }
  return pdftotextVersion;
}

function excel(buf: Buffer): Omit<Preprocessed, "ext" | "media_type"> {
  const wb = XLSX.read(buf, { type: "buffer", cellFormula: false, cellHTML: false });
  const sheets = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const range = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : null;
    const cells: { row: number; column: number; value: string }[] = [];
    for (const key of Object.keys(ws)) {
      if (key.startsWith("!")) continue;
      const cell = ws[key] as XLSX.CellObject;
      const value = cell.w ?? (cell.v === undefined || cell.v === null ? "" : String(cell.v));
      if (value === "") continue;
      const { r, c } = XLSX.utils.decode_cell(key);
      cells.push({ row: r + 1, column: c + 1, value });
    }
    cells.sort((a, b) => a.row - b.row || a.column - b.column);
    return {
      name,
      rows: range ? range.e.r + 1 : 0,
      columns: range ? range.e.c + 1 : 0,
      merged: (ws["!merges"] ?? []).map((m) => [m.s.r, m.e.r + 1, m.s.c, m.e.c + 1]),
      cells,
    };
  });
  const has = sheets.some((s) => s.cells.length);
  return {
    content: { sheets },
    has_text: has,
    segments: sheets.map((s) => `sheet:${s.name}`),
    warnings: has ? [] : ["Excel 中没有任何非空单元格"],
    preprocessor_version: `${FILE_IMPORT_VERSION}; sheetjs@${XLSX.version}`,
  };
}

async function pdf(buf: Buffer): Promise<Omit<Preprocessed, "ext" | "media_type">> {
  const ver = await pdftotextVer();
  if (!ver) {
    return { content: null, has_text: false, segments: [], warnings: ["本机未安装 pdftotext（brew install poppler），无法抽取 PDF 文字；可附带原件图片给视觉模型"], preprocessor_version: `${FILE_IMPORT_VERSION}; pdftotext@missing` };
  }
  const dir = await mkdtemp(join(tmpdir(), "studio-pdf-"));
  try {
    const file = join(dir, "in.pdf");
    await writeFile(file, buf);
    const { stdout } = await exec("pdftotext", ["-enc", "UTF-8", file, "-"], { maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
    // pdftotext 每页以换页符 \f 结尾
    const parts = stdout.split("\f");
    if (parts.length > 1 && parts[parts.length - 1].trim() === "") parts.pop();
    const pages = parts.map((text, i) => ({ page: i + 1, text: text.replace(/\s+$/, "") }));
    const empty = pages.filter((p) => !p.text.trim()).map((p) => p.page);
    const warnings: string[] = [];
    if (empty.length === pages.length) warnings.push("PDF 没有文字层（可能是扫描件）：已保存原件，但没有可发送的文本。请在「模型」页勾选「附带原件图片」并使用视觉模型。");
    else if (empty.length) warnings.push(`PDF 第 ${empty.join("、")} 页没有文字层（可能是扫描页），这些页只能通过附带原件图片读取`);
    return {
      content: { pages },
      has_text: empty.length < pages.length,
      segments: pages.map((p) => `page:${p.page}`),
      warnings,
      preprocessor_version: `${FILE_IMPORT_VERSION}; pdftotext@${ver}`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function preprocessFile(buf: Buffer, fileName: string): Promise<Preprocessed> {
  const ext = extname(fileName).toLowerCase();
  const media_type = MEDIA_TYPES[ext];
  if (!media_type) throw new Error(`不支持的文件类型 ${ext || "（无扩展名）"}：只接受 PDF、Excel（xlsx/xls）、PNG、JPG`);
  if (!MAGIC[ext].every((b, i) => buf[i] === b)) throw new Error(`文件「${fileName}」的内容与扩展名不符，已拒绝`);
  if (ext === ".pdf") return { ext, media_type, ...(await pdf(buf)) };
  if (ext === ".xlsx" || ext === ".xls") return { ext, media_type, ...excel(buf) };
  return {
    ext,
    media_type,
    content: null,
    has_text: false,
    segments: ["page:1"],
    warnings: ["图片没有文本：请在「模型」页勾选「附带原件图片」并使用视觉模型"],
    preprocessor_version: `${FILE_IMPORT_VERSION}; image`,
  };
}
