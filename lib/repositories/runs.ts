import type { Run } from "@/lib/contracts/run";
import { newId, sha256 } from "@/lib/hash";
import { db } from "./db";

export { markInterruptedRuns } from "./db";

/** 写入 Run：原始响应单独存入不可修改的 raw_responses 表 */
export function saveRun(run: Run): Run {
  const d = db();
  d.prepare("INSERT INTO raw_responses VALUES (?,?,?,?)").run(run.run_id, run.raw_response, sha256(run.raw_response), run.started_at);
  const { raw_response: _raw, ...body } = run;
  d.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?)").run(
    run.run_id,
    run.project_id,
    run.prompt_id,
    run.prompt_kind,
    run.input_snapshot_id ?? null,
    run.mode,
    run.status,
    run.started_at,
    JSON.stringify(body),
  );
  return run;
}

/** 模型调用开始时先登记 RUNNING Run（此时还没有原始响应） */
export function startRun(run: Run): Run {
  const { raw_response: _raw, raw_response_hash: _h, ...body } = run;
  db()
    .prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?)")
    .run(run.run_id, run.project_id, run.prompt_id, run.prompt_kind, run.input_snapshot_id ?? null, run.mode, "RUNNING", run.started_at, JSON.stringify({ ...body, status: "RUNNING" }));
  return run;
}

/** RUNNING → 终态：原始响应写入不可修改表，Run 只能从 RUNNING 更新一次 */
export function finishRun(run: Run): Run {
  const d = db();
  d.prepare("INSERT INTO raw_responses VALUES (?,?,?,?)").run(run.run_id, run.raw_response, sha256(run.raw_response), run.started_at);
  const { raw_response: _raw, ...body } = run;
  const r = d.prepare("UPDATE runs SET status = ?, body = ? WHERE run_id = ? AND status = 'RUNNING'").run(run.status, JSON.stringify(body), run.run_id);
  if (r.changes !== 1) throw new Error(`Run ${run.run_id} 不处于运行中，不能更新`);
  return run;
}

export function getRun(runId: string): Run | undefined {
  const d = db();
  const row = d.prepare("SELECT body FROM runs WHERE run_id = ?").get(runId) as { body: string } | undefined;
  if (!row) return undefined;
  // 运行中或被中断的 Run 还没有原始响应
  const raw = d.prepare("SELECT raw, sha256 FROM raw_responses WHERE run_id = ?").get(runId) as { raw: string; sha256: string } | undefined;
  return { ...(JSON.parse(row.body) as Omit<Run, "raw_response">), raw_response: raw?.raw ?? "", raw_response_hash: raw?.sha256 ?? "" };
}

export interface RunListItem {
  run_id: string;
  prompt_id: string;
  prompt_kind: string;
  mode: string;
  status: string;
  started_at: string;
  input_snapshot_id: string | null;
  label: string;
  model_name: string | null;
  is_unsaved_draft: boolean;
  replay_of_run_id: string | null;
  /** 为空表示未登记 Schema（UNKNOWN_SCHEMA）或未解析 */
  schema_id: string | null;
}

export function listRuns(projectId: string, promptId?: string, limit = 100): RunListItem[] {
  const rows = (
    promptId
      ? db().prepare("SELECT run_id, body FROM runs WHERE project_id = ? AND prompt_id = ? ORDER BY started_at DESC LIMIT ?").all(projectId, promptId, limit)
      : db().prepare("SELECT run_id, body FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?").all(projectId, limit)
  ) as { run_id: string; body: string }[];
  return rows.map((r) => {
    const b = JSON.parse(r.body) as Run & { label?: string };
    return {
      run_id: b.run_id,
      prompt_id: b.prompt_id,
      prompt_kind: b.prompt_kind,
      mode: b.mode,
      status: b.status,
      started_at: b.started_at,
      input_snapshot_id: b.input_snapshot_id ?? null,
      label: b.label ?? "",
      model_name: b.model_name ?? null,
      is_unsaved_draft: b.is_unsaved_draft,
      replay_of_run_id: b.replay_of_run_id ?? null,
      schema_id: b.schema_id ?? null,
    };
  });
}

export const ANNOTATION_TYPES = ["MODEL_WRONG", "CORRECT_VALUE", "ERROR_REASON", "CORRECT_CANDIDATE", "WRONG_RELATION", "NOTE"];

export interface Annotation {
  annotation_id: string;
  run_id: string;
  target_json_pointer: string | null;
  target: string | null;
  issue_type: string;
  expected_value: string | null;
  note: string | null;
  created_at: string;
  updated_at?: string | null;
}

/** 标注独立保存：不修改 Run、原始响应或任何九立数据 */
export function addAnnotation(a: Omit<Annotation, "annotation_id" | "created_at">): Annotation {
  const full: Annotation = { ...a, annotation_id: newId("ann"), created_at: new Date().toISOString() };
  db()
    .prepare("INSERT INTO annotations (annotation_id, run_id, target_json_pointer, target, issue_type, expected_value, note, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(full.annotation_id, full.run_id, full.target_json_pointer, full.target, full.issue_type, full.expected_value, full.note, full.created_at);
  return full;
}

const ANN_COLS = "annotation_id, run_id, target_json_pointer, target, issue_type, expected_value, note, created_at, updated_at";

export function listAnnotations(runId: string): Annotation[] {
  return db().prepare(`SELECT ${ANN_COLS} FROM annotations WHERE run_id = ? AND deleted_at IS NULL ORDER BY created_at`).all(runId) as unknown as Annotation[];
}

export function getAnnotation(annotationId: string): Annotation | undefined {
  return db().prepare(`SELECT ${ANN_COLS} FROM annotations WHERE annotation_id = ? AND deleted_at IS NULL`).get(annotationId) as unknown as Annotation | undefined;
}

/** 修改标注内容（不涉及模型输出）；已删除的返回 undefined */
export function updateAnnotation(annotationId: string, patch: Pick<Annotation, "issue_type" | "expected_value" | "note">): Annotation | undefined {
  const r = db()
    .prepare("UPDATE annotations SET issue_type = ?, expected_value = ?, note = ?, updated_at = ? WHERE annotation_id = ? AND deleted_at IS NULL")
    .run(patch.issue_type, patch.expected_value, patch.note, new Date().toISOString(), annotationId);
  return r.changes ? getAnnotation(annotationId) : undefined;
}

/** 删除标注：只做删除标记（留痕），不再列出、不进入导出 */
export function deleteAnnotation(annotationId: string): boolean {
  return db().prepare("UPDATE annotations SET deleted_at = ? WHERE annotation_id = ? AND deleted_at IS NULL").run(new Date().toISOString(), annotationId).changes === 1;
}
