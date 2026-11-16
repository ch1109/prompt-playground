// 九立二阶段 demo 的 v15 输出（P1/P2 v5.3、P3 v1.0、P4 最终版）：顶层 `"v": 15`，没有 schema_version。
// Schema 只校验各阶段的骨架（必需键、类型、P3 状态枚举），业务字段按原值展示；不是九立官方 Schema。

export const V15_SCHEMA_VERSION = "jiuli-v15";

/** 26 个业务短键的中文名：取自 demo `prompt final/字段映射_26项及合计.json`；wu 为重量单位 */
export const V15_FIELDS: [string, string][] = [
  ["hs", "税号"],
  ["br", "品牌"],
  ["md", "型号"],
  ["ds", "商品描述"],
  ["sc", "品名"],
  ["og", "产地"],
  ["u", "单位"],
  ["q", "数量"],
  ["pr", "报关单价"],
  ["a", "总价"],
  ["cur", "币种"],
  ["pk", "件数"],
  ["nw", "净重"],
  ["gw", "毛重"],
  ["wu", "重量单位"],
  ["sku", "SKU"],
  ["by", "对应的采购"],
  ["sn", "供应商号码"],
  ["sp", "供应商"],
  ["dt", "期票天数"],
  ["po", "采购订单号"],
  ["mn", "料号"],
  ["pl", "托盘数"],
  ["wh", "入仓号"],
  ["ln", "产线"],
  ["rm", "备注"],
];

export const V15_LABEL: Record<string, string> = Object.fromEntries(V15_FIELDS);

/** 「核心列」预设显示的字段 */
export const V15_CORE = new Set(["br", "md", "og", "u", "q", "pr", "a", "cur", "pk", "nw", "gw", "wu", "mn"]);

const issues = { type: "array", items: { type: "object" } };
const row = { type: "object", required: ["id"], properties: { id: { type: ["integer", "string"] }, issues } };

export const P1_V15 = {
  type: "object",
  required: ["v", "h", "r"],
  properties: {
    v: { const: 15 },
    h: { type: "object", properties: { cus: { type: "string" }, issues } },
    r: { type: "array", items: row },
    g: { type: "array", items: { type: "object", required: ["f", "v"] } },
    tot: { type: "object" },
  },
};

export const P2_V15 = {
  type: "object",
  required: ["v", "h"],
  properties: {
    v: { const: 15 },
    h: {
      type: "array",
      items: {
        type: "object",
        required: ["r"],
        properties: {
          wh: { type: "string" },
          tot: { type: "object" },
          qc: { type: "object" },
          issues,
          g: { type: "array" },
          r: { type: "array", items: { ...row, properties: { ...row.properties, parts: { type: "array", items: { type: "object" } } } } },
        },
      },
    },
  },
};

export const P3_V15 = {
  type: "object",
  required: ["v", "r"],
  properties: {
    v: { const: 15 },
    r: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "st", "m", "c"],
        properties: {
          id: { type: ["integer", "string"] },
          st: { enum: ["MATCHED", "MULTIPLE_CANDIDATES", "UNMATCHED"] },
          m: { type: "array", items: { type: "object" } },
          c: { type: "array", items: { type: "object" } },
          review: { type: "boolean" },
          issues,
        },
      },
    },
  },
};

export const P4_V15 = {
  type: "object",
  required: ["v", "r"],
  properties: {
    v: { const: 15 },
    r: { type: "array", items: row },
    changes: { type: "array", items: { type: "object", required: ["f"] } },
    tot_updates: { type: "array", items: { type: "object", required: ["f"] } },
    suggestions: { type: "array" },
    issues,
    rematch: { type: "boolean" },
    review: { type: "boolean" },
  },
};
