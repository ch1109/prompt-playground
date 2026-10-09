import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import {
  ConnectorError,
  type AuthorizedPreview,
  type CustomerSummary,
  type InspectionBatchSummary,
  type JiuliReadonlyConnector,
  type MaterialMetadata,
  type OrderTaskSummary,
  type Page,
  type ReadCapability,
} from "./types";

// 只读读取九立 Demo 本地数据文件（demo-generated/mock/*.json）。
// - 只打开 allowlist 中的固定文件名，全部用 readFileSync（只读），不存在写方法；
// - 每个调用都在服务端校验"当前操作者可访问的客户"，跨客户读取直接拒绝；
// - 这是九立 Demo 的本地数据，不是九立真实业务 API。

const MOCK_FILES = {
  customers: "customers.json",
  drafts: "entrustment-drafts.json",
  lines: "entrustment-lines.json",
  orders: "inspection-orders.json",
  sourceLines: "inspection-source-lines.json",
  groups: "inspection-groups.json",
  relations: "match-relations.json",
  sourceFiles: "source-files.json",
} as const;

const FILE_ID = /^F-[0-9a-f]{12}$/;
const PREVIEW_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
};
const PAGE_SIZE = 50;

type Rec = Record<string, unknown>;

function page<T>(items: T[], p: number): Page<T> {
  const start = Math.max(0, (p - 1) * PAGE_SIZE);
  return { items: items.slice(start, start + PAGE_SIZE), page: p, total: items.length };
}

export class JiuliDemoFilesConnector implements JiuliReadonlyConnector {
  private root: string;
  private allowed: Set<string> | "ALL";

  constructor(opts: { root: string; allowedCustomers: string }) {
    this.root = resolve(opts.root);
    const list = opts.allowedCustomers.split(",").map((s) => s.trim()).filter(Boolean);
    this.allowed = list.includes("*") ? "ALL" : new Set(list);
  }

  private mockDir() {
    return resolve(this.root, "demo-generated", "mock");
  }

  /** 防路径穿越：解析后的路径必须仍在 base 之内 */
  private safePath(base: string, rel: string): string {
    const abs = resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + sep)) throw new ConnectorError("FORBIDDEN", "路径越界");
    return abs;
  }

  private read(name: keyof typeof MOCK_FILES): Rec[] {
    const p = this.safePath(this.mockDir(), MOCK_FILES[name]);
    if (!existsSync(/*turbopackIgnore: true*/ p)) throw new ConnectorError("CONNECTOR_UNAVAILABLE", `九立 Demo 数据文件不存在：${MOCK_FILES[name]}`);
    const data = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(data) ? data : [];
  }

  private canAccess(customerId: unknown): boolean {
    return typeof customerId === "string" && (this.allowed === "ALL" || this.allowed.has(customerId));
  }

  private assertCustomer(customerId: unknown) {
    if (!this.canAccess(customerId)) throw new ConnectorError("FORBIDDEN", "无权访问该客户的数据");
  }

  async capabilities(): Promise<ReadCapability> {
    const ok = existsSync(/*turbopackIgnore: true*/ this.mockDir()) && existsSync(/*turbopackIgnore: true*/ resolve(this.mockDir(), MOCK_FILES.customers));
    return ok
      ? {
          status: "CONNECTED_DEMO_FILES",
          realApi: false,
          readOnly: true,
          source: `九立 Demo 本地数据文件（${this.root}/demo-generated/mock）`,
          message: "已只读连接九立 Demo 本地数据文件。九立真实业务只读 API 尚未接通。",
          canPreviewFiles: true,
        }
      : {
          status: "CONNECTOR_UNAVAILABLE",
          realApi: false,
          readOnly: true,
          source: this.root,
          message: "九立 Demo 数据目录不可用（路径或权限配置错误）。离线样本仍可使用。",
          canPreviewFiles: false,
        };
  }

  async searchCustomers(q: string, p = 1): Promise<Page<CustomerSummary>> {
    const needle = q.trim().toLowerCase();
    const items = this.read("customers")
      .filter((c) => this.canAccess(c.id)) // 未授权客户不回显
      .map((c) => ({ customer_id: String(c.id), name: String(c.name ?? ""), aliases: (c.aliases as string[]) ?? [] }))
      .filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.customer_id.toLowerCase().includes(needle));
    return page(items, p);
  }

  async listOrderTasks(customerId: string, p = 1): Promise<Page<OrderTaskSummary>> {
    this.assertCustomer(customerId);
    const items = this.read("drafts")
      .filter((d) => d.customerId === customerId)
      .map((d) => ({
        task_id: String(d.id),
        customer_id: String(d.customerId),
        sample_id: d.sampleId as string | undefined,
        status: d.status as string | undefined,
        line_count: ((d.lineIds as unknown[]) ?? []).length,
        file_id: d.fileId as string | undefined,
        version: d.version as number | undefined,
      }));
    return page(items, p);
  }

  async listInspectionBatches(customerId: string, p = 1): Promise<Page<InspectionBatchSummary>> {
    this.assertCustomer(customerId);
    const items = this.read("orders")
      .filter((o) => o.customerId === customerId)
      .map((o) => ({
        batch_id: String(o.id),
        customer_id: String(o.customerId),
        warehouse_no: o.warehouseNo as string | undefined,
        sample_id: o.sampleId as string | undefined,
        line_count: ((o.sourceLineIds as unknown[]) ?? []).length,
        file_id: o.fileId as string | undefined,
      }));
    return page(items, p);
  }

  async getTaskFacts(taskId: string) {
    const task = this.read("drafts").find((d) => d.id === taskId);
    if (!task) throw new ConnectorError("NOT_FOUND", "任务不存在");
    // 服务端按任务所属客户鉴权，不依赖前端隐藏选项（AT21）
    this.assertCustomer(task.customerId);
    const ids = new Set((task.lineIds as string[]) ?? []);
    const lines = this.read("lines").filter((l) => ids.has(String(l.id)));
    return { task, lines };
  }

  async getInspectionFacts(customerId: string, batchIds: string[]) {
    this.assertCustomer(customerId);
    const all = this.read("orders");
    const batches = batchIds.map((id) => {
      const b = all.find((o) => o.id === id);
      if (!b) throw new ConnectorError("NOT_FOUND", `查货批次 ${id} 不存在`);
      if (b.customerId !== customerId) throw new ConnectorError("FORBIDDEN", `查货批次 ${id} 不属于所选客户`);
      return b;
    });
    const lineIds = new Set(batches.flatMap((b) => (b.sourceLineIds as string[]) ?? []));
    const sourceLines = this.read("sourceLines").filter((l) => lineIds.has(String(l.id)) && l.customerId === customerId);
    const batchSet = new Set(batchIds);
    const groups = this.read("groups").filter((g) => batchSet.has(String(g.inspectionOrderId)) && g.customerId === customerId);
    return { batches, sourceLines, groups };
  }

  async getRelations(taskId: string) {
    const { lines } = await this.getTaskFacts(taskId);
    const lineIds = new Set(lines.map((l) => String(l.id)));
    const relations = this.read("relations").filter((r) => lineIds.has(String(r.entrustmentLineId ?? r.orderRowId ?? r.order_row_id)));
    return { relations };
  }

  /** 文件授权：只有被授权客户的任务/查货批次引用的文件才可访问 */
  private authorizedFileIds(): Set<string> {
    const ids = new Set<string>();
    for (const d of this.read("drafts")) {
      if (!this.canAccess(d.customerId)) continue;
      if (d.fileId) ids.add(String(d.fileId));
      for (const f of (d.supportingFileIds as string[]) ?? []) ids.add(f);
    }
    for (const o of this.read("orders")) if (this.canAccess(o.customerId) && o.fileId) ids.add(String(o.fileId));
    return ids;
  }

  async getMaterialMetadata(fileIds: string[]): Promise<MaterialMetadata[]> {
    const files = this.read("sourceFiles");
    const authorized = this.authorizedFileIds();
    return fileIds.map((id) => {
      const f = files.find((x) => x.id === id);
      const okId = FILE_ID.test(id);
      const ext = String(f?.extension ?? "").toLowerCase();
      const abs = f && okId ? this.safePath(this.root, String(f.path)) : undefined;
      return {
        file_id: id,
        file_name: f ? String(f.path).split("/").pop() ?? id : id,
        media_type: PREVIEW_TYPES[ext] ?? "application/octet-stream",
        sha256: f?.sha256 as string | undefined,
        role: f?.role as string | undefined,
        authorized: okId && authorized.has(id),
        exists: !!abs && existsSync(/*turbopackIgnore: true*/ abs),
        has_text_content: okId && existsSync(/*turbopackIgnore: true*/ this.safePath(resolve(this.root, "demo-generated", "extracted"), `${id}.json`)),
      };
    });
  }

  async getPreview(fileId: string): Promise<AuthorizedPreview> {
    if (!FILE_ID.test(fileId)) throw new ConnectorError("BAD_REQUEST", "非法文件 ID");
    const [meta] = await this.getMaterialMetadata([fileId]);
    if (!meta.authorized) throw new ConnectorError("FORBIDDEN", "无权访问该文件");
    const f = this.read("sourceFiles").find((x) => x.id === fileId)!;
    const abs = this.safePath(this.root, String(f.path));
    if (!existsSync(/*turbopackIgnore: true*/ abs) || !statSync(/*turbopackIgnore: true*/ abs).isFile()) throw new ConnectorError("NOT_FOUND", "原文件不存在或已失效");
    const ext = extname(abs).toLowerCase();
    if (!PREVIEW_TYPES[ext]) throw new ConnectorError("FORBIDDEN", "不允许预览的文件类型");
    return { absolutePath: abs, mediaType: PREVIEW_TYPES[ext], fileName: meta.file_name };
  }

  async getExtractedContent(fileId: string) {
    if (!FILE_ID.test(fileId)) return undefined;
    const p = this.safePath(resolve(this.root, "demo-generated", "extracted"), `${fileId}.json`);
    return existsSync(/*turbopackIgnore: true*/ p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
  }
}
