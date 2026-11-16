// 九立二阶段 demo v15 输出 → ViewModel：复用 v3 的四种版式（宽表 / 入仓号层级 / 候选对比 / 逐字段决策），只按原值展示，不推断。
import type { RelationView, TableColumn, TableRow } from "@/lib/contracts/view-model";
import { join, ptr } from "@/lib/pipeline/json-pointer";
import { V15_CORE, V15_FIELDS, V15_LABEL, V15_SCHEMA_VERSION } from "@/lib/schemas/jiuli-v15";
import { arr, display, makeCell, obj, type Obj, strOrUndef, VMBuilder } from "./helpers";
import { UNRESOLVED_GROUP } from "./jiuli-p2";
import type { BusinessAdapter } from "./types";

const label = (f: unknown) => V15_LABEL[String(f)] ?? String(f ?? "");

/** 问题 vs[]：{s,v} 写成「来源：值」，其他原样 */
function vsText(vs: unknown): string {
  return arr(vs)
    .map((x) => (x && typeof x === "object" ? `${display(obj(x).s)}：${display(obj(x).v)}` : display(x)))
    .join("；");
}

/** 单元格显示值：数组 / 对象转成可读文字，标量原样 */
function flat(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? JSON.stringify(x) : String(x))).join("、");
  if (v && typeof v === "object") return JSON.stringify(v);
  return v;
}

/** 已知业务字段之外、模型多给的标量键，原样加列（只在真的出现时） */
function extraKeys(items: Obj[], skip: string[]): string[] {
  const keys = new Set<string>();
  for (const it of items) for (const k of Object.keys(it)) if (!V15_LABEL[k] && !skip.includes(k)) keys.add(k);
  return [...keys];
}

function fieldColumns(first: TableColumn[], extra: string[]): TableColumn[] {
  return [...first, ...V15_FIELDS.map(([k, t]) => ({ key: k, title: t, core: V15_CORE.has(k), fixed: k === "md" })), ...extra.map((k) => ({ key: k, title: k }))];
}

/** 只显示至少有一行有值的列，避免 26 列大多为空 */
function nonEmpty(columns: TableColumn[], rows: TableRow[], keep: string[]): TableColumn[] {
  return columns.filter((c) => keep.includes(c.key) || rows.some((r) => r.cells[c.key]?.value !== undefined && r.cells[c.key]?.value !== ""));
}

/**
 * 模型问题 {f,t,vs,note} → IssueView。target.rowId 为函数时按问题字段定位行（P4 每个字段一行），
 * fieldKey 默认取问题字段；fieldKey 为函数时可改写或返回 undefined（不定位到列）。
 */
function modelIssues(
  b: VMBuilder,
  list: unknown,
  base: string,
  target: { tableId?: string; rowId?: string | ((f: string) => string | undefined); prefix?: string; fieldKey?: (f: string) => string | undefined },
) {
  arr(list).forEach((x0, i) => {
    const x = obj(x0);
    const f = strOrUndef(x.f) ?? "";
    const vs = vsText(x.vs);
    const rowId = typeof target.rowId === "function" ? target.rowId(f) : target.rowId;
    b.issue({
      type: strOrUndef(x.t) ?? "问题",
      severity: "UNKNOWN",
      summary: `${target.prefix ?? ""}${label(f) || "整体"} · ${display(x.t) || "问题"}${x.note ? `：${display(x.note)}` : ""}`,
      detail: vs ? `依据：${vs}` : undefined,
      target: rowId ? { tableId: target.tableId, rowId, fieldKey: f ? (target.fieldKey ? target.fieldKey(f) : f) : undefined, jsonPointer: join(base, i) } : { jsonPointer: join(base, i) },
      sourceRefIds: [],
      origin: "MODEL_FINDING",
    });
  });
}

const noField = () => undefined;

function rowCells(rowId: string, o: Obj, base: string, keys: string[]) {
  const cells: TableRow["cells"] = {};
  for (const k of keys) cells[k] = makeCell(rowId, k, flat(o[k]), join(base, k));
  return cells;
}

const ALL_KEYS = V15_FIELDS.map(([k]) => k);

// ---------------- P1：委托商品宽表 + 共享值 + 整票合计 ----------------
export const jiuliP1V15: BusinessAdapter = {
  adapterId: "jiuli-p1-v15",
  adapterVersion: "1.0.0",
  promptKind: "JIULI_P1",
  schemaVersion: V15_SCHEMA_VERSION,
  rendererId: "jiuli-p1-v15",
  adapt(doc, ctx) {
    const b = new VMBuilder(ctx);
    const d = obj(doc);
    const h = obj(d.h);
    const rid = b.uniqueRowIds();
    const items = arr(d.r).map(obj);
    const extra = extraKeys(items, ["id", "issues"]);
    const rows: TableRow[] = items.map((r, i) => {
      const base = ptr("r", i);
      const id = rid(`row-${display(r.id) || i + 1}`, base);
      modelIssues(b, r.issues, join(base, "issues"), { tableId: "orderRows", rowId: id, prefix: `第 ${display(r.id)} 行 · ` });
      return { id, cells: { id: makeCell(id, "id", r.id, join(base, "id")), ...rowCells(id, r, base, [...ALL_KEYS, ...extra]) } };
    });
    b.out.tables.push({ id: "orderRows", title: "委托商品行", columns: nonEmpty(fieldColumns([{ key: "id", title: "序号", kind: "number", fixed: true, core: true }], extra), rows, ["id", "md"]), rows });

    const shares: TableRow[] = arr(d.g).map((g0, i) => {
      const g = obj(g0);
      const id = `g-${i + 1}`;
      const base = ptr("g", i);
      return {
        id,
        cells: {
          f: makeCell(id, "f", label(g.f), join(base, "f")),
          v: makeCell(id, "v", g.v, join(base, "v")),
          unit: makeCell(id, "unit", g.wu ?? g.u, join(base, g.wu !== undefined ? "wu" : "u")),
          r: makeCell(id, "r", flat(g.r), join(base, "r")),
          group: makeCell(id, "group", g.group, join(base, "group")),
        },
      };
    });
    if (shares.length)
      b.out.tables.push({ id: "shareRecords", title: "多行共用的值", columns: [{ key: "f", title: "字段" }, { key: "v", title: "值" }, { key: "unit", title: "单位" }, { key: "r", title: "涉及商品行" }, { key: "group", title: "说明" }], rows: shares });

    const tot = obj(d.tot);
    if (Object.keys(tot).length) {
      const keys = Object.keys(tot).filter((k) => k !== "issues");
      b.out.tables.push({ id: "totals", title: "整票合计", columns: keys.map((k) => ({ key: k, title: label(k) })), rows: [{ id: "tot", cells: rowCells("tot", tot, "/tot", keys) }] });
      modelIssues(b, tot.issues, "/tot/issues", { prefix: "整票合计 · " });
    }
    modelIssues(b, h.issues, "/h/issues", { prefix: "抬头 · " });

    b.out.metadata = {
      summary: [
        { label: "委托商品行", value: rows.length },
        { label: "共用值", value: shares.length },
        { label: "模型报告问题", value: b.out.issues.length },
      ],
      notes: ["统计仅为结构计数，不代表业务准确率。"],
      headline: { entity: "商品", customerName: strOrUndef(h.cus), gold: false },
    };
    return b.out;
  },
};

// ---------------- P2：入仓号 → 合并商品 → 原始行 ----------------
export const jiuliP2V15: BusinessAdapter = {
  adapterId: "jiuli-p2-v15",
  adapterVersion: "1.0.1",
  promptKind: "JIULI_P2",
  schemaVersion: V15_SCHEMA_VERSION,
  rendererId: "jiuli-p2-v15",
  adapt(doc, ctx) {
    const b = new VMBuilder(ctx);
    const scopes = arr(obj(doc).h).map(obj);
    const li: TableRow[] = [];
    const merged: TableRow[] = [];
    const raw: TableRow[] = [];
    const shares: TableRow[] = [];
    const mergedItems = scopes.flatMap((h) => arr(h.r).map(obj));
    const rawItems = mergedItems.flatMap((r) => arr(r.parts).map(obj));
    const mergedExtra = extraKeys(mergedItems, ["id", "issues", "parts", "merge_note"]);
    const rawExtra = extraKeys(rawItems, ["n", "box", "dc", "lot", "issues"]);

    scopes.forEach((h, gi) => {
      const base = ptr("h", gi);
      const wh = strOrUndef(h.wh) ?? "";
      const group = wh || UNRESOLVED_GROUP;
      const liId = `wh-${gi + 1}`;
      const tot = obj(h.tot);
      const qc = obj(h.qc);
      li.push({
        id: liId,
        meta: { group },
        cells: {
          wh: makeCell(liId, "wh", wh || "（未确定）", join(base, "wh")),
          ...Object.fromEntries(["q", "u", "nw", "gw", "wu", "pk", "pl"].map((k) => [`tot_${k}`, makeCell(liId, `tot_${k}`, tot[k], join(base, "tot", k))])),
          qc: makeCell(liId, "qc", Object.keys(qc).length ? `原文 ${display(qc.raw) || "—"} / 逐行相加 ${display(qc.calc) || "—"}` : undefined, join(base, "qc")),
          products: makeCell(liId, "products", arr(h.r).length, join(base, "r")),
        },
      });
      modelIssues(b, h.issues, join(base, "issues"), { tableId: "logicalInspections", rowId: liId, prefix: `入仓号 ${wh || "（未确定）"} · `, fieldKey: noField });
      modelIssues(b, tot.issues, join(base, "tot", "issues"), { tableId: "logicalInspections", rowId: liId, prefix: `入仓号 ${wh || "（未确定）"} 合计 · `, fieldKey: noField });

      arr(h.r).forEach((r0, ri) => {
        const r = obj(r0);
        const rb = join(base, "r", ri);
        const pid = `${gi + 1}-${display(r.id) || ri + 1}`;
        const members: string[] = [];
        arr(r.parts).forEach((p0, pi) => {
          const p = obj(p0);
          const pb = join(rb, "parts", pi);
          const id = `${pid}-${display(p.n) || pi + 1}`;
          members.push(id);
          raw.push({
            id,
            meta: { group, merged: pid },
            cells: {
              product: makeCell(id, "product", pid, join(rb, "id")),
              n: makeCell(id, "n", p.n, join(pb, "n")),
              box: makeCell(id, "box", p.box, join(pb, "box")),
              md: makeCell(id, "md", r.md, join(rb, "md")),
              ...rowCells(id, p, pb, [...ALL_KEYS.filter((k) => k !== "md"), "dc", "lot", ...rawExtra]),
            },
          });
          modelIssues(b, p.issues, join(pb, "issues"), { tableId: "inspectionRawRows", rowId: id, prefix: `原始行 ${id} · ` });
        });
        merged.push({ id: pid, meta: { group, members }, cells: { id: makeCell(pid, "id", pid, join(rb, "id")), ...rowCells(pid, r, rb, [...ALL_KEYS, "merge_note", ...mergedExtra]) } });
        modelIssues(b, r.issues, join(rb, "issues"), { tableId: "mergedProducts", rowId: pid, prefix: `商品 ${pid} · ` });
      });

      arr(h.g).forEach((g0, i) => {
        const g = obj(g0);
        const id = `${gi + 1}-g${i + 1}`;
        const gb = join(base, "g", i);
        shares.push({
          id,
          meta: { group },
          cells: {
            f: makeCell(id, "f", label(g.f), join(gb, "f")),
            v: makeCell(id, "v", g.v, join(gb, "v")),
            unit: makeCell(id, "unit", g.wu ?? g.u, join(gb, g.wu !== undefined ? "wu" : "u")),
            r: makeCell(id, "r", flat(g.r), join(gb, "r")),
            group: makeCell(id, "group", g.group, join(gb, "group")),
          },
        });
      });
    });

    const liCols: TableColumn[] = [
      { key: "wh", title: "入仓号", fixed: true },
      { key: "products", title: "商品数", kind: "number" },
      { key: "tot_q", title: "合计数量" },
      { key: "tot_u", title: "单位" },
      { key: "tot_nw", title: "合计净重" },
      { key: "tot_gw", title: "合计毛重" },
      { key: "tot_wu", title: "重量单位" },
      { key: "tot_pk", title: "合计件数" },
      { key: "tot_pl", title: "托盘数" },
      { key: "qc", title: "数量核对" },
    ];
    b.out.tables.push({ id: "logicalInspections", title: "入仓号", columns: nonEmpty(liCols, li, ["wh"]), rows: li });
    b.out.tables.push({ id: "mergedProducts", title: "合并后的商品", columns: nonEmpty(fieldColumns([{ key: "id", title: "商品", fixed: true, core: true }], [...mergedExtra, "merge_note"]).map((c) => (c.key === "merge_note" ? { ...c, title: "合并说明" } : c)), merged, ["id", "md"]), rows: merged });
    b.out.tables.push({
      id: "inspectionRawRows",
      title: "查货原始行",
      columns: nonEmpty(
        [
          { key: "product", title: "所属商品", fixed: true },
          { key: "n", title: "行", kind: "number" },
          { key: "box", title: "箱号" },
          ...fieldColumns([], [...rawExtra, "dc", "lot"]).map((c) => (c.key === "dc" ? { ...c, title: "生产日期码" } : c.key === "lot" ? { ...c, title: "批号" } : c)),
        ],
        raw,
        ["product", "n"],
      ),
      rows: raw,
    });
    if (shares.length)
      b.out.tables.push({ id: "scopeRecords", title: "多行共用的值", columns: [{ key: "f", title: "字段" }, { key: "v", title: "值" }, { key: "unit", title: "单位" }, { key: "r", title: "涉及商品" }, { key: "group", title: "说明" }], rows: shares });

    b.out.metadata = {
      summary: [
        { label: "入仓号", value: li.length },
        { label: "合并后的商品", value: merged.length },
        { label: "原始行", value: raw.length },
        { label: "模型报告问题", value: b.out.issues.length },
      ],
      notes: ["统计仅为结构计数，不代表业务准确率。"],
      headline: { entity: "原始行", noCustomer: true, gold: false },
    };
    return b.out;
  },
};

/** 在请求 JSON 里按键找对象：委托行按 id（需带 md），查货商品按 ref。只读，找不到就不显示 */
function indexRequest(request: unknown) {
  const orders = new Map<string, Obj>();
  const refs = new Map<string, Obj>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Obj;
      if (o.id !== undefined && o.md !== undefined && !orders.has(String(o.id)) && o.ref === undefined) orders.set(String(o.id), o);
      if (typeof o.ref === "string" && !refs.has(o.ref)) refs.set(o.ref, o);
      Object.values(o).forEach(walk);
    }
  };
  walk(request);
  return { orders, refs };
}

// ---------------- P3：委托行 | 选中 / 候选 ----------------
export const jiuliP3V15: BusinessAdapter = {
  adapterId: "jiuli-p3-v15",
  adapterVersion: "1.0.2",
  promptKind: "JIULI_P3",
  schemaVersion: V15_SCHEMA_VERSION,
  rendererId: "jiuli-p3-v15",
  adapt(doc, ctx) {
    const b = new VMBuilder(ctx);
    const req = indexRequest(ctx.request);
    const orders: TableRow[] = [];
    const cands: TableRow[] = [];
    arr(obj(doc).r).forEach((r0, i) => {
      const r = obj(r0);
      const base = ptr("r", i);
      const id = `委托行 ${display(r.id) || i + 1}`;
      const o = req.orders.get(display(r.id)) ?? {};
      const m = arr(r.m).map(obj);
      const c = arr(r.c).map(obj);
      orders.push({
        id,
        meta: { status: r.st },
        cells: {
          order_row_id: makeCell(id, "order_row_id", r.id, join(base, "id")),
          model: makeCell(id, "model", o.md, join(base, "id")),
          brand: makeCell(id, "brand", o.br, join(base, "id")),
          quantity: makeCell(id, "quantity", o.q, join(base, "id")),
          match_status: makeCell(id, "match_status", r.st, join(base, "st")),
          review: makeCell(id, "review", r.review === true ? "是" : r.review === false ? "否" : undefined, join(base, "review")),
          selected_count: makeCell(id, "selected_count", m.length, join(base, "m")),
          candidate_count: makeCell(id, "candidate_count", c.length, join(base, "c")),
        },
      });
      for (const [kind, list, key] of [["SELECTED", m, "m"], ["CANDIDATE", c, "c"]] as const) {
        list.forEach((g, k) => {
          const gb = join(base, key, k);
          const cid = `${id}|${kind}|${k + 1}`;
          const ref = strOrUndef(g.ref) ?? "";
          const p = req.refs.get(ref) ?? {};
          const parts = arr(g.parts).map(String);
          cands.push({
            id: cid,
            meta: { orderRowId: id, kind },
            cells: {
              kind: makeCell(cid, "kind", kind === "SELECTED" ? "选中" : "候选", gb),
              ref: makeCell(cid, "ref", ref, join(gb, "ref")),
              wh: makeCell(cid, "wh", g.wh, join(gb, "wh")),
              model: makeCell(cid, "model", p.md, join(gb, "ref")),
              brand: makeCell(cid, "brand", p.br, join(gb, "ref")),
              quantity: makeCell(cid, "quantity", p.q, join(gb, "ref")),
              parts: makeCell(cid, "parts", parts.length ? `${parts.length} 行：${parts.join("、")}` : undefined, join(gb, "parts")),
              why: makeCell(cid, "why", g.why, join(gb, "why")),
            },
          });
          const rel: RelationView = { id: cid, fromId: id, toIds: parts.length ? parts : [ref], status: kind === "SELECTED" ? String(r.st ?? "") : "CANDIDATE", kind, sourceRefIds: [], jsonPointer: gb };
          b.out.relations.push(rel);
        });
      }
      modelIssues(b, r.issues, join(base, "issues"), { tableId: "orderRows", rowId: id, prefix: `委托行 ${display(r.id)} · `, fieldKey: noField });
    });
    b.out.tables.push({
      id: "orderRows",
      title: "委托商品",
      columns: nonEmpty(
        [
          { key: "order_row_id", title: "委托行", fixed: true },
          { key: "model", title: "委托型号" },
          { key: "brand", title: "品牌" },
          { key: "quantity", title: "数量" },
          { key: "match_status", title: "关系状态", kind: "state" },
          { key: "review", title: "需人工复核" },
          { key: "selected_count", title: "选中", kind: "number" },
          { key: "candidate_count", title: "候选", kind: "number" },
        ],
        orders,
        ["order_row_id", "match_status"],
      ),
      rows: orders,
    });
    b.out.tables.push({
      id: "candidateGroups",
      title: "选中 / 候选的查货商品",
      columns: nonEmpty(
        [
          { key: "kind", title: "类别", fixed: true },
          { key: "ref", title: "查货商品" },
          { key: "wh", title: "入仓号" },
          { key: "model", title: "查货型号" },
          { key: "brand", title: "品牌" },
          { key: "quantity", title: "数量" },
          { key: "parts", title: "原始行" },
          { key: "why", title: "依据" },
        ],
        cands,
        ["kind", "ref"],
      ),
      rows: cands,
    });
    const count = (s: string) => orders.filter((o) => o.meta?.status === s).length;
    b.out.metadata = {
      summary: [
        { label: "委托行", value: orders.length },
        { label: "已匹配", value: count("MATCHED") },
        { label: "多个候选", value: count("MULTIPLE_CANDIDATES") },
        { label: "未匹配", value: count("UNMATCHED") },
      ],
      notes: ["委托型号、查货型号取自本次输入（请求上下文），模型输出只给编号。"],
      headline: { entity: "委托商品", noCustomer: true, gold: false },
    };
    return b.out;
  },
};

// ---------------- P4：一条委托行的逐字段结果 + 合计更新 + 建议 ----------------
export const jiuliP4V15: BusinessAdapter = {
  adapterId: "jiuli-p4-v15",
  adapterVersion: "1.0.2",
  promptKind: "JIULI_P4",
  schemaVersion: V15_SCHEMA_VERSION,
  rendererId: "jiuli-p4-v15",
  adapt(doc, ctx) {
    const b = new VMBuilder(ctx);
    const d = obj(doc);
    const changes = arr(d.changes).map(obj);
    const decisions: TableRow[] = [];
    arr(d.r).forEach((r0, i) => {
      const r = obj(r0);
      const base = ptr("r", i);
      const rowKey = display(r.id) || String(i + 1);
      const risky = new Set(arr(r.issues).map((x) => String(obj(x).f ?? "")));
      arr(d.issues).forEach((x) => risky.add(String(obj(x).f ?? "")));
      const fields = [...ALL_KEYS.filter((k) => r[k] !== undefined), ...changes.map((c) => String(c.f)).filter((f) => r[f] === undefined), ...extraKeys([r], ["id", "issues"])];
      for (const f of [...new Set(fields)]) {
        const ch = changes.find((c) => c.f === f);
        const ci = ch ? changes.indexOf(ch) : -1;
        const id = `${rowKey}:${f}`;
        decisions.push({
          id,
          meta: { orderRowId: rowKey, changed: !!ch, risk: risky.has(f) },
          cells: {
            order_row_id: makeCell(id, "order_row_id", r.id, join(base, "id")),
            field: makeCell(id, "field", label(f), join(base, f)),
            value: makeCell(id, "value", flat(r[f]), join(base, f)),
            before: makeCell(id, "before", ch ? (ch.old === undefined || ch.old === null || ch.old === "" ? "（空）" : flat(ch.old)) : "—", ci >= 0 ? ptr("changes", ci, "old") : join(base, f)),
            action: makeCell(id, "action", ch ? "已更新" : "保持", ci >= 0 ? ptr("changes", ci) : join(base, f)),
            why: makeCell(id, "why", ch ? [display(ch.why), vsText(ch.vs)].filter(Boolean).join("｜") : "—", ci >= 0 ? ptr("changes", ci, "why") : join(base, f)),
          },
        });
        if (ch) b.out.changes.push({ id: `chg-${ci}`, rowId: id, field: f, action: "UPDATE", before: ch.old, after: ch.new, sourceRefIds: [], jsonPointer: ptr("changes", ci), beforeOrigin: "模型输出 changes[].old" });
      }
      const fieldRow = (f: string) => (decisions.some((x) => x.id === `${rowKey}:${f}`) ? `${rowKey}:${f}` : undefined);
      modelIssues(b, r.issues, join(base, "issues"), { tableId: "fieldDecisions", rowId: fieldRow, prefix: `委托行 ${rowKey} · `, fieldKey: () => "value" });
      if (i === 0) modelIssues(b, d.issues, "/issues", { tableId: "fieldDecisions", rowId: fieldRow, fieldKey: () => "value" });
    });
    b.out.tables.push({
      id: "fieldDecisions",
      title: "逐字段结果",
      columns: nonEmpty(
        [
          { key: "order_row_id", title: "委托行", fixed: true, core: true },
          { key: "field", title: "字段", fixed: true, core: true },
          { key: "value", title: "结果值", core: true },
          { key: "action", title: "本轮", core: true, kind: "state" },
          { key: "before", title: "原值", core: true },
          { key: "why", title: "依据", core: true },
        ],
        decisions,
        ["order_row_id", "field", "value", "action"],
      ),
      rows: decisions,
    });

    const tots = arr(d.tot_updates).map(obj);
    if (tots.length)
      b.out.tables.push({
        id: "totUpdates",
        title: "查货合计更新（整票 / 入仓号，不是行级字段）",
        columns: [{ key: "f", title: "字段" }, { key: "wh", title: "入仓号" }, { key: "scope", title: "范围" }, { key: "old", title: "原值" }, { key: "new", title: "新值" }, { key: "why", title: "依据" }],
        rows: tots.map((t, i) => {
          const id = `tot-${i + 1}`;
          const tb = ptr("tot_updates", i);
          return {
            id,
            cells: {
              f: makeCell(id, "f", label(t.f), join(tb, "f")),
              wh: makeCell(id, "wh", t.wh, join(tb, "wh")),
              scope: makeCell(id, "scope", t.scope, join(tb, "scope")),
              old: makeCell(id, "old", t.old, join(tb, "old")),
              new: makeCell(id, "new", t.new, join(tb, "new")),
              why: makeCell(id, "why", [display(t.why), vsText(t.vs)].filter(Boolean).join("｜"), join(tb, "why")),
            },
          };
        }),
      });

    const sugg = arr(d.suggestions);
    if (sugg.length)
      b.out.tables.push({
        id: "suggestions",
        title: "建议（未自动采用）",
        columns: [{ key: "f", title: "字段" }, { key: "content", title: "内容" }],
        rows: sugg.map((s0, i) => {
          const s = obj(s0);
          const id = `sg-${i + 1}`;
          const rest = Object.fromEntries(Object.entries(s).filter(([k]) => k !== "f"));
          return { id, cells: { f: makeCell(id, "f", label(s.f), ptr("suggestions", i, "f")), content: makeCell(id, "content", typeof s0 === "string" ? s0 : [display(rest.v ?? rest.value ?? rest.new), display(rest.why ?? rest.note), vsText(rest.vs)].filter(Boolean).join("｜") || JSON.stringify(rest), ptr("suggestions", i)) } };
        }),
      });

    b.out.metadata = {
      summary: [
        { label: "字段", value: decisions.length },
        { label: "本轮更新", value: changes.length },
        { label: "合计更新", value: tots.length },
        { label: "需人工处理", value: d.review === true ? "是" : d.review === false ? "否" : "—" },
        { label: "需重新匹配", value: d.rematch === true ? "是" : d.rematch === false ? "否" : "—" },
      ],
      notes: ["结果值是模型给出的候选，不是已写入九立的数据。"],
      headline: { entity: "字段", noCustomer: true, gold: false },
    };
    return b.out;
  },
};
