import type { EvidenceView } from "@/lib/contracts/view-model";
import { openOriginal } from "@/lib/materials/original-reader";
import { loadRunContext, runFileIds } from "@/lib/runs/debug-bundle";

// 来源坐标检查（v1.3 §10.5「来源引用是否仍完整」）：打开原件，看模型引用的原文是不是真的在它说的那一格 / 那一页。
// 只检查同时给了位置（单元格或页）和原文的来源；打不开原件、原件已被替换、只给了整行的，记为「没法检查」，不猜。

export interface SourceProblem {
  json_pointer: string;
  label: string | null;
  where: string;
  claimed: string;
  /** 原件这个位置实际写的内容；null = 这一格是空的 */
  actual: string | null;
}

export interface SourceCheck {
  checked: number;
  wrong: number;
  unchecked: number;
  problems: SourceProblem[];
}

// 去掉空白和常见分隔符再比较，避免千分位、换行、冒号写法不同造成误报
const n = (s: string) => s.replace(/[\s,，:：;；|]/g, "").toLowerCase();
const matches = (claimed: string, actual: string) => !!n(actual) && (n(actual).includes(n(claimed)) || n(claimed).includes(n(actual)));

/** Run 与原件都不可变（原件变了会记为没法检查），结果按 run_id 缓存 */
const cache = new Map<string, SourceCheck>();

export async function checkRunSources(runId: string): Promise<SourceCheck | null> {
  const hit = cache.get(runId);
  if (hit) return hit;
  const c = loadRunContext(runId);
  if (!c?.run.view_model) return null;
  const files = runFileIds(c);
  const isCell = (e: EvidenceView) => e.row != null && !!e.column;
  const isPage = (e: EvidenceView) => e.page != null && !e.sheet;
  const all = c.run.view_model.evidence.filter((e) => e.location !== "REQUEST" && e.fileId && e.rawText);
  const targets = all.filter((e) => files.has(e.fileId) && (isCell(e) || isPage(e)));
  const out: SourceCheck = { checked: 0, wrong: 0, unchecked: all.length - targets.length, problems: [] };
  for (const fileId of new Set(targets.map((e) => e.fileId))) {
    const evs = targets.filter((e) => e.fileId === fileId);
    const recorded = c.run.input_manifest?.files.find((f) => f.file_id === fileId)?.original_file_hash ?? c.snapshot?.materials.find((m) => m.file_id === fileId)?.content_hash ?? null;
    let original;
    try {
      original = await openOriginal(fileId, recorded);
    } catch {
      out.unchecked += evs.length;
      continue;
    }
    if (original.file.hash_matches_record === false) {
      out.unchecked += evs.length;
      continue;
    }
    for (const e of evs) {
      const at = original.at({ page: e.page, sheet: e.sheet, row: e.row, column: e.column, rawText: e.rawText }) as Record<string, unknown>;
      let ok: boolean;
      let actual: string | null = null;
      if (isCell(e)) {
        // 找不到 Sheet / 列号无法识别：没法检查；找到了但这一格是空的：算指错
        if (!("value_at_location" in at) || at.column === null) {
          out.unchecked++;
          continue;
        }
        actual = (at.value_at_location as string | null) ?? null;
        ok = actual !== null && (matches(e.rawText!, actual) || (at.raw_value != null && matches(e.rawText!, String(at.raw_value))));
      } else {
        if (at.raw_text_found_on_page === undefined) {
          out.unchecked++;
          continue;
        }
        ok = at.raw_text_found_on_page === true;
        actual = ok ? e.rawText! : "（这一页找不到这段原文）";
      }
      out.checked++;
      if (!ok) {
        out.wrong++;
        out.problems.push({ json_pointer: e.id, label: e.label ?? null, where: isCell(e) ? `${e.sheet ? `「${e.sheet}」` : ""}第 ${e.row} 行 ${at.column} 列` : `第 ${e.page} 页`, claimed: e.rawText!, actual });
      }
    }
  }
  cache.set(runId, out);
  return out;
}
