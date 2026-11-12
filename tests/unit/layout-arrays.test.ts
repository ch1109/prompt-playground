import { describe, expect, it } from "vitest";
import { findArrays } from "@/lib/layouts/arrays";

describe("findArrays", () => {
  it("根是列表", () => {
    expect(findArrays([{ a: 1 }, { a: 2 }])).toEqual([{ path: "", count: 2 }]);
  });
  it("多个列表，含嵌套，按出现顺序", () => {
    const doc = { items: [{ a: 1 }], meta: { rows: [{ b: 1 }, { b: 2 }] }, other: [{ c: 1 }] };
    expect(findArrays(doc)).toEqual([
      { path: "/items", count: 1 },
      { path: "/meta/rows", count: 2 },
      { path: "/other", count: 1 },
    ]);
  });
  it("跳过空列表、标量列表和非列表", () => {
    expect(findArrays({ a: [], b: [1, 2], c: "x", d: null, e: [{ k: 1 }] })).toEqual([{ path: "/e", count: 1 }]);
  });
  it("路径转义特殊字符", () => {
    expect(findArrays({ "a/b": [{ x: 1 }] })).toEqual([{ path: "/a~1b", count: 1 }]);
  });
  it("最多 4 层", () => {
    expect(findArrays({ a: { b: { c: { d: [{ x: 1 }] } } } })).toEqual([{ path: "/a/b/c/d", count: 1 }]);
    expect(findArrays({ a: { b: { c: { d: { e: [{ x: 1 }] } } } } })).toEqual([]);
  });
  it("最多 10 个", () => {
    const doc = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, [{ x: i }]]));
    expect(findArrays(doc)).toHaveLength(10);
  });
  it("标量根返回空", () => {
    expect(findArrays("x")).toEqual([]);
    expect(findArrays(null)).toEqual([]);
  });
});
