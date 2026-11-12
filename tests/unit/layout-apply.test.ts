import { describe, expect, it } from "vitest";
import { applyLayout } from "@/lib/layouts/apply";
import type { Layout } from "@/lib/layouts/types";
import { getByPointer } from "@/lib/pipeline/json-pointer";

const doc = {
  items: [
    { name: "苹果", qty: 3, status: "通过", level: "高", note: "好" },
    { name: "香蕉", qty: 5, status: "未通过", level: "提醒", note: { a: 1 } },
    { name: "梨", status: "fail", level: "严重" },
  ],
};

describe("applyLayout", () => {
  it("table：列、行与 pointer", () => {
    const layout: Layout = {
      version: 1,
      kind: "table",
      itemsPath: "/items",
      columns: [
        { label: "名称", path: "/name" },
        { label: "数量", path: "/qty", kind: "number" },
      ],
    };
    const r = applyLayout(layout, doc);
    if (r.kind !== "table") throw new Error("应为 table");
    expect(r.table.id).toBe("layout");
    expect(r.table.title).toBe("结果");
    expect(r.table.columns.map((c) => c.key)).toEqual(["c0", "c1"]);
    expect(r.table.columns[1].kind).toBe("number");
    expect(r.table.rows).toHaveLength(3);
    expect(r.table.rows[0].id).toBe("r0");
    expect(r.table.rows[0].cells.c1.value).toBe(3);
    // 缺失字段不崩，显示为空串
    expect(r.table.rows[2].cells.c1.value).toBe("");
    // pointer 能取回原值
    const cell = r.table.rows[1].cells.c0;
    expect(cell.jsonPointer).toBe("/items/1/name");
    expect(getByPointer(doc, cell.jsonPointer).value).toBe("香蕉");
  });

  it("根是数组（itemsPath 为空串）", () => {
    const root = [{ a: 1 }, { a: 2 }];
    const r = applyLayout({ version: 1, kind: "table", title: "T", itemsPath: "", columns: [{ label: "A", path: "/a" }] }, root);
    if (r.kind !== "table") throw new Error("应为 table");
    expect(r.table.title).toBe("T");
    expect(r.table.rows[1].cells.c0.jsonPointer).toBe("/1/a");
    expect(getByPointer(root, r.table.rows[1].cells.c0.jsonPointer).value).toBe(2);
  });

  it("cards：标题、徽章、字段字符串化与缺失", () => {
    const r = applyLayout(
      {
        version: 1,
        kind: "cards",
        itemsPath: "/items",
        titlePath: "/name",
        badgePath: "/status",
        fields: [
          { label: "备注", path: "/note" },
          { label: "数量", path: "/qty" },
        ],
      },
      doc,
    );
    if (r.kind !== "cards") throw new Error("应为 cards");
    expect(r.cards[0]).toMatchObject({ id: "r0", title: "苹果", badge: "通过", pointer: "/items/0" });
    expect(r.cards[1].fields[0].value).toBe('{"a":1}');
    expect(r.cards[2].fields[0]).toEqual({ label: "备注", value: "", pointer: "/items/2/note" });
    const noTitle = applyLayout({ version: 1, kind: "cards", itemsPath: "", titlePath: "/x", fields: [] }, [{}]);
    if (noTitle.kind !== "cards") throw new Error("应为 cards");
    expect(noTitle.cards[0].title).toBe("（无标题）");
  });

  it("checklist：计数与严重度映射", () => {
    const r = applyLayout(
      { version: 1, kind: "checklist", itemsPath: "/items", titlePath: "/name", statusPath: "/status", severityPath: "/level", detailPath: "/note" },
      doc,
    );
    if (r.kind !== "checklist") throw new Error("应为 checklist");
    expect(r.passCount).toBe(1);
    expect(r.failCount).toBe(2);
    expect(r.issues[0]).toMatchObject({ type: "通过", severity: "INFO", summary: "苹果", origin: "MODEL_FINDING", detail: "好" });
    expect(r.issues[0].target?.jsonPointer).toBe("/items/0");
    expect(r.issues[1]).toMatchObject({ type: "未通过", severity: "WARNING" });
    expect(r.issues[2]).toMatchObject({ type: "未通过", severity: "BLOCKER" });
  });

  it("checklist：自定义 passValues；无 statusPath 时全部未通过", () => {
    const d = [{ t: "a", s: "合格" }, { t: "b", s: "x" }];
    const r1 = applyLayout({ version: 1, kind: "checklist", itemsPath: "", titlePath: "/t", statusPath: "/s", passValues: ["合格"] }, d);
    if (r1.kind !== "checklist") throw new Error();
    expect([r1.passCount, r1.failCount]).toEqual([1, 1]);
    const r2 = applyLayout({ version: 1, kind: "checklist", itemsPath: "", titlePath: "/t" }, d);
    if (r2.kind !== "checklist") throw new Error();
    expect([r2.passCount, r2.failCount]).toEqual([0, 2]);
  });

  it("report：字符串、数组、对象、缺失节", () => {
    const d = { summary: "概述", list: ["甲", { x: 1 }], obj: { k: "v", n: 2 } };
    const r = applyLayout(
      {
        version: 1,
        kind: "report",
        sections: [
          { title: "概述", path: "/summary" },
          { title: "列表", path: "/list" },
          { title: "对象", path: "/obj" },
          { title: "缺", path: "/nope" },
        ],
      },
      d,
    );
    if (r.kind !== "report") throw new Error("应为 report");
    expect(r.sections[1].text).toBe('- 甲\n- {"x":1}');
    expect(r.sections[2].text).toBe("k：v\nn：2");
    expect(r.sections[3]).toMatchObject({ found: false, text: "" });
    expect(r.markdown).toBe("## 概述\n\n概述\n\n## 列表\n\n- 甲\n- {\"x\":1}\n\n## 对象\n\nk：v\nn：2");
  });

  it("report：所有节都缺失 → mismatch", () => {
    const r = applyLayout({ version: 1, kind: "report", sections: [{ title: "a", path: "/a" }] }, {});
    expect(r.kind).toBe("mismatch");
  });

  it("itemsPath 不存在或不是数组 → mismatch，并指出路径", () => {
    const l: Layout = { version: 1, kind: "table", itemsPath: "/items", columns: [{ label: "A", path: "/a" }] };
    const r1 = applyLayout(l, {});
    expect(r1.kind === "mismatch" && r1.reason).toContain("/items");
    const r2 = applyLayout(l, { items: "x" });
    expect(r2.kind === "mismatch" && r2.reason).toContain("/items");
    expect(applyLayout({ version: 1, kind: "cards", itemsPath: "", titlePath: "", fields: [] }, { a: 1 }).kind).toBe("mismatch");
    expect(applyLayout({ version: 1, kind: "checklist", itemsPath: "/x", titlePath: "" }, null).kind).toBe("mismatch");
  });

  it("空数组返回空结果，不算 mismatch", () => {
    const r = applyLayout({ version: 1, kind: "table", itemsPath: "/items", columns: [{ label: "A", path: "/a" }] }, { items: [] });
    expect(r.kind === "table" && r.table.rows).toEqual([]);
    const c = applyLayout({ version: 1, kind: "checklist", itemsPath: "", titlePath: "" }, []);
    expect(c).toMatchObject({ kind: "checklist", passCount: 0, failCount: 0 });
  });

  it("pointer 中含 ~ 和 / 的键被正确转义", () => {
    const d = { "a/b": [{ "x~y": 1, "p/q": { r: "深" } }] };
    const r = applyLayout(
      {
        version: 1,
        kind: "table",
        itemsPath: "/a~1b",
        columns: [
          { label: "X", path: "/x~0y" },
          { label: "R", path: "/p~1q/r" },
        ],
      },
      d,
    );
    if (r.kind !== "table") throw new Error("应为 table");
    const [c0, c1] = [r.table.rows[0].cells.c0, r.table.rows[0].cells.c1];
    expect(c0.jsonPointer).toBe("/a~1b/0/x~0y");
    expect(getByPointer(d, c0.jsonPointer).value).toBe(1);
    expect(getByPointer(d, c1.jsonPointer).value).toBe("深");
  });

  it("超过 2000 项只取前 2000 项", () => {
    const big = Array.from({ length: 2500 }, (_, i) => ({ n: i }));
    const r = applyLayout({ version: 1, kind: "table", itemsPath: "", columns: [{ label: "N", path: "/n" }] }, big);
    expect(r.kind === "table" && r.table.rows.length).toBe(2000);
  });
});
