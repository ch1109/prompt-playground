import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dbPath } from "@/lib/repositories/db";

// 网页「模型设置」保存的配置（含密钥），只在服务端读写，绝不返回给浏览器。
// 位置：未设置 STUDIO_DB_PATH 时是 data/model-config.json；设置了（如 e2e 的独立库）则是「数据库路径 + .model-config.json」，
// 与该数据库一起清理；也可用 STUDIO_MODEL_CONFIG_PATH 直接指定。

export interface ModelConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  updatedAt: string;
}

export function modelConfigPath(): string {
  if (process.env.STUDIO_MODEL_CONFIG_PATH) return process.env.STUDIO_MODEL_CONFIG_PATH;
  const db = process.env.STUDIO_DB_PATH;
  if (!db) return join(process.cwd(), "data", "model-config.json");
  return db === ":memory:" ? join(tmpdir(), "studio-memory.model-config.json") : `${dbPath()}.model-config.json`;
}

/** 文件不存在或损坏都返回 null（调用方退回环境变量），不抛错 */
export function readModelConfig(): ModelConfig | null {
  try {
    const c = JSON.parse(readFileSync(modelConfigPath(), "utf8")) as Partial<ModelConfig>;
    if (typeof c.baseUrl !== "string" || typeof c.model !== "string" || typeof c.apiKey !== "string") return null;
    return { baseUrl: c.baseUrl, model: c.model, apiKey: c.apiKey, updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : "" };
  } catch {
    return null;
  }
}

/** 先写临时文件（仅本人可读写）再改名，避免写到一半 */
export function writeModelConfig(c: { baseUrl: string; model: string; apiKey: string }): void {
  const path = modelConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const data: ModelConfig = { baseUrl: c.baseUrl, model: c.model, apiKey: c.apiKey, updatedAt: new Date().toISOString() };
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function clearModelConfig(): void {
  rmSync(modelConfigPath(), { force: true });
}

export type ModelConfigSource = "settings" | "env" | "none";

/** 实际生效的配置：设置文件三项齐全 → 用设置；否则用环境变量（MODEL_BASE_URL / MODEL_NAME / MODEL_API_KEY） */
export function effectiveModelConfig(): { source: ModelConfigSource; baseUrl?: string; model?: string; apiKey?: string } {
  const f = readModelConfig();
  if (f?.baseUrl && f.model && f.apiKey) return { source: "settings", baseUrl: f.baseUrl, model: f.model, apiKey: f.apiKey };
  const env = { baseUrl: process.env.MODEL_BASE_URL, model: process.env.MODEL_NAME, apiKey: process.env.MODEL_API_KEY };
  return { source: env.baseUrl && env.model && env.apiKey ? "env" : "none", ...env };
}
