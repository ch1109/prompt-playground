import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Prompt Studio 私有存储（SQLite）。与九立业务系统完全隔离：这里只存 Studio 自己的数据。
// 通过 Repository 函数访问，后续迁移 PostgreSQL 时业务层不变。

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prompts (
  prompt_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id),
  prompt_kind TEXT NOT NULL, name TEXT NOT NULL, active_schema_version TEXT, renderer_id TEXT
);
-- 只新增，不原地覆盖（无 UPDATE 路径）
CREATE TABLE IF NOT EXISTS prompt_versions (
  version_id TEXT PRIMARY KEY, prompt_id TEXT NOT NULL REFERENCES prompts(prompt_id),
  label TEXT NOT NULL, system_prompt TEXT NOT NULL, user_prompt_template TEXT NOT NULL,
  variables_schema TEXT, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, parent_version_id TEXT, source TEXT
);
CREATE TABLE IF NOT EXISTS input_snapshots (
  snapshot_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_type TEXT NOT NULL,
  label TEXT NOT NULL, content_hash TEXT NOT NULL, imported_at TEXT NOT NULL,
  parent_snapshot_id TEXT, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS input_materials (
  material_id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES input_snapshots(snapshot_id),
  file_id TEXT NOT NULL, content_hash TEXT, media_type TEXT, authorized_file_ref TEXT, availability TEXT NOT NULL
);
-- 原始响应单独存放，写入后不可修改
CREATE TABLE IF NOT EXISTS raw_responses (
  run_id TEXT PRIMARY KEY, raw TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, prompt_id TEXT NOT NULL, prompt_kind TEXT NOT NULL,
  input_snapshot_id TEXT, mode TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS annotations (
  annotation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
  target_json_pointer TEXT, target TEXT, issue_type TEXT NOT NULL, expected_value TEXT, note TEXT, created_at TEXT NOT NULL
);
-- 标注修订历史（v1.3 §6.1）：每次新增 / 修改 / 删除标注各追加一条完整快照，只追加不修改
CREATE TABLE IF NOT EXISTS annotation_revisions (
  annotation_id TEXT NOT NULL, revision INTEGER NOT NULL, run_id TEXT NOT NULL, action TEXT NOT NULL,
  body TEXT NOT NULL, author TEXT, created_at TEXT NOT NULL, PRIMARY KEY (annotation_id, revision)
);
CREATE TRIGGER IF NOT EXISTS annotation_revisions_no_update BEFORE UPDATE ON annotation_revisions
BEGIN SELECT RAISE(ABORT, '标注修订记录只追加不修改'); END;
CREATE TRIGGER IF NOT EXISTS annotation_revisions_no_delete BEFORE DELETE ON annotation_revisions
BEGIN SELECT RAISE(ABORT, '标注修订记录只追加不删除'); END;
-- Agent 访问授权（v1.3 §7.2 / §12.2 AgentAccessGrant）：令牌只存 sha256，到期或撤销后失效
CREATE TABLE IF NOT EXISTS agent_access_grants (
  grant_id TEXT PRIMARY KEY, principal TEXT NOT NULL, scopes TEXT NOT NULL, project_ids TEXT NOT NULL,
  customer_ids TEXT, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
);
-- Agent 调用审计（v1.3 §13.1-8）：谁、何时、调用了什么、读了哪个 Run、是否被拒绝；只追加
CREATE TABLE IF NOT EXISTS agent_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, grant_id TEXT, principal TEXT, tool TEXT NOT NULL,
  args TEXT, run_id TEXT, outcome TEXT NOT NULL, detail TEXT
);
CREATE TRIGGER IF NOT EXISTS agent_audit_log_no_update BEFORE UPDATE ON agent_audit_log
BEGIN SELECT RAISE(ABORT, '审计记录只追加不修改'); END;
CREATE TRIGGER IF NOT EXISTS agent_audit_log_no_delete BEFORE DELETE ON agent_audit_log
BEGIN SELECT RAISE(ABORT, '审计记录只追加不删除'); END;
-- 正式版本变更记录（v1.3 §11.4）：每次设定 / 晋升正式版本追加一条，只追加
CREATE TABLE IF NOT EXISTS prompt_stable_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, prompt_id TEXT NOT NULL, version_id TEXT NOT NULL, previous_version_id TEXT,
  candidate_id TEXT, experiment_id TEXT, decided_by TEXT, at TEXT NOT NULL, note TEXT
);
CREATE TRIGGER IF NOT EXISTS prompt_stable_history_no_update BEFORE UPDATE ON prompt_stable_history
BEGIN SELECT RAISE(ABORT, '正式版本记录只追加不修改'); END;
CREATE TRIGGER IF NOT EXISTS prompt_stable_history_no_delete BEFORE DELETE ON prompt_stable_history
BEGIN SELECT RAISE(ABORT, '正式版本记录只追加不删除'); END;
-- 隔离的提示词候选（v1.3 §10 / §11.4）：不进入 prompt_versions，不影响正式版本；只有人工采纳才生成新版本
CREATE TABLE IF NOT EXISTS prompt_candidates (
  candidate_id TEXT PRIMARY KEY, prompt_id TEXT NOT NULL, base_version_id TEXT NOT NULL,
  system_prompt TEXT NOT NULL, user_prompt_template TEXT NOT NULL, content_hash TEXT NOT NULL,
  reason TEXT NOT NULL, diagnosis_ref TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  status TEXT NOT NULL, decided_by TEXT, decided_at TEXT, decision_note TEXT, promoted_version_id TEXT
);
-- 候选内容不可改；状态只能从 DRAFT 改一次（采纳 / 拒绝）
CREATE TRIGGER IF NOT EXISTS prompt_candidates_guard BEFORE UPDATE ON prompt_candidates
WHEN OLD.status != 'DRAFT' OR NEW.system_prompt != OLD.system_prompt OR NEW.user_prompt_template != OLD.user_prompt_template
  OR NEW.base_version_id != OLD.base_version_id OR NEW.reason != OLD.reason OR NEW.prompt_id != OLD.prompt_id
BEGIN SELECT RAISE(ABORT, '候选内容不可修改；已采纳或已拒绝的候选不能再改'); END;
CREATE TRIGGER IF NOT EXISTS prompt_candidates_no_delete BEFORE DELETE ON prompt_candidates
BEGIN SELECT RAISE(ABORT, '候选不可删除（拒绝后保留历史）'); END;
-- 候选实验：固定样本上跑候选（和必要的基线），body 记录计划、预算、运行与评判报告
CREATE TABLE IF NOT EXISTS experiments (
  experiment_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, prompt_id TEXT NOT NULL, project_id TEXT NOT NULL,
  idempotency_key TEXT UNIQUE, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  finished_at TEXT, body TEXT NOT NULL
);
-- Agent 诊断报告（v1.3 §8.1 / §8.2）：Agent 的推测，与人工标注分开存放、不改写标注；只追加，再诊断就新增一条
CREATE TABLE IF NOT EXISTS diagnoses (
  diagnosis_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), project_id TEXT NOT NULL,
  target_json_pointer TEXT, target TEXT NOT NULL, root_cause_category TEXT NOT NULL, result_status TEXT NOT NULL,
  report TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS diagnoses_no_update BEFORE UPDATE ON diagnoses
BEGIN SELECT RAISE(ABORT, '诊断报告只追加不修改'); END;
CREATE TRIGGER IF NOT EXISTS diagnoses_no_delete BEFORE DELETE ON diagnoses
BEGIN SELECT RAISE(ABORT, '诊断报告只追加不删除'); END;
-- 数据集（v1.3 §6.3）：样本分 dev / regression / holdout；每个版本冻结当时的人工标注作为标准答案（gold_version = 数据集@版本）。
-- 只新增版本，不修改、不删除
CREATE TABLE IF NOT EXISTS datasets (
  dataset_id TEXT NOT NULL, version INTEGER NOT NULL, prompt_id TEXT NOT NULL, project_id TEXT NOT NULL,
  name TEXT NOT NULL, body TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (dataset_id, version)
);
CREATE TRIGGER IF NOT EXISTS datasets_no_update BEFORE UPDATE ON datasets
BEGIN SELECT RAISE(ABORT, '数据集版本只新增不修改'); END;
CREATE TRIGGER IF NOT EXISTS datasets_no_delete BEFORE DELETE ON datasets
BEGIN SELECT RAISE(ABORT, '数据集版本只新增不删除'); END;
-- 自动优化会话（v1.3 §11）：status 与 version（乐观锁）单独成列，其余在 body；事件只追加
CREATE TABLE IF NOT EXISTS optimization_sessions (
  session_id TEXT PRIMARY KEY, prompt_id TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL,
  version INTEGER NOT NULL, body TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS optimization_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL,
  from_status TEXT, to_status TEXT, actor TEXT, detail TEXT
);
CREATE TRIGGER IF NOT EXISTS optimization_events_no_update BEFORE UPDATE ON optimization_events
BEGIN SELECT RAISE(ABORT, '优化事件只追加不修改'); END;
CREATE TRIGGER IF NOT EXISTS optimization_events_no_delete BEFORE DELETE ON optimization_events
BEGIN SELECT RAISE(ABORT, '优化事件只追加不删除'); END;
-- 材料外发确认（v1.3 §13.1-3）：某项目第一次往某个服务商地址发材料时，用户确认一次；只新增，不修改、不删除
CREATE TABLE IF NOT EXISTS egress_consents (
  project_id TEXT NOT NULL, provider_host TEXT NOT NULL, confirmed_by TEXT NOT NULL, confirmed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, provider_host)
);
CREATE TRIGGER IF NOT EXISTS egress_consents_no_update BEFORE UPDATE ON egress_consents
BEGIN SELECT RAISE(ABORT, '外发确认记录只新增不修改'); END;
CREATE TRIGGER IF NOT EXISTS egress_consents_no_delete BEFORE DELETE ON egress_consents
BEGIN SELECT RAISE(ABORT, '外发确认记录只新增不删除'); END;
CREATE TRIGGER IF NOT EXISTS raw_responses_immutable BEFORE UPDATE ON raw_responses
BEGIN SELECT RAISE(ABORT, 'raw_responses 不可修改'); END;
-- 只有运行中（RUNNING）的 Run 可以更新为终态；结束后不可修改
CREATE TRIGGER IF NOT EXISTS runs_finished_immutable BEFORE UPDATE ON runs WHEN OLD.status != 'RUNNING'
BEGIN SELECT RAISE(ABORT, '已结束的 Run 不可修改'); END;
CREATE TRIGGER IF NOT EXISTS prompt_versions_immutable BEFORE UPDATE ON prompt_versions
BEGIN SELECT RAISE(ABORT, 'prompt_versions 只新增不修改'); END;
`;

const globalForDb = globalThis as unknown as { __studioDb?: DatabaseSync };

export function dbPath() {
  return process.env.STUDIO_DB_PATH ?? join(process.cwd(), "data", "studio.db");
}

export function db(): DatabaseSync {
  if (!globalForDb.__studioDb) {
    const p = dbPath();
    if (p !== ":memory:") mkdirSync(dirname(p), { recursive: true });
    const d = new DatabaseSync(p);
    d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    d.exec(SCHEMA);
    // 迁移：快照到期与删除时间（旧数据库补列）
    const cols = (d.prepare("PRAGMA table_info(input_snapshots)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("expires_at")) d.exec("ALTER TABLE input_snapshots ADD COLUMN expires_at TEXT");
    if (!cols.includes("deleted_at")) d.exec("ALTER TABLE input_snapshots ADD COLUMN deleted_at TEXT");
    // 迁移：项目归档时间
    const projCols = (d.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name);
    if (!projCols.includes("archived_at")) d.exec("ALTER TABLE projects ADD COLUMN archived_at TEXT");
    // 迁移：标注修改与删除时间（删除只做标记留痕）
    const annCols = (d.prepare("PRAGMA table_info(annotations)").all() as { name: string }[]).map((c) => c.name);
    if (!annCols.includes("updated_at")) d.exec("ALTER TABLE annotations ADD COLUMN updated_at TEXT");
    if (!annCols.includes("deleted_at")) d.exec("ALTER TABLE annotations ADD COLUMN deleted_at TEXT");
    // 迁移（v1.1 R-14）：评判、错误归因、是否已核实、保存时的模型原值、来源引用、标注人；旧标注这些列为空
    for (const [col, type] of [["assessment", "TEXT"], ["error_category", "TEXT"], ["category_confirmed", "INTEGER"], ["model_value", "TEXT"], ["source_ref_ids", "TEXT"], ["author", "TEXT"]])
      if (!annCols.includes(col)) d.exec(`ALTER TABLE annotations ADD COLUMN ${col} ${type}`);
    // 迁移（v1.3 M3）：正式版本指针；为空表示还没设定，首次读取时取当时最新版本
    const promptCols = (d.prepare("PRAGMA table_info(prompts)").all() as { name: string }[]).map((c) => c.name);
    if (!promptCols.includes("stable_version_id")) d.exec("ALTER TABLE prompts ADD COLUMN stable_version_id TEXT");
    // 迁移（v1.1 R-06）：Prompt 版本变更说明
    const pvCols = (d.prepare("PRAGMA table_info(prompt_versions)").all() as { name: string }[]).map((c) => c.name);
    if (!pvCols.includes("change_note")) d.exec("ALTER TABLE prompt_versions ADD COLUMN change_note TEXT");
    globalForDb.__studioDb = d;
    // 进程刚启动时不可能有正在进行的调用：遗留的 RUNNING 都是上次被中断的。
    // 命令行工具（STUDIO_CLI=1，如授权管理）与网页服务同时打开数据库，不能替网页服务做这个判断
    if (!process.env.STUDIO_CLI) markInterruptedRuns(d);
  }
  return globalForDb.__studioDb;
}

/** 把遗留的 RUNNING Run 标为 MODEL_ERROR / INTERRUPTED（服务重启或进程退出导致调用中断） */
export function markInterruptedRuns(d: DatabaseSync = db()) {
  const error = JSON.stringify({ code: "INTERRUPTED", message: "服务重启或进程退出，模型调用被中断，未取得结果" });
  d.prepare("UPDATE runs SET status = 'MODEL_ERROR', body = json_set(body, '$.status', 'MODEL_ERROR', '$.ended_at', ?, '$.error', json(?)) WHERE status = 'RUNNING'").run(
    new Date().toISOString(),
    error,
  );
  // 实验在服务进程里依次运行：进程重启后不会再继续，标为失败并说明原因（已完成的运行保留）
  d.prepare("UPDATE experiments SET status = 'FAILED', finished_at = ?, body = json_set(body, '$.error', ?) WHERE status = 'RUNNING'").run(
    new Date().toISOString(),
    "服务重启或进程退出，实验中断；已完成的运行保留，可重新发起实验",
  );
}

/** 仅测试使用：切换到新的数据库 */
export function resetDbForTests(path = ":memory:") {
  globalForDb.__studioDb?.close();
  globalForDb.__studioDb = undefined;
  process.env.STUDIO_DB_PATH = path;
}
