// v3.0 结构：依据 九立demo/提示词文件及方案/P{1-4}_*_FINAL_v3.0.txt 的"输出"章节推导（Studio 推导，非官方）。
import { envelope, intOrNull, stringOrNull, valuesObject } from "./common";

const source = {
  type: "object",
  required: ["file_id"],
  properties: {
    file_id: { type: "string" },
    page: intOrNull,
    sheet: stringOrNull,
    row: intOrNull,
    column: stringOrNull,
    raw_text: stringOrNull,
  },
};

const issue = {
  type: "object",
  required: ["code", "message"],
  properties: {
    code: { type: "string" },
    row_ref: { type: ["string", "integer", "null"] },
    field: stringOrNull,
    message: { type: "string" },
  },
};

const readStatus = {
  type: "array",
  items: {
    type: "object",
    required: ["file_id", "status"],
    properties: {
      file_id: { type: "string" },
      read_segments: { type: "array" },
      unread_segments: { type: "array" },
      status: { enum: ["COMPLETE", "INCOMPLETE", "UNREADABLE"] },
    },
  },
};

const p12Status = { enum: ["SUCCESS", "PARTIAL", "NEEDS_REVIEW", "INVALID_INPUT"] };
const p34Status = { enum: ["SUCCESS", "INVALID_INPUT"] };

export const P1_V3 = envelope("jiuli-ai-v3", "P1", {
  type: "object",
  required: ["processing_status", "customer_resolution", "read_status", "rows", "scope_records", "unlinked_records", "issues"],
  properties: {
    processing_status: p12Status,
    customer_resolution: {
      type: "object",
      required: ["status", "customer_id", "recognized_name", "candidate_customer_ids", "sources"],
      properties: {
        status: { enum: ["RESOLVED", "UNRESOLVED"] },
        customer_id: stringOrNull,
        recognized_name: { type: "string" },
        candidate_customer_ids: { type: "array", items: { type: "string" } },
        sources: { type: "array", items: source },
      },
    },
    read_status: readStatus,
    rows: {
      type: "array",
      items: {
        type: "object",
        required: ["row_no", "source", "values", "evidence", "conflicts"],
        properties: {
          row_no: { type: "integer" },
          source,
          values: valuesObject,
          evidence: {
            type: "array",
            items: {
              type: "object",
              required: ["field", "value", "source"],
              properties: { field: { type: "string" }, value: { type: "string" }, unit: { type: "string" }, source },
            },
          },
          conflicts: {
            type: "array",
            items: { type: "object", required: ["field", "message"], properties: { field: { type: "string" }, message: { type: "string" } } },
          },
        },
      },
    },
    scope_records: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "member_row_nos", "range_complete", "measurements"],
        properties: {
          kind: { enum: ["ORDER_TOTAL", "SUBTOTAL", "SHARED_WEIGHT", "SHARED_PACKAGE"] },
          member_row_nos: { type: "array", items: { type: "integer" } },
          range_complete: { type: "boolean" },
          measurements: { type: "array" },
        },
      },
    },
    unlinked_records: { type: "array" },
    issues: { type: "array", items: issue },
  },
});

export const P2_V3 = envelope("jiuli-ai-v3", "P2", {
  type: "object",
  required: ["processing_status", "customer_id", "read_status", "logical_inspections", "raw_rows", "scope_records", "issues"],
  properties: {
    processing_status: p12Status,
    customer_id: stringOrNull,
    read_status: readStatus,
    logical_inspections: {
      type: "array",
      items: {
        type: "object",
        required: ["warehouse_no", "sources", "range_status"],
        properties: {
          warehouse_no: { type: "string" },
          sources: { type: "array", items: source },
          range_status: { enum: ["COMPLETE", "PARTIAL", "UNCERTAIN"] },
        },
      },
    },
    raw_rows: {
      type: "array",
      items: {
        type: "object",
        required: ["record_no", "warehouse_no", "candidate_warehouse_nos", "source", "fields", "field_sources", "origin_candidates", "manual_marks"],
        properties: {
          record_no: { type: "integer" },
          warehouse_no: { type: "string" },
          candidate_warehouse_nos: { type: "array", items: { type: "string" } },
          source,
          fields: { type: "object" },
          field_sources: { type: "object" },
          origin_candidates: {
            type: "array",
            items: {
              type: "object",
              required: ["value", "kind"],
              properties: {
                value: { type: "string" },
                kind: { enum: ["HANDWRITTEN_COD", "HANDWRITTEN_COA", "PRINTED_COD", "PRINTED_COA", "COO", "ORIGIN_OTHER"] },
                source,
              },
            },
          },
          manual_marks: {
            type: "array",
            items: {
              type: "object",
              required: ["action"],
              properties: { action: { enum: ["TICK", "CIRCLE", "CROSS_OUT", "ARROW", "REPLACE", "UNCLEAR"] } },
            },
          },
        },
      },
    },
    scope_records: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "member_record_nos", "range_complete", "measurements"],
        properties: {
          warehouse_no: { type: "string" },
          kind: { enum: ["PACKAGE", "PACK", "LOGICAL_TOTAL", "QUANTITY_GROUP", "UNRESOLVED"] },
          identifier: { type: "string" },
          member_record_nos: { type: "array", items: { type: "integer" } },
          range_complete: { type: "boolean" },
          has_unresolved_goods: { type: "boolean" },
          measurements: { type: "array" },
        },
      },
    },
    issues: { type: "array", items: issue },
  },
});

export const P3_V3 = envelope("jiuli-ai-v3", "P3", {
  type: "object",
  required: ["processing_status", "row_relations", "issues"],
  properties: {
    processing_status: p34Status,
    row_relations: {
      type: "array",
      items: {
        type: "object",
        required: [
          "order_row_id",
          "match_status",
          "selected_raw_row_ids",
          "coverage",
          "evidence_keys",
          "candidate_groups",
          "weak_candidates",
          "issues",
        ],
        properties: {
          order_row_id: { type: "string" },
          match_status: { enum: ["MATCHED", "MULTIPLE_CANDIDATES", "UNMATCHED"] },
          selected_raw_row_ids: { type: "array", items: { type: "string" } },
          coverage: {
            type: "object",
            required: ["status", "overlap"],
            properties: {
              status: { enum: ["COMPLETE", "PARTIAL", "UNCERTAIN"] },
              overlap: { enum: ["DISJOINT", "OVERLAPPING", "UNKNOWN"] },
              evidence_keys: { type: "array", items: { type: "string" } },
            },
          },
          evidence_keys: { type: "array", items: { type: "string" } },
          candidate_groups: {
            type: "array",
            items: { type: "object", required: ["raw_row_ids"], properties: { raw_row_ids: { type: "array", items: { type: "string" } } } },
          },
          weak_candidates: {
            type: "array",
            items: { type: "object", required: ["raw_row_ids"], properties: { raw_row_ids: { type: "array", items: { type: "string" } } } },
          },
          issues: { type: "array", items: issue },
        },
      },
    },
    issues: { type: "array", items: issue },
  },
});

const fieldDecision = {
  type: "object",
  required: [
    "field",
    "decision",
    "result_value",
    "verification_status",
    "evidence_keys",
    "candidate_values",
    "referenced_issue_ids",
    "missing_required",
    "reason",
  ],
  properties: {
    field: { type: "string" },
    decision: { enum: ["KEEP", "FILL", "UPDATE", "CONFLICT", "MISSING", "NO_ACTION"] },
    result_value: { type: "string" },
    verification_status: {
      enum: ["VERIFIED_CONSISTENT", "VERIFIED_UPDATED", "CONFLICT", "MISSING_REQUIRED", "NO_EVIDENCE", "NOT_CHECKED"],
    },
    evidence_keys: { type: "array", items: { type: "string" } },
    candidate_values: { type: "array" },
    referenced_issue_ids: { type: "array", items: { type: "string" } },
    missing_required: { type: "boolean" },
    reason: { type: "string" },
  },
};

export const P4_V3 = envelope("jiuli-ai-v3", "P4", {
  type: "object",
  required: ["processing_status", "issues"],
  // VERIFY_FIELDS 输出 row_patches；ASSESS_CALCULATION 输出 calculation_checks
  anyOf: [{ required: ["row_patches"] }, { required: ["calculation_checks"] }],
  properties: {
    processing_status: p34Status,
    row_patches: {
      type: "array",
      items: {
        type: "object",
        required: ["order_row_id", "evaluated_fields", "field_decisions"],
        properties: {
          order_row_id: { type: "string" },
          evaluated_fields: { type: "array", items: { type: "string" } },
          field_decisions: { type: "array", items: fieldDecision },
        },
      },
    },
    calculation_checks: { type: "array" },
    issues: { type: "array", items: issue },
  },
});
