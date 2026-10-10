import type { TableColumn, TableRow } from "@/lib/contracts/view-model";
import { CORE_FIELDS, FIELD_LABELS, P1_VALUE_KEYS } from "@/lib/schemas/common";
import { join, ptr } from "@/lib/pipeline/json-pointer";
import { arr, display, makeCell, obj, strOrUndef, VMBuilder } from "./helpers";
import type { AdapterContext, BusinessAdapter } from "./types";

const FROZEN = new Set(["model"]);

function valueColumns(seqKey: string, seqTitle: string): TableColumn[] {
  return [
    { key: seqKey, title: seqTitle, kind: "number", fixed: true, core: true },
    ...P1_VALUE_KEYS.map((k) => ({ key: k, title: FIELD_LABELS[k], fixed: FROZEN.has(k), core: CORE_FIELDS.has(k) || k === "model" })),
  ];
}

function goldCheck(b: VMBuilder, ctx: AdapterContext, rowCount: number) {
  // AT04：漏行只能依据独立 Gold/材料证据判断，Adapter 不凭空告警
  const expected = ctx.gold?.expectedRowCount;
  if (typeof expected === "number" && expected !== rowCount) {
    b.issue({
      type: "ROW_COUNT_MISMATCH_GOLD",
      severity: "WARNING",
      summary: `Gold 标注商品行数 ${expected}，模型输出 ${rowCount} 行`,
      detail: "依据快照中的独立 Gold 标注判断，不是模型自述。",
      target: { tableId: "orderRows", jsonPointer: "/output/rows" },
      sourceRefIds: [],
      origin: "RULE",
    });
  }
}

// ---------------- v3：rows[{row_no, source, values, evidence, conflicts}] ----------------

export const jiuliP1V3: BusinessAdapter = {
  adapterId: "jiuli-p1-v3",
  adapterVersion: "1.1.0",
  promptKind: "JIULI_P1",
  schemaVersion: "jiuli-ai-v3",
  rendererId: "jiuli-p1-v3",
  adapt(doc, ctx) {
    const b = new VMBuilder(ctx);
    const out = obj(obj(doc).output);
    const rid = b.uniqueRowIds();

    // 客户识别来源
    const cr = obj(out.customer_resolution);
    arr(cr.sources).forEach((s, i) => b.sourceEvidence(s, ptr("output", "customer_resolution", "sources", i), "RESPONSE", "客户识别"));

    const rows: TableRow[] = [];
    const rowIdByNo = new Map<string, string>();
    arr(out.rows).forEach((r0, i) => {
      const r = obj(r0);
      const base = ptr("output", "rows", i);
      const rowNo = strOrUndef(r.row_no) ?? `#${i + 1}`;
      const rowId = rid(`row-${rowNo}`, base);
      rowIdByNo.set(rowNo, rowId);

      const rowSrc = b.sourceEvidence(r.source, join(base, "source"), "RESPONSE", `第 ${rowNo} 行主体位置`);
      const refsByField = new Map<string, string[]>();
      arr(r.evidence).forEach((e0, j) => {
        const e = obj(e0);
        const field = strOrUndef(e.field) ?? "";
        const id = b.sourceEvidence(e.source, join(base, "evidence", j, "source"), "RESPONSE", `${FIELD_LABELS[field] ?? field} = ${display(e.value)}${e.unit ? " " + display(e.unit) : ""}`);
        if (id) refsByField.set(field, [...(refsByField.get(field) ?? []), id]);
      });

      const values = obj(r.values);
      const cells: TableRow["cells"] = {
        row_no: makeCell(rowId, "row_no", r.row_no, join(base, "row_no"), rowSrc ? [rowSrc] : []),
      };
      for (const k of P1_VALUE_KEYS) {
        cells[k] = makeCell(rowId, k, values[k], join(base, "values", k), refsByField.get(k) ?? []);
      }
      rows.push({ id: rowId, sourceRefIds: rowSrc ? [rowSrc] : [], cells });

      arr(r.conflicts).forEach((c0, k) => {
        const c = obj(c0);
        const field = strOrUndef(c.field);
        const known = field !== undefined && (P1_VALUE_KEYS as readonly string[]).includes(field);
        if (field && !known) b.diag("WARNING", "CONFLICT_FIELD_UNKNOWN", `冲突字段 ${field} 不在 25 列中，无法定位到单元格`, join(base, "conflicts", k));
        b.issue({
          type: "FIELD_CONFLICT",
          severity: "WARNING",
          summary: `${FIELD_LABELS[field ?? ""] ?? field ?? "?"}：${display(c.message)}`,
          detail: "冲突候选值及来源见本行该字段的证据。",
          target: { tableId: "orderRows", rowId, fieldKey: known ? field : undefined, jsonPointer: join(base, "conflicts", k) },
          sourceRefIds: known ? refsByField.get(field!) ?? [] : [],
          origin: "MODEL_FINDING",
        });
      });
    });

    b.out.tables.push({ id: "orderRows", title: "委托商品行（25 字段）", columns: valueColumns("row_no", "序号"), rows });

    // 模型输出的问题：row_ref 能对上行序号才定位，否则作为一般问题，不伪造位置
    arr(out.issues).forEach((x0, i) => {
      const x = obj(x0);
      const p = ptr("output", "issues", i);
      const rowRef = strOrUndef(x.row_ref);
      const field = strOrUndef(x.field);
      const rowId = rowRef ? rowIdByNo.get(rowRef) : undefined;
      if (rowRef && !rowId) b.diag("WARNING", "ISSUE_TARGET_NOT_FOUND", `问题引用的行 ${rowRef} 不存在`, p);
      const known = field !== undefined && (P1_VALUE_KEYS as readonly string[]).includes(field);
      b.issue({
        type: strOrUndef(x.code) ?? "ISSUE",
        severity: "UNKNOWN",
        summary: display(x.message) || display(x0),
        target: rowId ? { tableId: "orderRows", rowId, fieldKey: known ? field : undefined, jsonPointer: p } : { jsonPointer: p },
        sourceRefIds: [],
        origin: "MODEL_FINDING",
      });
    });

    // 共享范围、未关联记录、读取状态：原样展示
    const scopeRows: TableRow[] = arr(out.scope_records).map((s0, i) => {
      const s = obj(s0);
      const base = ptr("output", "scope_records", i);
      const id = `scope-${i + 1}`;
      const src = b.sourceEvidence(s.source, join(base, "source"), "RESPONSE", `范围 ${display(s.kind)}`);
      return {
        id,
        sourceRefIds: src ? [src] : [],
        cells: {
          kind: makeCell(id, "kind", s.kind, join(base, "kind")),
          member_row_nos: makeCell(id, "member_row_nos", s.member_row_nos, join(base, "member_row_nos")),
          range_complete: makeCell(id, "range_complete", s.range_complete, join(base, "range_complete")),
          measurements: makeCell(
            id,
            "measurements",
            arr(s.measurements).map((m) => `${display(obj(m).field)}=${display(obj(m).value)}${obj(m).unit ? " " + display(obj(m).unit) : ""}`).join("；"),
            join(base, "measurements"),
            src ? [src] : [],
          ),
        },
      };
    });
    b.out.tables.push({
      id: "scopeRecords",
      title: "合计与共享范围",
      columns: [
        { key: "kind", title: "类型" },
        { key: "member_row_nos", title: "成员行" },
        { key: "range_complete", title: "范围完整" },
        { key: "measurements", title: "度量" },
      ],
      rows: scopeRows,
    });

    const unlinkedRows: TableRow[] = arr(out.unlinked_records).map((u0, i) => {
      const u = obj(u0);
      const base = ptr("output", "unlinked_records", i);
      const id = `unlinked-${i + 1}`;
      const src = b.sourceEvidence(u.source, join(base, "source"), "RESPONSE", "未关联记录");
      return {
        id,
        sourceRefIds: src ? [src] : [],
        cells: {
          fields: makeCell(id, "fields", u.fields, join(base, "fields"), src ? [src] : []),
          candidate_row_nos: makeCell(id, "candidate_row_nos", u.candidate_row_nos, join(base, "candidate_row_nos")),
          reason: makeCell(id, "reason", u.reason, join(base, "reason")),
        },
      };
    });
    b.out.tables.push({
      id: "unlinkedRecords",
      title: "未关联记录（没能对应到唯一商品行的辅助信息）",
      columns: [
        { key: "fields", title: "字段" },
        { key: "candidate_row_nos", title: "候选行" },
        { key: "reason", title: "原因" },
      ],
      rows: unlinkedRows,
    });

    const readRows: TableRow[] = arr(out.read_status).map((r0, i) => {
      const r = obj(r0);
      const base = ptr("output", "read_status", i);
      const id = `read-${i + 1}`;
      return {
        id,
        cells: {
          file_id: makeCell(id, "file_id", r.file_id, join(base, "file_id")),
          status: makeCell(id, "status", r.status, join(base, "status")),
          read_segments: makeCell(id, "read_segments", r.read_segments, join(base, "read_segments")),
          unread_segments: makeCell(id, "unread_segments", r.unread_segments, join(base, "unread_segments")),
        },
      };
    });
    b.out.tables.push({
      id: "readStatus",
      title: "材料读取情况",
      columns: [
        { key: "file_id", title: "文件" },
        { key: "status", title: "状态" },
        { key: "read_segments", title: "已读片段" },
        { key: "unread_segments", title: "未读片段" },
      ],
      rows: readRows,
    });

    goldCheck(b, ctx, rows.length);

    b.out.metadata = {
      summary: [
        { label: "处理状态", value: display(out.processing_status) || "—" },
        { label: "客户识别", value: `${display(cr.status) || "—"}${cr.customer_id ? " · " + display(cr.customer_id) : ""}` },
        { label: "原始商品行数", value: ctx.gold?.expectedRowCount ?? "未知", hint: "需 Gold/材料证据，模型输出不能自证" },
        { label: "识别商品行数", value: rows.length },
        { label: "问题数", value: b.out.issues.length },
        { label: "输入材料数", value: arr(out.read_status).length },
      ],
      notes: ["统计仅为结构计数，不代表业务准确率。"],
      headline: { entity: "商品", customerName: strOrUndef(cr.recognized_name), customerId: strOrUndef(cr.customer_id), gold: !!ctx.gold },
    };
    return b.out;
  },
};

// ---------------- v2.0：rows[{row_seq, local_row_ref, values, field_sources, field_conflicts}] ----------------

export const jiuliP1V2: BusinessAdapter = {
  adapterId: "jiuli-p1-v2",
  adapterVersion: "1.1.0",
  promptKind: "JIULI_P1",
  schemaVersion: "jiuli-ai-v2",
  rendererId: "jiuli-p1",
  adapt(doc, ctx) {
    const b = new VMBuilder(ctx);
    const out = obj(obj(doc).output);
    const rid = b.uniqueRowIds();

    // source_refs → evidence，按 local_source_ref 建索引
    arr(out.source_refs).forEach((s0, i) => {
      const s = obj(s0);
      const p = ptr("output", "source_refs", i);
      const ref = strOrUndef(s.local_source_ref);
      if (!ref) {
        b.diag("WARNING", "SOURCE_REF_WITHOUT_ID", "source_refs 项缺少 local_source_ref", p);
        return;
      }
      if (b.hasEvidence(ref)) b.diag("WARNING", "DUPLICATE_SOURCE_REF", `来源引用 ${ref} 重复`, p);
      b.addEvidence({
        id: ref,
        fileId: strOrUndef(s.file_id) ?? "",
        fileName: strOrUndef(s.file_name),
        page: typeof s.page === "number" ? s.page : null,
        sheet: strOrUndef(s.sheet) ?? null,
        row: typeof s.row === "number" ? s.row : null,
        column: strOrUndef(s.column) ?? null,
        rawText: strOrUndef(s.raw_text) ?? null,
        availability: "METADATA_ONLY",
        jsonPointer: p,
        location: "RESPONSE",
        label: `${display(s.source_type)} ${display(s.column)}`.trim(),
      });
    });

    const refIds = (v: unknown, pointer: string): string[] => {
      const ids = (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(String);
      for (const id of ids) {
        if (!b.hasEvidence(id)) {
          b.diag("WARNING", "SOURCE_REF_NOT_FOUND", `引用的来源 ${id} 不在 source_refs 中`, pointer);
          b.missingEvidence(id, "未在 source_refs 中定义");
        }
      }
      return ids;
    };

    const rows: TableRow[] = [];
    const rowIds = new Set<string>();
    arr(out.rows).forEach((r0, i) => {
      const r = obj(r0);
      const base = ptr("output", "rows", i);
      const rowId = rid(strOrUndef(r.local_row_ref) ?? `row#${i + 1}`, base);
      rowIds.add(rowId);
      const values = obj(r.values);
      const fs = obj(r.field_sources);
      const cells: TableRow["cells"] = { row_seq: makeCell(rowId, "row_seq", r.row_seq, join(base, "row_seq")) };
      for (const k of P1_VALUE_KEYS) {
        cells[k] = makeCell(rowId, k, values[k], join(base, "values", k), refIds(fs[k], join(base, "field_sources", k)));
      }
      rows.push({ id: rowId, cells, meta: { source_position: r.source_position } });

      arr(r.field_conflicts).forEach((c0, k) => {
        const c = obj(c0);
        const p = join(base, "field_conflicts", k);
        const field = strOrUndef(c.field);
        const known = field !== undefined && (P1_VALUE_KEYS as readonly string[]).includes(field);
        b.issue({
          type: strOrUndef(c.conflict_type) ?? strOrUndef(c.type) ?? "FIELD_CONFLICT",
          severity: "WARNING",
          summary: `${FIELD_LABELS[field ?? ""] ?? field ?? "字段"}：${display(c.message) || display(c0)}`,
          detail: c.candidates !== undefined ? `候选：${display(c.candidates)}` : undefined,
          target: { tableId: "orderRows", rowId, fieldKey: known ? field : undefined, jsonPointer: p },
          sourceRefIds: refIds(c.source_refs ?? (known ? fs[field!] : undefined), p),
          origin: "MODEL_FINDING",
        });
      });
    });
    b.out.tables.push({ id: "orderRows", title: "委托商品行（25 字段）", columns: valueColumns("row_seq", "序号"), rows });

    // warnings：字符串只作一般警告；只有对象里明确给了存在的行引用才定位
    arr(out.warnings).forEach((w, i) => {
      const p = ptr("output", "warnings", i);
      const wo = obj(w);
      const rowRef = strOrUndef(wo.local_row_ref);
      const target = rowRef && rowIds.has(rowRef) ? { tableId: "orderRows", rowId: rowRef, fieldKey: strOrUndef(wo.field), jsonPointer: p } : { jsonPointer: p };
      b.issue({ type: strOrUndef(wo.code) ?? "WARNING", severity: "UNKNOWN", summary: typeof w === "string" ? w : display(wo.message) || display(w), target, sourceRefIds: [], origin: "MODEL_FINDING" });
    });

    goldCheck(b, ctx, rows.length);
    const cr = obj(out.customer_resolution);
    b.out.metadata = {
      summary: [
        { label: "处理状态", value: display(out.processing_status) || "—" },
        { label: "客户识别", value: `${display(cr.status) || "—"}${cr.customer_id ? " · " + display(cr.customer_id) : ""}` },
        { label: "原始商品行数", value: ctx.gold?.expectedRowCount ?? "未知", hint: "需 Gold/材料证据" },
        { label: "识别商品行数", value: rows.length },
        { label: "问题数", value: b.out.issues.length },
        { label: "输入材料数", value: arr(out.source_materials).length },
      ],
      notes: ["统计仅为结构计数，不代表业务准确率。"],
      headline: { entity: "商品", customerName: strOrUndef(cr.recognized_name), customerId: strOrUndef(cr.customer_id), gold: !!ctx.gold },
    };
    return b.out;
  },
};
