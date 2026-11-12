import type { ExperimentReport } from "@/lib/experiments/evaluate";
import type { Annotation } from "./runs";
import { db } from "./db";

// 候选与实验的存储（v1.3 M3）。候选内容由触发器保证不可修改；实验 body 记录计划、预算、运行与报告。

export type CandidateStatus = "DRAFT" | "APPROVED" | "REJECTED";

export interface PromptCandidate {
  candidate_id: string;
  prompt_id: string;
  base_version_id: string;
  system_prompt: string;
  user_prompt_template: string;
  content_hash: string;
  reason: string;
  diagnosis_ref: string | null;
  created_by: string;
  created_at: string;
  status: CandidateStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  promoted_version_id: string | null;
}

const C_COLS = "candidate_id, prompt_id, base_version_id, system_prompt, user_prompt_template, content_hash, reason, diagnosis_ref, created_by, created_at, status, decided_by, decided_at, decision_note, promoted_version_id";

export function insertCandidate(c: PromptCandidate) {
  db()
    .prepare(`INSERT INTO prompt_candidates (${C_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(c.candidate_id, c.prompt_id, c.base_version_id, c.system_prompt, c.user_prompt_template, c.content_hash, c.reason, c.diagnosis_ref, c.created_by, c.created_at, c.status, null, null, null, null);
}

export function getCandidate(id: string): PromptCandidate | undefined {
  return db().prepare(`SELECT ${C_COLS} FROM prompt_candidates WHERE candidate_id = ?`).get(id) as unknown as PromptCandidate | undefined;
}

export function listCandidates(promptId: string): PromptCandidate[] {
  return db().prepare(`SELECT ${C_COLS} FROM prompt_candidates WHERE prompt_id = ? ORDER BY created_at DESC`).all(promptId) as unknown as PromptCandidate[];
}

/** 草稿 → 已采纳 / 已拒绝（只能一次，触发器兜底） */
export function decideCandidate(id: string, d: { status: "APPROVED" | "REJECTED"; decided_by: string; note: string | null; promoted_version_id?: string | null }) {
  const r = db()
    .prepare("UPDATE prompt_candidates SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, promoted_version_id = ? WHERE candidate_id = ? AND status = 'DRAFT'")
    .run(d.status, d.decided_by, new Date().toISOString(), d.note, d.promoted_version_id ?? null, id);
  return r.changes === 1;
}

export type ExperimentStatus = "RUNNING" | "COMPLETED" | "FAILED";

export interface ExperimentSample {
  sample_id: string;
  role: "TARGET" | "REGRESSION";
  snapshot_id: string;
  /** 复用的或本次新跑的基线 */
  baseline_run_id: string | null;
  baseline_reused: boolean;
  candidate_run_id: string | null;
  params: Record<string, unknown>;
  error: string | null;
}

export interface ExperimentBody {
  base_version_id: string;
  model: string;
  budget: { max_model_runs: number; planned_model_runs: number; used_model_runs: number };
  samples: ExperimentSample[];
  /** 按数据集做的实验：所用数据集版本（标准答案即该版本冻结的标注）；旧实验没有这一项 */
  dataset?: { dataset_id: string; version: number } | null;
  report: ExperimentReport | null;
  error: string | null;
}

export interface Experiment extends ExperimentBody {
  experiment_id: string;
  candidate_id: string;
  prompt_id: string;
  project_id: string;
  idempotency_key: string | null;
  status: ExperimentStatus;
  created_by: string;
  created_at: string;
  finished_at: string | null;
}

type Row = Record<string, string | null>;
const toExperiment = (r: Row): Experiment => ({ ...(JSON.parse(r.body!) as ExperimentBody), experiment_id: r.experiment_id!, candidate_id: r.candidate_id!, prompt_id: r.prompt_id!, project_id: r.project_id!, idempotency_key: r.idempotency_key, status: r.status as ExperimentStatus, created_by: r.created_by!, created_at: r.created_at!, finished_at: r.finished_at });

export function insertExperiment(e: Experiment) {
  const { experiment_id, candidate_id, prompt_id, project_id, idempotency_key, status, created_by, created_at, finished_at, ...body } = e;
  db().prepare("INSERT INTO experiments VALUES (?,?,?,?,?,?,?,?,?,?)").run(experiment_id, candidate_id, prompt_id, project_id, idempotency_key, status, created_by, created_at, finished_at, JSON.stringify(body));
}

export function updateExperiment(e: Experiment) {
  const { experiment_id, status, finished_at, candidate_id: _c, prompt_id: _p, project_id: _pr, idempotency_key: _k, created_by: _cb, created_at: _ca, ...body } = e;
  db().prepare("UPDATE experiments SET status = ?, finished_at = ?, body = ? WHERE experiment_id = ?").run(status, finished_at, JSON.stringify(body), experiment_id);
}

export function getExperiment(id: string): Experiment | undefined {
  const r = db().prepare("SELECT * FROM experiments WHERE experiment_id = ?").get(id) as Row | undefined;
  return r ? toExperiment(r) : undefined;
}

export function getExperimentByKey(key: string): Experiment | undefined {
  const r = db().prepare("SELECT * FROM experiments WHERE idempotency_key = ?").get(key) as Row | undefined;
  return r ? toExperiment(r) : undefined;
}

export function listExperiments(candidateId: string): Experiment[] {
  return (db().prepare("SELECT * FROM experiments WHERE candidate_id = ? ORDER BY created_at DESC").all(candidateId) as Row[]).map(toExperiment);
}

/**
 * 可复用的基线：同一提示词、正好是基础版本（不是草稿）、同一构造输入、同一模型、有输出的最近一次运行；不取实验里的候选运行。
 */
export function findBaselineRun(f: { promptId: string; versionId: string; builtInputHash: string; model: string }): string | null {
  const r = db()
    .prepare(
      `SELECT run_id FROM runs WHERE prompt_id = ? AND mode = 'MODEL_RUN' AND status IN ('SUCCEEDED','SCHEMA_INVALID','PARSE_ERROR','ADAPTER_ERROR')
         AND json_extract(body, '$.prompt_version_id') = ? AND json_extract(body, '$.is_unsaved_draft') = 0
         AND json_extract(body, '$.built_input_hash') = ? AND json_extract(body, '$.model_name') = ?
         AND (json_extract(body, '$.experiment_ref.role') IS NULL OR json_extract(body, '$.experiment_ref.role') = 'BASELINE')
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(f.promptId, f.versionId, f.builtInputHash, f.model) as { run_id: string } | undefined;
  return r?.run_id ?? null;
}

/** 某样本（同一提示词、同一输入快照）上的人工标注；不含实验候选运行上的标注 */
export function annotationsForSample(promptId: string, snapshotId: string): Annotation[] {
  const rows = db()
    .prepare(
      `SELECT a.* FROM annotations a JOIN runs r ON r.run_id = a.run_id
       WHERE r.prompt_id = ? AND r.input_snapshot_id = ? AND a.deleted_at IS NULL
         AND a.issue_type NOT IN ('ISSUE_REAL', 'ISSUE_FALSE_POSITIVE')
         AND (json_extract(r.body, '$.experiment_ref.role') IS NULL OR json_extract(r.body, '$.experiment_ref.role') = 'BASELINE')
       ORDER BY a.created_at`,
    )
    .all(promptId, snapshotId) as Record<string, unknown>[];
  return rows.map((r) => ({ ...(r as unknown as Annotation), source_ref_ids: typeof r.source_ref_ids === "string" ? JSON.parse(r.source_ref_ids) : [] }));
}
