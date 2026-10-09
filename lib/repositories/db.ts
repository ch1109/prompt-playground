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
    globalForDb.__studioDb = d;
    // 进程刚启动时不可能有正在进行的调用：遗留的 RUNNING 都是上次被中断的
    markInterruptedRuns(d);
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
}

/** 仅测试使用：切换到新的数据库 */
export function resetDbForTests(path = ":memory:") {
  globalForDb.__studioDb?.close();
  globalForDb.__studioDb = undefined;
  process.env.STUDIO_DB_PATH = path;
}
