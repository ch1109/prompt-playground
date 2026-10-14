import { createDatasetVersion, goldVersion } from "@/lib/datasets/service";
import type { Diagnosis } from "@/lib/repositories/diagnoses";
import { applyEdits, cancelExperiment, createCandidate, planExperiment, startExperiment, type PromptEdit } from "@/lib/experiments/service";
import { newId } from "@/lib/hash";
import { getCandidate, getExperiment } from "@/lib/repositories/experiments";
import { activeSessions, addEvent, getSession, insertSession, listEvents, listSessions, saveSession, SessionConflictError, type OptimizationSession } from "@/lib/repositories/optimizations";
import { getPrompt, getVersion, stableVersionId } from "@/lib/repositories/prompts";
import { getRun, listAnnotations } from "@/lib/repositories/runs";
import { getSnapshot } from "@/lib/repositories/snapshots";
import { resolveObject } from "@/lib/runs/debug-bundle";
import { RunServiceError } from "@/lib/runs/service";
import { afterDiagnosis, afterRound, assertTransition, isTerminal, type SessionState, type StopReason } from "./state-machine";

// 自动优化会话（v1.3 §11）：用户开始，Agent 按会话一轮轮诊断 → 候选 → 试运行；
// 轮数、调用次数、停止条件全在这里强制，Agent 绕不过。计划见 docs/audit/自动优化开发计划_2026-10-14.md。

export const SESSION_LIMITS = { maxIterations: 5, maxModelRuns: 60, defaultIterations: 3, maxNoProgress: 2, timeoutMinutes: 60 } as const;
/** 单次试运行最多调用模型的次数（与实验服务的硬上限一致） */
const PER_EXPERIMENT_CAP = 20;

const fail = (code: string, message: string, status = 400): never => {
  throw new RunServiceError(code, message, status);
};

const STOP_NOTE: Record<StopReason, string> = {
  MAX_ITERATIONS: "已达到最多轮数，还没有达标",
  NO_PROGRESS: "连续几轮没有进展，不再继续扩大修改",
  BUDGET_EXHAUSTED: "剩余调用次数不够再跑一轮",
  HARD_REGRESSION: "修改后违反了九立硬规则，立即停止",
  TIMEOUT: "超过会话时限",
  CANCELED: "已取消",
  EXPERIMENT_FAILED: "试运行失败",
};

/** 转到下一个状态：校验合法、保存（乐观锁）、记事件 */
function move(s: OptimizationSession, to: SessionState, actor: string, detail: Record<string, unknown> | null = null) {
  assertTransition(s.status, to);
  const from = s.status;
  s.status = to;
  saveSession(s);
  addEvent({ session_id: s.session_id, type: "STATE", from_status: from, to_status: to, actor, detail });
}

function stop(s: OptimizationSession, reason: StopReason, actor: string, note?: string) {
  s.stop_reason = reason;
  s.outcome_note = note ?? STOP_NOTE[reason];
  if (s.status === "EXPERIMENTING") {
    const exp = s.rounds.at(-1)?.experiment_id;
    if (exp) cancelExperiment(exp);
  }
  move(s, "STOPPED", actor, { stop_reason: reason, note: s.outcome_note });
}

/** 读取会话；顺带处理超时，以及服务重启后失败的试运行 */
export function loadSession(id: string): OptimizationSession {
  const s = getSession(id) ?? fail("SESSION_NOT_FOUND", `会话 ${id} 不存在`, 404);
  if (!isTerminal(s.status) && s.status !== "READY_FOR_REVIEW" && Date.now() > Date.parse(s.deadline)) stop(s, "TIMEOUT", "system");
  else if (s.status === "EXPERIMENTING") {
    const exp = getExperiment(s.rounds.at(-1)?.experiment_id ?? "");
    if (exp?.status === "FAILED") stop(s, "EXPERIMENT_FAILED", "system", `试运行失败：${exp.error ?? "原因未知"}`);
  }
  return s;
}

/** 当前状态下 Agent 下一步该做什么（给 get_optimization_session 用） */
export function nextAction(s: OptimizationSession): string {
  switch (s.status) {
    case "DIAGNOSING":
      return "读证据并诊断目标字段，然后用 submit_diagnosis_report 提交（带 session_id）";
    case "CANDIDATE_DRAFT":
      return s.rounds.at(-1) && !s.rounds.at(-1)!.experiment_id
        ? `用 run_experiment 试运行本轮候选 ${s.rounds.at(-1)!.candidate_id}（带 session_id）`
        : `用 create_prompt_candidate 创建第 ${s.rounds.length + 1} 轮候选（带 session_id，基于 ${s.base_version_id}）`;
    case "EXPERIMENTING":
      return "试运行进行中，稍后再用 get_optimization_session 查看";
    case "READY_FOR_REVIEW":
      return "已达标，等人在网页上审批；Agent 不需要再做什么";
    default:
      return "会话已结束，不要再做任何修改";
  }
}

export interface CreateSessionInput {
  runId: string;
  jsonPointer: string;
  regressionSamples: string[];
  maxModelRuns: number;
  maxIterations?: number;
  createdBy: string;
}

/**
 * 开始一次自动优化：要求目标字段已标「错」；自动建数据集版本（目标样本 dev、回归样本 regression），
 * 做证据预检，通过后进入 DIAGNOSING 等 Agent。
 */
export function createSession(input: CreateSessionInput): OptimizationSession {
  const run = getRun(input.runId) ?? fail("RUN_NOT_FOUND", "Run 不存在", 404);
  const prompt = getPrompt(run.prompt_id)!;
  if (activeSessions(prompt.prompt_id).length) fail("SESSION_ACTIVE", "这个提示词已有进行中的自动优化，请先等它结束、审批或取消", 409);
  const ann = listAnnotations(run.run_id)
    .filter((a) => a.target_json_pointer === input.jsonPointer && a.assessment === "WRONG")
    .at(-1) ?? fail("NO_WRONG_ANNOTATION", "这个字段还没有标「错」，先标注再让 AI 修");
  const maxIterations = input.maxIterations ?? SESSION_LIMITS.defaultIterations;
  if (!(Number.isInteger(maxIterations) && maxIterations >= 1 && maxIterations <= SESSION_LIMITS.maxIterations)) fail("BAD_ITERATIONS", `最多轮数要在 1–${SESSION_LIMITS.maxIterations} 之间`);
  if (!(Number.isInteger(input.maxModelRuns) && input.maxModelRuns > 0)) fail("BUDGET_REQUIRED", "必须填写最多调用模型几次");
  if (input.maxModelRuns > SESSION_LIMITS.maxModelRuns) fail("BUDGET_TOO_LARGE", `一次自动优化最多调用模型 ${SESSION_LIMITS.maxModelRuns} 次`);
  if (!run.input_snapshot_id || !getSnapshot(run.input_snapshot_id)) fail("NO_INPUT", "这次结果没有可重跑的输入快照，不能自动优化");
  const snapshot = getSnapshot(run.input_snapshot_id!)!;
  const fixtureId = snapshot.source_ids?.fixture_id;
  const targetSample = typeof fixtureId === "string" ? fixtureId : snapshot.snapshot_id;
  const regression = [...new Set(input.regressionSamples)].filter((x) => x !== targetSample);
  if (!regression.length) fail("NO_REGRESSION", "至少选一个回归样本（原本正常的样本），用来检查有没有改坏");
  const base = stableVersionId(prompt.prompt_id) ?? fail("NO_STABLE_VERSION", "这个提示词还没有正式版本");

  const dataset = createDatasetVersion({
    promptId: prompt.prompt_id,
    name: `自动优化 · ${ann.target ?? input.jsonPointer} · ${new Date().toISOString().slice(0, 10)}`,
    samples: [{ sample_id: targetSample, split: "dev" }, ...regression.map((sample_id) => ({ sample_id, split: "regression" as const }))],
    createdBy: input.createdBy,
  });
  let cell: { table_id: string | null; row_id: string | null; field: string | null } = { table_id: null, row_id: null, field: null };
  try {
    cell = resolveObject(run, { json_pointer: input.jsonPointer });
  } catch {
    // 不对应表格格子（例如结构层面的位置）：只按 JSON 位置定位
  }
  const now = new Date();
  const s: OptimizationSession = {
    session_id: newId("opt"),
    prompt_id: prompt.prompt_id,
    project_id: prompt.project_id,
    status: "CREATED",
    version: 1,
    created_by: input.createdBy,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    objective: { run_id: run.run_id, sample_id: targetSample, snapshot_id: snapshot.snapshot_id, ...cell, json_pointer: input.jsonPointer, annotation_id: ann.annotation_id, expected_value: ann.expected_value },
    dataset: { dataset_id: dataset.dataset_id, version: dataset.version },
    base_version_id: base,
    budget: { max_iterations: maxIterations, max_model_runs: input.maxModelRuns, max_no_progress: SESSION_LIMITS.maxNoProgress, timeout_minutes: SESSION_LIMITS.timeoutMinutes, used_model_runs: 0 },
    deadline: new Date(now.getTime() + SESSION_LIMITS.timeoutMinutes * 60_000).toISOString(),
    rounds: [],
    diagnosis_ids: [],
    best: null,
    no_progress: 0,
    stop_reason: null,
    outcome_note: null,
  };
  insertSession(s);
  addEvent({ session_id: s.session_id, type: "CREATED", from_status: null, to_status: "CREATED", actor: input.createdBy, detail: { dataset: goldVersion(dataset), budget: s.budget } });

  // 证据预检（§11.2 EVIDENCE_CHECK）：输入不完整时不循环运行（§11.3）
  move(s, "EVIDENCE_CHECK", "system");
  if (run.input_manifest && run.input_manifest.complete === false) {
    s.outcome_note = `原件没有完整进入模型（${run.input_manifest.truncation_reason ?? "输入不完整"}），先补齐输入再优化`;
    move(s, "BLOCKED", "system", { note: s.outcome_note });
  } else move(s, "DIAGNOSING", "system");
  return s;
}

/** 会话中的诊断：只有在 DIAGNOSING 时推动状态；必须是目标样本上的诊断 */
export function onSessionDiagnosis(sessionId: string, d: Diagnosis, actor: string): OptimizationSession {
  const s = loadSession(sessionId);
  if (isTerminal(s.status)) fail("SESSION_ENDED", "会话已结束", 409);
  const run = getRun(d.run_id);
  if (run?.input_snapshot_id !== s.objective.snapshot_id) fail("DIAGNOSIS_NOT_ON_TARGET", "诊断的 Run 不是这次自动优化的目标样本");
  s.diagnosis_ids.push(d.diagnosis_id);
  if (s.status !== "DIAGNOSING") {
    saveSession(s);
    addEvent({ session_id: s.session_id, type: "DIAGNOSIS_RECORDED", from_status: s.status, to_status: s.status, actor, detail: { diagnosis_id: d.diagnosis_id } });
    return s;
  }
  const to = afterDiagnosis({ category: d.root_cause_category, result_status: d.result_status });
  if (to !== "CANDIDATE_DRAFT") s.outcome_note = `${to === "BLOCKED" ? "证据不足，未确认根因" : "不是提示词能解决的问题"}：${d.report.root_cause.summary}。建议：${d.report.proposed_change.summary}`;
  move(s, to, actor, { diagnosis_id: d.diagnosis_id, category: d.root_cause_category, result_status: d.result_status });
  return s;
}

/** 会话中的候选：只能在 CANDIDATE_DRAFT、每轮一个、基于会话的基础版本 */
export function createSessionCandidate(input: { sessionId: string; baseVersionId: string; edits: PromptEdit[]; reason: string; diagnosisRef?: string | null; actor: string }) {
  const s = loadSession(input.sessionId);
  if (s.status !== "CANDIDATE_DRAFT") fail("SESSION_STATE", `会话现在是 ${s.status}，不能创建候选：${nextAction(s)}`, 409);
  const last = s.rounds.at(-1);
  if (last && !last.experiment_id) fail("ROUND_NOT_TESTED", `本轮候选 ${last.candidate_id} 还没试运行，先用 run_experiment 跑完`, 409);
  if (s.rounds.length >= s.budget.max_iterations) fail("MAX_ITERATIONS", "已达到最多轮数", 409);
  if (input.baseVersionId !== s.base_version_id) fail("WRONG_BASE_VERSION", `自动优化的每轮候选都要基于 ${s.base_version_id}（会话开始时的正式版本）`);
  const base = getVersion(s.base_version_id)!;
  const text = applyEdits({ system: base.system_prompt, user_template: base.user_prompt_template }, input.edits);
  const created = createCandidate({ promptId: s.prompt_id, baseVersionId: base.version_id, system: text.system, userTemplate: text.user_template, reason: input.reason, diagnosisRef: input.diagnosisRef ?? s.diagnosis_ids.at(-1) ?? null, createdBy: input.actor });
  s.rounds.push({ iteration: s.rounds.length + 1, candidate_id: created.candidate.candidate_id, experiment_id: null, conclusion: null, fixed: null, regressed: null, score: null, model_runs: null });
  saveSession(s);
  addEvent({ session_id: s.session_id, type: "CANDIDATE", from_status: s.status, to_status: s.status, actor: input.actor, detail: { iteration: s.rounds.length, candidate_id: created.candidate.candidate_id } });
  return { session: s, ...created };
}

/** 会话中的试运行：样本固定为目标样本 + 数据集回归层，计入会话预算；完成后自动评判并推进 */
export function startSessionExperiment(input: { sessionId: string; candidateId: string; actor: string; idempotencyKey?: string | null; dryRun?: boolean }) {
  const s = loadSession(input.sessionId);
  const last = s.rounds.at(-1);
  if (last?.experiment_id && last.candidate_id === input.candidateId) {
    const existing = getExperiment(last.experiment_id)!;
    return { session: s, experiment: existing, reused: true, planned_model_runs: existing.budget.planned_model_runs };
  }
  if (s.status !== "CANDIDATE_DRAFT") fail("SESSION_STATE", `会话现在是 ${s.status}，不能试运行：${nextAction(s)}`, 409);
  if (!last || last.candidate_id !== input.candidateId) return fail("NOT_ROUND_CANDIDATE", "只能试运行本轮用 create_prompt_candidate（带 session_id）创建的候选");
  const remaining = s.budget.max_model_runs - s.budget.used_model_runs;
  const experimentInput = { candidateId: input.candidateId, samples: [{ sample_id: s.objective.sample_id, role: "TARGET" as const }], maxModelRuns: Math.max(1, Math.min(remaining, PER_EXPERIMENT_CAP)), datasetRef: goldVersion(s.dataset) };
  let plan;
  try {
    plan = planExperiment(experimentInput);
  } catch (e) {
    if (e instanceof RunServiceError && e.code === "BUDGET_EXCEEDED") fail("SESSION_BUDGET_EXCEEDED", `会话剩余 ${remaining} 次调用，不够跑这一轮：${e.message}`, 409);
    throw e;
  }
  if (input.dryRun) return { session: s, experiment: null, reused: false, planned_model_runs: plan.planned_model_runs, plan };
  const started = startExperiment({ ...experimentInput, createdBy: input.actor, idempotencyKey: input.idempotencyKey ?? null });
  last.experiment_id = started.experiment.experiment_id;
  // 先按计划占用预算，防止并发超支；完成后改成实际用量
  s.budget.used_model_runs += plan.planned_model_runs;
  move(s, "EXPERIMENTING", input.actor, { experiment_id: last.experiment_id, planned_model_runs: plan.planned_model_runs });
  void started.done.then(() => onExperimentDone(s.session_id, started.experiment.experiment_id));
  return { session: s, experiment: started.experiment, reused: started.reused, planned_model_runs: plan.planned_model_runs };
}

/** 试运行结束：EVALUATING → 按每轮评判进入下一轮 / 等人审批 / 停止。会话已被取消或超时就不再处理 */
export function onExperimentDone(sessionId: string, experimentId: string, attempt = 0): OptimizationSession | undefined {
  try {
    const s = loadSession(sessionId);
    const round = s.rounds.at(-1);
    if (s.status !== "EXPERIMENTING" || round?.experiment_id !== experimentId) return s;
    const exp = getExperiment(experimentId)!;
    const plannedRuns = exp.budget.planned_model_runs;
    s.budget.used_model_runs += exp.budget.used_model_runs - plannedRuns;
    round.model_runs = exp.budget.used_model_runs;
    if (exp.status !== "COMPLETED" || !exp.report) {
      stop(s, "EXPERIMENT_FAILED", "system", `试运行失败：${exp.error ?? "没有评判报告"}`);
      return s;
    }
    move(s, "EVALUATING", "system", { experiment_id: experimentId });
    const r = exp.report;
    const decision = afterRound({
      conclusion: r.conclusion,
      fixed: r.counts.fixed,
      regressed: r.counts.regressed,
      hardRegression: r.samples.some((x) => x.hard_gates.length > 0),
      iteration: s.rounds.length,
      maxIterations: s.budget.max_iterations,
      bestScore: s.best?.score ?? null,
      noProgress: s.no_progress,
      maxNoProgress: s.budget.max_no_progress,
      remainingRuns: s.budget.max_model_runs - s.budget.used_model_runs,
      roundRuns: exp.budget.used_model_runs,
    });
    Object.assign(round, { conclusion: r.conclusion, fixed: r.counts.fixed, regressed: r.counts.regressed, score: decision.score });
    if (decision.improved && decision.stop_reason !== "HARD_REGRESSION") s.best = { candidate_id: round.candidate_id, iteration: round.iteration, score: decision.score };
    s.no_progress = decision.noProgress;
    if (decision.next === "STOPPED") stop(s, decision.stop_reason!, "system");
    else {
      if (decision.next === "READY_FOR_REVIEW") s.outcome_note = `第 ${round.iteration} 轮达标，等你审批候选 ${round.candidate_id}`;
      move(s, decision.next, "system", { conclusion: r.conclusion, score: decision.score });
    }
    return s;
  } catch (e) {
    // 并发更新冲突：重新读取再处理（最多 3 次）
    if (e instanceof SessionConflictError && attempt < 3) return onExperimentDone(sessionId, experimentId, attempt + 1);
    throw e;
  }
}

/** 用户取消：停掉进行中的试运行；已完成的运行与候选保留 */
export function cancelSession(sessionId: string, actor: string): OptimizationSession {
  const s = loadSession(sessionId);
  if (isTerminal(s.status)) fail("SESSION_ENDED", "会话已结束", 409);
  if (s.status === "READY_FOR_REVIEW") fail("SESSION_READY", "已达标、等你审批：请直接采纳或拒绝候选", 409);
  stop(s, "CANCELED", actor);
  return s;
}

/** 候选被人采纳 / 拒绝：等审批的会话随之结束；其他会话只记一条事件 */
export function onCandidateDecided(candidateId: string, decision: "APPROVED" | "REJECTED", actor: string) {
  const c = getCandidate(candidateId);
  if (!c) return;
  for (const s of listSessions(c.prompt_id)) {
    if (!s.rounds.some((r) => r.candidate_id === candidateId)) continue;
    if (s.status === "READY_FOR_REVIEW" && s.best?.candidate_id === candidateId) move(s, decision, actor, { candidate_id: candidateId });
    else addEvent({ session_id: s.session_id, type: `CANDIDATE_${decision}`, from_status: s.status, to_status: s.status, actor, detail: { candidate_id: candidateId } });
  }
}

/** 给网页与 Agent 看的会话：状态、预算、各轮、下一步、事件 */
export function sessionView(id: string) {
  const s = loadSession(id);
  return { ...s, stage: getPrompt(s.prompt_id)!.prompt_kind.replace(/^JIULI_/, ""), remaining_model_runs: s.budget.max_model_runs - s.budget.used_model_runs, next_action: nextAction(s), events: listEvents(s.session_id) };
}
