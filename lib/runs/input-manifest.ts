import type { InputSnapshot } from "@/lib/contracts/snapshot";
import type { InputManifest, ManifestFile } from "@/lib/contracts/run";
import type { PageImageCoverage } from "./page-images";

// 输入覆盖清单（R-02）：回答"这次 Run 实际发出了哪些文件、页、Sheet、文本和图片"。
// 只根据构造好的请求、快照登记的材料和页图转换结果统计，不做推测；拿不到的数字记 null（未知）。

export const INPUT_MANIFEST_VERSION = "input-manifest@1.0.0";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});

/** 请求中 input.materials（P1）/ input.files（P2）的文件条目 */
function requestFiles(request: Rec): Rec[] {
  const input = rec(request.input);
  return ["materials", "files"].flatMap((k) => (Array.isArray(input[k]) ? (input[k] as unknown[]).map(rec) : []));
}

function textPages(content: unknown, segments: string[]): number[] {
  const pages = rec(content).pages;
  if (Array.isArray(pages)) return pages.map((p) => Number(rec(p).page)).filter((n) => Number.isFinite(n));
  const single = Number(rec(content).page);
  if (Number.isFinite(single) && single > 0) return [single];
  return segments.map((s) => /^page:(\d+)$/.exec(s)?.[1]).filter(Boolean).map(Number);
}

function sheets(content: unknown): ManifestFile["sheets"] {
  const c = rec(content);
  if (Array.isArray(c.sheets))
    return c.sheets.map(rec).map((s) => ({ name: String(s.name ?? ""), rows: typeof s.rows === "number" ? s.rows : null, columns: typeof s.columns === "number" ? s.columns : null, cells: Array.isArray(s.cells) ? s.cells.length : null }));
  // 九立 Demo 的 Excel 抽取：单个 Sheet，rows 为数据行
  if (typeof c.sheet === "string") return [{ name: c.sheet, rows: Array.isArray(c.rows) ? c.rows.length : null, columns: Array.isArray(c.columns) ? c.columns.length : null, cells: null }];
  return null;
}

export interface ManifestInput {
  request: Rec;
  snapshot: InputSnapshot;
  builderId: string;
  builderVersion: string;
  /** 没有预处理文本、当前方式无法发给模型的文件 */
  blockedFiles: string[];
  attachImages: boolean;
  /** 页图覆盖；未开启附带图片时为 null */
  imageCoverage: PageImageCoverage[] | null;
  /** 连接器 / 上传登记的文件元数据（文件名、类型、原件 Hash） */
  fileMeta: { file_id: string; file_name?: string; media_type?: string; sha256?: string }[];
  /** 实际发送的 user 消息字符数 */
  userChars: number;
  systemChars: number;
  /** 模型是否声明支持图片：true / false / null（未声明） */
  visionSupported: boolean | null;
}

export function buildInputManifest(m: ManifestInput): InputManifest {
  const payload = rec(m.snapshot.normalized_payload);
  const uploadMeta = new Map(
    (Array.isArray(rec(payload.file_import).materials) ? (rec(payload.file_import).materials as unknown[]).map(rec) : []).map((x) => [String(x.file_id), x]),
  );
  const snapMat = new Map(m.snapshot.materials.map((x) => [x.file_id, x]));
  const meta = new Map(m.fileMeta.map((x) => [x.file_id, x]));
  const cov = new Map((m.imageCoverage ?? []).map((c) => [c.file_id, c]));
  const gaps: string[] = [];

  // 同一文件可能按单证拆成多条材料（发票页 / 箱单页），按 file_id 合并统计
  const byId = new Map<string, ManifestFile>();
  for (const f of requestFiles(m.request)) {
    const id = String(f.file_id ?? "");
    if (!id) continue;
    const segments = Array.isArray(f.segments) ? f.segments.map(String) : [];
    const content = f.content;
    const hasText = content !== null && content !== undefined;
    const chars = hasText ? JSON.stringify(content).length : 0;
    const sm = snapMat.get(id);
    const um = uploadMeta.get(id);
    const md = meta.get(id);
    const c = cov.get(id);
    const prev = byId.get(id);
    if (prev) {
      prev.roles = [...new Set([...prev.roles, String(f.material_type ?? "")].filter(Boolean))];
      prev.text_chars += chars;
      prev.text_pages = [...new Set([...prev.text_pages, ...textPages(content, segments)])].sort((a, b) => a - b);
      prev.text_sent ||= hasText;
      continue;
    }
    byId.set(id, {
      file_id: id,
      file_name: sm?.file_name ?? md?.file_name ?? null,
      media_type: sm?.media_type ?? md?.media_type ?? c?.media_type ?? null,
      original_file_hash: sm?.content_hash ?? (typeof um?.sha256 === "string" ? um.sha256 : null) ?? md?.sha256 ?? null,
      availability: sm?.availability ?? null,
      roles: f.material_type ? [String(f.material_type)] : [],
      preprocessor_version: typeof um?.preprocessor_version === "string" ? um.preprocessor_version : m.snapshot.source_type === "FILE_IMPORT" ? null : "上游已抽取（九立 Demo / 录制请求，版本未知）",
      text_sent: hasText,
      text_chars: chars,
      text_pages: textPages(content, segments),
      sheets: sheets(content),
      total_pages: c?.total_pages ?? null,
      image_pages_sent: c ? c.sent_pages : null,
      image_skipped_reason: c?.skipped_reason ?? null,
    });
  }
  const files = [...byId.values()];

  for (const id of m.blockedFiles) gaps.push(`材料 ${id} 没有预处理文本，当前方式无法发送给模型`);
  for (const f of files) if (!f.text_sent && !(f.image_pages_sent?.length)) gaps.push(`材料 ${f.file_id} 既没有发送文本也没有发送图片`);

  // 页图覆盖：只统计开启附带图片且知道总页数的文件
  let pageCoverage: string | null = null;
  let truncation: string | null = null;
  if (m.imageCoverage) {
    const pdfs = m.imageCoverage.filter((c) => c.media_type === "application/pdf" || c.media_type?.startsWith("image/"));
    const sent = pdfs.reduce((n, c) => n + c.sent_pages.length, 0);
    const known = pdfs.every((c) => c.total_pages !== null);
    const total = known ? pdfs.reduce((n, c) => n + (c.total_pages ?? 0), 0) : null;
    if (pdfs.length) pageCoverage = `${sent}/${total ?? "?"}`;
    const short = pdfs.filter((c) => c.total_pages !== null && c.sent_pages.length < c.total_pages);
    if (short.length) {
      truncation = short.map((c) => `${c.file_id} 发送 ${c.sent_pages.length}/${c.total_pages} 页${c.skipped_reason ? `（${c.skipped_reason}）` : "（20 页上限）"}`).join("；");
      gaps.push(`页图未全部发送：${truncation}。不能作为完整材料识别评测`);
    }
    if (!known && pdfs.length) gaps.push("部分原件读不出总页数，无法确认页图是否完整");
    for (const c of m.imageCoverage) if (c.skipped_reason && !c.sent_pages.length && (c.media_type === "application/pdf" || c.media_type?.startsWith("image/"))) gaps.push(`原件 ${c.file_id} 未附带图片：${c.skipped_reason}`);
  }

  const visualFiles = files.filter((f) => f.media_type === "application/pdf" || f.media_type?.startsWith("image/"));
  const imageCount = m.imageCoverage ? m.imageCoverage.reduce((n, c) => n + c.sent_pages.length, 0) : 0;
  const visual: InputManifest["visual_evidence"] = !visualFiles.length && !m.imageCoverage ? "NOT_APPLICABLE" : !m.attachImages ? "NOT_SENT" : imageCount === 0 ? "NOT_SENT" : truncation ? "PARTIAL" : "SENT";
  const notes: string[] = [];
  if (visual === "NOT_SENT") notes.push("未向模型发送原件图片：手写、勾选、版面等视觉证据没有进入模型，本次结果不能检验视觉识别能力");
  if (m.attachImages && m.visionSupported === false) gaps.push("当前模型声明不支持图片输入");
  if (m.attachImages && m.visionSupported === null) notes.push("当前模型没有声明是否支持图片（MODEL_SUPPORTS_IMAGES 未配置），无法确认图片被模型读取");

  return {
    version: INPUT_MANIFEST_VERSION,
    input_builder: `${m.builderId}@${m.builderVersion}`,
    snapshot_id: m.snapshot.snapshot_id,
    snapshot_source_type: m.snapshot.source_type,
    snapshot_hash: m.snapshot.content_hash,
    files,
    sent_text_chars: m.systemChars + m.userChars,
    sent_image_count: imageCount,
    page_coverage: pageCoverage,
    truncation_reason: truncation,
    visual_evidence: visual,
    complete: gaps.length === 0,
    gaps,
    notes,
  };
}
