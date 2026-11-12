import { validateLayout, type Layout, type StoredLayout } from "@/lib/layouts/types";
import { db } from "./db";
import { getPrompt } from "./prompts";

// 输出版式：按提示词保存，只追加。读出时再校验一次，不合法的当作没有

interface Row {
  prompt_id: string;
  layout_version: number;
  layout_json: string;
  source: "AI" | "USER";
  created_at: string;
}

function toStored(r: Row): StoredLayout | null {
  try {
    const v = validateLayout(JSON.parse(r.layout_json));
    return v.ok ? { prompt_id: r.prompt_id, layout_version: r.layout_version, layout: v.layout, source: r.source, created_at: r.created_at } : null;
  } catch {
    return null;
  }
}

export class LayoutError extends Error {
  constructor(
    public code: "PROMPT_NOT_FOUND" | "NOT_GENERIC_PROMPT" | "INVALID_LAYOUT",
    message: string,
    public httpStatus: number,
  ) {
    super(message);
  }
}

export function getLayout(promptId: string): StoredLayout | null {
  const r = db().prepare("SELECT * FROM prompt_layouts WHERE prompt_id = ? ORDER BY layout_version DESC LIMIT 1").get(promptId) as Row | undefined;
  return r ? toStored(r) : null;
}

/** 全部版本，新的在前；读出后不合法的版本跳过 */
export function listLayouts(promptId: string): StoredLayout[] {
  const rows = db().prepare("SELECT * FROM prompt_layouts WHERE prompt_id = ? ORDER BY layout_version DESC").all(promptId) as unknown as Row[];
  return rows.map(toStored).filter((x): x is StoredLayout => !!x);
}

export function saveLayout(promptId: string, layout: Layout, source: "AI" | "USER"): StoredLayout {
  const v = validateLayout(layout);
  if (!v.ok) throw new LayoutError("INVALID_LAYOUT", `版式不合法：${v.errors.join("；")}`, 400);
  const json = JSON.stringify(v.layout);
  const last = db().prepare("SELECT * FROM prompt_layouts WHERE prompt_id = ? ORDER BY layout_version DESC LIMIT 1").get(promptId) as Row | undefined;
  if (last && last.layout_json === json) {
    const same = toStored(last);
    if (same) return same;
  }
  const now = new Date().toISOString();
  const version = (last?.layout_version ?? 0) + 1;
  db().prepare("INSERT INTO prompt_layouts VALUES (?,?,?,?,?)").run(promptId, version, json, source, now);
  return { prompt_id: promptId, layout_version: version, layout: v.layout, source, created_at: now };
}

/** 路由层用：检查提示词存在且是通用提示词，再保存 */
export function saveLayoutForPrompt(promptId: string, layout: unknown, source: "AI" | "USER" = "USER"): StoredLayout {
  const p = getPrompt(promptId);
  if (!p) throw new LayoutError("PROMPT_NOT_FOUND", "Prompt 不存在", 404);
  if (p.prompt_kind !== "GENERIC_JSON") throw new LayoutError("NOT_GENERIC_PROMPT", "只有通用提示词可以设置版式", 400);
  return saveLayout(promptId, layout as Layout, source);
}
