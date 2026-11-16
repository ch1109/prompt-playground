import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import type { PromptKind, SchemaValidation, SchemaValidationError } from "@/lib/contracts/run";
import { getByPointer } from "@/lib/pipeline/json-pointer";
import { P1_V2, P2_V2, P3_V2, P4_V2 } from "./jiuli-v2";
import { P1_V3, P2_V3, P3_V3, P4_V3 } from "./jiuli-v3";
import { P1_V15, P2_V15, P3_V15, P4_V15, V15_SCHEMA_VERSION } from "./jiuli-v15";

export const SCHEMA_REGISTRY_VERSION = "1.0.0";

export interface SchemaEntry {
  schemaId: string;
  promptKind: PromptKind;
  schemaVersion: string;
  /** Schema 自身版本：结构推导规则变化时递增 */
  revision: string;
  origin: string;
  schema: object;
}

const V2_ORIGIN = "Studio 依据规格包 v2.0 示例推导（非九立官方 Schema）";
const V3_ORIGIN = "Studio 依据九立 v3.0 提示词输出章节推导（非九立官方 Schema）";
const V15_ORIGIN = "Studio 依据九立二阶段 demo v15 提示词输出章节推导（只校验骨架，非九立官方 Schema）";

export const SCHEMAS: SchemaEntry[] = [
  { schemaId: "jiuli-p1-v2", promptKind: "JIULI_P1", schemaVersion: "jiuli-ai-v2", revision: "1.0.0", origin: V2_ORIGIN, schema: P1_V2 },
  { schemaId: "jiuli-p2-v2", promptKind: "JIULI_P2", schemaVersion: "jiuli-ai-v2", revision: "1.0.0", origin: V2_ORIGIN, schema: P2_V2 },
  { schemaId: "jiuli-p3-v2", promptKind: "JIULI_P3", schemaVersion: "jiuli-ai-v2", revision: "1.0.0", origin: V2_ORIGIN, schema: P3_V2 },
  { schemaId: "jiuli-p4-v2", promptKind: "JIULI_P4", schemaVersion: "jiuli-ai-v2", revision: "1.0.0", origin: V2_ORIGIN, schema: P4_V2 },
  { schemaId: "jiuli-p1-v3", promptKind: "JIULI_P1", schemaVersion: "jiuli-ai-v3", revision: "1.0.0", origin: V3_ORIGIN, schema: P1_V3 },
  { schemaId: "jiuli-p2-v3", promptKind: "JIULI_P2", schemaVersion: "jiuli-ai-v3", revision: "1.0.0", origin: V3_ORIGIN, schema: P2_V3 },
  { schemaId: "jiuli-p3-v3", promptKind: "JIULI_P3", schemaVersion: "jiuli-ai-v3", revision: "1.0.0", origin: V3_ORIGIN, schema: P3_V3 },
  { schemaId: "jiuli-p4-v3", promptKind: "JIULI_P4", schemaVersion: "jiuli-ai-v3", revision: "1.0.0", origin: V3_ORIGIN, schema: P4_V3 },
  { schemaId: "jiuli-p1-v15", promptKind: "JIULI_P1", schemaVersion: V15_SCHEMA_VERSION, revision: "1.0.0", origin: V15_ORIGIN, schema: P1_V15 },
  { schemaId: "jiuli-p2-v15", promptKind: "JIULI_P2", schemaVersion: V15_SCHEMA_VERSION, revision: "1.0.0", origin: V15_ORIGIN, schema: P2_V15 },
  { schemaId: "jiuli-p3-v15", promptKind: "JIULI_P3", schemaVersion: V15_SCHEMA_VERSION, revision: "1.0.0", origin: V15_ORIGIN, schema: P3_V15 },
  { schemaId: "jiuli-p4-v15", promptKind: "JIULI_P4", schemaVersion: V15_SCHEMA_VERSION, revision: "1.0.0", origin: V15_ORIGIN, schema: P4_V15 },
];

const PROMPT_CODE: Record<string, PromptKind> = { P1: "JIULI_P1", P2: "JIULI_P2", P3: "JIULI_P3", P4: "JIULI_P4" };

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new Map<string, ValidateFunction>();

function validator(entry: SchemaEntry): ValidateFunction {
  let fn = compiled.get(entry.schemaId);
  if (!fn) {
    fn = ajv.compile(entry.schema);
    compiled.set(entry.schemaId, fn);
  }
  return fn;
}

export function findSchema(promptKind: PromptKind, schemaVersion: string | undefined): SchemaEntry | undefined {
  return SCHEMAS.find((s) => s.promptKind === promptKind && s.schemaVersion === schemaVersion);
}

function describeActual(value: unknown, found: boolean): string {
  if (!found) return "缺失";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return `string(${JSON.stringify(value.length > 40 ? value.slice(0, 40) + "…" : value)})`;
  return typeof value;
}

function toError(doc: unknown, e: ErrorObject): SchemaValidationError | null {
  const params = e.params as Record<string, unknown>;
  let pointer = e.instancePath;
  let expected: string;
  switch (e.keyword) {
    case "required":
      pointer = `${e.instancePath}/${String(params.missingProperty).replace(/~/g, "~0").replace(/\//g, "~1")}`;
      expected = "必需字段";
      break;
    case "type":
      expected = `类型 ${Array.isArray(params.type) ? (params.type as string[]).join("|") : String(params.type)}`;
      break;
    case "enum":
      expected = `枚举之一：${(params.allowedValues as unknown[]).join(" / ")}`;
      break;
    case "const":
      expected = `固定值 ${JSON.stringify(params.allowedValue)}`;
      break;
    case "anyOf":
      // anyOf 的子错误已单独列出 required；这里给一个汇总
      expected = "满足 row_patches 或 calculation_checks 之一";
      break;
    default:
      expected = e.message ?? e.keyword;
  }
  const actual = getByPointer(doc, pointer);
  return {
    jsonPointer: pointer,
    keyword: e.keyword,
    expected,
    actual: describeActual(actual.value, actual.found),
    message: e.message ?? "",
  };
}

/**
 * 按 (promptKind, schema_version) 查注册表并校验。
 * - 工作区选择的 Prompt 种类与 JSON 自报的 prompt 不一致 → INVALID（不偷偷换模板）
 * - GENERIC_JSON 或 schema_version 未登记 → UNKNOWN_SCHEMA（不强套九立模板）
 */
export function validateAgainstRegistry(doc: unknown, promptKind: PromptKind): SchemaValidation {
  const obj = (doc && typeof doc === "object" ? doc : {}) as Record<string, unknown>;
  // 二阶段 demo 的 v15 输出不带 schema_version，只有顶层 "v": 15
  const schemaVersion = typeof obj.schema_version === "string" ? obj.schema_version : obj.v === 15 ? V15_SCHEMA_VERSION : undefined;

  if (promptKind === "GENERIC_JSON") {
    return { status: "UNKNOWN_SCHEMA", promptKind, schemaVersion, errors: [] };
  }

  const entry = findSchema(promptKind, schemaVersion);
  if (!entry) {
    return { status: "UNKNOWN_SCHEMA", promptKind, schemaVersion, errors: [] };
  }

  const errors: SchemaValidationError[] = [];
  const declared = typeof obj.prompt === "string" ? PROMPT_CODE[obj.prompt] : undefined;
  if (declared && declared !== promptKind) {
    errors.push({
      jsonPointer: "/prompt",
      keyword: "promptKind",
      expected: `当前工作区为 ${promptKind}`,
      actual: `JSON 声明为 ${String(obj.prompt)}`,
      message: "JSON 声明的 prompt 与当前选择的 Prompt 不一致",
    });
  }

  const fn = validator(entry);
  fn(doc);
  for (const e of fn.errors ?? []) {
    const err = toError(doc, e);
    if (err) errors.push(err);
  }

  return {
    status: errors.length ? "INVALID" : "VALID",
    schemaId: entry.schemaId,
    schemaVersion: entry.schemaVersion,
    promptKind,
    errors,
  };
}

/** 从 JSON 自报的 prompt 字段推断种类（用于导入时预选，不替代用户选择） */
export function detectPromptKind(doc: unknown): PromptKind | undefined {
  const p = (doc as Record<string, unknown> | null)?.prompt;
  return typeof p === "string" ? PROMPT_CODE[p] : undefined;
}
