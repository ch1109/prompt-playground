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
  /** 运行时用的提示词版本；未保存的草稿运行为当时所在版本 */
  prompt_version_id: string | null;
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
  return rows.map((r) => toListItem(r.body));
}

function toListItem(body: string): RunListItem {
  const b = JSON.parse(body) as Run & { label?: string };
  return {
    run_id: b.run_id,
    prompt_id: b.prompt_id,
    prompt_kind: b.prompt_kind,
    mode: b.mode,
    status: b.status,
    started_at: b.started_at,
    input_snapshot_id: b.input_snapshot_id ?? null,
    prompt_version_id: b.prompt_version_id ?? null,
    label: b.label ?? "",
    model_name: b.model_name ?? null,
    is_unsaved_draft: b.is_unsaved_draft,
    replay_of_run_id: b.replay_of_run_id ?? null,
    schema_id: b.schema_id ?? null,
  };
}

/**
 * 按条件分页查询 Run（MCP list_runs）：按开始时间倒序；cursor 是上一页最后一条的「开始时间|run_id」。
 * sampleId 是样本 ID（经 FIXTURE 快照的 source_ids.fixture_id 关联）。
 */
export function queryRuns(f: { projectId: string; kind?: string; status?: string; sampleId?: string; cursor?: string; limit: number }): { items: RunListItem[]; next_cursor: string | null } {
  const where = ["project_id = ?"];
  const args: (string | number)[] = [f.projectId];
  if (f.kind) where.push("prompt_kind = ?"), args.push(f.kind);
  if (f.status) where.push("status = ?"), args.push(f.status);
  if (f.sampleId) where.push("input_snapshot_id IN (SELECT snapshot_id FROM input_snapshots WHERE json_extract(body, '$.source_ids.fixture_id') = ?)"), args.push(f.sampleId);
  if (f.cursor) {
    const [at, id] = f.cursor.split("|");
    where.push("(started_at < ? OR (started_at = ? AND run_id < ?))"), args.push(at, at, id ?? "");
  }
  const rows = db()
    .prepare(`SELECT body FROM runs WHERE ${where.join(" AND ")} ORDER BY started_at DESC, run_id DESC LIMIT ?`)
    .all(...args, f.limit + 1) as { body: string }[];
  const items = rows.slice(0, f.limit).map((r) => toListItem(r.body));
  const last = items[items.length - 1];
  return { items, next_cursor: rows.length > f.limit && last ? `${last.started_at}|${last.run_id}` : null };
}

/** 每个样本在本项目中的运行次数、最近运行时间与「标为错误」的标注数（经 FIXTURE 快照关联） */
export function fixtureRunStats(projectId: string): Map<string, { run_count: number; last_run_at: string | null; wrong_count: number }> {
  const rows = db()
    .prepare(
      `SELECT json_extract(s.body, '$.source_ids.fixture_id') AS fixture_id, COUNT(DISTINCT r.run_id) AS run_count, MAX(r.started_at) AS last_run_at,
         COUNT(DISTINCT CASE WHEN a.assessment = 'WRONG' THEN a.annotation_id END) AS wrong_count
       FROM input_snapshots s JOIN runs r ON r.input_snapshot_id = s.snapshot_id AND r.project_id = ?
       LEFT JOIN annotations a ON a.run_id = r.run_id AND a.deleted_at IS NULL
       WHERE s.source_type = 'FIXTURE' GROUP BY fixture_id`,
    )
    .all(projectId) as { fixture_id: string | null; run_count: number; last_run_at: string | null; wrong_count: number }[];
  return new Map(rows.filter((r) => r.fixture_id).map((r) => [r.fixture_id!, { run_count: r.run_count, last_run_at: r.last_run_at, wrong_count: r.wrong_count }]));
}

/** ASSESSMENT = v1.1 的评判型标注（错误 / 正确 / 不确定 + 错误归因）；其余为旧类型与 P3 关系类型 */
export const ANNOTATION_TYPES = ["ASSESSMENT", "MODEL_WRONG", "CORRECT_VALUE", "ERROR_REASON", "CORRECT_CANDIDATE", "WRONG_RELATION", "NOTE", "ISSUE_REAL", "ISSUE_FALSE_POSITIVE"];
export const ASSESSMENTS = ["WRONG", "CORRECT", "UNSURE"] as const;
/** 错误归因（v1.3 §6.2）：新标注使用这 13 类 */
export const ERROR_CATEGORIES = [
  "INPUT_MISSING_PAGE",
  "PREPROCESSING_ERROR",
  "OCR_VISION_ERROR",
  "PROMPT_RULE_ERROR",
  "MODEL_REASONING_ERROR",
  "CANDIDATE_RECALL_ERROR",
  "RELATION_SELECTION_ERROR",
  "SCHEMA_CONTRACT_ERROR",
  "ADAPTER_MAPPING_ERROR",
  "BUSINESS_RULE_ERROR",
  "INCORRECT_GOLD",
  "EVIDENCE_INSUFFICIENT",
  "UNKNOWN",
] as const;
/** v1.1 的 8 类旧归因：已有标注照常读取、显示，接口也仍接受；不改写旧数据 */
export const LEGACY_ERROR_CATEGORIES = ["INPUT_PREPROCESSING", "MODEL_EXTRACTION", "PROMPT_RULE", "CANDIDATE_RECALL", "MATCH_JUDGEMENT", "SCHEMA_CONTRACT", "ADAPTER_RENDER", "UNDETERMINED"] as const;
type ErrorCategory = (typeof ERROR_CATEGORIES)[number] | (typeof LEGACY_ERROR_CATEGORIES)[number];

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
  assessment?: (typeof ASSESSMENTS)[number] | null;
  error_category?: ErrorCategory | null;
  /** 错误归因是否已核实；false = 疑似 / 待核实 */
  category_confirmed?: boolean | null;
  /** 保存时该位置上模型输出的原值（JSON 文本）；指向请求上下文或不存在时为 null */
  model_value?: string | null;
  source_ref_ids?: string[];
  author?: string | null;
  /** 当前修订号（从 1 开始）与全部修订（旧到新）；只在读取时附带 */
  revision?: number;
  revisions?: AnnotationRevision[];
}

export interface AnnotationRevision {
  revision: number;
  action: "CREATE" | "UPDATE" | "DELETE";
  /** 这一版标注的完整内容 */
  body: Omit<Annotation, "revision" | "revisions">;
  author: string | null;
  created_at: string;
}

export type AnnotationInput = Omit<Annotation, "annotation_id" | "created_at" | "updated_at" | "revision" | "revisions">;

/** 校验评判字段的组合；返回错误说明或 null */
export function checkAssessment(a: Pick<Annotation, "assessment" | "error_category">): string | null {
  if (a.assessment && !ASSESSMENTS.includes(a.assessment)) return `assessment 必须是 ${ASSESSMENTS.join("/")}`;
  if (a.error_category && !(ERROR_CATEGORIES as readonly string[]).includes(a.error_category) && !(LEGACY_ERROR_CATEGORIES as readonly string[]).includes(a.error_category))
    return `error_category 必须是 ${ERROR_CATEGORIES.join("/")}`;
  if (a.assessment === "WRONG" && !a.error_category) return "标注错误时必须选择错误归因（证据不足可选 UNKNOWN 或标为待核实）";
  if (a.assessment === "CORRECT" && a.error_category) return "标注正确时不填错误归因";
  return null;
}

type Row = Record<string, unknown>;
function fromRow(r: Row): Annotation {
  return {
    ...(r as unknown as Annotation),
    category_confirmed: r.category_confirmed === null || r.category_confirmed === undefined ? null : r.category_confirmed === 1,
    source_ref_ids: typeof r.source_ref_ids === "string" ? (JSON.parse(r.source_ref_ids) as string[]) : [],
  };
}

/**
 * 追加一条修订。没有任何修订记录的旧标注（v1.3 之前创建）在第一次修改 / 删除时，
 * 先用修改前的内容补一条 CREATE，保证第 1 版是原始内容。
 */
function appendRevision(action: AnnotationRevision["action"], after: Annotation, before?: Annotation) {
  const d = db();
  const strip = ({ revision: _r, revisions: _rs, ...a }: Annotation) => a;
  const insert = d.prepare("INSERT INTO annotation_revisions (annotation_id, revision, run_id, action, body, author, created_at) VALUES (?,?,?,?,?,?,?)");
  let last = (d.prepare("SELECT MAX(revision) AS n FROM annotation_revisions WHERE annotation_id = ?").get(after.annotation_id) as { n: number | null }).n ?? 0;
  if (last === 0 && action !== "CREATE" && before) {
    insert.run(before.annotation_id, 1, before.run_id, "CREATE", JSON.stringify(strip(before)), before.author ?? null, before.created_at);
    last = 1;
  }
  insert.run(after.annotation_id, last + 1, after.run_id, action, JSON.stringify(strip(after)), process.env.STUDIO_USER || after.author || "本机用户", new Date().toISOString());
}

function revisionsOf(annotationIds: string[]): Map<string, AnnotationRevision[]> {
  const out = new Map<string, AnnotationRevision[]>();
  if (!annotationIds.length) return out;
  const rows = db()
    .prepare(`SELECT annotation_id, revision, action, body, author, created_at FROM annotation_revisions WHERE annotation_id IN (${annotationIds.map(() => "?").join(",")}) ORDER BY revision`)
    .all(...annotationIds) as Row[];
  for (const r of rows) {
    const list = out.get(String(r.annotation_id)) ?? [];
    list.push({ revision: Number(r.revision), action: r.action as AnnotationRevision["action"], body: JSON.parse(String(r.body)), author: (r.author as string | null) ?? null, created_at: String(r.created_at) });
    out.set(String(r.annotation_id), list);
  }
  return out;
}

/** 附上修订历史；没有修订记录的旧标注视为第 1 版 */
function withRevisions(list: Annotation[]): Annotation[] {
  const revs = revisionsOf(list.map((a) => a.annotation_id));
  return list.map((a) => {
    const r = revs.get(a.annotation_id) ?? [];
    return { ...a, revision: r.length ? r[r.length - 1].revision : 1, revisions: r };
  });
}

/** 标注独立保存：不修改 Run、原始响应或任何九立数据 */
export function addAnnotation(a: AnnotationInput): Annotation {
  const full: Annotation = { ...a, annotation_id: newId("ann"), created_at: new Date().toISOString() };
  db()
    .prepare(
      "INSERT INTO annotations (annotation_id, run_id, target_json_pointer, target, issue_type, expected_value, note, created_at, assessment, error_category, category_confirmed, model_value, source_ref_ids, author) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      full.annotation_id,
      full.run_id,
      full.target_json_pointer,
      full.target,
      full.issue_type,
      full.expected_value,
      full.note,
      full.created_at,
      full.assessment ?? null,
      full.error_category ?? null,
      full.category_confirmed === undefined || full.category_confirmed === null ? null : full.category_confirmed ? 1 : 0,
      full.model_value ?? null,
      JSON.stringify(full.source_ref_ids ?? []),
      full.author ?? null,
    );
  appendRevision("CREATE", readAnnotation(full.annotation_id)!);
  return getAnnotation(full.annotation_id)!;
}

/** 「问题是否属实」：同一次运行里同一条问题（target 以「问题 <id>（」开头）只保留一条，再次标注就是修改（留修订）。assessment 留空，评判逻辑看不到它 */
export function setIssueVerdict(runId: string, issue: { id: string; type: string; summary: string; jsonPointer?: string | null; sourceRefIds?: string[] }, verdict: "ISSUE_REAL" | "ISSUE_FALSE_POSITIVE", author: string): Annotation {
  const target = `问题 ${issue.id}（${issue.type}）：${issue.summary.slice(0, 30)}`;
  const cur = listAnnotations(runId).find((a) => a.issue_type.startsWith("ISSUE_") && a.target?.startsWith(`问题 ${issue.id}（`));
  if (cur) return updateAnnotation(cur.annotation_id, { issue_type: verdict, expected_value: cur.expected_value, note: cur.note })!;
  return addAnnotation({ run_id: runId, target_json_pointer: issue.jsonPointer ?? null, target, issue_type: verdict, expected_value: null, note: null, assessment: null, error_category: null, category_confirmed: null, model_value: null, source_ref_ids: issue.sourceRefIds ?? [], author });
}

const ANN_COLS = "annotation_id, run_id, target_json_pointer, target, issue_type, expected_value, note, created_at, updated_at, assessment, error_category, category_confirmed, model_value, source_ref_ids, author";

export function listAnnotations(runId: string): Annotation[] {
  return withRevisions((db().prepare(`SELECT ${ANN_COLS} FROM annotations WHERE run_id = ? AND deleted_at IS NULL ORDER BY created_at`).all(runId) as Row[]).map(fromRow));
}

/** 只读当前内容，不附修订历史 */
function readAnnotation(annotationId: string): Annotation | undefined {
  const r = db().prepare(`SELECT ${ANN_COLS} FROM annotations WHERE annotation_id = ? AND deleted_at IS NULL`).get(annotationId) as Row | undefined;
  return r ? fromRow(r) : undefined;
}

export function getAnnotation(annotationId: string): Annotation | undefined {
  const a = readAnnotation(annotationId);
  return a ? withRevisions([a])[0] : undefined;
}

/** 修改标注内容（不涉及模型输出，模型原值与目标不变）；已删除的返回 undefined */
export function updateAnnotation(annotationId: string, patch: Pick<Annotation, "issue_type" | "expected_value" | "note"> & Partial<Pick<Annotation, "assessment" | "error_category" | "category_confirmed">>): Annotation | undefined {
  const cur = readAnnotation(annotationId);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  db()
    .prepare("UPDATE annotations SET issue_type = ?, expected_value = ?, note = ?, assessment = ?, error_category = ?, category_confirmed = ?, updated_at = ? WHERE annotation_id = ? AND deleted_at IS NULL")
    .run(
      next.issue_type,
      next.expected_value,
      next.note,
      next.assessment ?? null,
      next.error_category ?? null,
      next.category_confirmed === undefined || next.category_confirmed === null ? null : next.category_confirmed ? 1 : 0,
      new Date().toISOString(),
      annotationId,
    );
  appendRevision("UPDATE", readAnnotation(annotationId)!, cur);
  return getAnnotation(annotationId);
}

/** 删除标注：只做删除标记（留痕），不再列出、不进入导出；修订历史追加一条 DELETE */
export function deleteAnnotation(annotationId: string): boolean {
  const cur = readAnnotation(annotationId);
  if (!cur) return false;
  db().prepare("UPDATE annotations SET deleted_at = ? WHERE annotation_id = ? AND deleted_at IS NULL").run(new Date().toISOString(), annotationId);
  appendRevision("DELETE", cur, cur);
  return true;
}
