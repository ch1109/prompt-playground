// 2026-11-16 流程走查发现的问题：v15 输出对比能逐行对齐；「重新整理」的模型运行按模型运行对比；文件名看不出类型时要提醒
import { describe, expect, it } from "vitest";
import type { Run } from "@/lib/contracts/run";
import { typeFromName } from "@/lib/materials/guess-type";
import { diffSummary, fromModel, strictConditions } from "@/lib/runs/compare";

describe("版本对比：v15 输出", () => {
  it("商品行按 id 对齐，只列出真正变化的字段", () => {
    const a = { v: 15, r: [{ id: 1, md: "A", og: "中国", issues: [] }, { id: 2, md: "B", og: "日本", issues: [] }] };
    const b = { v: 15, r: [{ id: 1, md: "A", og: "美国", issues: [] }, { id: 2, md: "B", og: "日本", issues: [] }, { id: 3, md: "C", issues: [] }] };
    const { rows } = diffSummary(a, b);
    expect(rows.some((r) => r.kind === "UNALIGNED")).toBe(false);
    expect(rows).toContainEqual({ pointer: "/r/[id=1]/og", kind: "CHANGED", a: '"中国"', b: '"美国"' });
    expect(rows.filter((r) => r.pointer.startsWith("/r/[id=3]")).every((r) => r.kind === "ADDED")).toBe(true);
  });

  it("P2 入仓号分组按 wh 对齐", () => {
    const { rows } = diffSummary({ v: 15, h: [{ wh: "001", tot: { q: "1" } }] }, { v: 15, h: [{ wh: "001", tot: { q: "2" } }] });
    expect(rows).toEqual([{ pointer: "/h/[wh=001]/tot/q", kind: "CHANGED", a: '"1"', b: '"2"' }]);
  });
});

describe("版本对比：重新整理的记录", () => {
  const base = { mode: "MODEL_RUN", model_name: "m", model_provider: "p", built_input_hash: "h", model_params: {}, attached_images: null, input_builder_id: "b", input_manifest: { files: [] } } as unknown as Run;
  it("对模型运行的重新整理按模型运行看待；仅渲染不算", () => {
    expect(fromModel({ ...base, mode: "REPLAY" })).toBe(true);
    expect(fromModel({ ...base, mode: "REPLAY", model_name: null })).toBe(false);
    expect(strictConditions(base, { ...base, mode: "REPLAY" }).applicable).toBe(true);
  });
});

describe("上传：材料类型", () => {
  it("文件名里有类型词才算判断出来，否则提醒确认", () => {
    expect(typeFromName("宏杉委托单.xls")).toBe(true);
    expect(typeFromName("INVOICE-001.pdf")).toBe(true);
    expect(typeFromName("1769762094319.pdf")).toBe(false);
  });
});
