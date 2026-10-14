"use client";
import { useMemo } from "react";
import type { RunDetail } from "@/lib/client/types";
import { businessViolations, rulesFor, type RuleViolation } from "@/lib/experiments/business-rules";
import { isWithin } from "@/lib/pipeline/json-pointer";
import { useStudio } from "@/lib/state/studio-store";

// 结果页的「九立硬规则检查」（P3 / P4）：打开结果时用这次的输入对照输出现算，不改任何已保存的数据。
// 没问题一行绿字；有问题逐条列出，点一条就选中对应的表格格子（右侧字段面板随之打开）。

export function RuleCheck({ detail }: { detail: RunDetail }) {
  const { run, request } = detail;
  const select = useStudio((s) => s.select);
  const setStore = useStudio((s) => s.set);
  const rules = rulesFor(run.prompt_kind);
  const violations = useMemo(() => businessViolations(run.prompt_kind, request, run.parsed_json), [run.prompt_kind, request, run.parsed_json]);
  if (!rules.length || run.parsed_json === undefined) return null;
  if (!violations)
    return (
      <p className="px-1 text-[12px] text-ink-400" data-testid="rule-check" data-state="unavailable">
        没法做九立规则检查：这次结果没有对应的输入（例如直接粘贴的输出，或输入快照已删除）。
      </p>
    );

  /** 找到指向同一处输出的表格格子：优先包含这一处的最细格子，其次这一处里面的第一个格子 */
  function locate(v: RuleViolation) {
    const cells = (run.view_model?.tables ?? []).flatMap((t) => t.rows.flatMap((r) => Object.values(r.cells).map((c) => ({ t, c }))));
    const outer = cells.filter(({ c }) => isWithin(v.json_pointer, c.jsonPointer)).sort((a, b) => b.c.jsonPointer.length - a.c.jsonPointer.length)[0];
    const hit = outer ?? cells.find(({ c }) => isWithin(c.jsonPointer, v.json_pointer));
    select(hit ? { tableId: hit.t.id, rowId: hit.c.rowId, fieldKey: hit.c.fieldKey, jsonPointer: hit.c.jsonPointer, sourceRefId: hit.c.sourceRefIds[0] } : { jsonPointer: v.json_pointer });
    setStore("evidenceOpen", true);
  }

  if (!violations.length)
    return (
      <p className="px-1 text-[12px] text-verify" data-testid="rule-check" data-state="pass" title={rules.join("\n")}>
        ✓ 已对照 {rules.length} 条九立硬规则（{rules.slice(0, 2).join("、")}等），都没有违反
      </p>
    );
  return (
    <div className="rounded-lg border border-stamp/30 bg-stamp/[0.05] p-2.5 text-[12px]" data-testid="rule-check" data-state="fail">
      <div className="font-semibold text-stamp">有 {violations.length} 处违反九立硬规则</div>
      <p className="mt-0.5 text-ink-400">这些规则写在九立提示词里，由系统拿这次的输入和输出直接对照得出，不是推测。点一条可定位到对应的格子。</p>
      <ul className="mt-1.5 space-y-1">
        {violations.map((v, i) => (
          <li key={i}>
            <button onClick={() => locate(v)} className="w-full rounded-md px-1.5 py-1 text-left hover:bg-stamp/10" data-testid="rule-violation">
              <span className="font-medium text-stamp">{v.label}</span>
              <span className="text-ink-300">：{v.message}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
