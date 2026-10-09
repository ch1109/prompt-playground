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
}

export const DEFAULT_PROJECT_ID = "jiuli";

/** 用户消息模板：{{input_json}} 在运行时替换为 InputBuilder 构造的请求 JSON */
export const DEFAULT_USER_TEMPLATE = "{{input_json}}";

const SEED: { id: string; kind: PromptKind; name: string; file?: string }[] = [
  { id: "jiuli-p1", kind: "JIULI_P1", name: "P1 委托材料识别", file: "P1_order_draft_FINAL_v3.0.txt" },
  { id: "jiuli-p2", kind: "JIULI_P2", name: "P2 查货材料识别", file: "P2_inspection_facts_FINAL_v3.0.txt" },
  { id: "jiuli-p3", kind: "JIULI_P3", name: "P3 商品对应关系", file: "P3_product_matching_FINAL_v3.0.txt" },
  { id: "jiuli-p4", kind: "JIULI_P4", name: "P4 字段核验与 Patch", file: "P4_field_verification_FINAL_v3.0.txt" },
  { id: "generic-json", kind: "GENERIC_JSON", name: "通用 JSON（未登记 Schema）" },
];

export function contentHash(system: string, user: string) {
  return sha256(`${system}\n\u0000\n${user}`);
}

const seeded = new WeakSet<object>();
export function ensureSeed() {
  const d = db();
  if (seeded.has(d)) return;
  const now = new Date().toISOString();
  d.prepare("INSERT OR IGNORE INTO projects VALUES (?,?,?,?)").run(DEFAULT_PROJECT_ID, "九立 AI 核对", "P1~P4 结构化提示词调试", now);
  for (const s of SEED) {
    d.prepare("INSERT OR IGNORE INTO prompts VALUES (?,?,?,?,?,?)").run(
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
    .prepare("INSERT INTO prompt_versions VALUES (?,?,?,?,?,?,?,?,?,?)")
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

export function listProjects() {
  ensureSeed();
  return db().prepare("SELECT * FROM projects ORDER BY created_at").all();
}

export function listPrompts(projectId: string): PromptDefinition[] {
  ensureSeed();
  return db().prepare("SELECT * FROM prompts WHERE project_id = ? ORDER BY prompt_id").all(projectId) as unknown as PromptDefinition[];
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

/** 创建不可变 PromptVersion（不覆盖历史） */
export function createVersion(input: { prompt_id: string; label: string; system_prompt: string; user_prompt_template: string; parent_version_id?: string | null }): PromptVersion {
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
  };
  db()
    .prepare("INSERT INTO prompt_versions VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(v.version_id, v.prompt_id, v.label, v.system_prompt, v.user_prompt_template, v.variables_schema, v.content_hash, v.created_at, v.parent_version_id, v.source);
  return v;
}
