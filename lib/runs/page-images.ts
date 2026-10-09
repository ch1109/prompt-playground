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

export async function buildPageImages(fileIds: string[]): Promise<{ images: PageImage[]; warnings: string[] }> {
  const warnings: string[] = [];
  const images: PageImage[] = [];
  if (!fileIds.length) return { images, warnings: ["构造输入没有引用原件文件，未附带图片"] };
  for (const id of fileIds) {
    const left = MAX_PAGES - images.length;
    if (left <= 0) {
      warnings.push(`已达 ${MAX_PAGES} 页上限，原件 ${id} 未附带`);
      continue;
    }
    try {
      const p = await resolveMaterialFile(id);
      let pages: { page: number | null; buf: Buffer; type: string }[];
      if (p.mediaType === "application/pdf") {
        // 多转一页，用来判断是否被截断
        const all = await pdfPages(p.absolutePath, left + 1);
        if (all.length > left) warnings.push(`原件 ${id} 超出 ${MAX_PAGES} 页上限，只附带了前 ${left} 页`);
        pages = all.slice(0, left).map((x) => ({ ...x, type: "image/jpeg" }));
      } else if (p.mediaType.startsWith("image/")) {
        pages = [{ page: null, buf: await readFile(/*turbopackIgnore: true*/ p.absolutePath), type: p.mediaType }];
      } else {
        warnings.push(`原件 ${id}（${p.fileName}）不是 PDF 或图片，未附带，模型只看到它的预处理文本`);
        continue;
      }
      for (const x of pages) images.push({ file_id: id, page: x.page, media_type: x.type, sha256: sha256(x.buf.toString("base64")), base64: x.buf.toString("base64") });
    } catch (e) {
      warnings.push(`原件 ${id} 无法转为图片（${e instanceof Error ? e.message : String(e)}），未附带`);
    }
  }
  return { images, warnings };
}
