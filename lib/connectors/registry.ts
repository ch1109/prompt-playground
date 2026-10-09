import { existsSync } from "node:fs";
import { JiuliDemoFilesConnector } from "./jiuli-demo-files";
import { ConnectorError, type JiuliReadonlyConnector, type ReadCapability } from "./types";

/**
 * 真实九立业务只读 API 的占位。
 * 现有九立仓库中不存在客户/任务/查货的读接口，因此这里不捏造任何 URL，
 * 所有读取方法一律返回 CONNECTOR_UNAVAILABLE。接口上同样没有写方法。
 */
export class JiuliHttpPlaceholderConnector implements JiuliReadonlyConnector {
  constructor(private baseUrl?: string) {}
  async capabilities(): Promise<ReadCapability> {
    return {
      status: this.baseUrl ? "CONNECTOR_UNAVAILABLE" : "NOT_CONFIGURED",
      realApi: false,
      readOnly: true,
      source: this.baseUrl ? "JIULI_API_BASE_URL（已填写）" : "未配置",
      message: this.baseUrl
        ? "已填写九立 API 地址，但九立尚未提供经确认的只读接口契约，Studio 未实现对其调用；请使用离线样本或 Demo 数据文件。"
        : "九立真实只读接口未接通（未配置）。离线样本仍可使用。",
      canPreviewFiles: false,
    };
  }
  private unavailable(): never {
    throw new ConnectorError("CONNECTOR_UNAVAILABLE", "九立真实只读接口未接通");
  }
  searchCustomers = async () => this.unavailable();
  listOrderTasks = async () => this.unavailable();
  listInspectionBatches = async () => this.unavailable();
  getTaskFacts = async () => this.unavailable();
  getInspectionFacts = async () => this.unavailable();
  getRelations = async () => this.unavailable();
  getMaterialMetadata = async () => this.unavailable();
}

export function getJiuliConnector(): JiuliReadonlyConnector {
  const root = process.env.JIULI_DEMO_ROOT;
  if (root) {
    // 路径配置错误时 capabilities() 会报告 CONNECTOR_UNAVAILABLE
    return new JiuliDemoFilesConnector({ root, allowedCustomers: process.env.JIULI_ALLOWED_CUSTOMERS ?? "" });
  }
  return new JiuliHttpPlaceholderConnector(process.env.JIULI_API_BASE_URL || undefined);
}

export function demoRootLooksValid(): boolean {
  const root = process.env.JIULI_DEMO_ROOT;
  return !!root && existsSync(root);
}
