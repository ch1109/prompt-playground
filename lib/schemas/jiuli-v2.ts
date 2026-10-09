// v2.0 结构：依据规格包 fixtures/jiuli-v2.0 与 03 映射文档推导（Studio 推导，非官方）。
import { envelope, intOrNull, stringOrNull, valuesObject } from "./common";

const sourceRefV2 = {
  type: "object",
  required: ["local_source_ref", "file_id"],
  properties: {
    local_source_ref: { type: "string" },
    source_type: { type: "string" },
    file_id: { type: "string" },
    file_name: stringOrNull,
    page: intOrNull,
    sheet: stringOrNull,
    row: intOrNull,
    column: stringOrNull,
    raw_text: stringOrNull,
  },
};

export const P1_V2 = envelope("jiuli-ai-v2", "P1", {
  type: "object",
  required: ["customer_resolution", "source_refs", "rows", "warnings"],
  properties: {
    processing_status: { type: "string" },
    source_refs: { type: "array", items: sourceRefV2 },
    rows: {
      type: "array",
      items: {
        type: "object",
        required: ["row_seq", "local_row_ref", "values", "field_sources", "field_conflicts"],
        properties: {
          row_seq: { type: "integer" },
          local_row_ref: { type: "string" },
          values: valuesObject,
          field_sources: { type: "object" },
          field_conflicts: { type: "array" },
        },
      },
    },
    source_total_facts: { type: "object" },
    warnings: { type: "array" },
  },
});

export const P2_V2 = envelope("jiuli-ai-v2", "P2", {
  type: "object",
  required: ["source_refs", "logical_inspections", "unresolved_scopes", "warnings"],
  properties: {
    source_refs: { type: "array", items: sourceRefV2 },
    logical_inspections: {
      type: "array",
      items: {
        type: "object",
        required: ["local_logical_ref", "warehouse_no", "raw_rows", "merged_products", "scope_uncertain"],
        properties: {
          local_logical_ref: { type: "string" },
          warehouse_no: { type: "string" },
          header_facts: { type: "object" },
          scope_uncertain: { type: "boolean" },
          raw_rows: {
            type: "array",
            items: {
              type: "object",
              required: ["local_raw_row_ref", "facts"],
              properties: {
                local_raw_row_ref: { type: "string" },
                facts: { type: "object" },
                origin_facts: { type: "array" },
                manual_marks: { type: "array" },
                package_facts: { type: "array" },
                weight_facts: { type: "array" },
                source_refs: { type: "array", items: { type: "string" } },
              },
            },
          },
          merged_products: {
            type: "array",
            items: {
              type: "object",
              required: ["local_merged_ref", "raw_row_refs"],
              properties: {
                local_merged_ref: { type: "string" },
                merge_key: { type: "object" },
                raw_row_refs: { type: "array", items: { type: "string" } },
                aggregated: { type: "object" },
                field_conflicts: { type: "array" },
              },
            },
          },
        },
      },
    },
    unresolved_scopes: { type: "array" },
    warnings: { type: "array" },
  },
});

export const P3_V2 = envelope("jiuli-ai-v2", "P3", {
  type: "object",
  required: ["row_relations", "warnings"],
  properties: {
    row_relations: {
      type: "array",
      items: {
        type: "object",
        required: ["order_row_id", "match_status", "coverage", "match_evidence", "candidate_groups", "weak_candidates"],
        properties: {
          order_row_id: { type: "string" },
          match_status: { enum: ["MATCHED", "MULTIPLE_CANDIDATES", "UNMATCHED"] },
          selected_group: {
            type: ["object", "null"],
            properties: {
              sources: {
                type: "array",
                items: {
                  type: "object",
                  required: ["raw_row_ids"],
                  properties: {
                    logical_inspection_id: { type: "string" },
                    merged_product_id: stringOrNull,
                    raw_row_ids: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          coverage: { type: "object" },
          match_evidence: { type: "array" },
          confidence: { type: "string" },
          candidate_groups: { type: "array" },
          weak_candidates: { type: "array" },
        },
      },
    },
    warnings: { type: "array" },
  },
});

export const P4_V2 = envelope("jiuli-ai-v2", "P4", {
  type: "object",
  required: ["base_draft_version", "row_patches", "warnings"],
  properties: {
    base_draft_version: { type: ["integer", "string"] },
    row_patches: {
      type: "array",
      items: {
        type: "object",
        required: ["order_row_id", "field_decisions"],
        properties: {
          order_row_id: { type: "string" },
          field_decisions: {
            type: "array",
            items: {
              type: "object",
              required: ["field", "decision", "current_value", "result_value", "verification_status", "source_refs"],
              properties: {
                field: { type: "string" },
                decision: { enum: ["KEEP", "FILL", "UPDATE", "CONFLICT", "MISSING", "NO_ACTION"] },
                verification_status: {
                  enum: ["VERIFIED_CONSISTENT", "VERIFIED_UPDATED", "CONFLICT", "MISSING_REQUIRED", "NO_EVIDENCE", "NOT_CHECKED"],
                },
                rule_id: { type: "string" },
                source_refs: { type: "array", items: { type: "string" } },
                conflict_values: { type: "array" },
              },
            },
          },
          row_verification: { type: "object" },
        },
      },
    },
    warnings: { type: "array" },
  },
});
