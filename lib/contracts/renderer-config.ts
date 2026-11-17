/** PRD §3.3：渲染配置只能引用白名单组件 */
export const COMPONENT_WHITELIST = [
  "data-table",
  "issue-list",
  "relation-canvas",
  "field-diff",
  "evidence-viewer",
  "run-metadata",
  "summary-strip",
] as const;

export type RendererComponent = (typeof COMPONENT_WHITELIST)[number];

/** binding 是登记过的逻辑选择器，不是 JS 表达式 */
export const BINDING_PATTERN = /^(tables\.[A-Za-z][A-Za-z0-9_]*|issues|relations|changes|evidence|diagnostics|metadata\.summary)$/;

export interface RendererRegion {
  id: string;
  component: RendererComponent;
  binding: string;
  mode?: "drawer" | "inline";
  options?: Record<string, unknown>;
}

export interface RendererConfig {
  renderer_id: string;
  renderer_config_version: string;
  adapter_id: string;
  supported_prompt_kinds: string[];
  layout: string;
  regions: RendererRegion[];
}

export interface SelectionState {
  runId: string | null;
  tableId?: string;
  rowId?: string;
  fieldKey?: string;
  issueId?: string;
  relationId?: string;
  sourceRefId?: string;
  jsonPointer?: string;
  /** 选中位置的中文说明（如「结果 · 第 2 行 · 分类」）；业务视图之外（通用提示词版式）靠它显示 */
  place?: string;
  /** 选中列的显示名 */
  fieldTitle?: string;
}
