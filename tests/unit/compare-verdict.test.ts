// 版本对比结论：复用试运行评判，按 A 上人工标过的字段判断修好 / 变差 / 需要你看
import { describe, expect, it } from "vitest";
import type { Run } from "@/lib/contracts/run";
import type { Annotation } from "@/lib/repositories/runs";
import { compareVerdict } from "@/lib/runs/compare-verdict";

const run = (id: string, value: string, snapshot = "snap_1"): Run =>
  ({ run_id: id, input_snapshot_id: snapshot, built_input_hash: null, mode: "RENDER_ONLY", status: "SUCCEEDED", prompt_kind: "GENERIC_JSON", schema_diagnostics: [], parsed_json: { model: value } }) as unknown as Run;
const ann = (p: Partial<Annotation>): Annotation => ({ annotation_id: "ann_1", run_id: "A", target_json_pointer: "/model", target: "型号", issue_type: "ASSESSMENT", expected_value: null, note: null, created_at: "", model_value: null, ...p });

describe("compareVerdict", () => {
  it("A 标「错」并给正确值，B 等于正确值：修好 1", () => {
    const v = compareVerdict(run("A", "x"), run("B", "y"), [ann({ assessment: "WRONG", expected_value: "y", model_value: '"x"' })]);
    expect(v).toMatchObject({ fixed: 1, regressed: 0, needsReview: 0 });
  });
  it("A 标「对」，B 的值变了：变差 1", () => {
    const v = compareVerdict(run("A", "x"), run("B", "y"), [ann({ assessment: "CORRECT", model_value: '"x"' })]);
    expect(v).toMatchObject({ fixed: 0, regressed: 1, needsReview: 0 });
  });
  it("A 标「错」没给正确值，B 的值变了：需要你看 1", () => {
    const v = compareVerdict(run("A", "x"), run("B", "y"), [ann({ assessment: "WRONG" })]);
    expect(v).toMatchObject({ fixed: 0, regressed: 0, needsReview: 1 });
  });
  it("A 标「对」且 B 没变：不计入三个数字，明细里为保持正确", () => {
    const v = compareVerdict(run("A", "x"), run("B", "x"), [ann({ assessment: "CORRECT", model_value: '"x"' })]);
    expect(v).toMatchObject({ fixed: 0, regressed: 0, needsReview: 0 });
    expect(v?.fields[0].outcome).toBe("KEPT");
  });
  it("两次运行输入不同：不给结论", () => {
    expect(compareVerdict(run("A", "x"), run("B", "y", "snap_2"), [ann({ assessment: "WRONG" })])).toBeNull();
  });
  it("A 上没有字段标注（含只标在 B 上、问题类标注）：不给结论", () => {
    expect(compareVerdict(run("A", "x"), run("B", "y"), [])).toBeNull();
    expect(compareVerdict(run("A", "x"), run("B", "y"), [ann({ run_id: "B", assessment: "WRONG" })])).toBeNull();
    expect(compareVerdict(run("A", "x"), run("B", "y"), [ann({ target_json_pointer: null, assessment: "CORRECT" })])).toBeNull();
  });
  it("只有「不确定」标注：不给结论", () => {
    expect(compareVerdict(run("A", "x"), run("B", "y"), [ann({ assessment: "UNSURE" })])).toBeNull();
  });
});
