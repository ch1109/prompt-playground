"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn, cx } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { FixtureSummary, RunDetail } from "@/lib/client/types";
import { optimizationPrompt } from "@/lib/mcp/task-template";
import type { sessionView } from "@/lib/optimization/service";

// 自动优化（v1.3 §11）的网页部分：字段面板里「让 AI 自动修」的开始表单，与「修改建议」页签顶部的会话进度。
// 每轮由用户启动的 Agent（Claude Code / Codex）执行；轮数、调用次数、停止条件由服务端强制。

export type SessionDTO = ReturnType<typeof sessionView>;

const ACTIVE = (s: SessionDTO) => !["BLOCKED", "NON_PROMPT_ISSUE", "STOPPED", "APPROVED", "REJECTED"].includes(s.status);
const RUNNING = (s: SessionDTO) => ACTIVE(s) && s.status !== "READY_FOR_REVIEW";

const STOP_LABEL: Record<string, string> = {
  MAX_ITERATIONS: "轮数用完",
  NO_PROGRESS: "连续没进展",
  BUDGET_EXHAUSTED: "调用次数用完",
  HARD_REGRESSION: "违反九立硬规则",
  TIMEOUT: "超时",
  CANCELED: "已取消",
  EXPERIMENT_FAILED: "试运行失败",
};

/** 会话状态一句话 */
export function sessionStatusText(s: SessionDTO): string {
  const n = s.rounds.length;
  switch (s.status) {
    case "CREATED":
    case "EVIDENCE_CHECK":
      return "准备中";
    case "DIAGNOSING":
      return "等 AI 诊断";
    case "CANDIDATE_DRAFT":
      return n && !s.rounds[n - 1].experiment_id ? `第 ${n} 轮：等 AI 试运行` : `等 AI 出第 ${n + 1} 轮修改`;
    case "EXPERIMENTING":
    case "EVALUATING":
      return `第 ${n} 轮试运行中`;
    case "READY_FOR_REVIEW":
      return "达标，等你审批";
    case "BLOCKED":
      return "已停：证据不足";
    case "NON_PROMPT_ISSUE":
      return "已停：不是提示词的问题";
    case "STOPPED":
      return `已停：${STOP_LABEL[s.stop_reason ?? ""] ?? "已停止"}`;
    case "APPROVED":
      return "已采纳";
    case "REJECTED":
      return "已拒绝";
  }
}

/** 复制给 Agent 的指令 */
function CopyInstruction({ s }: { s: SessionDTO }) {
  const [copied, setCopied] = useState(false);
  const o = s.objective;
  const text = optimizationPrompt({ sessionId: s.session_id, runId: o.run_id, stage: s.stage, objectRef: o.row_id ? { table_id: o.table_id ?? undefined, row_id: o.row_id, field: o.field ?? undefined } : { json_pointer: o.json_pointer }, expectedValue: o.expected_value });
  return (
    <button
      onClick={() =>
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
      className="text-[11px] text-info hover:underline"
      data-testid="btn-copy-optimization"
      title="粘贴到接入了 MCP（令牌带实验权限）的 Claude Code / Codex，它会按会话一轮轮诊断、修改、试运行"
    >
      {copied ? "已复制" : "复制自动优化指令"}
    </button>
  );
}

/** 字段面板：这个字段标了「错」时，可以开始自动优化；已有进行中的会话就显示它的状态 */
export function AutoFixEntry({ detail, pointer }: { detail: RunDetail; pointer: string }) {
  const run = detail.run;
  const [sessions, setSessions] = useState<SessionDTO[] | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => {
    api<SessionDTO[]>(`/api/optimizations?promptId=${encodeURIComponent(run.prompt_id)}`).then(setSessions, () => setSessions([]));
  }, [run.prompt_id]);
  useEffect(load, [load]);
  if (sessions === null || !run.input_snapshot_id) return null;
  const active = sessions.find(ACTIVE);
  if (active) {
    const mine = active.objective.run_id === run.run_id && active.objective.json_pointer === pointer;
    return (
      <div className="mt-1.5 border-t border-ink-800 pt-1.5 text-[11px]" data-testid="auto-fix" data-state="active">
        <span className="text-ink-400">自动优化：</span>
        {mine ? sessionStatusText(active) : "这个提示词有另一项自动优化在进行"}
        <span className="text-ink-400">（进度见「提示词调试 → 修改建议」）</span>
        {mine && RUNNING(active) && (
          <div>
            <CopyInstruction s={active} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="mt-1.5 border-t border-ink-800 pt-1.5 text-[11px]" data-testid="auto-fix" data-state="idle">
      {!open ? (
        <button onClick={() => setOpen(true)} className="text-info hover:underline" data-testid="btn-auto-fix" title="让 AI 一轮轮诊断、修改提示词并试运行；有上限、会自己停，最后由你决定采不采纳">
          让 AI 自动修
        </button>
      ) : (
        <AutoFixForm detail={detail} pointer={pointer} onCancel={() => setOpen(false)} onStarted={load} />
      )}
    </div>
  );
}

function AutoFixForm({ detail, pointer, onCancel, onStarted }: { detail: RunDetail; pointer: string; onCancel: () => void; onStarted: () => void }) {
  const run = detail.run;
  const target = typeof detail.snapshot?.source_ids?.fixture_id === "string" ? detail.snapshot.source_ids.fixture_id : run.input_snapshot_id;
  const [fixtures, setFixtures] = useState<FixtureSummary[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [rounds, setRounds] = useState(3);
  const [maxRuns, setMaxRuns] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ items: FixtureSummary[] }>(`/api/fixtures?project=${encodeURIComponent(run.project_id)}`).then((r) => setFixtures(r.items), () => setFixtures([]));
  }, [run.project_id]);
  // 同一提示词、能真实运行的其他样本；跑过的排前面（有现成基线，更省调用次数）
  const choices = useMemo(
    () => (fixtures ?? []).filter((f) => f.promptKind === run.prompt_kind && f.detail.runnable && f.id !== target).sort((a, b) => (b.stats?.run_count ?? 0) - (a.stats?.run_count ?? 0)),
    [fixtures, run.prompt_kind, target],
  );
  const perRound = 1 + picked.length;
  const suggested = Math.min(60, perRound * (rounds + 1));
  const budget = maxRuns ?? suggested;

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/optimizations", { json: { runId: run.run_id, jsonPointer: pointer, regressionSamples: picked, maxModelRuns: budget, maxIterations: rounds } });
      onStarted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5" data-testid="auto-fix-form">
      <div className="text-ink-300">回归样本（原本正常的样本，用来检查有没有改坏，至少选一个）</div>
      {fixtures === null ? (
        <div className="text-ink-400">读取样本…</div>
      ) : !choices.length ? (
        <div className="text-stamp">这个提示词没有别的可运行样本，无法检查有没有改坏</div>
      ) : (
        <div className="max-h-32 space-y-0.5 overflow-auto rounded border border-ink-800 p-1">
          {choices.map((f) => (
            <label key={f.id} className="flex items-center gap-1.5" title={f.id}>
              <input type="checkbox" checked={picked.includes(f.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, f.id] : p.filter((x) => x !== f.id)))} aria-label={`回归样本 ${f.title}`} />
              <span className="truncate">{f.title}</span>
              {(f.stats?.run_count ?? 0) > 0 && <span className="text-ink-400">跑过</span>}
            </label>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex items-center gap-1">
          最多
          <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))} aria-label="最多轮数" className="rounded border border-ink-700 bg-ink-900 px-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          轮
        </label>
        <label className="flex items-center gap-1" title={`每轮约调用 ${perRound} 次（目标样本 + 回归样本）；第一轮可能要补跑基线，多用一些`}>
          最多调用模型
          <input type="number" min={1} max={60} value={budget} onChange={(e) => setMaxRuns(Number(e.target.value))} aria-label="最多调用模型次数" className="w-14 rounded border border-ink-700 bg-ink-900 px-1" />次
        </label>
      </div>
      {err && <div className="text-stamp">{err}</div>}
      <div className="flex gap-1.5">
        <Btn tone="outline" onClick={start} disabled={busy || !picked.length || !(budget > 0)} data-testid="btn-start-auto-fix">
          开始
        </Btn>
        <Btn onClick={onCancel}>取消</Btn>
      </div>
    </div>
  );
}

/** 「修改建议」页签顶部：自动优化会话的进度与结论；进行中定时刷新 */
export function OptimizationSessions({ promptId, onProgress }: { promptId: string; onProgress: () => void }) {
  const [list, setList] = useState<SessionDTO[] | null>(null);
  const load = useCallback(() => {
    api<SessionDTO[]>(`/api/optimizations?promptId=${encodeURIComponent(promptId)}`).then(setList, () => setList([]));
  }, [promptId]);
  useEffect(load, [load]);
  const running = list?.some(RUNNING);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      load();
      onProgress();
    }, 3000);
    return () => clearInterval(t);
  }, [running, load, onProgress]);
  if (!list?.length) return null;
  return (
    <div className="space-y-1.5" data-testid="optimization-sessions">
      {list.slice(0, 3).map((s) => (
        <SessionCard key={s.session_id} s={s} onChanged={load} />
      ))}
    </div>
  );
}

function SessionCard({ s, onChanged }: { s: SessionDTO; onChanged: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  async function cancel() {
    try {
      await api(`/api/optimizations/${s.session_id}/cancel`, { method: "POST", json: {} });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  const field = s.objective.row_id ? `${s.objective.row_id} · ${s.objective.field}` : s.objective.json_pointer;
  return (
    <div className={cx("rounded-lg border p-2 text-[12px]", ACTIVE(s) ? "border-info/40 bg-info/[0.04]" : "border-ink-800")} data-testid="optimization-session" data-status={s.status}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-ink-100">自动优化 {field}</span>
        <span data-testid="optimization-status">{sessionStatusText(s)}</span>
        <span className="text-ink-400">
          {s.rounds.length}/{s.budget.max_iterations} 轮 · 已用 {s.budget.used_model_runs}/{s.budget.max_model_runs} 次调用
        </span>
      </div>
      {s.outcome_note && <p className="mt-0.5 text-ink-300">{s.outcome_note}</p>}
      {s.best && !ACTIVE(s) && s.status !== "APPROVED" && <p className="mt-0.5 text-ink-400">最好的一轮是第 {s.best.iteration} 轮，候选在下方，可以照常查看和审批。</p>}
      {err && <p className="text-stamp">{err}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-3">
        {RUNNING(s) && <CopyInstruction s={s} />}
        {RUNNING(s) && (
          <button onClick={cancel} className="text-[11px] text-stamp hover:underline" data-testid="btn-cancel-optimization">
            取消
          </button>
        )}
        {s.rounds.length > 0 && (
          <details className="text-[11px]">
            <summary className="cursor-pointer text-ink-400">各轮情况</summary>
            <ul className="mt-1 space-y-0.5">
              {s.rounds.map((r) => (
                <li key={r.iteration}>
                  第 {r.iteration} 轮 · 候选 <span className="font-mono">{r.candidate_id.slice(-6)}</span> ·{" "}
                  {r.conclusion === null ? (r.experiment_id ? "试运行中" : "还没试运行") : `修好 ${r.fixed} · 变差 ${r.regressed}${r.model_runs !== null ? ` · 调用 ${r.model_runs} 次` : ""}`}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
