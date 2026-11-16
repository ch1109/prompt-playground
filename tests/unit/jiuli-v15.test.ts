import { describe, expect, it } from "vitest";
import { businessViolations } from "@/lib/experiments/business-rules";
import { runPipeline } from "@/lib/pipeline/pipeline";

// 样例结构取自九立二阶段 demo 各提示词「输出」章节的示例（业务值均为假设）
const ctx = (request?: unknown) => ({ runId: "r", request }) as never;
const run = (kind: "JIULI_P1" | "JIULI_P2" | "JIULI_P3" | "JIULI_P4", doc: unknown, request?: unknown) =>
  runPipeline({ raw: "```json\n" + JSON.stringify(doc) + "\n```", promptKind: kind, context: ctx(request) });

describe("二阶段 demo v15 输出按业务表格渲染", () => {
  it("P1：识别为 v15，委托商品宽表、共用值、整票合计、行级问题定位到字段", () => {
    const pr = run("JIULI_P1", {
      v: 15,
      h: { cus: "某客户", issues: [] },
      r: [
        { id: 1, br: "HIROSE", md: "ABC-1", q: "20", u: "个", pr: "1.25", cur: "USD", og: "日本", issues: [{ f: "u", t: "推断", vs: [{ s: "委托书第1页", v: "个" }], note: "单位按品名推断" }] },
        { id: 2, br: "HIROSE", md: "DEF-2", q: "12", u: "个", x: { LOT: "2542、2523", "C/N": "3" }, issues: [] },
      ],
      g: [{ f: "gw", v: "1.1", r: [1, 2], wu: "千克", group: "共用外箱" }],
      tot: { q: "32", u: "个", issues: [] },
    });
    expect(pr.status).toBe("SUCCEEDED");
    expect(pr.validation.schemaId).toBe("jiuli-p1-v15");
    const vm = pr.viewModel!;
    expect(vm.rendererId).toBe("jiuli-p1-v15");
    const rows = vm.tables.find((t) => t.id === "orderRows")!;
    expect(rows.rows.map((r) => r.cells.md.value)).toEqual(["ABC-1", "DEF-2"]);
    // 全空的列不显示
    expect(rows.columns.some((c) => c.key === "hs")).toBe(false);
    // 辅助信息 x：列名用提示词里的正式名称，对象写成「标签：值」
    expect(rows.columns.find((c) => c.key === "x")?.title).toBe("辅助信息");
    expect(rows.rows[1].cells.x.value).toBe("LOT：2542、2523；C/N：3");
    expect(vm.tables.find((t) => t.id === "shareRecords")!.rows[0].cells.r.value).toBe("1、2");
    expect(vm.tables.find((t) => t.id === "totals")!.rows[0].cells.q.value).toBe("32");
    expect(vm.issues[0].target).toMatchObject({ tableId: "orderRows", rowId: "row-1", fieldKey: "u" });
    expect(vm.issues[0].detail).toContain("委托书第1页：个");
    expect(vm.metadata?.headline?.customerName).toBe("某客户");
  });

  it("P2：入仓号 → 合并商品 → 原始行，原始行归属到合并商品", () => {
    const pr = run("JIULI_P2", {
      v: 15,
      h: [
        {
          wh: "02609743",
          tot: { q: "300", u: "个", gw: "68", pk: "2", pl: "0", wu: "千克" },
          qc: { raw: "300", calc: "300", u: "个" },
          issues: [],
          g: [],
          r: [{ id: 1, br: "HIROSE", md: "ABC-1", og: "日本", q: "300", u: "个", parts: [{ n: 1, box: "1", mn: "M-1", q: "100" }, { n: 2, box: "2", mn: "M-1", q: "200" }], merge_note: "2条原始明细", issues: [] }],
        },
      ],
    });
    expect(pr.status).toBe("SUCCEEDED");
    const vm = pr.viewModel!;
    const merged = vm.tables.find((t) => t.id === "mergedProducts")!;
    const raw = vm.tables.find((t) => t.id === "inspectionRawRows")!;
    expect(merged.rows[0].meta).toMatchObject({ group: "02609743", members: ["1-1-1", "1-1-2"] });
    expect(raw.rows.map((r) => r.cells.md.value)).toEqual(["ABC-1", "ABC-1"]);
    expect(vm.tables.find((t) => t.id === "logicalInspections")!.rows[0].cells.qc.value).toBe("原文 300 / 逐行相加 300");
    // 输出里没有客户，不显示「客户 未识别」；按 v3 结构写的硬规则不适用
    expect(vm.metadata?.headline?.noCustomer).toBe(true);
    expect(businessViolations("JIULI_P2", { any: 1 }, pr.parse.value)).toBeNull();
  });

  it("P3：委托行状态、选中与候选；型号从输入里按 id / ref 取", () => {
    const pr = run(
      "JIULI_P3",
      {
        v: 15,
        r: [
          { id: 1, st: "MATCHED", m: [{ ref: "W-G001", wh: "02609743", parts: ["P-001"], why: "型号一致" }], c: [], review: false, issues: [] },
          { id: 2, st: "UNMATCHED", m: [], c: [], review: true, issues: [{ f: "md", t: "证据不足", vs: [], note: "无候选" }] },
        ],
      },
      { 委托商品行: [{ id: 1, md: "ABC-1", br: "HIROSE", q: "20" }, { id: 2, md: "XYZ", q: "1" }], 查货商品池: [{ ref: "W-G001", md: "ABC-1", q: "20" }] },
    );
    expect(pr.status).toBe("SUCCEEDED");
    const vm = pr.viewModel!;
    const orders = vm.tables.find((t) => t.id === "orderRows")!;
    expect(orders.rows.map((r) => [r.cells.model.value, r.cells.match_status.value])).toEqual([["ABC-1", "MATCHED"], ["XYZ", "UNMATCHED"]]);
    const cands = vm.tables.find((t) => t.id === "candidateGroups")!;
    expect(cands.rows[0]).toMatchObject({ meta: { orderRowId: "委托行 1", kind: "SELECTED" } });
    expect(cands.rows[0].cells.model.value).toBe("ABC-1");
    expect(vm.relations[0]).toMatchObject({ fromId: "委托行 1", toIds: ["P-001"] });
  });

  it("P4：逐字段结果标出本轮更新与原值；合计更新单独成表；问题定位到字段行", () => {
    const pr = run("JIULI_P4", {
      v: 15,
      r: [{ id: 1, md: "DF56", og: "日本", q: "100", issues: [{ f: "og", t: "差异", vs: [{ s: "委托书", v: "CHINA" }], note: "按查货更新" }] }],
      changes: [{ f: "og", old: "中国", new: "日本", vs: [{ s: "查货单", v: "JAPAN" }], why: "查货优先" }],
      tot_updates: [{ f: "gw", wh: "02609743", scope: "范围一致", old: "70", new: "68", vs: [], why: "按板标" }],
      suggestions: [],
      rematch: false,
      review: true,
    });
    expect(pr.status).toBe("SUCCEEDED");
    const vm = pr.viewModel!;
    const dec = vm.tables.find((t) => t.id === "fieldDecisions")!;
    const og = dec.rows.find((r) => r.id === "1:og")!;
    expect(og.meta).toMatchObject({ changed: true, risk: true });
    expect([og.cells.before.value, og.cells.value.value, og.cells.action.value]).toEqual(["中国", "日本", "已更新"]);
    expect(dec.rows.find((r) => r.id === "1:md")!.cells.action.value).toBe("保持");
    expect(vm.tables.find((t) => t.id === "totUpdates")!.rows[0].cells.new.value).toBe("68");
    expect(vm.tables.some((t) => t.id === "suggestions")).toBe(false);
    expect(vm.issues[0].target).toMatchObject({ tableId: "fieldDecisions", rowId: "1:og" });
  });

  it("骨架不对时仍局部渲染并标出结构问题；没有 v 的输出仍按 JSON 树", () => {
    expect(run("JIULI_P3", { v: 15, r: [{ id: 1, st: "OK", m: [], c: [] }] }).status).toBe("SCHEMA_INVALID");
    expect(run("JIULI_P1", { r: [] }).validation.status).toBe("UNKNOWN_SCHEMA");
  });
});
