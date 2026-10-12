"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import type { ExperimentReport, SampleEvaluation } from "@/lib/experiments/evaluate";
import type { Experiment, PromptCandidate } from "@/lib/repositories/experiments";
import { Badge, Btn, cx, Empty } from "@/components/ui";
import { Hunks } from "./run-compare";

// 候选与实验（v1.3 M3）：查看 Agent 创建的隔离候选、修改差异、实验报告，并由人决定采纳或拒绝。
// 正式版本只有在这里点「采纳」才会改变。

type StructuredHunks = Parameters<typeof Hunks>[0]["hunks"];
interface CandidateDTO extends PromptCandidate {
  base_label: string;
  diff: { system: StructuredHunks; user_template: StructuredHunks };
  experiments: (Omit<Experiment, "report"> & { report: ExperimentReport | null })[];
}

const STATUS = { DRAFT: ["待审批", "warn"], APPROVED: ["已采纳", "ok"], REJECTED: ["已拒绝", "mute"] } as const;
const CONCLUSION = { READY_FOR_REVIEW: ["可供人审", "ok"], NOT_RECOMMENDED: ["不建议采纳", "bad"], INSUFFICIENT_EVIDENCE: ["证据不足", "warn"] } as const;
const VERDICT = { FIXED: ["修好", "ok"], REGRESSED: ["退化", "bad"], NO_CHANGE: ["无变化", "mute"], UNDETERMINED: ["有差异·未判定", "info"], INCOMPLETE: ["没跑完", "warn"] } as const;
const STRUCTURE = { FIXED: "结构错误已消除", IMPROVED: "结构错误减少", SAME: "结构不变", WORSE: "结构错误增加", REGRESSED: "出现结构错误", INCOMPLETE: "没有结果" } as const;
const FIELD = { FIXED: "改对了", NOT_FIXED: "没改对", CHANGED_UNVERIFIED: "变了·无法确认", KEPT: "保持正确", REGRESSED: "改坏了" } as const;

const errs = (n: number | string | null) => (n === null ? "—" : n === "PARSE_FAILED" ? "无法解析" : `${n} 处`);

export function CandidatesTab({ promptId, onVersionsChanged }: { promptId: string; onVersionsChanged: () => void }) {
  const [list, setList] = useState<CandidateDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ candidates: CandidateDTO[] }>(`/api/prompts/${promptId}/candidates`)
      .then((r) => setList(r.candidates))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, [promptId]);
  useEffect(load, [load]);
  // 实验在后台运行：有运行中的实验时定时刷新
  const running = list?.some((c) => c.experiments.some((e) => e.status === "RUNNING"));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running, load]);

  return (
    <div className="space-y-2" data-testid="candidates-tab">
      <p className="text-[11.5px] text-ink-400">
        候选是基础版本的隔离副本，通常由 Agent 根据诊断创建并在固定样本上实验。候选不会出现在版本列表里，也不会影响正式版本；只有你在这里点「采纳」，才会生成新版本并设为正式版本。
      </p>
      {err && <p className="text-[12px] text-stamp">{err}</p>}
      {list === null ? (
        <p className="text-[12px] text-ink-400">读取中…</p>
      ) : !list.length ? (
        <Empty>还没有候选。接入 MCP 并带上实验权限后，Agent 可以创建候选（见 docs/MCP接入说明.md）。</Empty>
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
  const latest = c.experiments.find((e) => e.status === "COMPLETED");
  return (
    <details className="rounded-lg border border-ink-700 bg-ink-900 p-2.5 text-[12px]" data-testid="candidate-card" data-candidate-id={c.candidate_id} open={c.status === "DRAFT"}>
      <summary className="cursor-pointer">
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <Badge tone={STATUS[c.status][1]}>{STATUS[c.status][0]}</Badge>
          {latest?.report && <Badge tone={CONCLUSION[latest.report.conclusion][1]}>{CONCLUSION[latest.report.conclusion][0]}</Badge>}
          <span className="font-medium text-ink-100">{c.reason}</span>
        </span>
      </summary>
      <p className="mt-1 text-[11px] text-ink-400">
        基于「{c.base_label}」· 由 {c.created_by} 创建于 {c.created_at.slice(0, 16).replace("T", " ")}
        {c.diagnosis_ref ? ` · 关联诊断 ${c.diagnosis_ref}` : ""} · <span className="font-mono">{c.candidate_id}</span>
      </p>
      {c.status !== "DRAFT" && (
        <p className="mt-1 text-[11px] text-ink-300">
          {c.decided_by} 于 {c.decided_at?.slice(0, 16).replace("T", " ")} {c.status === "APPROVED" ? "采纳" : "拒绝"}
          {c.decision_note ? `：${c.decision_note}` : ""}
        </p>
      )}
      <div className="mt-2">
        <Hunks title="System 修改" hunks={c.diff.system} labels={["基础版本", "候选"]} />
        {!!c.diff.user_template?.length && <Hunks title="User 模板修改" hunks={c.diff.user_template} labels={["基础版本", "候选"]} />}
      </div>
      {!c.experiments.length ? (
        <p className="text-[11.5px] text-ink-400">尚未做实验。没有完成的实验不能采纳。</p>
      ) : (
        c.experiments.map((e) => <ExperimentView key={e.experiment_id} e={e} />)
      )}
      {c.status === "DRAFT" && <Decision c={c} report={latest?.report ?? null} onDecided={onDecided} />}
    </details>
  );
}

function ExperimentView({ e }: { e: CandidateDTO["experiments"][number] }) {
  const r = e.report;
  return (
    <div className="mt-2 rounded-md border border-ink-700 p-2" data-testid="experiment-view">
      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
        <span className="font-medium">实验 {e.experiment_id.slice(-6)}</span>
        <Badge tone={e.status === "COMPLETED" ? "ok" : e.status === "FAILED" ? "bad" : "info"}>{e.status === "RUNNING" ? "运行中" : e.status === "COMPLETED" ? "已完成" : "失败"}</Badge>
        <span className="text-ink-400">
          调用模型 {e.budget.used_model_runs} / 计划 {e.budget.planned_model_runs} / 上限 {e.budget.max_model_runs} 次 · 模型 {e.model} · 由 {e.created_by} 发起
        </span>
      </div>
      {e.error && <p className="mt-1 text-stamp">{e.error}</p>}
      {r && (
        <>
          <p className="mt-1.5" data-testid="experiment-conclusion">
            <Badge tone={CONCLUSION[r.conclusion][1]}>{CONCLUSION[r.conclusion][0]}</Badge>{" "}
            <span className="text-ink-300">{r.reasons.length ? r.reasons.join("；") : "目标样本全部修好，回归样本没有已知退化"}</span>
          </p>
          <table className="mt-1.5 w-full text-[11px]">
            <thead className="text-left text-ink-400">
              <tr>
                <th className="py-0.5 font-normal">样本</th>
                <th className="font-normal">结构（基线 → 候选）</th>
                <th className="font-normal">判定</th>
              </tr>
            </thead>
            <tbody>
              {r.samples.map((s) => (
                <SampleRow key={s.sample_id} s={s} />
              ))}
            </tbody>
          </table>
          <ul className="mt-1.5 list-disc pl-4 text-[11px] text-ink-400">
            {r.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SampleRow({ s }: { s: SampleEvaluation }) {
  return (
    <tr className="border-t border-ink-800 align-top" data-testid="experiment-sample" data-verdict={s.verdict}>
      <td className="py-1 pr-2">
        <span className="font-mono">{s.sample_id}</span> <Badge tone={s.role === "TARGET" ? "info" : "mute"}>{s.role === "TARGET" ? "目标" : "回归"}</Badge>
        {!s.comparability.comparable && <div className="text-risk">不可比：{s.comparability.reasons.join("、")}</div>}
        {s.hard_gates.map((g) => (
          <div key={g} className="text-stamp">
            硬闸门：{g}
          </div>
        ))}
        {s.annotated_fields.map((f) => (
          <div key={f.annotation_id} className={cx("text-ink-300", f.outcome === "REGRESSED" && "text-stamp")}>
            {f.target ?? f.json_pointer}：{f.baseline_value} → {f.candidate_value}（{FIELD[f.outcome]}）
          </div>
        ))}
        {!!s.unjudged_diffs.count && <div className="text-ink-400">另有 {s.unjudged_diffs.count} 处输出差异未判定</div>}
      </td>
      <td className="pr-2">
        {errs(s.structure.baseline_errors)} → {errs(s.structure.candidate_errors)}
        <div className="text-ink-400">{STRUCTURE[s.structure.change]}</div>
      </td>
      <td>
        <Badge tone={VERDICT[s.verdict][1]}>{VERDICT[s.verdict][0]}</Badge>
      </td>
    </tr>
  );
}

function Decision({ c, report, onDecided }: { c: CandidateDTO; report: ExperimentReport | null; onDecided: () => void }) {
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const risky = report?.conclusion !== "READY_FOR_REVIEW";
  async function decide(kind: "approve" | "reject") {
    if (kind === "approve" && !window.confirm(`采纳后会生成新版本「${label}」并设为正式版本。确定？`)) return;
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/candidates/${c.candidate_id}/${kind}`, { json: kind === "approve" ? { label, note, acknowledge_risks: ack } : { note } });
      onDecided();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-2 space-y-1.5 border-t border-ink-700 pt-2" data-testid="candidate-decision">
      {!report && <p className="text-[11.5px] text-risk">还没有完成的实验，暂时只能拒绝。</p>}
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="采纳后的新版本名称，如 v3.0-fix2 column 必须为字母" aria-label="新版本名称" className="w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-[12px]" />
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="审批说明（可选）" aria-label="审批说明" className="w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-[12px]" />
      {report && risky && (
        <label className="flex items-center gap-1.5 text-[11.5px] text-risk">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          实验结论不是「可供人审」，我已看过报告并了解风险
        </label>
      )}
      <div className="flex gap-1.5">
        <Btn tone="primary" disabled={busy || !report || !label.trim() || (risky && !ack)} onClick={() => decide("approve")} data-testid="btn-approve-candidate">
          采纳为正式版本
        </Btn>
        <Btn tone="danger" disabled={busy} onClick={() => decide("reject")} data-testid="btn-reject-candidate">
          拒绝
        </Btn>
      </div>
      {err && <p className="text-[12px] text-stamp">{err}</p>}
    </div>
  );
}
