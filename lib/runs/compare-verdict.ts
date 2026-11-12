import { evaluateSample, type FieldOutcome } from "@/lib/experiments/evaluate";
import type { Run } from "@/lib/contracts/run";
import type { Annotation } from "@/lib/repositories/runs";
import { inputComparability } from "./compare";

// 版本对比的结论（规范 §3.6）：A 上人工标过的字段，在 B 里是修好了、变差了，还是系统判断不了。
// 字段判定直接复用试运行评判 evaluateSample，不另写一套。

export interface VerdictField {
  pointer: string;
  /** 标注时记下的字段位置文字（拿不到则为 null） */
  target: string | null;
  assessment: string | null;
  expected: string | null;
  a: string;
  b: string;
  outcome: FieldOutcome;
}
export interface CompareVerdict {
  fixed: number;
  regressed: number;
  needsReview: number;
  fields: VerdictField[];
}

/** 输入不可比、或 A 上没有「对 / 错」的字段标注时返回 null（界面不显示结论行） */
export function compareVerdict(a: Run, b: Run, annotations: Annotation[]): CompareVerdict | null {
  if (!inputComparability(a, b).comparable) return null;
  const judged = annotations.filter((x) => x.run_id === a.run_id && x.target_json_pointer && (x.assessment === "WRONG" || x.assessment === "CORRECT"));
  if (!judged.length) return null;
  const fields = evaluateSample({ sample_id: a.input_snapshot_id ?? a.run_id, role: "TARGET", baseline: a, candidate: b, annotations: judged }).annotated_fields.map((f) => ({
    pointer: f.json_pointer,
    target: f.target,
    assessment: f.assessment ?? null,
    expected: f.expected_value,
    a: f.baseline_value,
    b: f.candidate_value,
    outcome: f.outcome,
  }));
  const n = (o: FieldOutcome) => fields.filter((f) => f.outcome === o).length;
  return { fixed: n("FIXED"), regressed: n("REGRESSED"), needsReview: n("CHANGED_UNVERIFIED"), fields };
}
