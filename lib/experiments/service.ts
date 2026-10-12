import type { ModelParams, Run } from "@/lib/contracts/run";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { newId, sha256, stableStringify } from "@/lib/hash";
import { buildInput, unresolvedVariables } from "@/lib/input-builders";
import { getProvider } from "@/lib/models/openai-compatible";
import {
  annotationsForSample,
  decideCandidate,
  findBaselineRun,
  getCandidate,
  getExperiment,
  getExperimentByKey,
  insertCandidate,
  insertExperiment,
  listExperiments,
  updateExperiment,
  type Experiment,
  type ExperimentSample,
  type PromptCandidate,
} from "@/lib/repositories/experiments";
import { contentHash, createVersion, getPrompt, getVersion, setStableVersion, stableVersionId } from "@/lib/repositories/prompts";
import { getRun } from "@/lib/repositories/runs";
import { getSnapshot } from "@/lib/repositories/snapshots";
import { textHunks } from "@/lib/runs/compare";
import { modelRun, RunServiceError } from "@/lib/runs/service";
import { evaluateSample, summarize } from "./evaluate";

// 候选与实验（v1.3 §10）：候选是基础版本的隔离副本；实验在固定样本上跑候选（缺基线时也跑基线），
// 只生成新 Run，不改历史、不动正式版本。正式版本只能由人工采纳移动（approveCandidate，只在网页上提供）。

/** 单次实验最多调用模型的次数（服务端硬上限，§11.3） */
export const MAX_EXPERIMENT_RUNS = 20;
const DEFAULT_PARAMS: ModelParams = { temperature: 0 };

const fail = (code: string, message: string, status = 400): never => {
  throw new RunServiceError(code, message, status);
};

export function createCandidate(input: { promptId: string; baseVersionId: string; system: string; userTemplate: string; reason: string; diagnosisRef?: string | null; createdBy: string }) {
  const prompt = getPrompt(input.promptId) ?? fail("PROMPT_NOT_FOUND", "提示词不存在", 404);
  const base = getVersion(input.baseVersionId);
  if (!base || base.prompt_id !== prompt.prompt_id) fail("VERSION_NOT_FOUND", "基础版本不存在，或不属于这个提示词", 404);
  if (!input.system.trim()) fail("CANDIDATE_EMPTY", "候选的 system 提示词不能为空");
  if (!input.reason.trim()) fail("REASON_REQUIRED", "必须写明修改原因（对应哪个诊断 / 错误）");
  const hash = contentHash(input.system, input.userTemplate);
  if (hash === base!.content_hash) fail("CANDIDATE_UNCHANGED", "候选与基础版本完全相同");
  const bad = unresolvedVariables(input.system, input.userTemplate);
  if (bad.length) fail("UNKNOWN_VARIABLES", `模板里有未登记的变量：${bad.join("、")}`);
  if (!input.userTemplate.includes("{{input_json}}")) fail("INPUT_VARIABLE_MISSING", "user 模板必须包含 {{input_json}}，否则模型收不到输入");
  const c: PromptCandidate = {
    candidate_id: newId("cand"),
    prompt_id: prompt.prompt_id,
    base_version_id: base!.version_id,
    system_prompt: input.system,
    user_prompt_template: input.userTemplate,
    content_hash: hash,
    reason: input.reason.trim(),
    diagnosis_ref: input.diagnosisRef?.trim() || null,
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
    status: "DRAFT",
    decided_by: null,
    decided_at: null,
    decision_note: null,
    promoted_version_id: null,
  };
  insertCandidate(c);
  return { candidate: c, diff: candidateDiff(c) };
}

export interface PromptEdit {
  part?: "system" | "user_template";
  find: string;
  replace: string;
}

/**
 * 按「查找 → 替换」生成候选文本（最小范围 Diff，§10.2）：每段 find 必须在当前文本里恰好出现一次，
 * 找不到或出现多次都拒绝，避免改错位置。
 */
export function applyEdits(base: { system: string; user_template: string }, edits: PromptEdit[]) {
  if (!edits.length) fail("NO_EDITS", "至少要有一处修改");
  const out = { ...base };
  edits.forEach((e, i) => {
    const part = e.part ?? "system";
    if (!e.find) fail("EDIT_FIND_EMPTY", `第 ${i + 1} 处修改的 find 为空；要追加内容，请找一段唯一的原文并在 replace 里带上它`);
    const n = out[part].split(e.find).length - 1;
    if (n !== 1) fail(n === 0 ? "EDIT_NOT_FOUND" : "EDIT_AMBIGUOUS", `第 ${i + 1} 处修改：find 在 ${part} 里出现了 ${n} 次，必须恰好 1 次`);
    out[part] = out[part].replace(e.find, () => e.replace);
  });
  return out;
}

export function candidateDiff(c: PromptCandidate) {
  const base = getVersion(c.base_version_id)!;
  return { base_version_id: base.version_id, base_label: base.label, system: textHunks(base.system_prompt, c.system_prompt), user_template: textHunks(base.user_prompt_template, c.user_prompt_template) };
}

export interface ExperimentInput {
  candidateId: string;
  samples: { sample_id: string; role: "TARGET" | "REGRESSION" }[];
  /** 本次实验最多调用模型几次（必填，≤ MAX_EXPERIMENT_RUNS） */
  maxModelRuns: number;
  /** 没有可复用基线时用的参数；复用基线时候选沿用基线的参数，保证可比 */
  params?: ModelParams;
  reuseBaseline?: boolean;
}

/** 预演：解析样本、找可复用基线、算出要调用几次模型；超预算直接拒绝，不产生费用 */
export function planExperiment(input: ExperimentInput) {
  const cand = getCandidate(input.candidateId) ?? fail("CANDIDATE_NOT_FOUND", "候选不存在", 404);
  if (cand.status !== "DRAFT") fail("CANDIDATE_DECIDED", "候选已采纳或已拒绝，不能再做实验", 409);
  const prompt = getPrompt(cand.prompt_id)!;
  if (!input.samples.length) fail("NO_SAMPLES", "至少要有一个样本");
  if (!input.samples.some((s) => s.role === "TARGET")) fail("NO_TARGET", "至少要有一个目标样本（role=TARGET）");
  if (new Set(input.samples.map((s) => s.sample_id)).size !== input.samples.length) fail("DUPLICATE_SAMPLE", "样本重复");
  if (!(Number.isInteger(input.maxModelRuns) && input.maxModelRuns > 0)) fail("BUDGET_REQUIRED", "必须给出本次实验最多调用模型的次数");
  if (input.maxModelRuns > MAX_EXPERIMENT_RUNS) fail("BUDGET_TOO_LARGE", `单次实验最多调用模型 ${MAX_EXPERIMENT_RUNS} 次`);
  const info = getProvider().info();
  if (!info.configured) fail("MODEL_NOT_CONFIGURED", "未配置模型，无法做实验");
  const samples: ExperimentSample[] = input.samples.map((s) => {
    let snapshot;
    if (s.sample_id.startsWith("snap_")) snapshot = getSnapshot(s.sample_id) ?? fail("SNAPSHOT_NOT_FOUND", `输入快照 ${s.sample_id} 不存在或已删除`, 404);
    else {
      const f = getFixture(s.sample_id) ?? fail("SAMPLE_NOT_FOUND", `样本 ${s.sample_id} 不存在`, 404);
      if (f.promptKind !== prompt.prompt_kind) fail("SAMPLE_KIND_MISMATCH", `样本 ${s.sample_id} 是 ${f.promptKind}，与提示词 ${prompt.prompt_kind} 不符`);
      snapshot = snapshotForFixture(prompt.project_id, f) ?? fail("SAMPLE_NOT_RUNNABLE", `样本 ${s.sample_id} 没有请求，只能仅渲染，不能真实运行`);
    }
    const built = buildInput(prompt.prompt_kind, snapshot);
    if (!built.ok) return fail(built.code, `样本 ${s.sample_id}：${built.message}`);
    const baselineId = input.reuseBaseline === false ? null : findBaselineRun({ promptId: prompt.prompt_id, versionId: cand.base_version_id, builtInputHash: sha256(stableStringify(built.request)), model: info.model });
    const baseline = baselineId ? getRun(baselineId) : undefined;
    return { sample_id: s.sample_id, role: s.role, snapshot_id: snapshot.snapshot_id, baseline_run_id: baselineId, baseline_reused: !!baselineId, candidate_run_id: null, params: { ...(baseline?.model_params ?? input.params ?? DEFAULT_PARAMS) }, error: null };
  });
  const planned = samples.length + samples.filter((s) => !s.baseline_run_id).length;
  if (planned > input.maxModelRuns) fail("BUDGET_EXCEEDED", `需要调用模型 ${planned} 次（候选 ${samples.length} 次 + 补跑基线 ${planned - samples.length} 次），超过本次上限 ${input.maxModelRuns} 次`);
  return { candidate: cand, model: info.model, planned_model_runs: planned, samples };
}

/**
 * 开始实验：同一个 idempotencyKey 重复提交时直接返回已有实验，不会再调用模型。
 * 样本依次运行（基线缺失时先补跑），全部结束后自动评判。
 */
export function startExperiment(input: ExperimentInput & { createdBy: string; idempotencyKey?: string | null }): { experiment: Experiment; reused: boolean; done: Promise<Experiment> } {
  if (input.idempotencyKey) {
    const existing = getExperimentByKey(input.idempotencyKey);
    if (existing) {
      if (existing.candidate_id !== input.candidateId) fail("IDEMPOTENCY_KEY_CONFLICT", "这个幂等键已用于另一个候选的实验", 409);
      return { experiment: existing, reused: true, done: Promise.resolve(existing) };
    }
  }
  const plan = planExperiment(input);
  const cand = plan.candidate;
  const prompt = getPrompt(cand.prompt_id)!;
  const base = getVersion(cand.base_version_id)!;
  const exp: Experiment = {
    experiment_id: newId("exp"),
    candidate_id: cand.candidate_id,
    prompt_id: cand.prompt_id,
    project_id: prompt.project_id,
    idempotency_key: input.idempotencyKey ?? null,
    status: "RUNNING",
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
    finished_at: null,
    base_version_id: base.version_id,
    model: plan.model,
    budget: { max_model_runs: input.maxModelRuns, planned_model_runs: plan.planned_model_runs, used_model_runs: 0 },
    samples: plan.samples,
    report: null,
    error: null,
  };
  insertExperiment(exp);

  const run = async (s: ExperimentSample, role: "BASELINE" | "CANDIDATE"): Promise<Run> => {
    exp.budget.used_model_runs++;
    updateExperiment(exp);
    return modelRun({
      projectId: prompt.project_id,
      promptId: prompt.prompt_id,
      snapshotId: s.snapshot_id,
      system: role === "BASELINE" ? base.system_prompt : cand.system_prompt,
      userTemplate: role === "BASELINE" ? base.user_prompt_template : cand.user_prompt_template,
      promptVersionId: base.version_id,
      params: s.params as ModelParams,
      label: `实验 ${exp.experiment_id.slice(-6)} · ${role === "BASELINE" ? "基线" : "候选"} · ${s.sample_id}`,
      experimentRef: { experiment_id: exp.experiment_id, candidate_id: cand.candidate_id, role, sample_id: s.sample_id },
    });
  };

  const done = (async () => {
    try {
      for (const s of exp.samples) {
        try {
          if (!s.baseline_run_id) s.baseline_run_id = (await run(s, "BASELINE")).run_id;
          s.candidate_run_id = (await run(s, "CANDIDATE")).run_id;
        } catch (e) {
          // 开始前就被拒绝的运行（配置、输入问题）：记在样本上，评判时算「没跑完」
          s.error = e instanceof Error ? e.message : String(e);
        }
        updateExperiment(exp);
      }
      exp.report = buildReport(exp);
      exp.status = "COMPLETED";
    } catch (e) {
      exp.status = "FAILED";
      exp.error = e instanceof Error ? e.message : String(e);
    }
    exp.finished_at = new Date().toISOString();
    updateExperiment(exp);
    return exp;
  })();
  return { experiment: exp, reused: false, done };
}

function buildReport(exp: Experiment) {
  const cand = getCandidate(exp.candidate_id)!;
  const base = getVersion(exp.base_version_id)!;
  const samples = exp.samples.map((s) =>
    evaluateSample({
      sample_id: s.sample_id,
      role: s.role,
      baseline: s.baseline_run_id ? getRun(s.baseline_run_id) : undefined,
      candidate: s.candidate_run_id ? getRun(s.candidate_run_id) : undefined,
      annotations: annotationsForSample(exp.prompt_id, s.snapshot_id),
    }),
  );
  return summarize(samples, { system: base.system_prompt, user_template: base.user_prompt_template }, { system: cand.system_prompt, user_template: cand.user_prompt_template });
}

/** 重新评判（标注可能在实验后新增）；只读，不调用模型 */
export function evaluateExperiment(experimentId: string) {
  const exp = getExperiment(experimentId) ?? fail("EXPERIMENT_NOT_FOUND", "实验不存在", 404);
  if (exp.status === "RUNNING") return { experiment: exp, report: null, note: "实验还在运行" };
  if (exp.status === "FAILED") return { experiment: exp, report: null, note: `实验失败：${exp.error}` };
  return { experiment: exp, report: buildReport(exp) };
}

/**
 * 人工采纳（只在网页提供，Agent 没有这个入口）：候选生成新的不可变版本，并把正式版本指向它。
 * 要求至少有一次完成的实验；最近一次报告不是「可供人审」时必须明确确认风险。
 */
export function approveCandidate(input: { candidateId: string; label: string; decidedBy: string; note?: string | null; acknowledgeRisks?: boolean }) {
  const cand = getCandidate(input.candidateId) ?? fail("CANDIDATE_NOT_FOUND", "候选不存在", 404);
  if (cand.status !== "DRAFT") fail("CANDIDATE_DECIDED", "候选已采纳或已拒绝", 409);
  if (!input.label.trim()) fail("LABEL_REQUIRED", "请给新版本起个名字");
  const exp = listExperiments(cand.candidate_id).find((e) => e.status === "COMPLETED") ?? fail("NO_EXPERIMENT", "候选还没有完成的实验，不能采纳");
  const report = buildReport(exp);
  if (report.conclusion !== "READY_FOR_REVIEW" && !input.acknowledgeRisks)
    fail("RISK_NOT_ACKNOWLEDGED", `最近一次实验的结论是「${report.conclusion}」：${report.reasons.join("；")}。确认了解风险后才能采纳`);
  const previous = stableVersionId(cand.prompt_id);
  const v = createVersion({
    prompt_id: cand.prompt_id,
    label: input.label.trim(),
    system_prompt: cand.system_prompt,
    user_prompt_template: cand.user_prompt_template,
    parent_version_id: cand.base_version_id,
    change_note: `采纳候选 ${cand.candidate_id}（实验 ${exp.experiment_id}）：${cand.reason}`,
  });
  setStableVersion(cand.prompt_id, v.version_id, { candidate_id: cand.candidate_id, experiment_id: exp.experiment_id, decided_by: input.decidedBy, note: input.note ?? null });
  decideCandidate(cand.candidate_id, { status: "APPROVED", decided_by: input.decidedBy, note: input.note ?? null, promoted_version_id: v.version_id });
  return { candidate: getCandidate(cand.candidate_id)!, version: v, previous_stable_version_id: previous };
}

/** 人工拒绝：正式版本不变，候选与实验历史保留 */
export function rejectCandidate(input: { candidateId: string; decidedBy: string; note?: string | null }) {
  const cand = getCandidate(input.candidateId) ?? fail("CANDIDATE_NOT_FOUND", "候选不存在", 404);
  if (!decideCandidate(cand.candidate_id, { status: "REJECTED", decided_by: input.decidedBy, note: input.note ?? null })) fail("CANDIDATE_DECIDED", "候选已采纳或已拒绝", 409);
  return getCandidate(cand.candidate_id)!;
}
