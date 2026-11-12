import type {
  Cell,
  CellState,
  Diagnostic,
  EvidenceView,
  IssueView,
  TableColumn,
  TableRow,
} from "@/lib/contracts/view-model";
import { join } from "@/lib/pipeline/json-pointer";
import type { AdapterContext, AdapterOutput } from "./types";

// ---------- 安全取值（Schema 无效时 Adapter 仍需安全运行，不能抛异常导致整页失败） ----------

export type Obj = Record<string, unknown>;

export function obj(v: unknown): Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
export function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}
export function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ---------- 单元格语义状态（AT03：无牌 / 空白 / 0 各保持原语义） ----------

const EXPLICIT_NONE = new Set(["无牌", "无品牌", "no brand", "nobrand"]);

export function cellState(fieldKey: string, value: unknown): CellState {
  if (value === undefined || value === null) return "NOT_DETECTED";
  if (typeof value === "string") {
    if (value === "") return "NOT_DETECTED";
    if (fieldKey === "brand" && EXPLICIT_NONE.has(value.trim().toLowerCase())) return "EXPLICIT_NONE";
  }
  return "PRESENT";
}

export function makeCell(
  rowId: string,
  fieldKey: string,
  value: unknown,
  jsonPointer: string,
  sourceRefIds: string[] = [],
  state?: CellState,
): Cell {
  return { rowId, fieldKey, value, jsonPointer, sourceRefIds, state: state ?? cellState(fieldKey, value) };
}

// ---------- ViewModel 构建器 ----------

export class VMBuilder {
  out: AdapterOutput = { tables: [], issues: [], relations: [], changes: [], evidence: [], diagnostics: [] };
  private evidenceIds = new Set<string>();
  private issueSeq = 0;

  constructor(private ctx: AdapterContext) {}

  diag(level: Diagnostic["level"], code: string, message: string, jsonPointer?: string) {
    this.out.diagnostics.push({ phase: "ADAPTER", level, code, message, jsonPointer });
  }

  /** 由 Source 对象生成证据（id 用 JSON Pointer，保证唯一且稳定） */
  sourceEvidence(source: unknown, pointer: string, location: "RESPONSE" | "REQUEST", label?: string): string | undefined {
    const s = obj(source);
    const fileId = strOrUndef(s.file_id);
    if (!fileId && s.raw_text === undefined) return undefined;
    return this.addEvidence({
      id: (location === "REQUEST" ? "req:" : "") + pointer,
      fileId: fileId ?? "",
      fileName: strOrUndef(s.file_name),
      page: numOrNull(s.page),
      sheet: strOrUndef(s.sheet) ?? null,
      row: numOrNull(s.row),
      column: strOrUndef(s.column) ?? null,
      rawText: strOrUndef(s.raw_text) ?? null,
      availability: "METADATA_ONLY",
      jsonPointer: pointer,
      location,
      label,
    });
  }

  addEvidence(e: EvidenceView): string {
    if (!this.evidenceIds.has(e.id)) {
      this.evidenceIds.add(e.id);
      this.out.evidence.push(this.resolveAvailability(e));
    }
    return e.id;
  }

  /** 只有引用 ID、却找不到来源定义：登记为 MISSING，不伪造来源 */
  missingEvidence(id: string, label: string) {
    if (this.evidenceIds.has(id)) return id;
    return this.addEvidence({ id, fileId: "", availability: "MISSING", rawText: null, label });
  }

  hasEvidence(id: string) {
    return this.evidenceIds.has(id);
  }

  private resolveAvailability(e: EvidenceView): EvidenceView {
    if (e.availability === "MISSING") return e;
    const m = this.ctx.materials?.[e.fileId];
    if (!m) return { ...e, availability: "METADATA_ONLY" };
    return { ...e, availability: m.availability === "MISSING" ? "METADATA_ONLY" : m.availability, fileName: e.fileName ?? m.fileName };
  }

  issue(i: Omit<IssueView, "id"> & { id?: string }) {
    this.out.issues.push({ ...i, id: i.id ?? `issue-${++this.issueSeq}` });
  }

  /** 行 ID 去重：重复时诊断并引入 sourcePath，禁止静默合并（PRD §3.4） */
  uniqueRowIds() {
    const seen = new Map<string, number>();
    return (preferred: string, sourcePath: string): string => {
      const n = seen.get(preferred) ?? 0;
      seen.set(preferred, n + 1);
      if (n === 0) return preferred;
      this.diag("WARNING", "DUPLICATE_ROW_REF", `业务引用 ${preferred} 重复出现，已用来源路径区分（未合并）`, sourcePath);
      return `${preferred}@${sourcePath}`;
    };
  }
}

export function table(id: string, title: string, columns: TableColumn[], rows: TableRow[]) {
  return { id, title, columns, rows };
}

/** 把一个任意对象的标量字段铺成单元格；复杂值保留原对象 */
export function cellsFromObject(rowId: string, o: Obj, basePointer: string, keys: string[], refs?: (k: string) => string[]) {
  const cells: Record<string, Cell> = {};
  for (const k of keys) {
    cells[k] = makeCell(rowId, k, o[k], join(basePointer, k), refs ? refs(k) : []);
  }
  return cells;
}

/** 检测 v2.1 可选增强字段：只有数据中真的出现才展示，并给出 INFO 诊断 */
export function detectOptionalFields(b: VMBuilder, items: unknown[], names: string[], basePointer: string): string[] {
  const present = names.filter((n) => items.some((it) => Object.prototype.hasOwnProperty.call(obj(it), n)));
  for (const n of present) {
    b.diag("INFO", "OPTIONAL_ENHANCEMENT_FIELD", `检测到可选增强字段 ${n}：未登记正式 v2.1 Schema，仅按原值展示`, basePointer);
  }
  return present;
}

export function display(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// ---------- v3 请求上下文：evidence_key 索引 ----------

export interface RequestEvidence {
  pointer: string;
  item: Obj;
}

/** 遍历 request JSON，收集所有带 evidence_key 的对象（P3 order_rows/inspection_candidates、P4 fields/origin_parts 等）。
 *  同一 key 出现多次且内容不同 → 记入 conflicts（解析时取首次出现并在证据上标注"键冲突"）。 */
export function indexEvidenceKeys(request: unknown): { index: Map<string, RequestEvidence>; conflicts: Map<string, string[]> } {
  const index = new Map<string, RequestEvidence>();
  const conflicts = new Map<string, string[]>();
  const walk = (v: unknown, p: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, join(p, i)));
    else if (v && typeof v === "object") {
      const o = v as Obj;
      if (typeof o.evidence_key === "string") {
        const prev = index.get(o.evidence_key);
        if (!prev) index.set(o.evidence_key, { pointer: p, item: o });
        else if (JSON.stringify(prev.item) !== JSON.stringify(o)) conflicts.set(o.evidence_key, [...(conflicts.get(o.evidence_key) ?? [prev.pointer]), p]);
      }
      for (const [k, x] of Object.entries(o)) walk(x, join(p, k));
    }
  };
  walk(request, "");
  return { index, conflicts };
}

export function reportKeyConflicts(b: VMBuilder, conflicts: Map<string, string[]>) {
  if (!conflicts.size) return;
  const [first, ptrs] = [...conflicts.entries()][0];
  b.diag(
    "WARNING",
    "EVIDENCE_KEY_CONFLICT_IN_REQUEST",
    `请求上下文中有 ${conflicts.size} 个 evidence_key 重复且内容不同（例：${first} 出现在 ${ptrs.join("、")}）。解析时取首次出现，相关证据已标注「键冲突」。`,
  );
}

/** 把 evidence_key 解析为证据：找到则登记来源（REQUEST），找不到登记 MISSING 并诊断 */
export function resolveEvidenceKeys(
  b: VMBuilder,
  keys: unknown,
  idx: Map<string, RequestEvidence> | undefined,
  pointer: string,
  conflicts?: Map<string, string[]>,
): string[] {
  return arr(keys).map((k0) => {
    const k = String(k0);
    if (b.hasEvidence(k)) return k;
    const hit = idx?.get(k);
    if (!hit) {
      if (idx) b.diag("WARNING", "EVIDENCE_KEY_NOT_FOUND", `evidence_key ${k} 不在本次请求上下文中`, pointer);
      return b.missingEvidence(k, idx ? "请求上下文中不存在该 evidence_key" : "缺少请求上下文，无法解析 evidence_key");
    }
    const s = obj(hit.item.source);
    return b.addEvidence({
      id: k,
      fileId: strOrUndef(s.file_id) ?? "",
      page: numOrNull(s.page),
      sheet: strOrUndef(s.sheet) ?? null,
      row: numOrNull(s.row),
      column: strOrUndef(s.column) ?? null,
      rawText: strOrUndef(s.raw_text) ?? null,
      availability: s.file_id ? "METADATA_ONLY" : "MISSING",
      jsonPointer: hit.pointer,
      location: "REQUEST",
      label:
        [hit.item.field, hit.item.value, hit.item.kind, hit.item.source_kind].filter((x) => x !== undefined && x !== "").map(display).join(" · ") +
        (conflicts?.has(k) ? "（键冲突：请求中同名 key 内容不同，取首次出现）" : ""),
    });
  });
}

/** 状态类单元格的英文枚举 → 中文（唯一一份；界面只显示中文，英文放悬停提示） */
export const STATE_LABEL: Record<string, string> = {
  // P4 核验状态
  VERIFIED_CONSISTENT: "已核验一致",
  VERIFIED_UPDATED: "已按规则更新",
  CONFLICT: "冲突",
  MISSING_REQUIRED: "必填缺失",
  NO_EVIDENCE: "未取得证据",
  NOT_CHECKED: "本轮未核验",
  // P4 决策
  KEEP: "保持",
  FILL: "补空",
  UPDATE: "更新",
  MISSING: "缺失",
  NO_ACTION: "不处理",
  // P3 关系 / 覆盖
  MATCHED: "已匹配",
  UNMATCHED: "未匹配",
  MULTIPLE_CANDIDATES: "多个候选",
  COMPLETE: "完整",
  PARTIAL: "部分覆盖",
  UNCERTAIN: "不确定",
  // 其他状态词
  NEEDS_REVIEW: "需人工看",
  SUCCESS: "成功",
  INVALID_INPUT: "输入无效",
  DISJOINT: "不重叠",
  OVERLAPPING: "有重叠",
  UNKNOWN: "未知",
};

/** 拆出状态格子的显示：兼容「KEEP（保持）」旧形式；未知值 label 原样返回、code 为空 */
export function stateLabel(raw: string): { label: string; code: string } {
  const m = /^([A-Z][A-Z_]*)（(.+)）$/.exec(raw);
  if (m) return { code: m[1], label: m[2] };
  return STATE_LABEL[raw] ? { code: raw, label: STATE_LABEL[raw] } : { code: "", label: raw };
}
