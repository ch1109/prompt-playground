import type { PromptKind } from "@/lib/contracts/run";
import type {
  ChangeView,
  Diagnostic,
  EvidenceView,
  IssueView,
  RelationView,
  Headline,
  SummaryItem,
  TableView,
} from "@/lib/contracts/view-model";

export interface MaterialAccess {
  availability: "AVAILABLE" | "METADATA_ONLY" | "FORBIDDEN" | "MISSING";
  fileName?: string;
}

/** Adapter 的确定性输入上下文（全部来自快照，不会在适配时拉取任何新数据） */
export interface AdapterContext {
  runId: string;
  /** v3：本次调用的 request JSON（来自快照），用于解析 evidence_key、当前值 */
  request?: unknown;
  /** 快照中材料的授权情况：file_id → 可用性。未提供时一律视为"仅元数据" */
  materials?: Record<string, MaterialAccess>;
  /** P4 只读 Patch 模拟所需的完整基准草稿（order_row_id → 字段 → 值） */
  baseDraft?: { version: string | number; rows: Record<string, Record<string, string>> };
  /** 独立 Gold 标注（AT04）：仅当提供时才判断漏行 */
  gold?: { expectedRowCount?: number };
}

export interface AdapterOutput {
  tables: TableView[];
  issues: IssueView[];
  relations: RelationView[];
  changes: ChangeView[];
  evidence: EvidenceView[];
  diagnostics: Diagnostic[];
  metadata?: { summary?: SummaryItem[]; notes?: string[]; headline?: Headline };
}

export interface BusinessAdapter {
  adapterId: string;
  adapterVersion: string;
  promptKind: PromptKind;
  schemaVersion: string;
  rendererId: string;
  adapt(doc: unknown, ctx: AdapterContext): AdapterOutput;
}
