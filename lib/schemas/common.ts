// 注意：九立仓库中没有正式 JSON Schema 文件。
// 本目录下的 Schema 由 Prompt Studio 依据规格示例（v2.0）与 v3.0 提示词原文"输出"章节推导，
// 只校验结构契约（必需键、类型、枚举），不校验业务事实；不是九立官方 Schema。

export const P1_VALUE_KEYS = [
  "customer_name",
  "brand",
  "model",
  "description",
  "product_name",
  "origin",
  "unit",
  "quantity",
  "customs_unit_price",
  "total_price",
  "currency",
  "packages",
  "net_weight",
  "gross_weight",
  "sku",
  "buyer",
  "supplier_code",
  "supplier",
  "payment_term_days",
  "purchase_order_no",
  "material_no",
  "pallet_count",
  "warehouse_no",
  "production_line",
  "remark",
] as const;

/** 25 列中文名：取自九立 v3.0 方案 §3 与 real-calibration fieldMap */
export const FIELD_LABELS: Record<string, string> = {
  customer_name: "客户名",
  brand: "品牌",
  model: "型号",
  description: "商品描述",
  product_name: "品名",
  origin: "产地",
  unit: "单位",
  quantity: "数量",
  customs_unit_price: "报关单价",
  total_price: "总价",
  currency: "币种",
  packages: "件数",
  net_weight: "净重",
  gross_weight: "毛重",
  sku: "sku",
  buyer: "对应的采购",
  supplier_code: "供应商号码",
  supplier: "供应商",
  payment_term_days: "期票天数",
  purchase_order_no: "采购订单号",
  material_no: "物料号码",
  pallet_count: "托盘数",
  warehouse_no: "入仓号",
  production_line: "产线",
  remark: "备注",
};

/** "核心字段"预设：v3 方案中的 13 个必填字段 */
export const CORE_FIELDS = new Set([
  "customer_name",
  "brand",
  "model",
  "product_name",
  "origin",
  "unit",
  "quantity",
  "customs_unit_price",
  "total_price",
  "currency",
  "packages",
  "net_weight",
  "gross_weight",
]);

export const stringOrNull = { type: ["string", "null"] };
export const intOrNull = { type: ["integer", "null"] };

export function envelope(schemaVersion: string, prompt: string, output: object) {
  return {
    type: "object",
    required: ["schema_version", "prompt", "request_id", "output"],
    properties: {
      schema_version: { const: schemaVersion },
      prompt: { const: prompt },
      request_id: { type: "string" },
      output,
    },
  };
}

export const valuesObject = {
  type: "object",
  required: [...P1_VALUE_KEYS],
  properties: Object.fromEntries(P1_VALUE_KEYS.map((k) => [k, { type: "string" }])),
};
