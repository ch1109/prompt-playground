"use client";
import type { EvidenceView, ViewModel } from "@/lib/contracts/view-model";
import { useStudio } from "@/lib/state/studio-store";
import { Badge, cx } from "@/components/ui";

const AVAIL = {
  AVAILABLE: { tone: "ok", text: "可预览原文" },
  METADATA_ONLY: { tone: "warn", text: "仅元数据（原文未导入/不可访问）" },
  MISSING: { tone: "bad", text: "来源缺失" },
  FORBIDDEN: { tone: "bad", text: "无权访问" },
} as const;

/** 授权预览链接；有页码时加 #page=N，浏览器 PDF 查看器会直接跳到该页 */
export function previewHref(e: Pick<EvidenceView, "fileId" | "page">): string {
  return `/api/materials/${encodeURIComponent(e.fileId)}/preview${e.page != null ? `#page=${e.page}` : ""}`;
}

/** 当前选择对象关联的来源引用 */
export function selectedRefIds(vm: ViewModel, sel: ReturnType<typeof useStudio.getState>["selection"]): string[] | null {
  if (sel.issueId) return vm.issues.find((i) => i.id === sel.issueId)?.sourceRefIds ?? [];
  if (sel.relationId) return vm.relations.find((r) => r.id === sel.relationId)?.sourceRefIds ?? [];
  if (sel.tableId && sel.rowId) {
    const row = vm.tables.find((t) => t.id === sel.tableId)?.rows.find((r) => r.id === sel.rowId);
    if (!row) return null;
    const cell = sel.fieldKey ? row.cells[sel.fieldKey] : undefined;
    return cell?.sourceRefIds.length ? cell.sourceRefIds : row.sourceRefIds ?? [];
  }
  return null;
}

export function EvidenceCard({ e, active, canPreview }: { e: EvidenceView; active?: boolean; canPreview: boolean }) {
  const select = useStudio((s) => s.select);
  const setStore = useStudio((s) => s.set);
  const sel = useStudio((s) => s.selection);
  const a = AVAIL[e.availability];
  return (
    <div data-evidence-id={e.id} className={cx("rounded border border-ink-700 bg-ink-950/60 p-2", active && "border-stamp/70")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={a.tone}>{e.availability}</Badge>
        <span className="text-[11px] text-ink-400">{a.text}</span>
      </div>
      {e.label && <div className="mt-1 text-[12px] text-ink-100">{e.label}</div>}
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-[11px] text-ink-300">
        <dt className="text-ink-400">文件</dt>
        <dd className="font-mono break-all">
          {e.fileId || "—"}
          {e.fileName ? ` · ${e.fileName}` : ""}
        </dd>
        <dt className="text-ink-400">位置</dt>
        <dd className="font-mono">
          {[e.page != null && `第${e.page}页`, e.sheet && `Sheet ${e.sheet}`, e.row != null && `行${e.row}`, e.column && `列${e.column}`].filter(Boolean).join(" · ") || "未提供（不捏造坐标）"}
        </dd>
        <dt className="text-ink-400">原文</dt>
        <dd className="break-words whitespace-pre-wrap">{e.rawText ?? <span className="text-ink-600">无</span>}</dd>
        <dt className="text-ink-400">引用</dt>
        <dd className="font-mono break-all text-ink-400">{e.id}</dd>
      </dl>
      <div className="mt-1.5 flex gap-2">
        {e.jsonPointer !== undefined && (
          <button
            onClick={() => {
              select({ ...sel, sourceRefId: e.id, jsonPointer: (e.location === "REQUEST" ? "req:" : "") + e.jsonPointer });
              setStore("resultTab", "json");
            }}
            className="text-[11px] text-info hover:underline"
          >
            在 JSON 中定位
          </button>
        )}
        {e.availability === "AVAILABLE" && e.fileId && (canPreview || e.fileId.startsWith("U-")) && (
          <a href={previewHref(e)} target="_blank" rel="noopener noreferrer" className="text-[11px] text-verify hover:underline">
            {e.page != null ? `打开原文件第 ${e.page} 页（授权预览）` : "打开原文件（授权预览）"}
          </a>
        )}
      </div>
    </div>
  );
}

export function EvidenceViewer({ vm, canPreview }: { vm: ViewModel; canPreview: boolean }) {
  const sel = useStudio((s) => s.selection);
  const refs = selectedRefIds(vm, sel);
  const byId = new Map(vm.evidence.map((e) => [e.id, e]));
  if (refs === null) return <p className="text-[12px] text-ink-400">点击表格单元格、问题、关系或 Patch 查看来源。</p>;
  if (sel.tableId && sel.rowId && !vm.tables.find((t) => t.id === sel.tableId)?.rows.some((r) => r.id === sel.rowId) && !sel.issueId) {
    return <p className="text-[12px] text-risk">无法定位：所选对象在当前结果中不存在。</p>;
  }
  if (refs.length === 0) return <p className="text-[12px] text-risk">未提供来源（这不代表证据通过）。</p>;
  return (
    <div className="space-y-2">
      {refs.map((id) => {
        const e = byId.get(id);
        return e ? <EvidenceCard key={id} e={e} active={sel.sourceRefId === id} canPreview={canPreview} /> : <div key={id} className="text-[12px] text-stamp">引用 {id} 无法定位</div>;
      })}
    </div>
  );
}
