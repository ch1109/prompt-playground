// 渲染协议 v1 的标准 ViewModel（PRD §3.2，冻结）。
// 只增加了可选扩展字段（meta / metadata / simulation），不改变原有字段语义。

export type JsonPointer = string; // RFC6901，例如 /output/rows/0/values/model
export type RefId = string;

export type CellState =
  | "PRESENT"
  | "EXPLICIT_NONE"
  | "SOURCE_BLANK"
  | "NOT_DETECTED"
  | "UNREADABLE"
  | "AMBIGUOUS";

export interface Cell {
  rowId: string;
  fieldKey: string;
  value: unknown;
  state?: CellState;
  jsonPointer: JsonPointer;
  sourceRefIds: RefId[];
}

export interface TableColumn {
  key: string;
  title: string;
  kind?: "text" | "number" | "state";
  fixed?: boolean;
  /** 扩展：是否属于"核心字段"预设 */
  core?: boolean;
}

export interface TableRow {
  id: string;
  sourceRefIds?: string[];
  cells: Record<string, Cell>;
  /** 扩展：分组/父子关系等只读元信息（例如 P2 原始行所属逻辑单） */
  meta?: Record<string, unknown>;
}

export interface TableView {
  id: string;
  title: string;
  columns: TableColumn[];
  rows: TableRow[];
}

export interface IssueView {
  id: string;
  type: string;
  severity?: "INFO" | "WARNING" | "BLOCKER" | "UNKNOWN";
  summary: string;
  detail?: string;
  target?: { tableId?: string; rowId?: string; fieldKey?: string; jsonPointer?: JsonPointer };
  sourceRefIds: string[];
  origin: "MODEL_FINDING" | "SCHEMA" | "ADAPTER" | "RULE" | "ANNOTATION";
}

export interface RelationView {
  id: string;
  fromId: string;
  toIds: string[];
  status: string;
  sourceRefIds: string[];
  jsonPointer: JsonPointer;
  coverage?: unknown;
  evidence?: unknown[];
  /** 扩展：SELECTED=模型选中组；CANDIDATE=候选组；WEAK=弱候选 */
  kind?: "SELECTED" | "CANDIDATE" | "WEAK";
}

export interface PatchSimulation {
  /** 是否允许在内存中模拟应用 */
  applicable: boolean;
  simulatedValue?: unknown;
  reason: string;
}

export interface ChangeView {
  id: string;
  rowId: string;
  field: string;
  action: string;
  before: unknown;
  after: unknown;
  candidate?: unknown;
  ruleId?: string;
  verificationStatus?: string;
  sourceRefIds: string[];
  jsonPointer: JsonPointer;
  /** 扩展：只读 Patch 模拟结果（SIMULATION_ONLY） */
  simulation?: PatchSimulation;
  /** 扩展：before 的来源说明，例如 "模型输出 current_value" / "请求 input.target_rows" / "未提供基准" */
  beforeOrigin?: string;
}

export type EvidenceAvailability = "AVAILABLE" | "METADATA_ONLY" | "MISSING" | "FORBIDDEN";

export interface EvidenceView {
  id: string;
  fileId: string;
  fileName?: string;
  page?: number | null;
  sheet?: string | null;
  row?: number | null;
  column?: string | null;
  rawText?: string | null;
  availability: EvidenceAvailability;
  /** 扩展：证据所在 JSON 位置（原始响应或请求上下文） */
  jsonPointer?: JsonPointer;
  /** 扩展：证据来自 response 还是 request 上下文 */
  location?: "RESPONSE" | "REQUEST";
  /** 扩展：业务含义，例如 field/value/kind */
  label?: string;
}

export interface Diagnostic {
  phase: "PARSE" | "SCHEMA" | "ADAPTER" | "RENDER";
  level: "ERROR" | "WARNING" | "INFO";
  code: string;
  message: string;
  jsonPointer?: JsonPointer;
}

export interface SummaryItem {
  label: string;
  value: string | number;
  hint?: string;
}

export interface ViewModel {
  viewModelVersion: "1.0";
  runId: string;
  rendererId: string;
  tables: TableView[];
  issues: IssueView[];
  relations: RelationView[];
  changes: ChangeView[];
  evidence: EvidenceView[];
  diagnostics: Diagnostic[];
  /** 扩展（03 文档：只读 ViewModel extension）：确定性统计，不是准确率；headline 供结果区第一屏的精简状态 */
  metadata?: { summary?: SummaryItem[]; notes?: string[]; headline?: Headline };
}

/** 结果区第一屏的精简状态（只读扩展）：主要对象的称呼、客户名称（主）与编号（次）、是否对照了独立 Gold */
export interface Headline {
  /** 主表行的称呼，如「商品」 */
  entity: string;
  customerName?: string;
  customerId?: string;
  /** 快照里有独立 Gold 标注，才能谈准确性 */
  gold: boolean;
}
