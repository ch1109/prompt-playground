"use client";
import type { StructuredPatchHunk } from "diff";
import { useEffect, useMemo, useState } from "react";
import { api, getLayout } from "@/lib/client/api";
import type { RunDetail } from "@/lib/client/types";
import { Badge, Btn, cx } from "@/components/ui";
import { compareRuns, diffSummary, type DiffRow } from "@/lib/runs/compare";
import { compareVerdict, type VerdictField } from "@/lib/runs/compare-verdict";
import type { Annotation } from "@/lib/repositories/runs";
import { applyLayout } from "@/lib/layouts/apply";
import type { Layout } from "@/lib/layouts/types";
import { LayoutView } from "@/components/views/layout-view";

export { compareRuns, diffJson, diffSummary, flatten, inputComparability, strictConditions, textHunks } from "@/lib/runs/compare";

const OUTCOME_LABEL: Record<VerdictField["outcome"], string> = { FIXED: "修好了", REGRESSED: "变差了", CHANGED_UNVERIFIED: "需要你看", NOT_FIXED: "还没修好", KEPT: "保持正确" };
const ASSESSMENT_LABEL: Record<string, string> = { CORRECT: "对", WRONG: "错" };

const KIND_LABEL: Record<DiffRow["kind"], string> = { ADDED: "新增", REMOVED: "删除", CHANGED: "变化", UNALIGNED: "无法对齐" };

/** labels：差异两侧的叫法（默认 A / B） */
export function Hunks({ title, hunks, labels = ["A", "B"] }: { title: string; hunks: StructuredPatchHunk[] | null; labels?: [string, string] }) {
  return (
    <div className="mb-3">
      <h4 className="mb-1.5 text-[12.5px] font-semibold text-ink-100">{title}</h4>
      {hunks === null ? (
        <p className="text-[12px] text-ink-400">至少一方没有记录实际发送的提示词（例如「仅渲染」的 Run），无法对比。</p>
      ) : hunks.length === 0 ? (
        <p className="text-[12px] text-verify">完全相同</p>
      ) : (
        <pre className="overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-2 text-[11.5px] leading-5" data-testid="prompt-diff">
          {hunks.map((h, i) => (
            <div key={i}>
              <div className="text-info">{`@@ ${labels[0]} 第 ${h.oldStart} 行 / ${labels[1]} 第 ${h.newStart} 行 @@`}</div>
              {h.lines.map((l, j) => (
                <div key={j} className={cx("whitespace-pre-wrap break-all", l[0] === "+" && "bg-verify/10 text-verify", l[0] === "-" && "bg-stamp/10 text-stamp", l[0] === " " && "text-ink-400")}>
                  {l}
                </div>
              ))}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

/** 手动并排对比两次历史 Run 的 JSON（轻量对比，不是带准确率的正式评测） */
/** 嵌在「版本对比」模式页面里显示。inline 已不再使用（组件只有内嵌形态），保留为可选仅为兼容调用方 */
export function RunCompare({ ids, onClose }: { ids: [string, string]; onClose: () => void; inline?: boolean }) {
  const [ra, setA] = useState<RunDetail | null>(null);
  const [rb, setB] = useState<RunDetail | null>(null);
  // 不管先勾选哪一条，较早的那次运行当 A（旧）、较晚的当 B（新），这样「修好 / 变差」的方向不会反
  const [a, b] = ra && rb && ra.run.started_at > rb.run.started_at ? [rb, ra] : [ra, rb];
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    const fail = () => setFailed(true);
    api<RunDetail>(`/api/runs/${ids[0]}`).then(setA).catch(fail);
    api<RunDetail>(`/api/runs/${ids[1]}`).then(setB).catch(fail);
  }, [ids]);
  // 通用提示词设置过版式时，把两次结果按版式并排显示（业务人员先看这个；下面的 JSON 差异留给排查）
  const [layout, setLayout] = useState<Layout | null>(null);
  const promptId = a?.run.prompt_id;
  useEffect(() => {
    setLayout(null);
    if (promptId && a?.run.prompt_kind === "GENERIC_JSON") getLayout(promptId).then((r) => setLayout(r.layout?.layout ?? null)).catch(() => {});
  }, [promptId, a?.run.prompt_kind]);
  const sideBySide = layout && a?.run.parsed_json !== undefined && b?.run.parsed_json !== undefined ? ([a, b] as const).map((d) => applyLayout(layout, d.run.parsed_json)) : null;
  const diff = useMemo(() => (a && b ? diffSummary(a.run.parsed_json ?? a.run.raw_response, b.run.parsed_json ?? b.run.raw_response) : { rows: [], same: 0 }), [a, b]);
  const rows = diff.rows;
  const count = (k: DiffRow["kind"]) => rows.filter((r) => r.kind === k).length;
  const cmp = useMemo(() => (a && b ? compareRuns(a.run, b.run, [a.prompt_version_label, b.prompt_version_label]) : null), [a, b]);
  const verdict = useMemo(() => (a && b ? compareVerdict(a.run, b.run, a.annotations as unknown as Annotation[]) : null), [a, b]);
  return (
    <div role="region" aria-label="对比两次运行">
      <div className="flex w-full flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-ink-800 px-4 py-2.5">
          <span className="text-[12.5px] font-semibold tracking-tight">运行对比</span>
          <RunTag side="A" d={a} id={ids[0]} />
          <span className="text-ink-600">→</span>
          <RunTag side="B" d={b} id={ids[1]} />
          <Btn className="ml-auto" onClick={onClose}>
            清除选择
          </Btn>
        </div>
        <div className="space-y-4 overflow-auto px-5 py-4">
          {cmp && (
            <>
              {verdict && (
                <div data-testid="compare-verdict">
                  <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                    <Badge tone="ok">修好 {verdict.fixed}</Badge>
                    <Badge tone="bad">变差 {verdict.regressed}</Badge>
                    <Badge tone="warn">需要你看 {verdict.needsReview}</Badge>
                    <span className="text-[11px] text-ink-400">按 A 上你标过的字段判断</span>
                  </div>
                  <details className="mt-1.5 text-[12px]">
                    <summary className="cursor-pointer text-ink-300">查看是哪些字段</summary>
                    <table className="mt-1.5 w-full text-[11.5px]">
                      <thead className="text-ink-400">
                        <tr>
                          <th className="px-2 py-1 text-left font-medium">字段</th>
                          <th className="px-2 py-1 text-left font-medium">你标的</th>
                          <th className="px-2 py-1 text-left font-medium">A</th>
                          <th className="px-2 py-1 text-left font-medium">B</th>
                          <th className="px-2 py-1 text-left font-medium">结论</th>
                        </tr>
                      </thead>
                      <tbody>
                        {verdict.fields.map((f) => (
                          <tr key={f.pointer} className="border-b border-ink-800 align-top">
                            <td className="px-2 py-1 break-all" title={f.pointer}>
                              {f.target ?? f.pointer}
                            </td>
                            <td className="px-2 py-1 break-all">
                              {ASSESSMENT_LABEL[f.assessment ?? ""] ?? f.assessment}
                              {f.expected ? `，正确值：${f.expected}` : ""}
                            </td>
                            <td className="px-2 py-1 break-all">{f.a}</td>
                            <td className="px-2 py-1 break-all">{f.b}</td>
                            <td className="px-2 py-1">{OUTCOME_LABEL[f.outcome]}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                </div>
              )}
              {!cmp.input.comparable && (
                <div className="rounded-xl border border-stamp/30 bg-stamp/[0.06] px-4 py-2.5 text-[12px] text-stamp" data-testid="input-not-comparable">
                  <div className="font-semibold">输入不可直接比较：只能看技术差异，不能作为提示词改进的依据</div>
                  {cmp.input.reasons.map((r) => (
                    <div key={r}>· {r}</div>
                  ))}
                </div>
              )}
              <div
                data-testid="strict-verdict"
                className={cx("rounded-xl border px-4 py-2.5 text-[12px]", !cmp.strict.applicable ? "border-ink-700 text-ink-300" : cmp.strict.strict ? "border-verify/25 bg-verify/[0.05] text-verify" : "border-risk/30 bg-risk/[0.06] text-risk")}
              >
                <div className="font-semibold">
                  {!cmp.strict.applicable ? "不适用严格同条件对比" : cmp.strict.strict ? "✓ 满足严格同条件：同一输入、图片、预处理、构造器、模型与参数" : "✗ 不满足严格同条件对比：输出差异不能只归因于提示词"}
                </div>
                {cmp.strict.reasons.map((r) => (
                  <div key={r}>· {r}</div>
                ))}
                <div className="mt-1 text-[11px] text-ink-400">差异数 ≠ 错误数。没有标准答案时只展示差异，不计算正确率、修复或退化。</div>
              </div>
              {sideBySide && (
                <div data-testid="compare-layout">
                  <h4 className="mb-1.5 text-[12.5px] font-semibold text-ink-100">两次结果（按版式）</h4>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {sideBySide.map((r, i) => (
                      <div key={i} className="min-w-0">
                        <div className="mb-1 text-[11px] text-ink-400">{i === 0 ? "A（较早）" : "B（较晚）"}</div>
                        <LayoutView result={r} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {cmp.system?.length === 0 && cmp.user?.length === 0 ? (
                <p className="text-[12px] text-ink-400">
                  提示词：<span className="text-verify">两次完全相同</span>（System 提示词与 User 消息）
                </p>
              ) : (
                <div>
                  <Hunks title="System 提示词差异" hunks={cmp.system} />
                  <Hunks title="User 消息差异（含构造输入）" hunks={cmp.user} />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]" data-testid="diff-counts">
                <h4
                  className="mr-1 text-[12.5px] font-semibold text-ink-100"
                  title="行按业务键对齐（委托行 ID、字段名、原文位置等，路径中显示为 [键=值]）；对象数组找不到可靠的键时标为「无法对齐」，不按行号硬配。"
                >
                  输出 JSON 差异
                </h4>
                <Badge tone="ok">新增 {count("ADDED")}</Badge>
                <Badge tone="bad">删除 {count("REMOVED")}</Badge>
                <Badge tone="warn">变化 {count("CHANGED")}</Badge>
                <Badge>一致 {diff.same}</Badge>
                <Badge tone="info">无法对齐 {count("UNALIGNED")}</Badge>
              </div>
            </>
          )}
          {failed ? (
            <p className="text-stamp">读取失败，请重试。</p>
          ) : !a || !b ? (
            <p className="text-ink-400">加载中…</p>
          ) : rows.length === 0 ? (
            <p className="text-verify">两次输出完全一致</p>
          ) : (
            <table className="w-full font-mono text-[11.5px]">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.pointer + r.kind} className="border-b border-ink-800">
                    <td className="w-20 py-1">
                      <Badge tone={r.kind === "ADDED" ? "ok" : r.kind === "REMOVED" ? "bad" : r.kind === "UNALIGNED" ? "info" : "warn"}>{KIND_LABEL[r.kind]}</Badge>
                    </td>
                    <td className="w-[38%] py-1 pr-3 break-all text-ink-300">{r.pointer}</td>
                    <td className={cx("py-1 pr-3 break-all", r.a !== undefined && "text-stamp")}>{r.a ?? ""}</td>
                    <td className={cx("py-1 break-all", r.b !== undefined && "text-verify")}>{r.b ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {cmp && (
            <details className="rounded-xl border border-ink-700 text-[12px]">
              <summary className="cursor-pointer px-4 py-2.5 font-semibold text-ink-100">
                运行参数对比
                <span className="ml-2 font-normal text-ink-400">{cmp.metrics.filter((m) => m.differs).length} 项不同 · 状态、模型、指纹、token、耗时等</span>
              </summary>
              <table className="w-full border-t border-ink-800 text-[12px]" data-testid="compare-metrics">
                <thead className="text-ink-400">
                  <tr>
                    <th className="w-36 px-4 py-1.5 text-left font-medium">指标</th>
                    <th className="px-2 py-1.5 text-left font-medium">A</th>
                    <th className="px-2 py-1.5 text-left font-medium">B</th>
                  </tr>
                </thead>
                <tbody>
                  {cmp.metrics.map((m) => (
                    <tr key={m.key} className={cx("border-t border-ink-800", m.differs && "bg-risk/[0.06]")}>
                      <td className="px-4 py-1 text-ink-400">{m.label}</td>
                      <td className="px-2 py-1 font-mono break-all">{m.a}</td>
                      <td className="px-2 py-1 font-mono break-all">{m.b}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

/** 对比头部的一侧：运行时间 + 提示词版本；Run ID 只放在悬停提示里 */
function RunTag({ side, d, id }: { side: "A" | "B"; d: RunDetail | null; id: string }) {
  return (
    <span
      title={`${side === "A" ? "A：较早的那次" : "B：较晚的那次"}\n${d?.run.label ?? ""}\n${id}`}
      className="inline-flex max-w-[360px] items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-2 py-0.5 text-[11.5px]"
    >
      <span className="font-semibold">{side}</span>
      <span className="truncate text-ink-300">{d ? `${d.run.started_at.slice(5, 16).replace("T", " ")} · ${d.prompt_version_label ?? "未记录版本"}` : "加载中…"}</span>
    </span>
  );
}
