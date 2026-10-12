import { structuredPatch, type StructuredPatchHunk } from "diff";
import type { Run } from "@/lib/contracts/run";
import { escapeToken } from "@/lib/pipeline/json-pointer";

// 两次 Run 的比较（纯函数）：界面的版本对比与 MCP compare_runs 共用。

/** 把 JSON 展平为 pointer → 标量 */
export function flatten(v: unknown, p = "", out = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(v)) {
    if (!v.length) out.set(p, "[]");
    v.forEach((x, i) => flatten(x, `${p}/${i}`, out));
  } else if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (!keys.length) out.set(p, "{}");
    for (const k of keys) flatten((v as Record<string, unknown>)[k], `${p}/${escapeToken(k)}`, out);
  } else out.set(p, JSON.stringify(v));
  return out;
}

type Obj = Record<string, unknown>;
/** UNALIGNED = 对象数组找不到可靠业务键，无法确定哪两项是同一业务对象（不按行号硬配） */
export type DiffRow = { pointer: string; kind: "ADDED" | "REMOVED" | "CHANGED" | "UNALIGNED"; a?: string; b?: string };
type Stats = { same: number };

const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));

/**
 * 对象数组的业务键（按优先级）：委托行 ID、v2 行引用、字段名、文件 ID、原文位置，最后才是模型自编的序号。
 * 原文位置 = 来源文件 + Sheet + 页 + 行，比模型序号可靠：少一行时后续行不会错位。
 */
const ROW_KEYS: [string, (o: Obj) => string | null][] = [
  ["order_row_id", (o) => str(o.order_row_id)],
  ["local_row_ref", (o) => str(o.local_row_ref)],
  ["local_raw_row_ref", (o) => str(o.local_raw_row_ref)],
  ["raw_row_id", (o) => str(o.raw_row_id)],
  ["field", (o) => str(o.field)],
  ["file_id", (o) => str(o.file_id)],
  [
    "原文位置",
    (o) => {
      const s = o.source as Obj | undefined;
      if (!s || typeof s !== "object" || (s.row == null && s.page == null)) return null;
      // Excel 用 Sheet + 行定位，页码对 Excel 没有意义（模型时填 1、时填 null），不参与对齐
      const hasSheet = s.sheet != null && s.sheet !== "";
      return [s.file_id, hasSheet ? s.sheet : "-", hasSheet ? "-" : s.page, s.row].map((x) => (x == null || x === "" ? "-" : String(x))).join(":");
    },
  ],
  ["record_no", (o) => str(o.record_no)],
  ["row_no", (o) => str(o.row_no)],
];

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** 两边都能为每个元素给出非空且不重复的键，才用它对齐 */
function pickKey(a: unknown[], b: unknown[]) {
  if (!a.length || !b.length || !a.every(isObj) || !b.every(isObj)) return null;
  for (const [name, fn] of ROW_KEYS) {
    const ka = (a as Obj[]).map(fn);
    const kb = (b as Obj[]).map(fn);
    const ok = (ks: (string | null)[]) => ks.every((k) => k !== null) && new Set(ks).size === ks.length;
    if (ok(ka) && ok(kb)) return { name, ka: ka as string[], kb: kb as string[] };
  }
  return null;
}

function diffValue(a: unknown, b: unknown, p: string, rows: DiffRow[], st: Stats) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const key = pickKey(a, b);
    if (key) {
      const seg = (k: string) => `${p}/[${key.name}=${k}]`;
      const ib = new Map(key.kb.map((k, i) => [k, i]));
      key.ka.forEach((k, i) => (ib.has(k) ? diffValue(a[i], b[ib.get(k)!], seg(k), rows, st) : leaves(a[i], seg(k), "REMOVED", rows)));
      const ia = new Set(key.ka);
      key.kb.forEach((k, i) => !ia.has(k) && leaves(b[i], seg(k), "ADDED", rows));
      return;
    }
    if (!a.length || !b.length) {
      if (a.length !== b.length) rows.push({ pointer: p, kind: "CHANGED", a: a.length ? `[${a.length} 项]` : "[]", b: b.length ? `[${b.length} 项]` : "[]" });
      else st.same++;
      return;
    }
    // 对象数组没有可靠业务键：不凭位置认定是同一对象，整体标为无法对齐
    if ((a.some(isObj) || b.some(isObj)) && JSON.stringify(a) !== JSON.stringify(b)) {
      rows.push({ pointer: p, kind: "UNALIGNED", a: `[${a.length} 项] ${JSON.stringify(a).slice(0, 300)}`, b: `[${b.length} 项] ${JSON.stringify(b).slice(0, 300)}` });
      return;
    }
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= b.length) leaves(a[i], `${p}/${i}`, "REMOVED", rows);
      else if (i >= a.length) leaves(b[i], `${p}/${i}`, "ADDED", rows);
      else diffValue(a[i], b[i], `${p}/${i}`, rows, st);
    }
    return;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) {
      if (k in b) diffValue(a[k], b[k], `${p}/${escapeToken(k)}`, rows, st);
      else leaves(a[k], `${p}/${escapeToken(k)}`, "REMOVED", rows);
    }
    for (const k of Object.keys(b)) if (!(k in a)) leaves(b[k], `${p}/${escapeToken(k)}`, "ADDED", rows);
    return;
  }
  // 标量或类型不同：作为整体比较（容器按展平后的文本比较）
  const fa = JSON.stringify(a);
  const fb = JSON.stringify(b);
  if (fa === fb) st.same += flatten(a).size;
  if (fa !== fb) {
    if (isObj(a) || Array.isArray(a) || isObj(b) || Array.isArray(b)) {
      leaves(a, p, "REMOVED", rows);
      leaves(b, p, "ADDED", rows);
    } else rows.push({ pointer: p, kind: "CHANGED", a: fa, b: fb });
  }
}

function leaves(v: unknown, p: string, kind: "ADDED" | "REMOVED", rows: DiffRow[]) {
  for (const [k, val] of flatten(v, p)) rows.push(kind === "ADDED" ? { pointer: k, kind, b: val } : { pointer: k, kind, a: val });
}

/**
 * 两次输出的差异：对象数组按业务键对齐（见 ROW_KEYS），路径中的 [键=值] 表示按业务键定位；
 * 对象数组找不到可靠键时标为 UNALIGNED（无法对齐），不按行号硬配；标量数组按位置比较。
 */
export function diffSummary(a: unknown, b: unknown): { rows: DiffRow[]; same: number } {
  const rows: DiffRow[] = [];
  const st: Stats = { same: 0 };
  diffValue(a, b, "", rows, st);
  return { rows: rows.sort((x, y) => x.pointer.localeCompare(y.pointer)), same: st.same };
}

export function diffJson(a: unknown, b: unknown): DiffRow[] {
  return diffSummary(a, b).rows;
}

const dash = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

/** 两段文本的逐行差异（前后各保留 2 行上下文）；任一方没有文本时为 null */
export function textHunks(a?: string, b?: string): StructuredPatchHunk[] | null {
  if (a === undefined || b === undefined) return null;
  return structuredPatch("A", "B", a, b, "", "", { context: 2 }).hunks;
}

/** 两次 Run 的关键指标与实际发送提示词的差异（仅对比，不代表准确率） */
/** 版本显示：优先版本名称，其次 ID；运行时为未保存草稿的另行标注 */
function versionText(r: Run, label?: string | null) {
  if (!r.prompt_version_id) return r.mode === "MODEL_RUN" ? "未保存草稿" : "—";
  const name = label || r.prompt_version_id;
  return r.is_unsaved_draft ? `${name}（基于此版本的未保存草稿）` : name;
}

const imagesText = (r: Run) => (r.attached_images === null || r.attached_images === undefined ? "未开启" : `${r.attached_images.length} 张 ${r.attached_images.map((i) => i.sha256.slice(0, 6)).join(",")}`);
const preprocessText = (r: Run) => (r.input_manifest ? [...new Set(r.input_manifest.files.map((f) => f.preprocessor_version ?? "未知"))].join("；") || "无原件" : "未记录（v1.1 之前）");

/**
 * 严格同条件判定（R-07）：同一构造输入、同一附带图片、同一预处理版本、同一输入构造器、同一模型与参数。
 * 只有两边都是真实模型运行才适用；判不出（缺记录）的项也算不满足，不默认相同。
 */
export function strictConditions(a: Run, b: Run): { applicable: boolean; strict: boolean; reasons: string[] } {
  if (a.mode !== "MODEL_RUN" || b.mode !== "MODEL_RUN") return { applicable: false, strict: false, reasons: ["至少一方不是真实模型运行（仅渲染 / 回放没有请求），只能比较输出"] };
  const reasons: string[] = [];
  const same = (name: string, x: unknown, y: unknown) => {
    if (x === undefined || x === null || y === undefined || y === null) reasons.push(`${name}：至少一方未记录`);
    else if (JSON.stringify(x) !== JSON.stringify(y)) reasons.push(`${name}不同`);
  };
  same("构造输入 Hash", a.built_input_hash, b.built_input_hash);
  same("模型", `${a.model_provider}/${a.model_name}`, `${b.model_provider}/${b.model_name}`);
  same("模型参数", a.model_params ? Object.entries(a.model_params).sort() : null, b.model_params ? Object.entries(b.model_params).sort() : null);
  if (imagesText(a) !== imagesText(b)) reasons.push("附带原件图片不同");
  same("输入构造器", (a as Run & { input_builder_id?: string }).input_builder_id, (b as Run & { input_builder_id?: string }).input_builder_id);
  same("预处理版本", a.input_manifest ? preprocessText(a) : null, b.input_manifest ? preprocessText(b) : null);
  return { applicable: true, strict: reasons.length === 0, reasons };
}

/**
 * 输入可比性（v1.3 §3.5 / §10.4）：两次运行是否用的同一份输入、同一预处理。
 * 不可比时仍可看技术差异，但不能当作提示词改进的依据；缺记录按不可比处理，不默认相同。
 */
export function inputComparability(a: Run, b: Run): { comparable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const sameSnapshot = !!a.input_snapshot_id && a.input_snapshot_id === b.input_snapshot_id;
  const sameBuilt = !!a.built_input_hash && a.built_input_hash === b.built_input_hash;
  if (!sameSnapshot && !sameBuilt) {
    if ((!a.input_snapshot_id && !a.built_input_hash) || (!b.input_snapshot_id && !b.built_input_hash)) reasons.push("至少一方没有输入记录（例如粘贴的输出）");
    else reasons.push("两次运行用的输入不同（样本或输入快照不同）");
  }
  if (a.mode === "MODEL_RUN" && b.mode === "MODEL_RUN") {
    if (!a.input_manifest || !b.input_manifest) reasons.push("至少一方没有预处理记录（v1.1 之前的运行）");
    else if (preprocessText(a) !== preprocessText(b)) reasons.push("预处理版本不同");
  }
  return { comparable: reasons.length === 0, reasons };
}

export function compareRuns(a: Run, b: Run, versionLabels: [string | null | undefined, string | null | undefined] = [undefined, undefined]) {
  const schemaErrors = (r: Run) => String(r.schema_diagnostics.filter((d) => d.level === "ERROR").length);
  const rows: [string, (r: Run) => string][] = [
    ["状态", (r) => r.status],
    ["模式", (r) => r.mode],
    ["模型", (r) => dash(r.model_name)],
    ["Prompt 版本", (r) => versionText(r, versionLabels[r === a ? 0 : 1])],
    ["实际提示词 Hash", (r) => dash(r.actual_prompt_hash?.slice(0, 12))],
    ["构造输入 Hash", (r) => dash(r.built_input_hash?.slice(0, 12))],
    ["输入快照", (r) => dash(r.input_snapshot_id)],
    ["输入构造器", (r) => dash((r as Run & { input_builder_id?: string }).input_builder_id)],
    ["附带原件图片", imagesText],
    ["预处理版本", preprocessText],
    ["输入覆盖", (r) => (r.input_manifest ? `${r.input_manifest.complete ? "完整" : "不完整"} · 文本 ${r.input_manifest.sent_text_chars} 字 · 图片 ${r.input_manifest.sent_image_count}` : "未记录")],
    ["模型参数", (r) => (r.model_params ? JSON.stringify(r.model_params) : "—")],
    ["输入 Token", (r) => dash(r.token_usage?.prompt_tokens)],
    ["输出 Token", (r) => dash(r.token_usage?.completion_tokens)],
    ["耗时 (ms)", (r) => dash(r.latency_ms)],
    ["结束原因", (r) => dash(r.finish_reason)],
    ["Schema 错误数", schemaErrors],
    ["原始响应 Hash", (r) => dash(r.raw_response_hash?.slice(0, 12))],
  ];
  return {
    input: inputComparability(a, b),
    strict: strictConditions(a, b),
    metrics: rows.map(([key, f]) => ({ key, a: f(a), b: f(b), differs: f(a) !== f(b) })),
    system: textHunks(a.actual_prompt?.system, b.actual_prompt?.system),
    user: textHunks(a.actual_prompt?.user, b.actual_prompt?.user),
  };
}
