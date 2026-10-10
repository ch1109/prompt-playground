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

/** 可用性之外的补充说明：让徽章与能否打开原件保持一致，并说明"只有元数据"的原因 */
export function availabilityNote(e: EvidenceView, previewable: boolean, snapshotSource?: string | null): string | null {
  if (e.availability === "AVAILABLE" && e.fileId && !previewable) return "原件在快照中登记为可用，但当前九立连接未接通，暂时无法打开。";
  if (e.availability === "METADATA_ONLY" && snapshotSource === "FIXTURE") return "样本只带模型输出与请求，不含原件文件，所以只有元数据。想核对原件，可从九立导入同一任务后再运行。";
  return null;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const colName = (n: number) => {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

/**
 * Excel 证据所在行的单元格（R-13）：只读快照里随请求发送的预处理文本，不按文件名去找原件。
 * 支持上传预处理结构 {sheets:[{name,cells:[{row,column,value}]}]} 与九立 Demo 抽取结构 {sheet,rows:[{row,B,C…}]}；找不到返回 null。
 */
export function excelRowExcerpt(request: unknown, e: Pick<EvidenceView, "fileId" | "sheet" | "row">): { column: string; value: string }[] | null {
  if (e.row == null) return null;
  const input = rec(rec(request).input);
  const files = [...(Array.isArray(input.materials) ? input.materials : []), ...(Array.isArray(input.files) ? input.files : [])].map(rec);
  for (const f of files.filter((x) => x.file_id === e.fileId)) {
    const c = rec(f.content);
    if (Array.isArray(c.sheets)) {
      const sh = c.sheets.map(rec).find((x) => !e.sheet || x.name === e.sheet);
      const cells = (Array.isArray(sh?.cells) ? sh.cells : []).map(rec).filter((x) => x.row === e.row);
      if (cells.length) return cells.map((x) => ({ column: colName(Number(x.column)), value: String(x.value ?? "") }));
    }
    if (Array.isArray(c.rows) && (!e.sheet || c.sheet === e.sheet)) {
      const r = c.rows.map(rec).find((x) => x.row === e.row);
      if (r)
        return Object.entries(r)
          .filter(([k]) => k !== "row")
          .map(([k, v]) => ({ column: k, value: typeof v === "object" && v !== null ? String(rec(v).cached ?? JSON.stringify(v)) : String(v ?? "") }));
    }
  }
  return null;
}

export function EvidenceCard({ e, active, canPreview, snapshotSource, request }: { e: EvidenceView; active?: boolean; canPreview: boolean; snapshotSource?: string | null; request?: unknown }) {
  const select = useStudio((s) => s.select);
  const setStore = useStudio((s) => s.set);
  const sel = useStudio((s) => s.selection);
  const a = AVAIL[e.availability];
  const previewable = !!e.fileId && (canPreview || e.fileId.startsWith("U-"));
  const note = availabilityNote(e, previewable, snapshotSource);
  const excerpt = e.sheet || e.row != null ? excelRowExcerpt(request, e) : null;
  return (
    <div data-evidence-id={e.id} className={cx("rounded-lg border border-ink-700 bg-ink-950/60 p-2", active && "border-accent/60 ring-2 ring-accent/15")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={a.tone}>{e.availability}</Badge>
        <span className="text-[11px] text-ink-400">{a.text}</span>
      </div>
      {note && (
        <p className="mt-1 text-[11px] text-risk" data-testid="evidence-note">
          {note}
        </p>
      )}
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
        <dt className="text-ink-400" title="模型或请求中记录的原文摘录，不是从原件重新读取的">{e.location === "REQUEST" ? "请求原文" : "模型摘录"}</dt>
        <dd className="break-words whitespace-pre-wrap">{e.rawText ?? <span className="text-ink-600">无</span>}</dd>
        <dt className="text-ink-400">引用</dt>
        <dd className="font-mono break-all text-ink-400">{e.id}</dd>
      </dl>
      {excerpt && (
        <div className="mt-1" data-testid="excel-excerpt">
          <div className="text-[10.5px] text-ink-400">快照中第 {e.row} 行的单元格（随请求发送的预处理文本，不是原件截图）</div>
          <div className="flex flex-wrap gap-1 text-[11px]">
            {excerpt.map((c) => (
              <span key={c.column} className={cx("rounded border border-ink-700 px-1", e.column && c.column === e.column && "border-accent bg-accent/10")}>
                <span className="text-ink-400">{c.column}</span> {c.value}
              </span>
            ))}
          </div>
        </div>
      )}
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
        {e.availability === "AVAILABLE" && previewable && (
          <a href={previewHref(e)} target="_blank" rel="noopener noreferrer" className="text-[11px] text-verify hover:underline">
            {e.page != null ? `打开原文件第 ${e.page} 页（授权预览）` : "打开原文件（授权预览）"}
          </a>
        )}
      </div>
    </div>
  );
}

export function EvidenceViewer({ vm, canPreview, snapshotSource, request }: { vm: ViewModel; canPreview: boolean; snapshotSource?: string | null; request?: unknown }) {
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
        return e ? <EvidenceCard key={id} e={e} active={sel.sourceRefId === id} canPreview={canPreview} snapshotSource={snapshotSource} request={request} /> : <div key={id} className="text-[12px] text-stamp">引用 {id} 无法定位</div>;
      })}
    </div>
  );
}
