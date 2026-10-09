import type { Run } from "@/lib/contracts/run";
import { getByPointer } from "@/lib/pipeline/json-pointer";
import { db } from "./db";
import { getRun, type Annotation } from "./runs";

export interface AnnotationExportRow {
  annotation_id: string;
  created_at: string;
  run_id: string;
  run_label: string;
  run_status: string;
  prompt_kind: string;
  prompt_version_id: string;
  model_name: string;
  target: string;
  target_json_pointer: string;
  /** 标注位置上模型输出的原值（只读取，不修改）；指向请求上下文或不存在时为空 */
  model_value: string;
  issue_type: string;
  expected_value: string;
  note: string;
}

const text = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** 项目内全部标注 + 所属 Run 的关键信息，供离线评测使用 */
export function exportAnnotations(projectId: string): AnnotationExportRow[] {
  const anns = db()
    .prepare("SELECT a.* FROM annotations a JOIN runs r ON r.run_id = a.run_id WHERE r.project_id = ? AND a.deleted_at IS NULL ORDER BY a.created_at")
    .all(projectId) as unknown as Annotation[];
  const runs = new Map<string, (Run & { label?: string }) | undefined>();
  return anns.map((a) => {
    if (!runs.has(a.run_id)) runs.set(a.run_id, getRun(a.run_id));
    const run = runs.get(a.run_id);
    const pointer = a.target_json_pointer ?? "";
    const value = run && pointer !== "" && !pointer.startsWith("req:") ? getByPointer(run.parsed_json, pointer) : undefined;
    return {
      annotation_id: a.annotation_id,
      created_at: a.created_at,
      run_id: a.run_id,
      run_label: run?.label ?? "",
      run_status: run?.status ?? "",
      prompt_kind: run?.prompt_kind ?? "",
      prompt_version_id: run?.prompt_version_id ?? "",
      model_name: run?.model_name ?? "",
      target: a.target ?? "",
      target_json_pointer: pointer,
      model_value: value?.found ? text(value.value) : "",
      issue_type: a.issue_type,
      expected_value: a.expected_value ?? "",
      note: a.note ?? "",
    };
  });
}

const COLUMNS: (keyof AnnotationExportRow)[] = [
  "annotation_id", "created_at", "run_id", "run_label", "run_status", "prompt_kind", "prompt_version_id", "model_name",
  "target", "target_json_pointer", "model_value", "issue_type", "expected_value", "note",
];

/** CSV：带 BOM 让 Excel 正确识别中文；每格加引号并转义内部引号 */
export function annotationsToCsv(rows: AnnotationExportRow[]): string {
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return "﻿" + [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((k) => cell(r[k])).join(","))].join("\r\n");
}
