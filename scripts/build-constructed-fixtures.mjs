// 生成"人工构造"的负例/场景 Fixture。这些不是真实单证、也不是真实模型输出。
// 用法：node scripts/build-constructed-fixtures.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "constructed");
mkdirSync(OUT, { recursive: true });

const KEYS = ["customer_name","brand","model","description","product_name","origin","unit","quantity","customs_unit_price","total_price","currency","packages","net_weight","gross_weight","sku","buyer","supplier_code","supplier","payment_term_days","purchase_order_no","material_no","pallet_count","warehouse_no","production_line","remark"];
const values = (o) => Object.fromEntries(KEYS.map((k) => [k, o[k] ?? ""]));
const src = (file_id, row, column, raw_text, extra = {}) => ({ file_id, page: null, sheet: "Sheet1", row, column, raw_text, ...extra });
const v3 = (prompt, output) => ({ schema_version: "jiuli-ai-v3", prompt, request_id: `REQ-CONSTRUCTED-${prompt}`, output });
const manifest = [];
function write(name, data, meta) {
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n";
  writeFileSync(join(OUT, name), body);
  manifest.push({ file: name, ...meta });
}

// ---------- P1 v3：冲突 + 无牌/空白/0 + 漏行（配合 Gold） ----------
const p1Rows = [
  {
    row_no: 1,
    source: src("F-ORDER", 5, "B", "ABC-01"),
    values: values({ customer_name: "客户A", brand: "MICRON", model: "ABC-01", product_name: "存储器", origin: "马来西亚", unit: "个", quantity: "1000", customs_unit_price: "10", total_price: "10000", currency: "USD" }),
    evidence: [
      { field: "model", value: "ABC-01", unit: "", source: src("F-ORDER", 5, "C", "ABC-01") },
      { field: "customs_unit_price", value: "10", unit: "", source: src("F-ORDER", 5, "H", "10") },
      { field: "customs_unit_price", value: "11", unit: "", source: { file_id: "F-INVOICE", page: 1, sheet: null, row: 3, column: "Unit Price", raw_text: "USD 11.00" } },
    ],
    conflicts: [{ field: "customs_unit_price", message: "委托单价 10 与发票单价 11 不同" }],
  },
  {
    row_no: 2,
    source: src("F-ORDER", 6, "B", "XYZ-02"),
    values: values({ customer_name: "客户A", brand: "无牌", model: "XYZ-02", product_name: "电阻", unit: "个", quantity: "0", customs_unit_price: "0.5", currency: "USD" }),
    evidence: [
      { field: "brand", value: "无牌", unit: "", source: src("F-ORDER", 6, "D", "无牌") },
      { field: "quantity", value: "0", unit: "PCS", source: src("F-ORDER", 6, "G", "0") },
    ],
    conflicts: [],
  },
  {
    row_no: 3,
    source: src("F-ORDER", 7, "B", "QWE-03"),
    values: values({ customer_name: "客户A", brand: "", model: "QWE-03", product_name: "", unit: "个", quantity: "200" }),
    evidence: [{ field: "model", value: "QWE-03", unit: "", source: src("F-ORDER", 7, "C", "QWE-03") }],
    conflicts: [],
  },
];
write(
  "p1-v3-conflict.json",
  v3("P1", {
    processing_status: "SUCCESS",
    customer_resolution: { status: "RESOLVED", customer_id: "C001", recognized_name: "客户A", candidate_customer_ids: ["C001"], sources: [src("F-ORDER", 2, "B", "客户A")] },
    read_status: [{ file_id: "F-ORDER", read_segments: ["sheet:Sheet1"], unread_segments: [], status: "COMPLETE" }, { file_id: "F-INVOICE", read_segments: ["page:1"], unread_segments: [], status: "COMPLETE" }],
    rows: p1Rows,
    scope_records: [{ kind: "ORDER_TOTAL", member_row_nos: [1, 2, 3], range_complete: false, measurements: [{ field: "quantity", value: "1200", unit: "PCS", source: src("F-ORDER", 10, "G", "TOTAL 1200") }], source: src("F-ORDER", 10, "A", "TOTAL") }],
    unlinked_records: [{ source: { file_id: "F-INVOICE", page: 1, sheet: null, row: 9, column: null, raw_text: "EXTRA-99 1pc" }, fields: { model: "EXTRA-99" }, candidate_row_nos: [], reason: "发票多出的商品，未能唯一对应" }],
    issues: [{ code: "FIELD_MISSING", row_ref: 3, field: "brand", message: "第3行品牌为空" }, { code: "GENERAL_NOTE", row_ref: null, field: null, message: "一般性提示，没有具体位置" }],
  }),
  { promptKind: "JIULI_P1", schemaVersion: "jiuli-ai-v3", origin: "CONSTRUCTED", title: "P1 冲突 + 无牌/空白/0 + 漏行", covers: ["AT02", "AT03", "AT04"], gold: { expectedRowCount: 4 } },
);

// ---------- P1：Schema 类型错误（JSON 合法） ----------
write(
  "p1-v3-schema-type-error.json",
  v3("P1", {
    processing_status: "DONE",
    customer_resolution: { status: "RESOLVED", customer_id: "C001", recognized_name: "客户A", candidate_customer_ids: [], sources: [] },
    read_status: [],
    rows: [{ row_no: "1", source: src("F-ORDER", 5, "B", "ABC-01"), values: { ...values({ model: "ABC-01" }), quantity: 100 }, evidence: [] }],
    scope_records: [],
    unlinked_records: [],
  }),
  { promptKind: "JIULI_P1", schemaVersion: "jiuli-ai-v3", origin: "CONSTRUCTED", title: "Schema 类型错误（quantity 为数字、缺 conflicts/issues、未知枚举）", covers: ["AT17"] },
);

// ---------- 无效 JSON / 非纯 JSON / 围栏 JSON ----------
write("invalid-json-truncated.txt", JSON.stringify(v3("P1", { processing_status: "SUCCESS", rows: [{ row_no: 1 }] }), null, 2).slice(0, 120), {
  promptKind: "JIULI_P1", origin: "CONSTRUCTED", title: "无效 JSON（模拟断流截断）", covers: ["AT16"],
});
write("not-pure-json.txt", "好的，以下是识别结果：\n\n```json\n" + JSON.stringify(v3("P1", { processing_status: "SUCCESS" })) + "\n```\n\n如有疑问请告诉我。", {
  promptKind: "JIULI_P1", origin: "CONSTRUCTED", title: "非纯 JSON（夹杂说明文字，不做猜测提取）", covers: ["AT16"],
});

// ---------- XSS：业务字符串含 HTML/脚本 ----------
write(
  "p1-v3-xss.json",
  v3("P1", {
    processing_status: "SUCCESS",
    customer_resolution: { status: "UNRESOLVED", customer_id: null, recognized_name: "<b>客户</b>", candidate_customer_ids: [], sources: [] },
    read_status: [],
    rows: [{
      row_no: 1,
      source: src("F-ORDER", 5, "B", "<script>window.__xss=1</script>"),
      values: values({ model: "<img src=x onerror=\"window.__xss=1\">", remark: "<script>window.__xss=1</script>", description: "javascript:alert(1)" }),
      evidence: [{ field: "model", value: "<img src=x onerror=\"window.__xss=1\">", unit: "", source: src("F-ORDER", 5, "C", "<iframe src=javascript:alert(1)>") }],
      conflicts: [{ field: "model", message: "<svg onload=\"window.__xss=1\">" }],
    }],
    scope_records: [],
    unlinked_records: [],
    issues: [{ code: "XSS", row_ref: 1, field: "remark", message: "<img src=x onerror=\"window.__xss=1\">" }],
  }),
  { promptKind: "JIULI_P1", schemaVersion: "jiuli-ai-v3", origin: "CONSTRUCTED", title: "恶意 HTML 片段（必须按文本显示）", covers: ["9.4 安全转义"] },
);

// ---------- 未登记 Schema ----------
write("unknown-schema-version.json", { schema_version: "jiuli-ai-v9", prompt: "P1", request_id: "REQ-X", output: { rows: [] } }, {
  promptKind: "JIULI_P1", origin: "CONSTRUCTED", title: "未登记 schema_version（UNKNOWN_SCHEMA）", covers: ["3.5 降级"],
});

// ---------- P2 v3：无仓号 + 同仓号多页多行 + 多来源产地 + 0/O 模糊 ----------
const p2src = (page, row, raw) => ({ file_id: "F-INSP", page, sheet: null, row, column: null, raw_text: raw });
const raw = (record_no, wh, cands, page, fields, origins = [], marks = []) => ({
  record_no,
  warehouse_no: wh,
  candidate_warehouse_nos: cands,
  source: p2src(page, record_no, `${fields.model ?? ""} ${fields.quantity ?? ""}`),
  fields,
  field_sources: Object.fromEntries(Object.keys(fields).map((k) => [k, [p2src(page, record_no, String(fields[k]))]])),
  origin_candidates: origins,
  manual_marks: marks,
});
write(
  "p2-v3-no-warehouse.json",
  v3("P2", {
    processing_status: "NEEDS_REVIEW",
    customer_id: "C001",
    read_status: [{ file_id: "F-INSP", read_segments: ["page:1", "page:2", "page:3"], unread_segments: [], status: "COMPLETE" }],
    logical_inspections: [{ warehouse_no: "26091801", sources: [p2src(1, null, "条码 26091801")], range_status: "COMPLETE" }],
    raw_rows: [
      raw(1, "26091801", [], 1, { brand: "MICRON", model: "ABC-01", quantity: "400", net_weight: "1.2", net_weight_unit: "KG" }, [
        { value: "MALAYSIA", kind: "PRINTED_COD", source: p2src(1, 1, "COD: MALAYSIA") },
        { value: "中国", kind: "HANDWRITTEN_COD", source: p2src(1, 1, "手写 COD 中国") },
      ]),
      raw(2, "26091801", [], 2, { brand: "MICRON", model: "ABC-01", quantity: "600", net_weight: "1.8", net_weight_unit: "KG" }, [
        { value: "MALAYSIA", kind: "PRINTED_COA", source: p2src(2, 2, "COA MALAYSIA") },
        { value: "MALAYSIA", kind: "COO", source: p2src(2, 2, "Made in Malaysia") },
      ]),
      raw(3, "", ["26091801", "26091807"], 3, { model: "XYZ-02", quantity: "50" }, [], [
        { action: "UNCLEAR", field: "model", old_value: "", new_value: "", source: p2src(3, 3, "手写 X0Z-02 / XOZ-02 难辨 0/O") },
      ]),
    ],
    scope_records: [
      { warehouse_no: "26091801", kind: "LOGICAL_TOTAL", identifier: "printed-total", member_record_nos: [1, 2], range_complete: true, has_unresolved_goods: false, measurements: [{ field: "gross_weight", value: "3.5", unit: "KG", fact_kind: "HANDWRITTEN_GW", source: p2src(1, null, "GW 3.5KG") }], source: p2src(1, null, "合计") },
      { warehouse_no: "", kind: "UNRESOLVED", identifier: "page-3", member_record_nos: [3], range_complete: false, has_unresolved_goods: true, measurements: [], source: p2src(3, null, "第3页无条码") },
    ],
    issues: [{ code: "WAREHOUSE_UNRESOLVED", row_ref: 3, field: "warehouse_no", message: "第3页商品入仓号无法确定（26091801 或 26091807）" }],
  }),
  { promptKind: "JIULI_P2", schemaVersion: "jiuli-ai-v3", origin: "CONSTRUCTED", title: "P2 无仓号 + 同仓号多页 + 多来源产地", covers: ["AT05", "AT06", "AT07"] },
);

// ---------- P2 v2：同仓号多原始行合并 + 无仓号逻辑单 ----------
const v2raw = (ref, page, model, qty) => ({
  local_raw_row_ref: ref,
  source_position: { file_id: "F101", page, row: 3 },
  facts: { brand: "MICRON", model, product_name: "", origin: "", unit: "PCS", quantity: qty, packages: "", net_weight: "", gross_weight: "", sku: "", purchase_order_no: "", material_no: "", pallet_count: "", warehouse_no: "26091801", production_line: "", remark: "" },
  relation_features: { pack_no: "P1", box_no: "", dc: "", lot: "" },
  normalized_identity: { brand_key: "MICRON", model_key: model, origin_key: "" },
  origin_facts: [{ kind: "PRINTED_COD", value: "MALAYSIA" }],
  manual_marks: [],
  package_facts: [],
  weight_facts: [],
  source_refs: ["SRC_101"],
});
write(
  "p2-v2-merge.json",
  {
    schema_version: "jiuli-ai-v2",
    prompt: "P2",
    request_id: "REQ-CONSTRUCTED-P2V2",
    output: {
      processing_status: "SUCCESS",
      customer_id: "C001",
      inspection_ingest_id: "II_001",
      source_refs: [{ local_source_ref: "SRC_101", source_type: "INSPECTION", file_id: "F101", file_name: "查货单.pdf", page: 2, sheet: null, row: 3, column: "型号", raw_text: "#ABC-01" }],
      logical_inspections: [
        {
          local_logical_ref: "LI_TMP_001",
          warehouse_no: "26091801",
          source_file_ids: ["F101"],
          header_facts: { packages: [], gross_weight: [], net_weight: [], pallet_count: [] },
          raw_rows: [v2raw("IR_001", 1, "ABC-01", "400"), v2raw("IR_002", 2, "ABC-01", "600"), v2raw("IR_003", 3, "ABC-01", "1")],
          merged_products: [{ local_merged_ref: "MP_001", merge_key: { brand: "MICRON", model: "ABC-01", origin: "MALAYSIA" }, raw_row_refs: ["IR_001", "IR_002", "IR_003"], aggregated: { quantity: "1001", packages: "", net_weight: "", gross_weight: "" }, field_conflicts: [] }],
          scope_uncertain: false,
        },
        {
          local_logical_ref: "LI_TMP_002",
          warehouse_no: "",
          source_file_ids: ["F101"],
          header_facts: {},
          raw_rows: [v2raw("IR_009", 5, "XYZ-02", "50")],
          merged_products: [{ local_merged_ref: "MP_009", merge_key: { brand: "MICRON", model: "XYZ-02", origin: "" }, raw_row_refs: ["IR_009", "IR_404"], aggregated: { quantity: "50" }, field_conflicts: [] }],
          scope_uncertain: true,
        },
      ],
      unresolved_scopes: [{ message: "第5页入仓号无法识别", source_refs: ["SRC_101"] }],
      warnings: ["手写 0/O 模糊，型号可能为 XYZ-02 或 XYZ-O2"],
    },
  },
  { promptKind: "JIULI_P2", schemaVersion: "jiuli-ai-v2", origin: "CONSTRUCTED", title: "P2 v2 同仓号多行合并 + 无仓号 + 悬空引用", covers: ["AT05", "AT06"] },
);

// ---------- P3 v3：一对多 / 多候选 / UNMATCHED / PARTIAL（含 request） ----------
const ev = (key, field, value, raw_text, file_id = "F-ORDER") => ({ evidence_key: key, field, value, source: { file_id, page: 1, sheet: null, row: null, column: null, raw_text } });
const cand = (raw_row_id, li, wh, model, qty, evs) => ({
  raw_row_id, customer_id: "C001", logical_inspection_id: li, warehouse_no: wh, merged_product_id: null,
  identity: { model, brand: "MICRON", origin: "MALAYSIA", quantity: qty, unit: "PCS" },
  scope_summary: { coverage: "COMPLETE", overlap: "DISJOINT", has_extra_goods: false, has_unresolved_goods: false },
  evidence: evs, occupied_by_order_row_id: null,
});
const p3req = {
  schema_version: "jiuli-ai-v3", prompt: "P3", request_id: "REQ-CONSTRUCTED-P3",
  context: { customer_id: "C001", retrieval_complete: true },
  input: {
    order_rows: [
      { order_row_id: "OR_001", customer_id: "C001", identity: { model: "ABC-01", brand: "MICRON", quantity: "1000" }, evidence: [ev("E-O-1-MODEL", "model", "ABC-01", "ABC-01")] },
      { order_row_id: "OR_002", customer_id: "C001", identity: { model: "DUP-05", brand: "MICRON", quantity: "300" }, evidence: [ev("E-O-2-MODEL", "model", "DUP-05", "DUP-05")] },
      { order_row_id: "OR_003", customer_id: "C001", identity: { model: "NEW-77", brand: "TI", quantity: "10" }, evidence: [] },
      { order_row_id: "OR_004", customer_id: "C001", identity: { model: "PART-9", brand: "MICRON", quantity: "500" }, evidence: [ev("E-O-4-MODEL", "model", "PART-9", "PART-9")] },
    ],
    inspection_candidates: [
      cand("IR_A1", "LI_A", "26091801", "ABC-01", "400", [ev("E-I-A1-MODEL", "model", "ABC-01", "#ABC-01", "F-INSP-A")]),
      cand("IR_B1", "LI_B", "26091822", "ABC-01", "600", [ev("E-I-B1-MODEL", "model", "ABC-01", "ABC-01", "F-INSP-B"), ev("E-I-B1-SCOPE", "scope", "PO 9988 共同覆盖", "PO 9988", "F-INSP-B")]),
      cand("IR_C1", "LI_A", "26091801", "DUP-05", "300", [ev("E-I-C1-MODEL", "model", "DUP-05", "DUP-05", "F-INSP-A")]),
      cand("IR_C2", "LI_B", "26091822", "DUP-05", "300", [ev("E-I-C2-MODEL", "model", "DUP-05", "DUP-05", "F-INSP-B")]),
      cand("IR_C3", "LI_B", "26091822", "DUP-05A", "300", [ev("E-I-C3-MODEL", "model", "DUP-05A", "DUP-05A", "F-INSP-B")]),
      cand("IR_D1", "LI_A", "26091801", "PART-9", "200", [ev("E-I-D1-MODEL", "model", "PART-9", "PART-9", "F-INSP-A")]),
    ],
    proposed_groups: [],
    comparison_results: [],
  },
};
write("p3-v3-multi-candidate.request.json", p3req, { role: "REQUEST_CONTEXT", for: "p3-v3-multi-candidate.json", origin: "CONSTRUCTED", title: "P3 请求上下文" });
write(
  "p3-v3-multi-candidate.json",
  v3("P3", {
    processing_status: "SUCCESS",
    row_relations: [
      { order_row_id: "OR_001", match_status: "MATCHED", selected_raw_row_ids: ["IR_A1", "IR_B1"], coverage: { status: "COMPLETE", overlap: "DISJOINT", evidence_keys: ["E-I-B1-SCOPE"] }, evidence_keys: ["E-O-1-MODEL", "E-I-A1-MODEL", "E-I-B1-MODEL"], candidate_groups: [], weak_candidates: [], issues: [] },
      { order_row_id: "OR_002", match_status: "MULTIPLE_CANDIDATES", selected_raw_row_ids: [], coverage: { status: "UNCERTAIN", overlap: "UNKNOWN", evidence_keys: [] }, evidence_keys: [], candidate_groups: [{ raw_row_ids: ["IR_C2"], evidence_keys: ["E-I-C2-MODEL"] }, { raw_row_ids: ["IR_C1"], evidence_keys: ["E-I-C1-MODEL"] }, { raw_row_ids: ["IR_C3"], evidence_keys: ["E-I-C3-MODEL", "E-NOT-EXIST"] }], weak_candidates: [], issues: [{ code: "MULTIPLE_MODEL_CANDIDATES", row_ref: "OR_002", field: "model", message: "三个同型号候选无法消歧" }] },
      { order_row_id: "OR_003", match_status: "UNMATCHED", selected_raw_row_ids: [], coverage: { status: "UNCERTAIN", overlap: "UNKNOWN", evidence_keys: [] }, evidence_keys: [], candidate_groups: [], weak_candidates: [], issues: [] },
      { order_row_id: "OR_004", match_status: "MATCHED", selected_raw_row_ids: ["IR_D1"], coverage: { status: "PARTIAL", overlap: "DISJOINT", evidence_keys: [] }, evidence_keys: ["E-O-4-MODEL", "E-I-D1-MODEL"], candidate_groups: [], weak_candidates: [{ raw_row_ids: ["IR_GHOST"], evidence_keys: [], reason: "不在快照中的原始行（用于测试悬空引用）" }], issues: [] },
    ],
    issues: [],
  }),
  { promptKind: "JIULI_P3", schemaVersion: "jiuli-ai-v3", origin: "CONSTRUCTED", title: "P3 一对多 + 多候选 + UNMATCHED + PARTIAL", covers: ["AT08", "AT09", "AT10"], request: "p3-v3-multi-candidate.request.json" },
);

// ---------- P3 v2 + v2.1 可选字段（人工复核状态） ----------
write(
  "p3-v2-review-status.json",
  {
    schema_version: "jiuli-ai-v2", prompt: "P3", request_id: "REQ-CONSTRUCTED-P3V21",
    output: {
      customer_id: "C001", order_task_id: "OT_001", draft_id: "DRAFT_001", draft_version: 1,
      row_relations: [
        { order_row_id: "OR_001", match_status: "MATCHED", selected_group: { sources: [{ logical_inspection_id: "LI_001", merged_product_id: "MP_001", raw_row_ids: ["IR_001"] }] }, coverage: { status: "COMPLETE", order_quantity: "1000", source_ranges: [], independent_scope_evidence: true }, match_evidence: [{ type: "MODEL", result: "前后缀差异", source_refs: ["SRC_201"] }], confidence: "MEDIUM", candidate_groups: [], weak_candidates: [], relation_review_status: "PENDING_REVIEW", difference_flags: ["MODEL_AFFIX_DIFFERENCE"] },
        { order_row_id: "OR_002", match_status: "UNMATCHED", selected_group: null, coverage: { status: "UNCERTAIN" }, match_evidence: [], confidence: "LOW", candidate_groups: [], weak_candidates: [], unmatched_reason: "NO_CANDIDATE_IN_POOL" },
      ],
      warnings: [],
    },
  },
  { promptKind: "JIULI_P3", schemaVersion: "jiuli-ai-v2", origin: "CONSTRUCTED", title: "P3 v2 + v2.1 可选字段（复核门控）", covers: ["AT11"] },
);

// ---------- P4 v3：KEEP+NO_EVIDENCE / FILL / UPDATE / CONFLICT / MISSING / LOCKED（含 request） ----------
const f = (current_value, write_policy = "AUTO", evidence = [], unresolved_issues = [], value_origin = "ORDER") => ({ base_value: current_value, current_value, value_origin, write_policy, evidence, unresolved_issues });
const e4 = (key, value) => ({ evidence_key: key, value, unit: "", source_kind: "RAW", scope: { coverage: "COMPLETE", overlap: "DISJOINT", has_extra_goods: false, has_unresolved_goods: false }, raw_row_ids: ["IR_A1"], source: { file_id: "F-INSP-A", page: 1, sheet: null, row: 4, column: null, raw_text: value } });
const p4req = {
  schema_version: "jiuli-ai-v3", prompt: "P4", request_id: "REQ-CONSTRUCTED-P4",
  context: { customer_id: "C001", mode: "VERIFY_FIELDS" },
  input: {
    target_rows: [
      {
        order_row_id: "OR_001",
        relation: { match_status: "MATCHED", raw_row_ids: ["IR_A1"], coverage: { status: "COMPLETE", overlap: "DISJOINT", evidence_keys: [] } },
        evaluated_fields: ["brand", "origin", "net_weight", "gross_weight", "product_name"],
        fields: {
          brand: f("MICRON"),
          origin: f("中国", "AUTO", [e4("E-ORIGIN-1", "马来西亚")]),
          net_weight: f("", "AUTO", [e4("E-NW-1", "1.2")]),
          gross_weight: f("2.0", "AUTO", [e4("E-GW-1", "2.1"), e4("E-GW-2", "2.4")]),
          product_name: f(""),
        },
      },
      {
        order_row_id: "OR_002",
        relation: { match_status: "MATCHED", raw_row_ids: ["IR_C1"], coverage: { status: "COMPLETE", overlap: "DISJOINT", evidence_keys: [] } },
        evaluated_fields: ["origin", "net_weight"],
        fields: {
          origin: f("中国", "LOCKED", [e4("E-ORIGIN-2", "韩国")], [], "HUMAN"),
          net_weight: f("", "AUTO", [e4("E-NW-2", "0.5")], [{ issue_id: "ISS-9", field: "net_weight", message: "历史净重冲突未处理", blocks_auto_write: true }]),
        },
      },
    ],
  },
};
write("p4-v3-conflict.request.json", p4req, { role: "REQUEST_CONTEXT", for: "p4-v3-conflict.json", origin: "CONSTRUCTED", title: "P4 请求上下文" });
const fd = (field, decision, result_value, verification_status, evidence_keys = [], extra = {}) => ({ field, decision, result_value, verification_status, evidence_keys, candidate_values: [], referenced_issue_ids: [], missing_required: false, reason: "", ...extra });
write(
  "p4-v3-conflict.json",
  v3("P4", {
    processing_status: "SUCCESS",
    row_patches: [
      {
        order_row_id: "OR_001",
        evaluated_fields: ["brand", "origin", "net_weight", "gross_weight", "product_name"],
        field_decisions: [
          fd("brand", "KEEP", "MICRON", "NO_EVIDENCE", [], { reason: "查货无品牌证据" }),
          fd("origin", "UPDATE", "马来西亚", "VERIFIED_UPDATED", ["E-ORIGIN-1"], { reason: "完整范围手写 COD 马来西亚" }),
          fd("net_weight", "FILL", "1.2", "VERIFIED_UPDATED", ["E-NW-1"], { reason: "商品直接 NW" }),
          fd("gross_weight", "CONFLICT", "2.0", "CONFLICT", [], { candidate_values: [{ value: "2.1", evidence_keys: ["E-GW-1"] }, { value: "2.4", evidence_keys: ["E-GW-2"] }], reason: "两个同级 GW 候选不同" }),
          fd("product_name", "MISSING", "", "MISSING_REQUIRED", [], { missing_required: true, reason: "主体品名为空" }),
        ],
      },
      {
        order_row_id: "OR_002",
        evaluated_fields: ["origin", "net_weight"],
        field_decisions: [
          fd("origin", "UPDATE", "韩国", "VERIFIED_UPDATED", ["E-ORIGIN-2"], { reason: "（构造：模型违规对 LOCKED 字段给出 UPDATE）" }),
          fd("net_weight", "FILL", "0.5", "VERIFIED_UPDATED", ["E-NW-2"], { referenced_issue_ids: ["ISS-9"], reason: "（构造：存在阻断问题仍 FILL）" }),
        ],
      },
    ],
    issues: [],
  }),
  { promptKind: "JIULI_P4", schemaVersion: "jiuli-ai-v3", origin: "CONSTRUCTED", title: "P4 KEEP无证据/FILL/UPDATE/CONFLICT/MISSING/锁定", covers: ["AT12", "AT13", "AT14", "AT15"], request: "p4-v3-conflict.request.json" },
);

// ---------- P4 v2 + 完整基准草稿（演示完整 Patch 后草稿） ----------
write(
  "p4-v2-with-base-draft.json",
  {
    schema_version: "jiuli-ai-v2", prompt: "P4", request_id: "REQ-CONSTRUCTED-P4V2",
    output: {
      base_draft_version: 3,
      row_patches: [{
        order_row_id: "OR_001",
        field_decisions: [
          { field: "origin", decision: "UPDATE", current_value: "中国", result_value: "马来西亚", verification_status: "VERIFIED_UPDATED", rule_id: "ORIGIN_PRIORITY_COMPLETE_COVERAGE", source_refs: ["SRC_201"], conflict_values: [] },
          { field: "net_weight", decision: "CONFLICT", current_value: "1.0", result_value: "1.0", verification_status: "CONFLICT", rule_id: "NW_CONFLICT", source_refs: ["SRC_203"], conflict_values: ["1.2", "1.3"] },
        ],
        row_verification: { has_inspection_basis: true, coverage_status: "COMPLETE", has_conflict: true, has_missing_required: false },
      }],
      warnings: [],
    },
  },
  {
    promptKind: "JIULI_P4", schemaVersion: "jiuli-ai-v2", origin: "CONSTRUCTED", title: "P4 v2 + 匹配版本的完整基准草稿", covers: ["AT13", "AT14"],
    baseDraft: { version: 3, rows: { OR_001: Object.fromEntries(KEYS.map((k) => [k, { customer_name: "客户A", brand: "MICRON", model: "ABC-01", origin: "中国", net_weight: "1.0", quantity: "1000" }[k] ?? ""])) } },
  },
);

// ---------- 未知枚举 ----------
write(
  "p3-v3-unknown-enum.json",
  v3("P3", { processing_status: "SUCCESS", row_relations: [{ order_row_id: "OR_009", match_status: "PROBABLY_MATCHED", selected_raw_row_ids: ["IR_1"], coverage: { status: "MOSTLY", overlap: "DISJOINT", evidence_keys: [] }, evidence_keys: [], candidate_groups: [], weak_candidates: [], issues: [] }], issues: [] }),
  { promptKind: "JIULI_P3", schemaVersion: "jiuli-ai-v3", origin: "CONSTRUCTED", title: "P3 未知枚举（PROBABLY_MATCHED）", covers: ["9.1 未知枚举"] },
);

writeFileSync(join(OUT, "manifest.json"), JSON.stringify({ note: "人工构造的测试 Fixture：不是真实单证，不是真实模型输出，不能用于宣称准确率。", items: manifest }, null, 2) + "\n");
console.log(`wrote ${manifest.length} fixtures to ${OUT}`);
