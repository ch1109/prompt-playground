import type { TableColumn, TableRow } from "@/lib/contracts/view-model";
import { FIELD_LABELS } from "@/lib/schemas/common";
import { join, ptr } from "@/lib/pipeline/json-pointer";
import { arr, display, makeCell, obj, strOrUndef, VMBuilder } from "./helpers";
import type { BusinessAdapter } from "./types";

/** 无可靠入仓号的原始行归到此"虚拟分组"展示，绝不伪造入仓号 */
export const UNRESOLVED_GROUP = "__UNRESOLVED__";

const RAW_FIELD_ORDER = [
  "brand",
  "model",
  "product_name",
  "unit",
  "quantity",
  "packages",
  "net_weight",
  "net_weight_unit",
  "gross_weight",
  "gross_weight_unit",
  "sku",
  "purchase_order_no",
  "material_no",
  "pallet_count",
  "production_line",
  "remark",
  "pack_no",
  "box_no",
  "dc",
  "lot",
];

const label = (k: string) =>
  FIELD_LABELS[k] ??
  ({ net_weight_unit: "净重单位", gross_weight_unit: "毛重单位", pack_no: "Pack", box_no: "箱号", dc: "DC", lot: "LOT" } as Record<string, string>)[k] ??
  k;

// ---------------- v3：logical_inspections + raw_rows(按 warehouse_no 关联) + scope_records ----------------

export const jiuliP2V3: BusinessAdapter = {
  adapterId: "jiuli-p2-v3",
  adapterVersion: "1.0.0",
  promptKind: "JIULI_P2",
  schemaVersion: "jiuli-ai-v3",
  rendererId: "jiuli-p2-v3",
  adapt(doc, ctx) {
    const b = new VMBuilder(ctx);
    const out = obj(obj(doc).output);
    const rid = b.uniqueRowIds();

    const rawRows = arr(out.raw_rows);
    const liWarehouses = new Set<string>();

    // 一层：逻辑查货单
    const liRows: TableRow[] = arr(out.logical_inspections).map((l0, i) => {
      const l = obj(l0);
      const base = ptr("output", "logical_inspections", i);
      const wh = strOrUndef(l.warehouse_no) ?? "";
      if (!wh) b.diag("WARNING", "LOGICAL_INSPECTION_WITHOUT_WAREHOUSE", "逻辑查货单缺少入仓号（v3 契约要求未确定号码不创建逻辑单）", base);
      liWarehouses.add(wh);
      const id = rid(`wh-${wh}`, base);
      const srcIds = arr(l.sources)
        .map((s, j) => b.sourceEvidence(s, join(base, "sources", j), "RESPONSE", `入仓号 ${wh} 来源`))
        .filter((x): x is string => !!x);
      const count = rawRows.filter((r) => strOrUndef(obj(r).warehouse_no) === wh).length;
      return {
        id,
        sourceRefIds: srcIds,
        meta: { group: wh },
        cells: {
          warehouse_no: makeCell(id, "warehouse_no", wh, join(base, "warehouse_no"), srcIds),
          range_status: makeCell(id, "range_status", l.range_status, join(base, "range_status")),
          raw_row_count: makeCell(id, "raw_row_count", count, base),
          source_count: makeCell(id, "source_count", srcIds.length, join(base, "sources"), srcIds),
        },
      };
    });
    b.out.tables.push({
      id: "logicalInspections",
      title: "逻辑查货单（按入仓号）",
      columns: [
        { key: "warehouse_no", title: "入仓号", fixed: true },
        { key: "range_status", title: "范围状态" },
        { key: "raw_row_count", title: "原始行数", kind: "number" },
        { key: "source_count", title: "来源数", kind: "number" },
      ],
      rows: liRows,
    });

    // 三层：原始行（v3 P2 不输出 merged_product，合并由九立程序完成）
    const fieldKeys = new Set<string>();
    rawRows.forEach((r) => Object.keys(obj(obj(r).fields)).forEach((k) => fieldKeys.add(k)));
    const orderedFields = [...RAW_FIELD_ORDER.filter((k) => fieldKeys.has(k)), ...[...fieldKeys].filter((k) => !RAW_FIELD_ORDER.includes(k))];

    const rowIdByRecord = new Map<string, string>();
    const raw: TableRow[] = rawRows.map((r0, i) => {
      const r = obj(r0);
      const base = ptr("output", "raw_rows", i);
      const recNo = strOrUndef(r.record_no) ?? `#${i + 1}`;
      const id = rid(`rec-${recNo}`, base);
      rowIdByRecord.set(recNo, id);
      const wh = strOrUndef(r.warehouse_no) ?? "";
      const cands = arr(r.candidate_warehouse_nos).map(String);
      if (wh && !liWarehouses.has(wh)) b.diag("WARNING", "RAW_ROW_WAREHOUSE_NOT_IN_LOGICAL", `原始行 ${recNo} 的入仓号 ${wh} 不在 logical_inspections 中`, join(base, "warehouse_no"));
      const rowSrc = b.sourceEvidence(r.source, join(base, "source"), "RESPONSE", `原始行 ${recNo}`);
      const fs = obj(r.field_sources);
      const fields = obj(r.fields);
      const cells: TableRow["cells"] = {
        record_no: makeCell(id, "record_no", r.record_no, join(base, "record_no"), rowSrc ? [rowSrc] : []),
        warehouse_no: makeCell(id, "warehouse_no", wh, join(base, "warehouse_no")),
        candidate_warehouse_nos: makeCell(id, "candidate_warehouse_nos", cands.length ? cands.join(" / ") : "", join(base, "candidate_warehouse_nos")),
      };
      for (const k of orderedFields) {
        const srcs = arr(fs[k]).length ? arr(fs[k]) : fs[k] ? [fs[k]] : [];
        const ids = srcs
          .map((s, j) => b.sourceEvidence(s, Array.isArray(fs[k]) ? join(base, "field_sources", k, j) : join(base, "field_sources", k), "RESPONSE", `${label(k)}（原始行 ${recNo}）`))
          .filter((x): x is string => !!x);
        cells[k] = makeCell(id, k, fields[k], join(base, "fields", k), ids);
      }
      // 产地类事实：保留原始类别与文本，不裁决最终产地（AT07）
      const originIds: string[] = [];
      const origins = arr(r.origin_candidates).map((o0, j) => {
        const o = obj(o0);
        const sid = b.sourceEvidence(o.source, join(base, "origin_candidates", j, "source"), "RESPONSE", `${display(o.kind)}：${display(o.value)}`);
        if (sid) originIds.push(sid);
        return `${display(o.kind)}:${display(o.value)}`;
      });
      cells.origin_candidates = makeCell(id, "origin_candidates", origins.join("；"), join(base, "origin_candidates"), originIds);
      const marks = arr(r.manual_marks).map((m0) => {
        const m = obj(m0);
        return `${display(m.action)}${m.field ? "@" + display(m.field) : ""}${m.new_value ? ` ${display(m.old_value)}→${display(m.new_value)}` : ""}`;
      });
      cells.manual_marks = makeCell(id, "manual_marks", marks.join("；"), join(base, "manual_marks"));

      if (!wh) {
        b.issue({
          type: "WAREHOUSE_UNRESOLVED",
          severity: "WARNING",
          summary: `原始行 ${recNo} 无可靠入仓号${cands.length ? `，候选：${cands.join(" / ")}` : ""}`,
          detail: "按原样归入「未确定入仓号」，不自动归入任何逻辑查货单。",
          target: { tableId: "inspectionRawRows", rowId: id, fieldKey: "warehouse_no", jsonPointer: join(base, "warehouse_no") },
          sourceRefIds: rowSrc ? [rowSrc] : [],
          origin: "ADAPTER",
        });
      }
      return { id, sourceRefIds: rowSrc ? [rowSrc] : [], meta: { group: wh || UNRESOLVED_GROUP }, cells };
    });
    b.out.tables.push({
      id: "inspectionRawRows",
      title: "原始查货行（raw_rows）",
      columns: [
        { key: "record_no", title: "记录号", kind: "number", fixed: true },
        { key: "warehouse_no", title: "入仓号" },
        { key: "candidate_warehouse_nos", title: "候选入仓号" },
        ...orderedFields.map<TableColumn>((k) => ({ key: k, title: label(k), fixed: k === "model" })),
        { key: "origin_candidates", title: "产地事实（类别:原文）" },
        { key: "manual_marks", title: "人工标记" },
      ],
      rows: raw,
    });

    // 共享范围（包装 / Pack / 合计 / 未确定）
    const scopeRows: TableRow[] = arr(out.scope_records).map((s0, i) => {
      const s = obj(s0);
      const base = ptr("output", "scope_records", i);
      const id = `scope-${i + 1}`;
      const src = b.sourceEvidence(s.source, join(base, "source"), "RESPONSE", `范围 ${display(s.kind)} ${display(s.identifier)}`);
      const measIds: string[] = [];
      const meas = arr(s.measurements).map((m0, j) => {
        const m = obj(m0);
        const sid = b.sourceEvidence(m.source, join(base, "measurements", j, "source"), "RESPONSE", `${display(m.field)}=${display(m.value)}`);
        if (sid) measIds.push(sid);
        return `${display(m.field)}=${display(m.value)}${m.unit ? " " + display(m.unit) : ""}${m.fact_kind && m.fact_kind !== "EXPLICIT" ? `(${display(m.fact_kind)})` : ""}`;
      });
      if (s.has_unresolved_goods === true || s.kind === "UNRESOLVED") {
        b.issue({
          type: s.kind === "UNRESOLVED" ? "UNRESOLVED_SCOPE" : "SCOPE_HAS_UNRESOLVED_GOODS",
          severity: "WARNING",
          summary: `范围 ${display(s.kind)} ${display(s.identifier)}（入仓号 ${display(s.warehouse_no) || "未定"}）含未确定商品或归属`,
          target: { tableId: "scopeRecords", rowId: id, jsonPointer: base },
          sourceRefIds: src ? [src] : [],
          origin: "MODEL_FINDING",
        });
      }
      return {
        id,
        sourceRefIds: src ? [src] : [],
        meta: { group: strOrUndef(s.warehouse_no) || UNRESOLVED_GROUP },
        cells: {
          warehouse_no: makeCell(id, "warehouse_no", s.warehouse_no, join(base, "warehouse_no")),
          kind: makeCell(id, "kind", s.kind, join(base, "kind")),
          identifier: makeCell(id, "identifier", s.identifier, join(base, "identifier")),
          member_record_nos: makeCell(id, "member_record_nos", s.member_record_nos, join(base, "member_record_nos")),
          range_complete: makeCell(id, "range_complete", s.range_complete, join(base, "range_complete")),
          has_unresolved_goods: makeCell(id, "has_unresolved_goods", s.has_unresolved_goods, join(base, "has_unresolved_goods")),
          measurements: makeCell(id, "measurements", meas.join("；"), join(base, "measurements"), measIds),
        },
      };
    });
    b.out.tables.push({
      id: "scopeRecords",
      title: "包装 / 重量 / 合计范围（scope_records，原值不累计不平均）",
      columns: [
        { key: "warehouse_no", title: "入仓号" },
        { key: "kind", title: "类型" },
        { key: "identifier", title: "标识" },
        { key: "member_record_nos", title: "成员记录号" },
        { key: "range_complete", title: "范围完整" },
        { key: "has_unresolved_goods", title: "含未定商品" },
        { key: "measurements", title: "度量（原文）" },
      ],
      rows: scopeRows,
    });

    arr(out.issues).forEach((x0, i) => {
      const x = obj(x0);
      const p = ptr("output", "issues", i);
      const rowRef = strOrUndef(x.row_ref);
      const rowId = rowRef ? rowIdByRecord.get(rowRef) : undefined;
      if (rowRef && !rowId) b.diag("WARNING", "ISSUE_TARGET_NOT_FOUND", `问题引用的记录 ${rowRef} 不存在`, p);
      b.issue({
        type: strOrUndef(x.code) ?? "ISSUE",
        severity: "UNKNOWN",
        summary: display(x.message) || display(x0),
        target: rowId ? { tableId: "inspectionRawRows", rowId, fieldKey: strOrUndef(x.field), jsonPointer: p } : { jsonPointer: p },
        sourceRefIds: [],
        origin: "MODEL_FINDING",
      });
    });

    b.out.metadata = {
      summary: [
        { label: "处理状态", value: display(out.processing_status) || "—" },
        { label: "逻辑查货单", value: liRows.length },
        { label: "原始行", value: raw.length },
        { label: "未确定入仓号行", value: raw.filter((r) => r.meta?.group === UNRESOLVED_GROUP).length },
        { label: "范围记录", value: scopeRows.length },
        { label: "问题数", value: b.out.issues.length },
      ],
      notes: ["v3 P2 不输出合并产品（merged_product 由九立程序严格三键合并生成），此处按入仓号展示原始行。"],
    };
    return b.out;
  },
};

// ---------------- v2.0：logical_inspections[{raw_rows, merged_products}] + unresolved_scopes ----------------

export const jiuliP2V2: BusinessAdapter = {
  adapterId: "jiuli-p2-v2",
  adapterVersion: "1.0.0",
  promptKind: "JIULI_P2",
  schemaVersion: "jiuli-ai-v2",
  rendererId: "jiuli-p2",
  adapt(doc, ctx) {
    const b = new VMBuilder(ctx);
    const out = obj(obj(doc).output);
    const rid = b.uniqueRowIds();

    arr(out.source_refs).forEach((s0, i) => {
      const s = obj(s0);
      const ref = strOrUndef(s.local_source_ref);
      if (!ref) return;
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
        jsonPointer: ptr("output", "source_refs", i),
        location: "RESPONSE",
      });
    });
    const refs = (v: unknown, p: string) =>
      arr(v)
        .map(String)
        .map((id) => {
          if (!b.hasEvidence(id)) {
            b.diag("WARNING", "SOURCE_REF_NOT_FOUND", `引用的来源 ${id} 不在 source_refs 中`, p);
            b.missingEvidence(id, "未在 source_refs 中定义");
          }
          return id;
        });

    const liRows: TableRow[] = [];
    const mpRows: TableRow[] = [];
    const rawRowsOut: TableRow[] = [];
    const rawFieldKeys = new Set<string>();
    arr(out.logical_inspections).forEach((l) => arr(obj(l).raw_rows).forEach((r) => Object.keys(obj(obj(r).facts)).forEach((k) => rawFieldKeys.add(k))));
    const rawFields = [...RAW_FIELD_ORDER.filter((k) => rawFieldKeys.has(k)), ...[...rawFieldKeys].filter((k) => !RAW_FIELD_ORDER.includes(k))];

    arr(out.logical_inspections).forEach((l0, i) => {
      const l = obj(l0);
      const base = ptr("output", "logical_inspections", i);
      const wh = strOrUndef(l.warehouse_no) ?? "";
      const liId = rid(strOrUndef(l.local_logical_ref) ?? `li#${i + 1}`, base);
      const group = wh || UNRESOLVED_GROUP;
      const hf = obj(l.header_facts);
      liRows.push({
        id: liId,
        meta: { group },
        cells: {
          warehouse_no: makeCell(liId, "warehouse_no", wh, join(base, "warehouse_no")),
          local_logical_ref: makeCell(liId, "local_logical_ref", l.local_logical_ref, join(base, "local_logical_ref")),
          scope_uncertain: makeCell(liId, "scope_uncertain", l.scope_uncertain, join(base, "scope_uncertain")),
          header_facts: makeCell(
            liId,
            "header_facts",
            Object.entries(hf)
              .map(([k, v]) => `${label(k)}:${arr(v).length ? display(v) : "—"}`)
              .join("；"),
            join(base, "header_facts"),
          ),
          raw_row_count: makeCell(liId, "raw_row_count", arr(l.raw_rows).length, join(base, "raw_rows")),
          merged_count: makeCell(liId, "merged_count", arr(l.merged_products).length, join(base, "merged_products")),
        },
      });
      if (!wh) {
        b.issue({
          type: "WAREHOUSE_UNRESOLVED",
          severity: "WARNING",
          summary: `逻辑查货单 ${display(l.local_logical_ref)} 无有效入仓号`,
          target: { tableId: "logicalInspections", rowId: liId, fieldKey: "warehouse_no", jsonPointer: join(base, "warehouse_no") },
          sourceRefIds: [],
          origin: "ADAPTER",
        });
      }
      if (l.scope_uncertain === true) {
        b.issue({
          type: "SCOPE_UNCERTAIN",
          severity: "WARNING",
          summary: `逻辑查货单 ${wh || display(l.local_logical_ref)} 范围不确定`,
          target: { tableId: "logicalInspections", rowId: liId, jsonPointer: join(base, "scope_uncertain") },
          sourceRefIds: [],
          origin: "MODEL_FINDING",
        });
      }

      const rawIdsHere = new Set<string>();
      const mergedOf = new Map<string, string>();
      arr(l.merged_products).forEach((m0) => arr(obj(m0).raw_row_refs).forEach((r) => mergedOf.set(String(r), strOrUndef(obj(m0).local_merged_ref) ?? "")));

      arr(l.raw_rows).forEach((r0, j) => {
        const r = obj(r0);
        const rb = join(base, "raw_rows", j);
        const ref = strOrUndef(r.local_raw_row_ref) ?? `raw#${i + 1}.${j + 1}`;
        const id = rid(ref, rb);
        rawIdsHere.add(ref);
        const facts = obj(r.facts);
        const srcIds = refs(r.source_refs, join(rb, "source_refs"));
        const cells: TableRow["cells"] = {
          local_raw_row_ref: makeCell(id, "local_raw_row_ref", ref, join(rb, "local_raw_row_ref"), srcIds),
          merged_into: makeCell(id, "merged_into", mergedOf.get(ref) ?? "", rb),
        };
        for (const k of rawFields) cells[k] = makeCell(id, k, facts[k], join(rb, "facts", k), srcIds);
        const rf = obj(r.relation_features);
        cells.relation_features = makeCell(id, "relation_features", Object.entries(rf).filter(([, v]) => v !== "").map(([k, v]) => `${k}=${display(v)}`).join("；"), join(rb, "relation_features"));
        for (const k of ["origin_facts", "manual_marks", "package_facts", "weight_facts"]) {
          cells[k] = makeCell(id, k, arr(r[k]).length ? r[k] : "", join(rb, k));
        }
        rawRowsOut.push({ id, sourceRefIds: srcIds, meta: { group, parent: liId, merged: mergedOf.get(ref) }, cells });
      });

      arr(l.merged_products).forEach((m0, j) => {
        const m = obj(m0);
        const mb = join(base, "merged_products", j);
        const id = rid(strOrUndef(m.local_merged_ref) ?? `mp#${i + 1}.${j + 1}`, mb);
        const members = arr(m.raw_row_refs).map(String);
        members.forEach((ref, k) => {
          if (!rawIdsHere.has(ref)) {
            b.diag("ERROR", "RAW_ROW_REF_NOT_FOUND", `合并产品 ${id} 引用的原始行 ${ref} 不存在于该逻辑单`, join(mb, "raw_row_refs", k));
            b.issue({
              type: "DANGLING_RAW_ROW_REF",
              severity: "BLOCKER",
              summary: `合并产品 ${id} 引用了不存在的原始行 ${ref}`,
              target: { tableId: "mergedProducts", rowId: id, jsonPointer: join(mb, "raw_row_refs", k) },
              sourceRefIds: [],
              origin: "ADAPTER",
            });
          }
        });
        const mk = obj(m.merge_key);
        const ag = obj(m.aggregated);
        mpRows.push({
          id,
          meta: { group, parent: liId, members },
          cells: {
            local_merged_ref: makeCell(id, "local_merged_ref", m.local_merged_ref, join(mb, "local_merged_ref")),
            brand: makeCell(id, "brand", mk.brand, join(mb, "merge_key", "brand")),
            model: makeCell(id, "model", mk.model, join(mb, "merge_key", "model")),
            origin: makeCell(id, "origin", mk.origin, join(mb, "merge_key", "origin")),
            quantity: makeCell(id, "quantity", ag.quantity, join(mb, "aggregated", "quantity")),
            packages: makeCell(id, "packages", ag.packages, join(mb, "aggregated", "packages")),
            net_weight: makeCell(id, "net_weight", ag.net_weight, join(mb, "aggregated", "net_weight")),
            gross_weight: makeCell(id, "gross_weight", ag.gross_weight, join(mb, "aggregated", "gross_weight")),
            raw_row_refs: makeCell(id, "raw_row_refs", members.join(", "), join(mb, "raw_row_refs")),
          },
        });
        arr(m.field_conflicts).forEach((c0, k) => {
          const c = obj(c0);
          b.issue({
            type: "MERGED_FIELD_CONFLICT",
            severity: "WARNING",
            summary: `合并产品 ${id}：${display(c.field)} ${display(c.message) || display(c0)}`,
            target: { tableId: "mergedProducts", rowId: id, fieldKey: strOrUndef(c.field), jsonPointer: join(mb, "field_conflicts", k) },
            sourceRefIds: [],
            origin: "MODEL_FINDING",
          });
        });
      });
    });

    b.out.tables.push(
      {
        id: "logicalInspections",
        title: "逻辑查货单（按入仓号）",
        columns: [
          { key: "warehouse_no", title: "入仓号", fixed: true },
          { key: "local_logical_ref", title: "逻辑单引用" },
          { key: "scope_uncertain", title: "范围不确定" },
          { key: "header_facts", title: "表头事实" },
          { key: "raw_row_count", title: "原始行", kind: "number" },
          { key: "merged_count", title: "合并产品", kind: "number" },
        ],
        rows: liRows,
      },
      {
        id: "mergedProducts",
        title: "合并产品（merge_key + aggregated）",
        columns: [
          { key: "local_merged_ref", title: "合并引用", fixed: true },
          { key: "brand", title: "品牌" },
          { key: "model", title: "型号" },
          { key: "origin", title: "产地" },
          { key: "quantity", title: "数量" },
          { key: "packages", title: "件数" },
          { key: "net_weight", title: "净重" },
          { key: "gross_weight", title: "毛重" },
          { key: "raw_row_refs", title: "组成原始行" },
        ],
        rows: mpRows,
      },
      {
        id: "inspectionRawRows",
        title: "原始查货行（raw_rows）",
        columns: [
          { key: "local_raw_row_ref", title: "原始行引用", fixed: true },
          { key: "merged_into", title: "所属合并产品" },
          ...rawFields.map<TableColumn>((k) => ({ key: k, title: label(k) })),
          { key: "relation_features", title: "关系特征" },
          { key: "origin_facts", title: "产地事实" },
          { key: "manual_marks", title: "人工标记" },
          { key: "package_facts", title: "包装事实" },
          { key: "weight_facts", title: "重量事实" },
        ],
        rows: rawRowsOut,
      },
    );

    arr(out.unresolved_scopes).forEach((u, i) => {
      b.issue({
        type: "UNRESOLVED_SCOPE",
        severity: "WARNING",
        summary: typeof u === "string" ? u : display(obj(u).message) || display(u),
        detail: typeof u === "object" ? display(u) : undefined,
        target: { jsonPointer: ptr("output", "unresolved_scopes", i) },
        sourceRefIds: refs(obj(u).source_refs, ptr("output", "unresolved_scopes", i)),
        origin: "MODEL_FINDING",
      });
    });
    arr(out.warnings).forEach((w, i) => {
      b.issue({ type: "WARNING", severity: "UNKNOWN", summary: typeof w === "string" ? w : display(w), target: { jsonPointer: ptr("output", "warnings", i) }, sourceRefIds: [], origin: "MODEL_FINDING" });
    });

    b.out.metadata = {
      summary: [
        { label: "处理状态", value: display(out.processing_status) || "—" },
        { label: "逻辑查货单", value: liRows.length },
        { label: "合并产品", value: mpRows.length },
        { label: "原始行", value: rawRowsOut.length },
        { label: "未解决范围", value: arr(out.unresolved_scopes).length },
        { label: "问题数", value: b.out.issues.length },
      ],
    };
    return b.out;
  },
};
