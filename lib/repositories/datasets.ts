import type { Annotation } from "./runs";
import { db } from "./db";

// 数据集存储（v1.3 §6.3）：(dataset_id, version) 只新增；body 里是样本、分层与冻结的标注。

export const SPLITS = ["dev", "regression", "holdout"] as const;
export type Split = (typeof SPLITS)[number];

/** 冻结时的一条人工标注（完整副本，之后改标注不影响它） */
export type FrozenAnnotation = Annotation & { revision: number };

export interface DatasetSample {
  sample_id: string;
  split: Split;
  snapshot_id: string;
  /** 这个版本的标准答案：冻结时该样本上的人工标注 */
  gold: FrozenAnnotation[];
}

export interface Dataset {
  dataset_id: string;
  version: number;
  prompt_id: string;
  project_id: string;
  name: string;
  samples: DatasetSample[];
  note: string | null;
  created_by: string;
  created_at: string;
}

type Row = Record<string, string | number>;
const fromRow = (r: Row): Dataset => {
  const body = JSON.parse(String(r.body)) as { samples: DatasetSample[]; note: string | null };
  return { dataset_id: String(r.dataset_id), version: Number(r.version), prompt_id: String(r.prompt_id), project_id: String(r.project_id), name: String(r.name), samples: body.samples, note: body.note, created_by: String(r.created_by), created_at: String(r.created_at) };
};

export function insertDataset(d: Dataset) {
  db()
    .prepare("INSERT INTO datasets (dataset_id, version, prompt_id, project_id, name, body, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(d.dataset_id, d.version, d.prompt_id, d.project_id, d.name, JSON.stringify({ samples: d.samples, note: d.note }), d.created_by, d.created_at);
}

/** 指定版本；不给版本取最新版本 */
export function getDataset(datasetId: string, version?: number): Dataset | undefined {
  const r = (
    version === undefined
      ? db().prepare("SELECT * FROM datasets WHERE dataset_id = ? ORDER BY version DESC LIMIT 1").get(datasetId)
      : db().prepare("SELECT * FROM datasets WHERE dataset_id = ? AND version = ?").get(datasetId, version)
  ) as Row | undefined;
  return r ? fromRow(r) : undefined;
}

/** 某提示词的数据集，每个只取最新版本 */
export function listDatasets(promptId: string): Dataset[] {
  return (
    db()
      .prepare("SELECT d.* FROM datasets d WHERE d.prompt_id = ? AND d.version = (SELECT MAX(version) FROM datasets x WHERE x.dataset_id = d.dataset_id) ORDER BY d.created_at DESC")
      .all(promptId) as Row[]
  ).map(fromRow);
}
