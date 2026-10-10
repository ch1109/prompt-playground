import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveMaterialFile } from "@/lib/materials/store";
import { sha256 } from "@/lib/hash";

// 把构造输入引用的原件（PDF / 图片）转成页面图片，随请求发给视觉模型。
// 原件按授权读取（九立只读连接器或 Studio 上传原件）；PDF 转图写到系统临时目录，用完即删，不改原件。

export const MAX_PAGES = 20;
const exec = promisify(execFile);

export interface PageImage {
  file_id: string;
  page: number | null;
  media_type: string;
  sha256: string;
  base64: string;
}

/** 构造输入中 input.materials / input.files 引用的文件 ID */
export function referencedFileIds(request: Record<string, unknown>): string[] {
  const input = request.input as Record<string, unknown> | undefined;
  const ids = new Set<string>();
  for (const key of ["materials", "files"]) {
    const list = input?.[key];
    if (!Array.isArray(list)) continue;
    for (const m of list) if (typeof m?.file_id === "string") ids.add(m.file_id);
  }
  return [...ids];
}

async function pdfPages(path: string, maxPages: number): Promise<{ page: number; buf: Buffer }[]> {
  const dir = await mkdtemp(join(tmpdir(), "studio-pages-"));
  try {
    // 长边 2000px 的 JPEG；只转前 maxPages 页
    await exec("pdftoppm", ["-jpeg", "-scale-to", "2000", "-l", String(maxPages), path, join(dir, "p")], { timeout: 120000 });
    const files = (await readdir(dir)).sort();
    return Promise.all(files.map(async (f) => ({ page: Number(/-(\d+)\.jpg$/.exec(f)?.[1]), buf: await readFile(join(dir, f)) })));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** PDF 总页数（pdfinfo）；读不出时为 null（未知），不猜 */
export async function pdfPageCount(path: string): Promise<number | null> {
  try {
    const { stdout } = await exec("pdfinfo", [path], { timeout: 30000 });
    const n = Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 每个原件的页图覆盖：总页数（未知为 null）、实际发送的页（图片文件为 [null]）、未附带原因 */
export interface PageImageCoverage {
  file_id: string;
  media_type: string | null;
  total_pages: number | null;
  sent_pages: (number | null)[];
  skipped_reason: string | null;
}

/** 只规划不转换（请求预览用）：按与运行时相同的 20 页上限，算出每个原件将发送哪些页 */
export async function planPageImages(fileIds: string[]): Promise<PageImageCoverage[]> {
  return (await collect(fileIds, false)).coverage;
}

export async function buildPageImages(fileIds: string[]): Promise<{ images: PageImage[]; warnings: string[]; coverage: PageImageCoverage[] }> {
  return collect(fileIds, true);
}

async function collect(fileIds: string[], convert: boolean): Promise<{ images: PageImage[]; warnings: string[]; coverage: PageImageCoverage[] }> {
  const warnings: string[] = [];
  const images: PageImage[] = [];
  const coverage: PageImageCoverage[] = [];
  if (!fileIds.length) return { images, warnings: ["构造输入没有引用原件文件，未附带图片"], coverage };
  let used = 0;
  for (const id of fileIds) {
    const left = MAX_PAGES - used;
    const cov: PageImageCoverage = { file_id: id, media_type: null, total_pages: null, sent_pages: [], skipped_reason: null };
    coverage.push(cov);
    try {
      const p = await resolveMaterialFile(id);
      cov.media_type = p.mediaType;
      if (p.mediaType === "application/pdf") cov.total_pages = await pdfPageCount(p.absolutePath);
      else if (p.mediaType.startsWith("image/")) cov.total_pages = 1;
      if (left <= 0) {
        cov.skipped_reason = `已达 ${MAX_PAGES} 页上限`;
        warnings.push(`已达 ${MAX_PAGES} 页上限，原件 ${id} 未附带`);
        continue;
      }
      let pages: { page: number | null; buf?: Buffer; type: string }[];
      if (p.mediaType === "application/pdf") {
        if (convert) {
          // 多转一页，用来判断是否被截断
          const all = await pdfPages(p.absolutePath, left + 1);
          if (all.length > left) warnings.push(`原件 ${id} 超出 ${MAX_PAGES} 页上限，只附带了前 ${left} 页`);
          pages = all.slice(0, left).map((x) => ({ ...x, type: "image/jpeg" }));
        } else {
          const n = Math.min(cov.total_pages ?? left, left);
          pages = Array.from({ length: n }, (_, i) => ({ page: i + 1, type: "image/jpeg" }));
        }
      } else if (p.mediaType.startsWith("image/")) {
        pages = [{ page: null, buf: convert ? await readFile(/*turbopackIgnore: true*/ p.absolutePath) : undefined, type: p.mediaType }];
      } else {
        cov.skipped_reason = "不是 PDF 或图片";
        warnings.push(`原件 ${id}（${p.fileName}）不是 PDF 或图片，未附带，模型只看到它的预处理文本`);
        continue;
      }
      used += pages.length;
      cov.sent_pages = pages.map((x) => x.page);
      if (convert) for (const x of pages) images.push({ file_id: id, page: x.page, media_type: x.type, sha256: sha256(x.buf!.toString("base64")), base64: x.buf!.toString("base64") });
    } catch (e) {
      cov.skipped_reason = `无法读取原件（${e instanceof Error ? e.message : String(e)}）`;
      warnings.push(`原件 ${id} 无法转为图片（${e instanceof Error ? e.message : String(e)}），未附带`);
    }
  }
  return { images, warnings, coverage };
}
