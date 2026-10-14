"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import type { ExperimentReport, SampleEvaluation } from "@/lib/experiments/evaluate";
import type { Experiment, PromptCandidate } from "@/lib/repositories/experiments";
import { Badge, Btn, cx, Empty } from "@/components/ui";
import { Hunks } from "./run-compare";

// 修改建议（v1.3 M3）：AI 根据诊断提出的提示词修改（候选），先在样本上试运行，再由人决定采纳或拒绝。
// 面向新手：先给一句结论和推荐，再给按钮；修改内容、逐样本情况、注意事项都收在「查看详情」里。

type StructuredHunks = Parameters<typeof Hunks>[0]["hunks"];
type ExperimentDTO = Omit<Experiment, "report"> & { report: ExperimentReport | null };
interface CandidateDTO extends PromptCandidate {
  base_label: string;
  diff: { system: StructuredHunks; user_template: StructuredHunks };
  experiments: ExperimentDTO[];
}

const STATUS = { DRAFT: ["等你决定", "warn"], APPROVED: ["已采纳", "ok"], REJECTED: ["已拒绝", "mute"] } as const;
const ADVICE = {
  READY_FOR_REVIEW: { title: "可以采纳", text: "text-verify", box: "border-verify/30 bg-verify/[0.06]" },
  NOT_RECOMMENDED: { title: "建议拒绝", text: "text-stamp", box: "border-stamp/30 bg-stamp/[0.05]" },
  INSUFFICIENT_EVIDENCE: { title: "先别急着采纳", text: "text-risk", box: "border-risk/30 bg-risk/[0.06]" },
} as const;
const ROLE = { TARGET: "要修的", REGRESSION: "用来检查的" } as const;
const VERDICT = { FIXED: ["修好了", "ok"], REGRESSED: ["变差了", "bad"], NO_CHANGE: ["没变化", "mute"], UNDETERMINED: ["需要你看", "info"], INCOMPLETE: ["没跑完", "warn"] } as const;

const firstSentence = (t: string) => {
  const s = t.split(/[。\n]/)[0];
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
};

/** 一个样本的结果，用一句大白话说清楚 */
function sampleSentence(s: SampleEvaluation): string {
  const parts: string[] = [];
  const st = s.structure;
  if (st.change === "FIXED") parts.push(`格式错误从 ${st.baseline_errors === "PARSE_FAILED" ? "无法解析" : `${st.baseline_errors} 处`}变成 0`);
  if (st.change === "REGRESSED" || st.change === "WORSE") parts.push("出现了新的格式错误");
  if (s.source_check?.worse) parts.push(`有 ${s.source_check.candidate!.wrong - s.source_check.baseline!.wrong} 处来源指到了原件里不对的位置`);
  s.hard_gates.forEach((g) => parts.push(g));
  s.annotated_fields.forEach((f) => {
    const name = f.target ?? f.json_pointer;
    if (f.outcome === "FIXED") parts.push(`你标错的「${name}」改对了`);
    if (f.outcome === "REGRESSED") parts.push(`你标为正确的「${name}」被改成了「${f.candidate_value}」`);
  });
  if (s.verdict === "INCOMPLETE") parts.push("模型没跑完，没有结果可比");
  if (s.verdict === "NO_CHANGE") parts.push("输出完全没变");
  if (s.unjudged_diffs.count) parts.push(`另有 ${s.unjudged_diffs.count} 处小变化系统判断不了好坏`);
  return parts.join("；") || "没有发现问题";
}

/** 结论下面那句原因 */
function adviceReason(r: ExperimentReport): string {
  const bad = r.samples.filter((s) => s.verdict === "REGRESSED");
  if (r.conclusion === "NOT_RECOMMENDED") return `有 ${bad.length} 个样本变差了：${bad.map((s) => `${s.sample_id}（${sampleSentence(s)}）`).join("；")}`;
  if (r.conclusion === "READY_FOR_REVIEW")
    return r.unjudged_diff_count ? `要修的问题修好了，检查样本没有发现变差。还有 ${r.unjudged_diff_count} 处小变化系统判断不了，建议点开详情扫一眼。` : "要修的问题修好了，检查样本也没有任何变化。";
  return `证据还不够：${r.reasons.join("；")}`;
}

export function CandidatesTab({ promptId, onVersionsChanged }: { promptId: string; onVersionsChanged: () => void }) {
  const [list, setList] = useState<CandidateDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ candidates: CandidateDTO[] }>(`/api/prompts/${promptId}/candidates`)
      .then((r) => setList(r.candidates))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, [promptId]);
  useEffect(load, [load]);
  // 试运行在后台进行：有进行中的就定时刷新
  const running = list?.some((c) => c.experiments.some((e) => e.status === "RUNNING"));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running, load]);

  return (
    <div className="space-y-2" data-testid="candidates-tab">
      <p className="text-[12px] text-ink-400">AI 根据诊断提出的提示词修改会出现在这里。在你点「采纳」之前，它们不会影响正在用的版本。</p>
      {err && <p className="text-[12px] text-stamp">{err}</p>}
      {list === null ? (
        <p className="text-[12px] text-ink-400">读取中…</p>
      ) : !list.length ? (
        <Empty>还没有修改建议。让 Codex / Claude Code 诊断问题并提出修改，见 docs/MCP接入说明.md 第 7 节。</Empty>
      ) : (
        list.map((c) => (
          <CandidateCard
            key={c.candidate_id}
            c={c}
            onDecided={() => {
              load();
              onVersionsChanged();
            }}
          />
        ))
      )}
    </div>
  );
}

function CandidateCard({ c, onDecided }: { c: CandidateDTO; onDecided: () => void }) {
  const latest = c.experiments[0];
  const report = c.experiments.find((e) => e.status === "COMPLETED")?.report ?? null;
  const advice = report ? ADVICE[report.conclusion] : null;
  const count = (v: SampleEvaluation["verdict"]) => report?.samples.filter((s) => s.verdict === v).length ?? 0;
  return (
    <section className="rounded-lg border border-ink-700 bg-ink-900 p-3 text-[12px]" data-testid="candidate-card" data-candidate-id={c.candidate_id}>
      <div className="flex items-start gap-1.5">
        <Badge tone={STATUS[c.status][1]}>{STATUS[c.status][0]}</Badge>
        <span className="font-medium text-ink-100" title={c.reason}>
          {firstSentence(c.reason)}
        </span>
      </div>

      {latest?.status === "RUNNING" ? (
        <p className="mt-2 text-info">
          正在试运行… 已调用模型 {latest.budget.used_model_runs} / {latest.budget.planned_model_runs} 次
        </p>
      ) : latest?.status === "FAILED" ? (
        <p className="mt-2 text-stamp">试运行失败：{latest.error}</p>
      ) : !report ? (
        <p className="mt-2 text-ink-400">还没有试运行，暂时只能拒绝。</p>
      ) : (
        <div className={cx("mt-2 rounded-md border p-2.5", advice!.box)} data-testid="experiment-conclusion">
          <div className={cx("text-[15px] font-semibold", advice!.text)}>{advice!.title}</div>
          <p className="mt-1 leading-relaxed text-ink-200">{adviceReason(report)}</p>
          <p className="mt-1.5 flex flex-wrap gap-1.5" data-testid="experiment-counts">
            <Badge tone="ok">修好 {count("FIXED")}</Badge>
            <Badge tone="bad">变差 {count("REGRESSED")}</Badge>
            <Badge tone="info">需要你看 {count("UNDETERMINED") + count("INCOMPLETE")}</Badge>
          </p>
        </div>
      )}

      {c.status === "DRAFT" ? (
        <Decision c={c} report={report} onDecided={onDecided} />
      ) : (
        <p className="mt-2 text-[11.5px] text-ink-300">
          {c.decided_by} 于 {c.decided_at?.slice(0, 16).replace("T", " ")} {c.status === "APPROVED" ? "采纳" : "拒绝"}
          {c.decision_note ? `：${c.decision_note}` : ""}
        </p>
      )}

      <details className="mt-2 text-[11.5px]">
        <summary className="cursor-pointer text-ink-400">查看详情（改了哪里 · 每个样本 · 注意事项）</summary>
        <h4 className="mt-2 font-medium text-ink-300">为什么改</h4>
        <p className="text-ink-300">{c.reason}</p>
        <p className="mt-0.5 text-ink-400">
          基于「{c.base_label}」· {c.created_by} 提出于 {c.created_at.slice(0, 16).replace("T", " ")}
          {c.diagnosis_ref ? ` · 诊断 ${c.diagnosis_ref}` : ""}
        </p>
        <h4 className="mt-2 font-medium text-ink-300">改了哪里</h4>
        <Hunks title="System" hunks={c.diff.system} labels={["原来", "修改后"]} />
        {!!c.diff.user_template?.length && <Hunks title="User 模板" hunks={c.diff.user_template} labels={["原来", "修改后"]} />}
        {c.experiments.map((e) => (
          <ExperimentDetail key={e.experiment_id} e={e} />
        ))}
      </details>
    </section>
  );
}

function ExperimentDetail({ e }: { e: ExperimentDTO }) {
  return (
    <div className="mt-2" data-testid="experiment-view">
      <h4 className="font-medium text-ink-300">
        试运行 {e.created_at.slice(5, 16).replace("T", " ")}（用 {e.model}，调用 {e.budget.used_model_runs} 次，上限 {e.budget.max_model_runs} 次）
      </h4>
      {e.report?.samples.map((s) => (
        <div key={s.sample_id} className="mt-1 rounded border border-ink-800 p-1.5" data-testid="experiment-sample" data-verdict={s.verdict}>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={VERDICT[s.verdict][1]}>{VERDICT[s.verdict][0]}</Badge>
            <span className="text-ink-400">{ROLE[s.role]}样本</span>
            <span className="font-mono">{s.sample_id}</span>
          </div>
          <p className="mt-0.5 text-ink-300">{sampleSentence(s)}</p>
          {s.source_check?.candidate_problems.map((p) => (
            <p key={p.json_pointer} className="text-stamp">
              {p.where}：模型说写着「{p.claimed}」，原件{p.actual === null ? "这一格是空的" : `写的是「${p.actual}」`}
            </p>
          ))}
          {!s.comparability.comparable && <p className="text-risk">两次运行条件不同（{s.comparability.reasons.join("、")}），只能参考</p>}
        </div>
      ))}
      {e.report && (
        <ul className="mt-1.5 list-disc pl-4 text-ink-400">
          {e.report.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Decision({ c, report, onDecided }: { c: CandidateDTO; report: ExperimentReport | null; onDecided: () => void }) {
  const [mode, setMode] = useState<"idle" | "approve" | "reject">("idle");
  const [label, setLabel] = useState(`${c.base_label.split(/[\s（(]/)[0]} 修订 ${new Date().toISOString().slice(5, 10)}`);
  const [note, setNote] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const risky = report?.conclusion !== "READY_FOR_REVIEW";
  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/candidates/${c.candidate_id}/${mode}`, { json: mode === "approve" ? { label, note, acknowledge_risks: ack } : { note } });
      onDecided();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  if (mode === "idle")
    return (
      <div className="mt-2 flex gap-1.5" data-testid="candidate-decision">
        <Btn tone={report?.conclusion === "READY_FOR_REVIEW" ? "primary" : "outline"} disabled={!report} onClick={() => setMode("approve")} data-testid="btn-approve-candidate">
          采纳
        </Btn>
        <Btn tone={report?.conclusion === "NOT_RECOMMENDED" ? "danger" : "ghost"} onClick={() => setMode("reject")} data-testid="btn-reject-candidate">
          拒绝
        </Btn>
      </div>
    );
  return (
    <div className="mt-2 space-y-1.5 rounded-md border border-ink-700 p-2" data-testid="candidate-decision">
      {mode === "approve" ? (
        <>
          <p className="text-ink-300">采纳后会保存成一个新版本，并把它设为正在用的正式版本。</p>
          <label className="block text-ink-400">
            新版本名称
            <input value={label} onChange={(e) => setLabel(e.target.value)} aria-label="新版本名称" className="mt-0.5 w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-[12px] text-ink-100" />
          </label>
          {risky && (
            <label className="flex items-start gap-1.5 text-risk">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
              试运行的结论是「{report ? ADVICE[report.conclusion].title : "—"}」，我看过详情，仍然要采纳
            </label>
          )}
        </>
      ) : (
        <p className="text-ink-300">拒绝后正在用的版本不变，这条建议和试运行记录都会保留。</p>
      )}
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="说明（可选）" aria-label="审批说明" className="w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-[12px]" />
      <div className="flex gap-1.5">
        <Btn tone={mode === "approve" ? "primary" : "danger"} disabled={busy || (mode === "approve" && (!label.trim() || (risky && !ack)))} onClick={submit} data-testid="btn-confirm-decision">
          {mode === "approve" ? "确认采纳" : "确认拒绝"}
        </Btn>
        <Btn onClick={() => setMode("idle")} disabled={busy}>
          取消
        </Btn>
      </div>
      {err && <p className="text-stamp">{err}</p>}
    </div>
  );
}
