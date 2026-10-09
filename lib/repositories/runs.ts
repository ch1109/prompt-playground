import type { Run } from "@/lib/contracts/run";
import { newId, sha256 } from "@/lib/hash";
import { db } from "./db";

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

export function getRun(runId: string): Run | undefined {
  const d = db();
  const row = d.prepare("SELECT body FROM runs WHERE run_id = ?").get(runId) as { body: string } | undefined;
  if (!row) return undefined;
  const raw = d.prepare("SELECT raw, sha256 FROM raw_responses WHERE run_id = ?").get(runId) as { raw: string; sha256: string };
  return { ...(JSON.parse(row.body) as Omit<Run, "raw_response">), raw_response: raw.raw, raw_response_hash: raw.sha256 };
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
    };
  });
}

export interface Annotation {
  annotation_id: string;
  run_id: string;
  target_json_pointer: string | null;
  target: string | null;
  issue_type: string;
  expected_value: string | null;
  note: string | null;
  created_at: string;
}

/** 标注独立保存：不修改 Run、原始响应或任何九立数据 */
export function addAnnotation(a: Omit<Annotation, "annotation_id" | "created_at">): Annotation {
  const full: Annotation = { ...a, annotation_id: newId("ann"), created_at: new Date().toISOString() };
  db()
    .prepare("INSERT INTO annotations VALUES (?,?,?,?,?,?,?,?)")
    .run(full.annotation_id, full.run_id, full.target_json_pointer, full.target, full.issue_type, full.expected_value, full.note, full.created_at);
  return full;
}

export function listAnnotations(runId: string): Annotation[] {
  return db().prepare("SELECT * FROM annotations WHERE run_id = ? ORDER BY created_at").all(runId) as unknown as Annotation[];
}
