import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptKind } from "@/lib/contracts/run";
import { newId, sha256 } from "@/lib/hash";
import { db } from "./db";

export interface PromptDefinition {
  prompt_id: string;
  project_id: string;
  prompt_kind: PromptKind;
  name: string;
  active_schema_version: string | null;
  renderer_id: string | null;
  /** 正式版本（v1.3 M3）：只有人工审批采纳候选时才移动；为空表示尚未设定 */
  stable_version_id?: string | null;
}

export interface PromptVersion {
  version_id: string;
  prompt_id: string;
  label: string;
  system_prompt: string;
  user_prompt_template: string;
  variables_schema: string | null;
  content_hash: string;
  created_at: string;
  parent_version_id: string | null;
  source: string | null;
  /** 变更说明（v1.1 起）；旧版本为空 */
  change_note?: string | null;
}

export const DEFAULT_PROJECT_ID = "jiuli";

/** 用户消息模板：{{input_json}} 在运行时替换为 InputBuilder 构造的请求 JSON */
export const DEFAULT_USER_TEMPLATE = "{{input_json}}";

const SEED: { id: string; kind: PromptKind; name: string; file?: string }[] = [
  { id: "jiuli-p1", kind: "JIULI_P1", name: "P1 委托材料识别", file: "P1_order_draft_FINAL_v3.0.txt" },
  { id: "jiuli-p2", kind: "JIULI_P2", name: "P2 查货材料识别", file: "P2_inspection_facts_FINAL_v3.0.txt" },
  { id: "jiuli-p3", kind: "JIULI_P3", name: "P3 商品对应关系", file: "P3_product_matching_FINAL_v3.0.txt" },
  { id: "jiuli-p4", kind: "JIULI_P4", name: "P4 字段核验与 Patch", file: "P4_field_verification_FINAL_v3.0.txt" },
  { id: "generic-json", kind: "GENERIC_JSON", name: "通用提示词" },
];

export function contentHash(system: string, user: string) {
  return sha256(`${system}\n\u0000\n${user}`);
}

const seeded = new WeakSet<object>();
export function ensureSeed() {
  const d = db();
  if (seeded.has(d)) return;
  const now = new Date().toISOString();
  d.prepare("INSERT OR IGNORE INTO projects (project_id, name, description, created_at) VALUES (?,?,?,?)").run(DEFAULT_PROJECT_ID, "九立 AI 核对", "P1~P4 结构化提示词调试", now);
  for (const s of SEED) {
    d.prepare("INSERT OR IGNORE INTO prompts (prompt_id, project_id, prompt_kind, name, active_schema_version, renderer_id) VALUES (?,?,?,?,?,?)").run(
      s.id,
      DEFAULT_PROJECT_ID,
      s.kind,
      s.name,
      s.kind === "GENERIC_JSON" ? null : "jiuli-ai-v3",
      null,
    );
    if (s.file) {
      seeded.add(d); // syncSeedVersion 内部会调用 ensureSeed，先标记避免递归
      syncSeedVersion(s.id, `prompts/jiuli-v3/${s.file}`, readFileSync(join(process.cwd(), "prompts", "jiuli-v3", s.file), "utf8"));
      continue;
    }
    const has = d.prepare("SELECT 1 FROM prompt_versions WHERE prompt_id = ? LIMIT 1").get(s.id);
    if (!has) insertSeed(s.id, "默认", "只输出一个合法 JSON 对象。", "seed", null);
  }
  // v1.2：内置通用提示词改名（只改仍是旧默认名的，用户改过的名字不动）
  d.prepare("UPDATE prompts SET name = '通用提示词' WHERE prompt_kind = 'GENERIC_JSON' AND name = '通用 JSON（未登记 Schema）'").run();
  seeded.add(d);
}

function insertSeed(promptId: string, label: string, system: string, source: string, parent: string | null): PromptVersion {
  const v: PromptVersion = {
    version_id: newId("pv"),
    prompt_id: promptId,
    label,
    system_prompt: system,
    user_prompt_template: DEFAULT_USER_TEMPLATE,
    variables_schema: JSON.stringify({ input_json: "InputBuilder 构造的请求 JSON" }),
    content_hash: contentHash(system, DEFAULT_USER_TEMPLATE),
    created_at: new Date().toISOString(),
    parent_version_id: parent,
    source,
  };
  db()
    .prepare("INSERT INTO prompt_versions (version_id, prompt_id, label, system_prompt, user_prompt_template, variables_schema, content_hash, created_at, parent_version_id, source) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(v.version_id, v.prompt_id, v.label, v.system_prompt, v.user_prompt_template, v.variables_schema, v.content_hash, v.created_at, v.parent_version_id, v.source);
  return v;
}

/**
 * 提示词源文件同步（服务启动时检查一次）：首次导入为初始版本；
 * 文件内容与该来源最新版本不同 → 追加新版本（parent 指向上一版），不覆盖历史。返回新建版本或 null。
 */
export function syncSeedVersion(promptId: string, source: string, text: string): PromptVersion | null {
  ensureSeed();
  const latest = db().prepare("SELECT * FROM prompt_versions WHERE prompt_id = ? AND source = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(promptId, source) as unknown as
    | PromptVersion
    | undefined;
  if (!latest) return insertSeed(promptId, "v3.0 原文（九立demo）", text, source, null);
  if (latest.system_prompt === text) return null;
  return insertSeed(promptId, `v3.0 原文（文件已更新 ${new Date().toISOString().slice(0, 10)}）`, text, source, latest.version_id);
}

export type ProjectTemplate = "JIULI" | "BLANK";

/**
 * 新建项目。JIULI：复制九立项目 P1~P4 当前最新版本作为初始版本（source=copy:<原版本>）+ 通用 JSON；
 * BLANK：只有通用 JSON。运行、快照、标注都按项目隔离。
 */
export function createProject(input: { name: string; description?: string; template: ProjectTemplate }) {
  ensureSeed();
  const name = input.name.trim();
  if (!name) throw new Error("项目名称不能为空");
  const d = db();
  const project = { project_id: newId("proj"), name, description: input.description?.trim() || null, created_at: new Date().toISOString() };
  d.prepare("INSERT INTO projects (project_id, name, description, created_at) VALUES (?,?,?,?)").run(project.project_id, project.name, project.description, project.created_at);
  const sources = input.template === "JIULI" ? listPrompts(DEFAULT_PROJECT_ID) : listPrompts(DEFAULT_PROJECT_ID).filter((x) => x.prompt_kind === "GENERIC_JSON");
  for (const src of sources) {
    const promptId = `${project.project_id}-${src.prompt_id.replace(/^jiuli-/, "")}`;
    d.prepare("INSERT INTO prompts (prompt_id, project_id, prompt_kind, name, active_schema_version, renderer_id) VALUES (?,?,?,?,?,?)").run(promptId, project.project_id, src.prompt_kind, src.name, src.active_schema_version, src.renderer_id);
    copyLatestVersion(src.prompt_id, promptId, project.created_at);
  }
  return project;
}

/** 把九立项目某提示词的最新版本复制为新提示词的初始版本（source=copy:<原版本>） */
function copyLatestVersion(srcPromptId: string, promptId: string, createdAt: string) {
  const latest = listVersions(srcPromptId)[0];
  if (!latest) return;
  db()
    .prepare("INSERT INTO prompt_versions (version_id, prompt_id, label, system_prompt, user_prompt_template, variables_schema, content_hash, created_at, parent_version_id, source) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(newId("pv"), promptId, `复制自 九立 AI 核对 · ${latest.label}`, latest.system_prompt, latest.user_prompt_template, latest.variables_schema, latest.content_hash, createdAt, null, `copy:${latest.version_id}`);
}

export interface ProjectRow {
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
  archived_at: string | null;
}

/** 全部项目（含已归档，由界面分组显示） */
export function listProjects(): ProjectRow[] {
  ensureSeed();
  return db().prepare("SELECT project_id, name, description, created_at, archived_at FROM projects ORDER BY created_at").all() as unknown as ProjectRow[];
}

/** 改名 / 归档 / 恢复。归档只做标记，数据全部保留；默认项目不能归档。项目不存在返回 undefined */
export function updateProject(projectId: string, patch: { name?: string; archived?: boolean }): ProjectRow | undefined {
  ensureSeed();
  const d = db();
  if (!d.prepare("SELECT 1 FROM projects WHERE project_id = ?").get(projectId)) return undefined;
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("项目名称不能为空");
    d.prepare("UPDATE projects SET name = ? WHERE project_id = ?").run(name, projectId);
  }
  if (patch.archived !== undefined) {
    if (patch.archived && projectId === DEFAULT_PROJECT_ID) throw new Error("默认项目「九立 AI 核对」不能归档");
    d.prepare("UPDATE projects SET archived_at = ? WHERE project_id = ?").run(patch.archived ? new Date().toISOString() : null, projectId);
  }
  return listProjects().find((p) => p.project_id === projectId);
}

/**
 * 在项目内新建提示词。P1~P4 以九立项目同种类最新版本为起点（沿用其 Schema）；通用 JSON 从默认提示开始。
 */
export function createPrompt(input: { projectId: string; name: string; kind: PromptKind }): PromptDefinition {
  ensureSeed();
  const d = db();
  const name = input.name.trim();
  if (!name) throw new Error("提示词名称不能为空");
  if (!d.prepare("SELECT 1 FROM projects WHERE project_id = ?").get(input.projectId)) throw new Error("项目不存在");
  const src = listPrompts(DEFAULT_PROJECT_ID).find((p) => p.prompt_kind === input.kind);
  if (!src) throw new Error(`不支持的提示词种类 ${input.kind}`);
  const prompt: PromptDefinition = { prompt_id: newId("prm"), project_id: input.projectId, prompt_kind: input.kind, name, active_schema_version: src.active_schema_version, renderer_id: src.renderer_id };
  d.prepare("INSERT INTO prompts (prompt_id, project_id, prompt_kind, name, active_schema_version, renderer_id) VALUES (?,?,?,?,?,?)").run(prompt.prompt_id, prompt.project_id, prompt.prompt_kind, prompt.name, prompt.active_schema_version, prompt.renderer_id);
  if (input.kind === "GENERIC_JSON") insertSeed(prompt.prompt_id, "默认", "只输出一个合法 JSON 对象。", "studio-editor", null);
  else copyLatestVersion(src.prompt_id, prompt.prompt_id, new Date().toISOString());
  return prompt;
}

export function listPrompts(projectId: string): PromptDefinition[] {
  ensureSeed();
  // 通用提示词排最前（进入项目默认落在通用），九立预设按 P1→P4；同种类按创建顺序
  return db().prepare("SELECT * FROM prompts WHERE project_id = ? ORDER BY prompt_kind != 'GENERIC_JSON', prompt_kind, rowid").all(projectId) as unknown as PromptDefinition[];
}

export function getPrompt(promptId: string): PromptDefinition | undefined {
  ensureSeed();
  return db().prepare("SELECT * FROM prompts WHERE prompt_id = ?").get(promptId) as unknown as PromptDefinition | undefined;
}

export function listVersions(promptId: string): PromptVersion[] {
  ensureSeed();
  return db().prepare("SELECT * FROM prompt_versions WHERE prompt_id = ? ORDER BY created_at DESC, rowid DESC").all(promptId) as unknown as PromptVersion[];
}

export function getVersion(versionId: string): PromptVersion | undefined {
  return db().prepare("SELECT * FROM prompt_versions WHERE version_id = ?").get(versionId) as unknown as PromptVersion | undefined;
}

/**
 * 正式版本 ID。从未设定过时，取当时最新的版本作为初始正式版本并记一笔；之后只有 setStableVersion 能移动它。
 * 用户在编辑器里保存新版本不会改变正式版本。
 */
export function stableVersionId(promptId: string): string | null {
  const p = getPrompt(promptId);
  if (!p) return null;
  if (p.stable_version_id) return p.stable_version_id;
  const latest = listVersions(promptId)[0];
  if (!latest) return null;
  setStableVersion(promptId, latest.version_id, { decided_by: "system", note: "初始化：取当时最新的版本作为正式版本" });
  return latest.version_id;
}

/** 移动正式版本指针并追加变更记录（调用方负责审批校验） */
export function setStableVersion(promptId: string, versionId: string, meta: { candidate_id?: string | null; experiment_id?: string | null; decided_by: string; note?: string | null }) {
  const d = db();
  const prev = (d.prepare("SELECT stable_version_id FROM prompts WHERE prompt_id = ?").get(promptId) as { stable_version_id: string | null } | undefined)?.stable_version_id ?? null;
  d.prepare("UPDATE prompts SET stable_version_id = ? WHERE prompt_id = ?").run(versionId, promptId);
  d.prepare("INSERT INTO prompt_stable_history (prompt_id, version_id, previous_version_id, candidate_id, experiment_id, decided_by, at, note) VALUES (?,?,?,?,?,?,?,?)").run(
    promptId,
    versionId,
    prev,
    meta.candidate_id ?? null,
    meta.experiment_id ?? null,
    meta.decided_by,
    new Date().toISOString(),
    meta.note ?? null,
  );
}

export function stableHistory(promptId: string) {
  return db().prepare("SELECT * FROM prompt_stable_history WHERE prompt_id = ? ORDER BY id DESC").all(promptId) as Record<string, unknown>[];
}

/** 创建不可变 PromptVersion（不覆盖历史） */
export function createVersion(input: { prompt_id: string; label: string; system_prompt: string; user_prompt_template: string; parent_version_id?: string | null; change_note?: string | null }): PromptVersion {
  ensureSeed();
  const v: PromptVersion = {
    version_id: newId("pv"),
    prompt_id: input.prompt_id,
    label: input.label,
    system_prompt: input.system_prompt,
    user_prompt_template: input.user_prompt_template,
    variables_schema: null,
    content_hash: contentHash(input.system_prompt, input.user_prompt_template),
    created_at: new Date().toISOString(),
    parent_version_id: input.parent_version_id ?? null,
    source: "studio-editor",
    change_note: input.change_note?.trim() || null,
  };
  db()
    .prepare("INSERT INTO prompt_versions (version_id, prompt_id, label, system_prompt, user_prompt_template, variables_schema, content_hash, created_at, parent_version_id, source, change_note) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(v.version_id, v.prompt_id, v.label, v.system_prompt, v.user_prompt_template, v.variables_schema, v.content_hash, v.created_at, v.parent_version_id, v.source, v.change_note ?? null);
  return v;
}
