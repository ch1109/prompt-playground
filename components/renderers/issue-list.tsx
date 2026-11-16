"use client";
import { useMemo, useState } from "react";
import type { IssueView } from "@/lib/contracts/view-model";
import { ISSUE_VERDICT_LABEL, issueIdOfTarget } from "@/lib/client/types";
import { useStudio } from "@/lib/state/studio-store";
import { Badge, cx, Empty } from "@/components/ui";

const ORIGIN_LABEL: Record<IssueView["origin"], string> = {
  MODEL_FINDING: "模型发现",
  SCHEMA: "结构",
  ADAPTER: "适配器",
  RULE: "规则",
  ANNOTATION: "标注",
};
const SEV_TONE = { BLOCKER: "bad", WARNING: "warn", INFO: "info", UNKNOWN: "mute" } as const;
const SEV_LABEL: Record<keyof typeof SEV_TONE, string> = { BLOCKER: "严重", WARNING: "提醒", INFO: "提示", UNKNOWN: "未分级" };

export function IssueList({ issues }: { issues: IssueView[] }) {
  const sel = useStudio((s) => s.selection);
  const select = useStudio((s) => s.select);
  const setStore = useStudio((s) => s.set);
  // 标过「属实 / 误报」的问题：id -> issue_type
  const verdicts = useStudio((s) => (s.selection.runId ? s.runs[s.selection.runId]?.annotations : undefined));
  const verdictOf = useMemo(() => new Map((verdicts ?? []).filter((a) => a.issue_type in ISSUE_VERDICT_LABEL).map((a) => [issueIdOfTarget(a.target), a.issue_type])), [verdicts]);
  const [origin, setOrigin] = useState<string>("ALL");
  const origins = useMemo(() => [...new Set(issues.map((i) => i.origin))], [issues]);
  const shown = issues.filter((i) => origin === "ALL" || i.origin === origin);
  const pick = (i: IssueView) => {
    select({ issueId: i.id, tableId: i.target?.tableId, rowId: i.target?.rowId, fieldKey: i.target?.fieldKey, jsonPointer: i.target?.jsonPointer, sourceRefId: i.sourceRefIds[0] });
    setStore("evidenceOpen", true);
  };

  return (
    <div data-region="issues">
      {origins.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-ink-700 px-3 py-1.5">
          <Badge>{issues.length}</Badge>
          {["ALL", ...origins].map((o) => (
            <button key={o} onClick={() => setOrigin(o)} className={cx("rounded-md px-2 py-0.5 text-[11.5px]", origin === o ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:text-ink-100")}>
              {o === "ALL" ? "全部" : ORIGIN_LABEL[o as IssueView["origin"]]}
            </button>
          ))}
        </div>
      )}
      {shown.length === 0 ? (
        <Empty>没有问题记录</Empty>
      ) : (
        <ul className="max-h-72 divide-y divide-ink-800 overflow-auto">
          {shown.map((i) => {
            const verdict = verdictOf.get(i.id);
            return (
            <li key={i.id} className="group relative">
              <button
                data-issue-id={i.id}
                onClick={() => pick(i)}
                title={i.target?.rowId ? `定位：${i.target.rowId}${i.target.fieldKey ? " / " + i.target.fieldKey : ""}` : "没有具体位置（一般提醒）"}
                className={cx("flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-ink-800/60", sel.issueId === i.id && "bg-accent/[0.07]")}
              >
                {/* 模型没给严重度时不贴「未分级」，避免每条都挂同一个标签 */}
                {i.severity && i.severity !== "UNKNOWN" && (
                  <Badge tone={SEV_TONE[i.severity]} title={`严重度：${i.severity}`}>
                    {SEV_LABEL[i.severity]}
                  </Badge>
                )}
                {verdict && (
                  <span data-testid="issue-verdict">
                    <Badge tone={verdict === "ISSUE_FALSE_POSITIVE" ? "mute" : "ok"}>{ISSUE_VERDICT_LABEL[verdict]}</Badge>
                  </span>
                )}
                <span className={cx("min-w-0 flex-1", verdict === "ISSUE_FALSE_POSITIVE" && "opacity-50")}>
                  <span className="break-words" title={`类型：${i.type}`}>{i.summary}</span>
                  {i.detail && <span className="block text-[11px] text-ink-400">{i.detail}</span>}
                  <span className="block text-[10.5px] text-ink-600">
                    {ORIGIN_LABEL[i.origin]}
                    {i.sourceRefIds.length ? ` · ${i.sourceRefIds.length} 个来源` : ""}
                  </span>
                </span>
              </button>
              <span className="absolute top-1 right-2 hidden gap-1 group-hover:flex">
                {i.target?.jsonPointer !== undefined && (
                  <button onClick={() => (pick(i), setStore("resultTab", "json"))} className="rounded bg-ink-900 px-1.5 text-[10.5px] text-info shadow-sm hover:underline">
                    查看 JSON 位置
                  </button>
                )}
                <button onClick={() => pick(i)} className="rounded bg-ink-900 px-1.5 text-[10.5px] text-info shadow-sm hover:underline">
                  查看来源
                </button>
              </span>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
