// PRD §1.1 最小只读 Connector 契约。注意：接口上**没有任何写方法**。

export type ConnectorStatus = "CONNECTED_DEMO_FILES" | "NOT_CONFIGURED" | "CONNECTOR_UNAVAILABLE";

export interface ReadCapability {
  status: ConnectorStatus;
  /** 是否为九立真实业务只读 API（目前恒为 false） */
  realApi: boolean;
  readOnly: true;
  source: string;
  message: string;
  canPreviewFiles: boolean;
}

export interface Page<T> {
  items: T[];
  page: number;
  total: number;
}

export interface CustomerSummary {
  customer_id: string;
  name: string;
  aliases: string[];
}

export interface OrderTaskSummary {
  task_id: string;
  customer_id: string;
  sample_id?: string;
  status?: string;
  line_count: number;
  file_id?: string;
  version?: number;
}

export interface InspectionBatchSummary {
  batch_id: string;
  customer_id: string;
  warehouse_no?: string;
  sample_id?: string;
  line_count: number;
  file_id?: string;
}

export interface OrderTaskFacts {
  task: Record<string, unknown>;
  lines: Record<string, unknown>[];
}

export interface InspectionFacts {
  batches: Record<string, unknown>[];
  sourceLines: Record<string, unknown>[];
  groups: Record<string, unknown>[];
}

export interface RelationFacts {
  relations: Record<string, unknown>[];
}

export interface MaterialMetadata {
  file_id: string;
  file_name: string;
  media_type: string;
  sha256?: string;
  role?: string;
  authorized: boolean;
  exists: boolean;
  has_text_content: boolean;
  /** 文件内单证分段（九立 Demo documentSegments：kind 如 invoice / packing-list，pages 从 1 开始） */
  segments?: { kind: string; pages: number[] }[];
  /** 与另一文件为同一业务单证（例如同一委托书的 xls 与 pdf） */
  same_document_as?: string | null;
}

export interface AuthorizedPreview {
  absolutePath: string;
  mediaType: string;
  fileName: string;
}

export class ConnectorError extends Error {
  constructor(
    public code: "FORBIDDEN" | "NOT_FOUND" | "CONNECTOR_UNAVAILABLE" | "BAD_REQUEST",
    message: string,
  ) {
    super(message);
  }
}

export interface JiuliReadonlyConnector {
  capabilities(): Promise<ReadCapability>;
  searchCustomers(q: string, page: number): Promise<Page<CustomerSummary>>;
  listOrderTasks(customerId: string, page: number): Promise<Page<OrderTaskSummary>>;
  listInspectionBatches(customerId: string, page: number): Promise<Page<InspectionBatchSummary>>;
  getTaskFacts(taskId: string): Promise<OrderTaskFacts>;
  getInspectionFacts(customerId: string, batchIds: string[]): Promise<InspectionFacts>;
  getRelations(taskId: string): Promise<RelationFacts>;
  getMaterialMetadata(fileIds: string[]): Promise<MaterialMetadata[]>;
  getPreview?(fileId: string): Promise<AuthorizedPreview>;
  /** 预处理文本（九立 Demo 已抽取的 extracted/*.json），只读 */
  getExtractedContent?(fileId: string): Promise<unknown | undefined>;
}
