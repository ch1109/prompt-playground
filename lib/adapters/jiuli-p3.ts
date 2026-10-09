import type { RelationView, TableColumn, TableRow } from "@/lib/contracts/view-model";
import { join, ptr } from "@/lib/pipeline/json-pointer";
import {
  arr,
  detectOptionalFields,
  display,
  indexEvidenceKeys,
  makeCell,
  obj,
  type Obj,
  reportKeyConflicts,
  resolveEvidenceKeys,
  strOrUndef,
  VMBuilder,
} from "./helpers";
import type { BusinessAdapter } from "./types";

const V21_FIELDS = ["relation_review_status", "difference_flags", "unmatched_reason"];

const ORDER_COLS: TableColumn[] = [
  { key: "order_row_id", title: "委托行", fixed: true },
  { key: "model", title: "委托型号" },
  { key: "brand", title: "品牌" },
  { key: "quantity", title: "数量" },
  { key: "match_status", title: "关系状态", kind: "state" },
  { key: "coverage_status", title: "覆盖", kind: "state" },
  { key: "coverage_overlap", title: "重叠" },
  { key: "selected_count", title: "选中原始行", kind: "number" },
  { key: "candidate_count", title: "候选组", kind: "number" },
  { key: "weak_count", title: "弱候选", kind: "number" },
];

const CAND_COLS: TableColumn[] = [
  { key: "kind", title: "类别", fixed: true },
  { key: "group_no", title: "组", kind: "number" },
  { key: "raw_row_id", title: "查货原始行" },
  { key: "warehouse_no", title: "入仓号" },
  { key: "model", title: "查货型号" },
  { key: "brand", title: "品牌" },
  { key: "quantity", title: "数量" },
  { key: "logical_inspection_id", title: "逻辑查货单" },
  { key: "merged_product_id", title: "合并产品" },
  { key: "reason", title: "说明" },
];

const KIND_LABEL = { SELECTED: "选中", CANDIDATE: "候选组", WEAK: "弱候选" } as const;

// ---------------- v3：row_relations[{selected_raw_row_ids, coverage, evidence_keys, candidate_groups, weak_candidates, issues}] ----------------

export const jiuliP3V3: BusinessAdapter = {
  adapterId: "jiuli-p3-v3",
  adapterVersion: "1.0.0",
  promptKind: "JIULI_P3",
  schemaVersion: "jiuli-ai-v3",
  rendererId: "jiuli-p3-v3",
  adapt(doc, ctx) {
    const b = new VMBuilder(ctx);
    const out = obj(obj(doc).output);
    const rid = b.uniqueRowIds();

    const req = ctx.request ? obj(obj(ctx.request).input) : undefined;
    if (!ctx.request) {
      b.diag("WARNING", "NO_REQUEST_CONTEXT", "未关联输入快照（P3 request），evidence_key 与查货行身份信息无法解析；关系仍按原样展示。");
    }
    const { index, conflicts } = ctx.request ? indexEvidenceKeys(ctx.request) : { index: undefined, conflicts: new Map<string, string[]>() };
    reportKeyConflicts(b, conflicts);

    const orderIdentity = new Map<string, { identity: Obj; pointer: string }>();
    arr(req?.order_rows).forEach((o, i) => orderIdentity.set(String(obj(o).order_row_id), { identity: obj(obj(o).identity), pointer: ptr("input", "order_rows", i) }));
    const candidates = new Map<string, Obj>();
    const candPtr = new Map<string, string>();
    arr(req?.inspection_candidates).forEach((c, i) => {
      candidates.set(String(obj(c).raw_row_id), obj(c));
      candPtr.set(String(obj(c).raw_row_id), ptr("input", "inspection_candidates", i));
    });

    const relations = arr(out.row_relations);
    const optional = detectOptionalFields(b, relations, V21_FIELDS, ptr("output", "row_relations"));
    const orderRows: TableRow[] = [];
    const candRows: TableRow[] = [];
    const seenOrder = new Set<string>();

    relations.forEach((r0, i) => {
      const r = obj(r0);
      const base = ptr("output", "row_relations", i);
      const orderId = strOrUndef(r.order_row_id) ?? `#${i + 1}`;
      if (req && !orderIdentity.has(orderId)) b.diag("WARNING", "ORDER_ROW_NOT_IN_SNAPSHOT", `委托行 ${orderId} 不在本次请求 input.order_rows 中`, join(base, "order_row_id"));
      seenOrder.add(orderId);
      const rowId = rid(orderId, base);
      const ident = orderIdentity.get(orderId)?.identity ?? {};
      const identBase = orderIdentity.get(orderId)?.pointer;
      // 身份信息来自请求上下文：用 req: 前缀指向请求 JSON，避免误跳到响应中的其他对象
      const identPtr = (k: string) => (identBase ? "req:" + join(identBase, "identity", k) : base);
      const cov = obj(r.coverage);
      const evIds = resolveEvidenceKeys(b, r.evidence_keys, index, join(base, "evidence_keys"), conflicts);
      const covIds = resolveEvidenceKeys(b, cov.evidence_keys, index, join(base, "coverage", "evidence_keys"), conflicts);
      const status = strOrUndef(r.match_status) ?? "";

      const cells: TableRow["cells"] = {
        order_row_id: makeCell(rowId, "order_row_id", orderId, join(base, "order_row_id"), evIds),
        model: makeCell(rowId, "model", req ? ident.model : "（无请求上下文）", identPtr("model")),
        brand: makeCell(rowId, "brand", req ? ident.brand : "", identPtr("brand")),
        quantity: makeCell(rowId, "quantity", req ? ident.quantity : "", identPtr("quantity")),
        match_status: makeCell(rowId, "match_status", status, join(base, "match_status"), evIds),
        coverage_status: makeCell(rowId, "coverage_status", cov.status, join(base, "coverage", "status"), covIds),
        coverage_overlap: makeCell(rowId, "coverage_overlap", cov.overlap, join(base, "coverage", "overlap")),
        selected_count: makeCell(rowId, "selected_count", arr(r.selected_raw_row_ids).length, join(base, "selected_raw_row_ids")),
        candidate_count: makeCell(rowId, "candidate_count", arr(r.candidate_groups).length, join(base, "candidate_groups")),
        weak_count: makeCell(rowId, "weak_count", arr(r.weak_candidates).length, join(base, "weak_candidates")),
      };
      for (const f of optional) cells[f] = makeCell(rowId, f, r[f], join(base, f));
      orderRows.push({ id: rowId, sourceRefIds: evIds, cells, meta: { status } });

      // 关系与候选：保持模型给出的顺序，不自动排序/挑选
      const groups: { kind: "SELECTED" | "CANDIDATE" | "WEAK"; ids: unknown[]; keys: unknown; reason?: unknown; pointer: string }[] = [];
      if (arr(r.selected_raw_row_ids).length) groups.push({ kind: "SELECTED", ids: arr(r.selected_raw_row_ids), keys: r.evidence_keys, pointer: join(base, "selected_raw_row_ids") });
      arr(r.candidate_groups).forEach((g, k) => groups.push({ kind: "CANDIDATE", ids: arr(obj(g).raw_row_ids), keys: obj(g).evidence_keys, pointer: join(base, "candidate_groups", k) }));
      arr(r.weak_candidates).forEach((g, k) => groups.push({ kind: "WEAK", ids: arr(obj(g).raw_row_ids), keys: obj(g).evidence_keys, reason: obj(g).reason, pointer: join(base, "weak_candidates", k) }));
      if (status === "MATCHED" && !arr(r.selected_raw_row_ids).length) b.diag("WARNING", "MATCHED_WITHOUT_SELECTION", `委托行 ${orderId} 为 MATCHED 但 selected_raw_row_ids 为空`, join(base, "selected_raw_row_ids"));

      let groupNo = 0;
      for (const g of groups) {
        groupNo++;
        const keyIds = resolveEvidenceKeys(b, g.keys, index, g.pointer, conflicts);
        const toIds: string[] = [];
        g.ids.forEach((raw0, k) => {
          const raw = String(raw0);
          const c = candidates.get(raw);
          if (req && !c) b.diag("WARNING", "RAW_ROW_NOT_IN_SNAPSHOT", `原始行 ${raw} 不在请求候选中，关系图不画此边`, g.kind === "SELECTED" ? join(g.pointer, k) : join(g.pointer, "raw_row_ids", k));
          if (!req || c) toIds.push(raw);
          const ci = obj(c?.identity);
          const id = `${rowId}|${g.kind}|${groupNo}|${raw}`;
          const p = g.kind === "SELECTED" ? join(g.pointer, k) : join(g.pointer, "raw_row_ids", k);
          const cp = (...f: string[]) => (candPtr.has(raw) ? "req:" + join(candPtr.get(raw)!, ...f) : p);
          candRows.push({
            id,
            sourceRefIds: keyIds,
            meta: { orderRowId: rowId, kind: g.kind, relationId: `${rowId}|${g.kind}|${groupNo}` },
            cells: {
              kind: makeCell(id, "kind", KIND_LABEL[g.kind], p, keyIds),
              group_no: makeCell(id, "group_no", groupNo, g.pointer),
              raw_row_id: makeCell(id, "raw_row_id", raw, p, keyIds),
              warehouse_no: makeCell(id, "warehouse_no", c?.warehouse_no ?? (req ? "（不在快照）" : ""), cp("warehouse_no")),
              model: makeCell(id, "model", ci.model, cp("identity", "model")),
              brand: makeCell(id, "brand", ci.brand, cp("identity", "brand")),
              quantity: makeCell(id, "quantity", ci.quantity, cp("identity", "quantity")),
              logical_inspection_id: makeCell(id, "logical_inspection_id", c?.logical_inspection_id, cp("logical_inspection_id")),
              merged_product_id: makeCell(id, "merged_product_id", c?.merged_product_id, cp("merged_product_id")),
              reason: makeCell(id, "reason", g.reason ?? "", g.kind === "WEAK" ? join(g.pointer, "reason") : g.pointer),
            },
          });
        });
        const rel: RelationView = {
          id: `${rowId}|${g.kind}|${groupNo}`,
          fromId: rowId,
          toIds,
          status: g.kind === "SELECTED" ? status : g.kind,
          kind: g.kind,
          sourceRefIds: keyIds,
          jsonPointer: g.pointer,
          coverage: g.kind === "SELECTED" ? r.coverage : undefined,
          evidence: g.kind === "SELECTED" ? arr(r.evidence_keys) : arr(g.keys),
        };
        b.out.relations.push(rel);
      }

      arr(r.issues).forEach((x0, k) => {
        const x = obj(x0);
        b.issue({
          type: strOrUndef(x.code) ?? "ISSUE",
          severity: "UNKNOWN",
          summary: `${orderId}：${display(x.message) || display(x0)}`,
          target: { tableId: "orderRows", rowId, fieldKey: "match_status", jsonPointer: join(base, "issues", k) },
          sourceRefIds: evIds,
          origin: "MODEL_FINDING",
        });
      });
    });

    // INVALID_INPUT 时契约要求 row_relations=[]，不算缺项
    if (req && out.processing_status !== "INVALID_INPUT") {
      for (const [id] of orderIdentity) {
        if (!seenOrder.has(id)) b.diag("WARNING", "ORDER_ROW_WITHOUT_RELATION", `请求中的委托行 ${id} 没有对应的 row_relations 结果（契约要求每行恰好一项）`);
      }
    }

    arr(out.issues).forEach((x0, i) => {
      const x = obj(x0);
      b.issue({ type: strOrUndef(x.code) ?? "ISSUE", severity: "UNKNOWN", summary: display(x.message) || display(x0), target: { jsonPointer: ptr("output", "issues", i) }, sourceRefIds: [], origin: "MODEL_FINDING" });
    });

    b.out.tables.push(
      { id: "orderRows", title: "委托商品关系摘要", columns: [...ORDER_COLS, ...optional.map((f) => ({ key: f, title: f }))], rows: orderRows },
      { id: "candidateGroups", title: "选中组 / 候选组 / 弱候选（按模型原顺序）", columns: CAND_COLS, rows: candRows },
    );

    const count = (s: string) => orderRows.filter((r) => r.meta?.status === s).length;
    const retrieval = obj(obj(ctx.request).context).retrieval_complete;
    b.out.metadata = {
      summary: [
        { label: "处理状态", value: display(out.processing_status) || "—" },
        { label: "委托行", value: orderRows.length },
        { label: "MATCHED", value: count("MATCHED") },
        { label: "多候选", value: count("MULTIPLE_CANDIDATES") },
        { label: "UNMATCHED", value: count("UNMATCHED") },
        { label: "检索完整（系统给定）", value: retrieval === undefined ? "未知" : String(retrieval) },
      ],
      notes: [
        "UNMATCHED 原样展示：是否「查货尚未到达」需快照上下文独立提供，不从关系状态推断。",
        "关系成立 ≠ 可自动应用；此处标注仅用于评测，不改九立占用与核销。",
      ],
    };
    return b.out;
  },
};

// ---------------- v2.0：selected_group.sources[] + match_evidence[] + confidence ----------------

export const jiuliP3V2: BusinessAdapter = {
  adapterId: "jiuli-p3-v2",
  adapterVersion: "1.0.0",
  promptKind: "JIULI_P3",
  schemaVersion: "jiuli-ai-v2",
  rendererId: "jiuli-p3",
  adapt(doc, ctx) {
    const b = new VMBuilder(ctx);
    const out = obj(obj(doc).output);
    const rid = b.uniqueRowIds();
    const relations = arr(out.row_relations);
    const optional = detectOptionalFields(b, relations, V21_FIELDS, ptr("output", "row_relations"));
    const orderRows: TableRow[] = [];
    const candRows: TableRow[] = [];

    const refIds = (v: unknown) => arr(v).map((x) => b.missingEvidence(String(x), "P3 v2 输出只含来源引用 ID，快照中未提供来源定义"));

    relations.forEach((r0, i) => {
      const r = obj(r0);
      const base = ptr("output", "row_relations", i);
      const orderId = strOrUndef(r.order_row_id) ?? `#${i + 1}`;
      const rowId = rid(orderId, base);
      const cov = obj(r.coverage);
      const evIds = arr(r.match_evidence).flatMap((e) => refIds(obj(e).source_refs));
      const status = strOrUndef(r.match_status) ?? "";
      const selectedSources = arr(obj(r.selected_group).sources);
      const cells: TableRow["cells"] = {
        order_row_id: makeCell(rowId, "order_row_id", orderId, join(base, "order_row_id"), evIds),
        model: makeCell(rowId, "model", "", base),
        brand: makeCell(rowId, "brand", "", base),
        quantity: makeCell(rowId, "quantity", cov.order_quantity, join(base, "coverage", "order_quantity")),
        match_status: makeCell(rowId, "match_status", status, join(base, "match_status"), evIds),
        coverage_status: makeCell(rowId, "coverage_status", cov.status, join(base, "coverage", "status")),
        coverage_overlap: makeCell(rowId, "coverage_overlap", cov.independent_scope_evidence === undefined ? "" : `独立范围证据：${display(cov.independent_scope_evidence)}`, join(base, "coverage")),
        selected_count: makeCell(rowId, "selected_count", selectedSources.reduce<number>((n, s) => n + arr(obj(s).raw_row_ids).length, 0), join(base, "selected_group")),
        candidate_count: makeCell(rowId, "candidate_count", arr(r.candidate_groups).length, join(base, "candidate_groups")),
        weak_count: makeCell(rowId, "weak_count", arr(r.weak_candidates).length, join(base, "weak_candidates")),
        confidence: makeCell(rowId, "confidence", r.confidence, join(base, "confidence")),
        match_evidence: makeCell(rowId, "match_evidence", arr(r.match_evidence).map((e) => `${display(obj(e).type)}：${display(obj(e).result)}`).join("；"), join(base, "match_evidence"), evIds),
      };
      for (const f of optional) cells[f] = makeCell(rowId, f, r[f], join(base, f));
      orderRows.push({ id: rowId, sourceRefIds: evIds, cells, meta: { status } });

      let groupNo = 0;
      const pushGroup = (kind: "SELECTED" | "CANDIDATE" | "WEAK", sources: unknown[], pointer: string, reason?: unknown) => {
        groupNo++;
        const toIds: string[] = [];
        sources.forEach((s0, j) => {
          const s = obj(s0);
          const sp = kind === "SELECTED" ? join(pointer, j) : pointer;
          arr(s.raw_row_ids).forEach((raw0, k) => {
            const raw = String(raw0);
            toIds.push(raw);
            const id = `${rowId}|${kind}|${groupNo}|${raw}`;
            candRows.push({
              id,
              sourceRefIds: kind === "SELECTED" ? evIds : [],
              meta: { orderRowId: rowId, kind, relationId: `${rowId}|${kind}|${groupNo}` },
              cells: {
                kind: makeCell(id, "kind", KIND_LABEL[kind], join(sp, "raw_row_ids", k)),
                group_no: makeCell(id, "group_no", groupNo, pointer),
                raw_row_id: makeCell(id, "raw_row_id", raw, join(sp, "raw_row_ids", k)),
                warehouse_no: makeCell(id, "warehouse_no", "", sp),
                model: makeCell(id, "model", "", sp),
                brand: makeCell(id, "brand", "", sp),
                quantity: makeCell(id, "quantity", "", sp),
                logical_inspection_id: makeCell(id, "logical_inspection_id", s.logical_inspection_id, join(sp, "logical_inspection_id")),
                merged_product_id: makeCell(id, "merged_product_id", s.merged_product_id, join(sp, "merged_product_id")),
                reason: makeCell(id, "reason", reason ?? "", pointer),
              },
            });
          });
        });
        b.out.relations.push({
          id: `${rowId}|${kind}|${groupNo}`,
          fromId: rowId,
          toIds,
          status: kind === "SELECTED" ? status : kind,
          kind,
          sourceRefIds: kind === "SELECTED" ? evIds : [],
          jsonPointer: pointer,
          coverage: kind === "SELECTED" ? r.coverage : undefined,
          evidence: kind === "SELECTED" ? arr(r.match_evidence) : undefined,
        });
      };
      if (selectedSources.length) pushGroup("SELECTED", selectedSources, join(base, "selected_group", "sources"));
      // 候选结构未在 v2.0 示例中给出：兼容 {sources:[...]} 或 {raw_row_ids:[...]}
      arr(r.candidate_groups).forEach((g, k) => {
        const go = obj(g);
        pushGroup("CANDIDATE", go.sources ? arr(go.sources) : [go], join(base, "candidate_groups", k));
      });
      arr(r.weak_candidates).forEach((g, k) => {
        const go = obj(g);
        pushGroup("WEAK", go.sources ? arr(go.sources) : [go], join(base, "weak_candidates", k), go.reason);
      });
    });

    arr(out.warnings).forEach((w, i) => {
      b.issue({ type: "WARNING", severity: "UNKNOWN", summary: typeof w === "string" ? w : display(w), target: { jsonPointer: ptr("output", "warnings", i) }, sourceRefIds: [], origin: "MODEL_FINDING" });
    });

    b.out.tables.push(
      {
        id: "orderRows",
        title: "委托商品关系摘要",
        columns: [
          ...ORDER_COLS,
          { key: "confidence", title: "模型自述置信（非概率）" },
          { key: "match_evidence", title: "匹配证据" },
          ...optional.map((f) => ({ key: f, title: f })),
        ],
        rows: orderRows,
      },
      { id: "candidateGroups", title: "选中组 / 候选组 / 弱候选（按模型原顺序）", columns: CAND_COLS, rows: candRows },
    );
    const count = (s: string) => orderRows.filter((r) => r.meta?.status === s).length;
    b.out.metadata = {
      summary: [
        { label: "委托行", value: orderRows.length },
        { label: "MATCHED", value: count("MATCHED") },
        { label: "多候选", value: count("MULTIPLE_CANDIDATES") },
        { label: "UNMATCHED", value: count("UNMATCHED") },
      ],
      notes: ["confidence 为模型输出文字，不能当作概率或准确率。", "UNMATCHED 原样展示，不推断「查货未到」。"],
    };
    return b.out;
  },
};
