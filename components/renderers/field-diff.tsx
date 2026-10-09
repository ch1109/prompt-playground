"use client";
import type { ChangeView } from "@/lib/contracts/view-model";
import { FIELD_LABELS } from "@/lib/schemas/common";
import { useStudio } from "@/lib/state/studio-store";
import { Badge, CellValue, cx, Empty, stateTone } from "@/components/ui";

const STATUS_LABEL: Record<string, string> = {
  VERIFIED_CONSISTENT: "已核验一致",
  VERIFIED_UPDATED: "已按规则更新",
  CONFLICT: "冲突",
  MISSING_REQUIRED: "必填缺失",
  NO_EVIDENCE: "未取得证据",
  NOT_CHECKED: "本轮未核验",
};

/** 字段差异 + 只读 Patch 模拟。模拟值与模型声称的 result_value 是不同列，不写盘。 */
export function FieldDiff({ changes, filter }: { changes: ChangeView[]; filter?: (c: ChangeView) => boolean }) {
  const sel = useStudio((s) => s.selection);
  const select = useStudio((s) => s.select);
  const setStore = useStudio((s) => s.set);
  const shown = changes.filter((c) => (filter ? filter(c) : true));
  return (
    <div data-region="field-diff">
      <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-1.5">
        <span className="text-[12px] font-semibold">Patch 预览</span>
        <span className="stamp inline-block rounded-sm border-2 border-stamp px-1.5 font-mono text-[10.5px] font-bold tracking-widest text-stamp">SIMULATION_ONLY</span>
        <span className="text-[11px] text-ink-400">仅内存模拟，禁止写回九立</span>
      </div>
      {shown.length === 0 ? (
        <Empty>没有字段决策</Empty>
      ) : (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-ink-850 text-ink-300">
              <tr>
                {["委托行 · 字段", "决策", "核验状态", "原值（基准）", "模型结果值", "模拟新值", "规则 / 来源"].map((h) => (
                  <th key={h} className="border-b border-ink-700 px-2 py-1 text-left font-medium whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr
                  key={c.id}
                  data-change-id={c.id}
                  onClick={() => {
                    select({ tableId: "fieldDecisions", rowId: c.id, fieldKey: "decision", jsonPointer: c.jsonPointer, sourceRefId: c.sourceRefIds[0] });
                    setStore("evidenceOpen", true);
                  }}
                  className={cx("cursor-pointer border-b border-ink-800 hover:bg-ink-800/60", sel.rowId === c.id && "bg-stamp/[0.07]")}
                >
                  <td className="px-2 py-1 whitespace-nowrap">
                    <span className="font-mono text-ink-400">{c.rowId}</span> · {FIELD_LABELS[c.field] ?? c.field}
                  </td>
                  <td className="px-2 py-1">
                    <Badge tone={stateTone(c.action)}>{c.action}</Badge>
                  </td>
                  <td className="px-2 py-1">
                    <Badge tone={stateTone(c.verificationStatus ?? "")} title={c.verificationStatus}>
                      {STATUS_LABEL[c.verificationStatus ?? ""] ?? c.verificationStatus ?? "—"}
                    </Badge>
                  </td>
                  <td className="px-2 py-1" title={c.beforeOrigin}>
                    {c.beforeOrigin === "未提供基准" ? <span className="text-ink-600">未提供基准</span> : <CellValue value={c.before} />}
                  </td>
                  <td className="px-2 py-1">
                    <CellValue value={c.after} />
                    {Array.isArray(c.candidate) && c.candidate.length > 0 && <div className="text-[11px] text-risk">候选：{c.candidate.map((x) => (typeof x === "object" ? (x as { value?: unknown }).value : x)).join(" / ")}</div>}
                  </td>
                  <td className="px-2 py-1">
                    {c.simulation?.applicable ? (
                      <span className="font-medium text-verify">{String(c.simulation.simulatedValue)}</span>
                    ) : (
                      <span className="text-[11px] text-ink-400">— {c.simulation?.reason}</span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-[11px] text-ink-400">
                    {c.ruleId && <div className="font-mono">{c.ruleId}</div>}
                    {c.sourceRefIds.length ? `${c.sourceRefIds.length} 个来源` : "未提供来源"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
