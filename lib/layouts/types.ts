import Ajv from "ajv";

/**
 * 版式（Layout）：描述「通用提示词的 JSON 输出，按什么样子显示」。
 * 只含 JSON Pointer 路径和显示名，不含代码或表达式（与渲染配置同一条安全规矩）。
 * 版式按提示词保存、只追加；模型原始输出不变，换版式即可重新显示旧运行。
 *
 * 路径约定（RFC6901）：
 * - itemsPath：指向「数组」的绝对路径，例如 "/items"；根本身是数组时写 ""。
 * - 其余 path：相对「某一项」的路径，例如 "/name"；"" 表示这一项本身。
 */

export const LAYOUT_KINDS = ["table", "cards", "checklist", "report"] as const;
export type LayoutKind = (typeof LAYOUT_KINDS)[number];

export const LAYOUT_LIMITS = { maxColumns: 30, maxFields: 30, maxSections: 50, maxPath: 200, maxLabel: 40 } as const;

export interface TableLayout {
  kind: "table";
  itemsPath: string;
  columns: { label: string; path: string; kind?: "text" | "number" | "state" }[];
}
export interface CardsLayout {
  kind: "cards";
  itemsPath: string;
  titlePath: string;
  /** 卡片右上角的小标签（如状态、类别），可选 */
  badgePath?: string;
  fields: { label: string; path: string }[];
}
export interface ChecklistLayout {
  kind: "checklist";
  itemsPath: string;
  titlePath: string;
  /** 状态字段；其值在 passValues 里算「通过」，否则算「未通过」 */
  statusPath?: string;
  passValues?: string[];
  /** 严重度字段；取值含 严重/BLOCKER/high 等按 BLOCKER，提醒/WARNING/medium 按 WARNING，其余 INFO */
  severityPath?: string;
  detailPath?: string;
}
export interface ReportLayout {
  kind: "report";
  /** 每节：标题 + 内容所在路径（绝对路径，值可为文字、数组或对象） */
  sections: { title: string; path: string }[];
}
export type Layout = (TableLayout | CardsLayout | ChecklistLayout | ReportLayout) & { version: 1; title?: string };

/** 保存下来的版式（只追加，version 递增） */
export interface StoredLayout {
  prompt_id: string;
  layout_version: number;
  layout: Layout;
  /** AI 生成 / 用户保存 */
  source: "AI" | "USER";
  created_at: string;
}

const path = { type: "string", maxLength: LAYOUT_LIMITS.maxPath, pattern: "^(/[^/]*)*$" };
const label = { type: "string", minLength: 1, maxLength: LAYOUT_LIMITS.maxLabel };
const common = { version: { const: 1 }, title: label };

const SCHEMA = {
  oneOf: [
    {
      type: "object",
      required: ["version", "kind", "itemsPath", "columns"],
      additionalProperties: false,
      properties: {
        ...common,
        kind: { const: "table" },
        itemsPath: path,
        columns: {
          type: "array",
          minItems: 1,
          maxItems: LAYOUT_LIMITS.maxColumns,
          items: {
            type: "object",
            required: ["label", "path"],
            additionalProperties: false,
            properties: { label, path, kind: { enum: ["text", "number", "state"] } },
          },
        },
      },
    },
    {
      type: "object",
      required: ["version", "kind", "itemsPath", "titlePath", "fields"],
      additionalProperties: false,
      properties: {
        ...common,
        kind: { const: "cards" },
        itemsPath: path,
        titlePath: path,
        badgePath: path,
        fields: {
          type: "array",
          maxItems: LAYOUT_LIMITS.maxFields,
          items: { type: "object", required: ["label", "path"], additionalProperties: false, properties: { label, path } },
        },
      },
    },
    {
      type: "object",
      required: ["version", "kind", "itemsPath", "titlePath"],
      additionalProperties: false,
      properties: {
        ...common,
        kind: { const: "checklist" },
        itemsPath: path,
        titlePath: path,
        statusPath: path,
        passValues: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 } },
        severityPath: path,
        detailPath: path,
      },
    },
    {
      type: "object",
      required: ["version", "kind", "sections"],
      additionalProperties: false,
      properties: {
        ...common,
        kind: { const: "report" },
        sections: {
          type: "array",
          minItems: 1,
          maxItems: LAYOUT_LIMITS.maxSections,
          items: { type: "object", required: ["title", "path"], additionalProperties: false, properties: { title: label, path } },
        },
      },
    },
  ],
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(SCHEMA);

/** 校验版式；失败时给中文原因。含疑似可执行代码的文字一律拒绝 */
export function validateLayout(input: unknown): { ok: true; layout: Layout } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!validate(input)) {
    errors.push("版式结构不符合要求");
    for (const e of (validate.errors ?? []).slice(0, 5)) if (e.instancePath) errors.push(`${e.instancePath} ${e.message}`);
  }
  if (/=>|function\s*\(|<script|javascript:/i.test(JSON.stringify(input ?? null))) errors.push("版式含有疑似可执行代码");
  return errors.length ? { ok: false, errors } : { ok: true, layout: input as Layout };
}

/** 解释器的输出（G1 产出，G2 的组件消费）。所有文字都是纯文本 */
export interface LayoutCard {
  id: string;
  title: string;
  badge?: string;
  fields: { label: string; value: string; pointer: string }[];
  /** 这一项在原始 JSON 里的位置 */
  pointer: string;
}
export interface LayoutSection {
  title: string;
  text: string;
  pointer: string;
  found: boolean;
}
export type LayoutResult =
  | { kind: "table"; table: import("@/lib/contracts/view-model").TableView }
  | { kind: "checklist"; issues: import("@/lib/contracts/view-model").IssueView[]; passCount: number; failCount: number }
  | { kind: "cards"; cards: LayoutCard[] }
  | { kind: "report"; sections: LayoutSection[]; markdown: string }
  | { kind: "mismatch"; reason: string };
