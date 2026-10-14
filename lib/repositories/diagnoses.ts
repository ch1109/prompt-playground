import type { DiagnosisReport } from "@/lib/diagnoses/report";
import { db } from "./db";

// Agent 诊断报告（v1.3 §8）：只追加；同一字段再诊断会新增一条，旧报告保留。

export interface DiagnosisTargetRef {
  stage: string;
  table_id: string | null;
  row_id: string | null;
  field: string | null;
  json_pointer: string | null;
}

export interface Diagnosis {
  diagnosis_id: string;
  run_id: string;
  project_id: string;
  target: DiagnosisTargetRef;
  root_cause_category: string;
  result_status: DiagnosisReport["result_status"];
  report: DiagnosisReport;
  /** 提交报告的 Agent（令牌的 principal） */
  created_by: string;
  created_at: string;
}

type Row = Record<string, string | null>;
const fromRow = (r: Row): Diagnosis => ({
  diagnosis_id: r.diagnosis_id!,
  run_id: r.run_id!,
  project_id: r.project_id!,
  target: JSON.parse(r.target!),
  root_cause_category: r.root_cause_category!,
  result_status: r.result_status as Diagnosis["result_status"],
  report: JSON.parse(r.report!),
  created_by: r.created_by!,
  created_at: r.created_at!,
});

export function insertDiagnosis(d: Diagnosis) {
  db()
    .prepare("INSERT INTO diagnoses (diagnosis_id, run_id, project_id, target_json_pointer, target, root_cause_category, result_status, report, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(d.diagnosis_id, d.run_id, d.project_id, d.target.json_pointer, JSON.stringify(d.target), d.root_cause_category, d.result_status, JSON.stringify(d.report), d.created_by, d.created_at);
}

/** 某个 Run 的全部诊断，新的在前 */
export function listDiagnoses(runId: string): Diagnosis[] {
  return (db().prepare("SELECT * FROM diagnoses WHERE run_id = ? ORDER BY created_at DESC").all(runId) as Row[]).map(fromRow);
}

export function getDiagnosis(id: string): Diagnosis | undefined {
  const r = db().prepare("SELECT * FROM diagnoses WHERE diagnosis_id = ?").get(id) as Row | undefined;
  return r ? fromRow(r) : undefined;
}
