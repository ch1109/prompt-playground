// §6.1 问题标注：「属实 / 误报」。存在 annotations 表里，assessment 留空，所以评判逻辑看不到它。
import { beforeAll, describe, expect, it } from "vitest";
import { getFixture } from "@/lib/fixtures/catalog";
import { evaluateSample } from "@/lib/experiments/evaluate";
import { exportAnnotations } from "@/lib/repositories/annotations-export";
import { db, resetDbForTests } from "@/lib/repositories/db";
import { addAnnotation, getRun, listAnnotations, setIssueVerdict } from "@/lib/repositories/runs";
import { annotationsForSample } from "@/lib/repositories/experiments";
import { loadRunContext } from "@/lib/runs/debug-bundle";
import { contextMarkdown } from "@/lib/runs/export";
import { renderOnly } from "@/lib/runs/service";

beforeAll(() => resetDbForTests(":memory:"));

function runWithIssue() {
  const run = renderOnly({ projectId: "jiuli", promptId: "jiuli-p1", raw: getFixture("constructed/p1-v3-conflict.json")!.raw });
  const issue = run.view_model!.issues[0];
  expect(issue).toBeTruthy();
  return { run, issue };
}
const rawHash = (id: string) => (db().prepare("SELECT sha256 FROM raw_responses WHERE run_id = ?").get(id) as { sha256: string }).sha256;
const revisions = (id: string) => db().prepare("SELECT action FROM annotation_revisions WHERE annotation_id = ? ORDER BY revision").all(id) as { action: string }[];

describe("问题标注：属实 / 误报", () => {
  it("问题 id 在同一次运行里回放不变", () => {
    const { run } = runWithIssue();
    const again = getRun(run.run_id)!.view_model!.issues.map((i) => i.id);
    expect(again).toEqual(run.view_model!.issues.map((i) => i.id));
  });

  it("标「误报」后能读回；再标同一条是修改不是新增，且留修订；原始响应不变", () => {
    const { run, issue } = runWithIssue();
    const hash = rawHash(run.run_id);
    const a = setIssueVerdict(run.run_id, { id: issue.id, type: issue.type, summary: issue.summary, jsonPointer: issue.target?.jsonPointer ?? null }, "ISSUE_FALSE_POSITIVE", "测试");
    expect(a.issue_type).toBe("ISSUE_FALSE_POSITIVE");
    expect(a.assessment ?? null).toBeNull();
    expect(listAnnotations(run.run_id)).toHaveLength(1);
    const b = setIssueVerdict(run.run_id, { id: issue.id, type: issue.type, summary: issue.summary }, "ISSUE_REAL", "测试");
    expect(b.annotation_id).toBe(a.annotation_id);
    expect(listAnnotations(run.run_id)).toHaveLength(1);
    expect(listAnnotations(run.run_id)[0].issue_type).toBe("ISSUE_REAL");
    expect(revisions(a.annotation_id).map((r) => r.action)).toEqual(["CREATE", "UPDATE"]);
    expect(rawHash(run.run_id)).toBe(hash);
  });

  it("标注导出和 context.md 里都有；不影响字段标注的评判", () => {
    const { run, issue } = runWithIssue();
    addAnnotation({ run_id: run.run_id, target_json_pointer: "/output/x", target: "字段", issue_type: "ASSESSMENT", expected_value: null, note: null, assessment: "WRONG", error_category: "UNKNOWN", category_confirmed: true, model_value: null, source_ref_ids: [], author: "t" });
    setIssueVerdict(run.run_id, { id: issue.id, type: issue.type, summary: issue.summary, jsonPointer: issue.target?.jsonPointer ?? null }, "ISSUE_FALSE_POSITIVE", "测试");
    const rows = exportAnnotations("jiuli").filter((r) => r.run_id === run.run_id);
    const row = rows.find((r) => r.issue_type === "ISSUE_FALSE_POSITIVE")!;
    expect(row.assessment).toBe("");
    expect(row.target).toContain(issue.id);
    expect(rows.find((r) => r.issue_type === "ASSESSMENT")!.assessment).toBe("WRONG");
    const md = contextMarkdown(loadRunContext(run.run_id)!, []);
    expect(md).toContain("### 对模型报告问题的判断");
    expect(md).toContain(`误报 · ${issue.summary.slice(0, 30)}`);
    // 评判只看 assessment 为 WRONG / CORRECT 的标注：问题标注不会成为字段结果
    const ev = evaluateSample({ sample_id: "s", role: "TARGET", baseline: getRun(run.run_id)!, candidate: getRun(run.run_id)!, annotations: listAnnotations(run.run_id) });
    expect(JSON.stringify(ev)).not.toContain("ISSUE_FALSE_POSITIVE");
    // 冻结标准答案走 annotationsForSample：会带上它，但 assessment 为空，不会被当成 WRONG / CORRECT
    const snap = getRun(run.run_id)!.input_snapshot_id;
    if (snap) expect(annotationsForSample("jiuli-p1", snap).filter((a) => a.issue_type.startsWith("ISSUE_")).every((a) => !a.assessment)).toBe(true);
  });
});
