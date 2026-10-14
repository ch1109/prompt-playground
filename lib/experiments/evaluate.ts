import type { Run } from "@/lib/contracts/run";
import { getByPointer } from "@/lib/pipeline/json-pointer";
import type { Annotation } from "@/lib/repositories/runs";
import { diffSummary, textHunks } from "@/lib/runs/compare";
import type { RuleViolation } from "./business-rules";
import type { SourceCheck } from "./source-check";

// 实验评判（v1.3 §10.3–10.5）：没有 Gold，只用两类依据——
// 1）结构检查（能否解析、Schema 错误数）是确定性的；
// 2）人工标注：标「错」并填了正确值的字段看是否改对，标「对」的字段看是否被改动。
// 其余输出差异一律记为「未判定」，不宣称准确率提升。

export type StructureChange = "FIXED" | "IMPROVED" | "SAME" | "WORSE" | "REGRESSED" | "INCOMPLETE";
export type FieldOutcome = "FIXED" | "NOT_FIXED" | "CHANGED_UNVERIFIED" | "KEPT" | "REGRESSED";
export type SampleVerdict = "FIXED" | "REGRESSED" | "NO_CHANGE" | "UNDETERMINED" | "INCOMPLETE";
export type Conclusion = "READY_FOR_REVIEW" | "NOT_RECOMMENDED" | "INSUFFICIENT_EVIDENCE";

/** 结构问题数：无法解析记为 Infinity；没有结果（模型出错 / 取消 / 运行中）为 null */
export function structureErrors(r: Run | undefined): number | null {
  if (!r || ["MODEL_ERROR", "CANCELLED", "RUNNING"].includes(r.status)) return null;
  if (r.status === "PARSE_ERROR") return Infinity;
  return r.schema_diagnostics.filter((d) => d.level === "ERROR").length + (r.status === "ADAPTER_ERROR" ? 1 : 0);
}

function structureChange(base: number | null, cand: number | null): StructureChange {
  if (base === null || cand === null) return "INCOMPLETE";
  if (base === cand) return "SAME";
  if (base > 0 && cand === 0) return "FIXED";
  if (base === 0 && cand > 0) return "REGRESSED";
  return cand < base ? "IMPROVED" : "WORSE";
}

const parseJson = (t: string | null | undefined): unknown => {
  if (t === null || t === undefined) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const show = (v: unknown) => (v === undefined ? "（没有这个位置）" : typeof v === "string" ? v : JSON.stringify(v));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameText = (v: unknown, expected: string) => (typeof v === "string" ? v : JSON.stringify(v)).trim() === expected.trim();

/** 实验可比性（§10.4）：同一构造输入、同一模型、同一参数、同样不带 / 带图片；不满足只能当探索性对比 */
export function experimentComparable(a: Run, b: Run): { comparable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!a.built_input_hash || a.built_input_hash !== b.built_input_hash) reasons.push("构造输入不同或未记录");
  if (`${a.model_provider}/${a.model_name}` !== `${b.model_provider}/${b.model_name}`) reasons.push("模型不同");
  if (!same(a.model_params ?? null, b.model_params ?? null)) reasons.push("模型参数不同");
  if (!!a.attached_images?.length !== !!b.attached_images?.length) reasons.push("一方附带了原件图片");
  return { comparable: reasons.length === 0, reasons };
}

export interface SampleInput {
  sample_id: string;
  role: "TARGET" | "REGRESSION";
  baseline?: Run;
  candidate?: Run;
  /** 这个样本上的人工标注（基线或同输入其他运行上的） */
  annotations: Annotation[];
  /** 来源坐标检查（打开原件核对）；没做为 undefined */
  sources?: { baseline: SourceCheck | null; candidate: SourceCheck | null };
  /** P3 / P4 业务硬规则的违反情况（null = 该阶段没有规则或没有输出） */
  rules?: { baseline: RuleViolation[] | null; candidate: RuleViolation[] | null };
}

export function evaluateSample(s: SampleInput) {
  const { baseline: b, candidate: c } = s;
  // 输出里「无法解析」写成文字（Infinity 序列化后会变成 null，和「没有结果」混淆）
  const label = (n: number | null) => (n === Infinity ? "PARSE_FAILED" : n);
  const structure = { baseline_errors: label(structureErrors(b)), candidate_errors: label(structureErrors(c)), baseline_status: b?.status ?? null, candidate_status: c?.status ?? null, change: structureChange(structureErrors(b), structureErrors(c)) };
  const rows = b?.view_model && c?.view_model ? { baseline: b.view_model.tables[0]?.rows.length ?? 0, candidate: c.view_model.tables[0]?.rows.length ?? 0 } : null;
  // 硬闸门（§10.3）：P1 / P2 主表行数减少 = 疑似漏行
  const hardGates: string[] = [];
  if (rows && rows.candidate < rows.baseline && (b!.prompt_kind === "JIULI_P1" || b!.prompt_kind === "JIULI_P2")) hardGates.push(`主表行数从 ${rows.baseline} 减少到 ${rows.candidate}（疑似漏行）`);

  const fields = s.annotations
    .filter((a) => a.target_json_pointer && (a.assessment === "WRONG" || a.assessment === "CORRECT"))
    .map((a) => {
      const p = a.target_json_pointer!;
      const bv = b?.parsed_json === undefined ? undefined : getByPointer(b.parsed_json, p).value;
      const cv = c?.parsed_json === undefined ? undefined : getByPointer(c.parsed_json, p).value;
      let outcome: FieldOutcome;
      if (a.assessment === "CORRECT") {
        // 标「对」时记下的模型原值才是正确值（标注可能打在同一样本的另一次运行上）；基线本来就不等于它时，候选没变对不算退化
        const ref = parseJson(a.model_value) ?? bv;
        outcome = same(cv, ref) ? "KEPT" : same(bv, ref) ? "REGRESSED" : "NOT_FIXED";
      }
      else if (a.expected_value) outcome = cv !== undefined && sameText(cv, a.expected_value) ? "FIXED" : same(bv, cv) ? "NOT_FIXED" : "CHANGED_UNVERIFIED";
      else outcome = same(bv, cv) ? "NOT_FIXED" : "CHANGED_UNVERIFIED";
      return { annotation_id: a.annotation_id, annotated_run_id: a.run_id, json_pointer: p, target: a.target, assessment: a.assessment, expected_value: a.expected_value, baseline_value: show(bv), candidate_value: show(cv), outcome };
    });

  const diff = b?.parsed_json !== undefined && c?.parsed_json !== undefined ? diffSummary(b.parsed_json, c.parsed_json) : null;
  const judged = new Set(fields.map((f) => f.json_pointer));
  const unjudged = diff ? diff.rows.filter((r) => !judged.has(r.pointer)) : [];

  // P3 / P4 业务硬规则：某条规则在修改后违反得比原来多 → 硬闸门
  const rb = s.rules?.baseline;
  const rc = s.rules?.candidate;
  if (rb && rc)
    for (const rule of new Set(rc.map((x) => x.rule))) {
      const before = rb.filter((x) => x.rule === rule);
      const after = rc.filter((x) => x.rule === rule);
      if (after.length > before.length) {
        const fresh = after.filter((x) => !before.some((y) => y.message === x.message));
        hardGates.push(`${after[0].label}：比原来多 ${after.length - before.length} 处（例：${(fresh[0] ?? after[0]).message}）`);
      }
    }

  // 来源指错的地方比基线多 → 退化（引用的原文不在它说的位置）
  const sb = s.sources?.baseline;
  const sc = s.sources?.candidate;
  const sourcesWorse = !!sb && !!sc && sc.wrong > sb.wrong;

  let verdict: SampleVerdict;
  if (structure.change === "INCOMPLETE") verdict = "INCOMPLETE";
  else if (structure.change === "REGRESSED" || structure.change === "WORSE" || hardGates.length || sourcesWorse || fields.some((f) => f.outcome === "REGRESSED")) verdict = "REGRESSED";
  else if (structure.change === "FIXED" || fields.some((f) => f.outcome === "FIXED")) verdict = "FIXED";
  else if (!diff?.rows.length && structure.change === "SAME") verdict = "NO_CHANGE";
  else verdict = "UNDETERMINED";

  return {
    sample_id: s.sample_id,
    role: s.role,
    baseline_run_id: b?.run_id ?? null,
    candidate_run_id: c?.run_id ?? null,
    comparability: b && c ? experimentComparable(b, c) : { comparable: false, reasons: ["缺少基线或候选运行"] },
    structure,
    rows,
    hard_gates: hardGates,
    annotated_fields: fields,
    business_rules: rb && rc ? { baseline: rb.length, candidate: rc.length, candidate_violations: rc.slice(0, 10) } : null,
    source_check: sb || sc ? { baseline: sb ? { checked: sb.checked, wrong: sb.wrong, unchecked: sb.unchecked } : null, candidate: sc ? { checked: sc.checked, wrong: sc.wrong, unchecked: sc.unchecked } : null, worse: sourcesWorse, candidate_problems: sc?.problems.slice(0, 5) ?? [] } : null,
    unjudged_diffs: { count: unjudged.length, examples: unjudged.slice(0, 10) },
    usage: { baseline: b?.token_usage ?? null, candidate: c?.token_usage ?? null, latency_ms: [b?.latency_ms ?? null, c?.latency_ms ?? null] },
    verdict,
  };
}

export type SampleEvaluation = ReturnType<typeof evaluateSample>;

/** 汇总：只有目标样本全部修好、没有任何退化、样本都可比且完成时，才是「可供人审」 */
export function summarize(
  samples: SampleEvaluation[],
  base: { system: string; user_template: string },
  cand: { system: string; user_template: string },
  basis: { gold_version: string | null; ruleset_version: string | null } = { gold_version: null, ruleset_version: null },
) {
  const reasons: string[] = [];
  const targets = samples.filter((s) => s.role === "TARGET");
  const regressionSet = samples.filter((s) => s.role === "REGRESSION");
  let conclusion: Conclusion;
  if (samples.some((s) => s.verdict === "REGRESSED")) {
    conclusion = "NOT_RECOMMENDED";
    reasons.push(`有退化：${samples.filter((s) => s.verdict === "REGRESSED").map((s) => s.sample_id).join("、")}`);
  } else {
    if (!targets.length) reasons.push("没有目标样本");
    if (!regressionSet.length) reasons.push("没有回归样本");
    if (samples.some((s) => s.verdict === "INCOMPLETE")) reasons.push(`有样本没跑完：${samples.filter((s) => s.verdict === "INCOMPLETE").map((s) => s.sample_id).join("、")}`);
    if (targets.some((s) => s.verdict !== "FIXED")) reasons.push(`目标样本没有全部修好：${targets.filter((s) => s.verdict !== "FIXED").map((s) => `${s.sample_id}（${s.verdict}）`).join("、")}`);
    if (samples.some((s) => !s.comparability.comparable)) reasons.push("有样本的基线与候选不可比（只能当探索性对比）");
    conclusion = reasons.length ? "INSUFFICIENT_EVIDENCE" : "READY_FOR_REVIEW";
  }
  const unjudged = samples.reduce((n, s) => n + s.unjudged_diffs.count, 0);
  const sumTokens = (k: "baseline" | "candidate") => samples.reduce((n, s) => n + (s.usage[k]?.total_tokens ?? 0), 0);
  return {
    conclusion,
    reasons,
    /** 评判依据：标准答案版本（数据集@版本；null = 用样本上当前的人工标注，没有版本）与规则集版本 */
    gold_version: basis.gold_version,
    ruleset_version: basis.ruleset_version,
    counts: { fixed: samples.filter((s) => s.verdict === "FIXED").length, regressed: samples.filter((s) => s.verdict === "REGRESSED").length, no_change: samples.filter((s) => s.verdict === "NO_CHANGE").length, undetermined: samples.filter((s) => s.verdict === "UNDETERMINED").length, incomplete: samples.filter((s) => s.verdict === "INCOMPLETE").length },
    unjudged_diff_count: unjudged,
    tokens: { baseline: sumTokens("baseline"), candidate: sumTokens("candidate") },
    prompt_diff: { system: textHunks(base.system, cand.system), user_template: textHunks(base.user_template, cand.user_template) },
    limitations: [
      basis.gold_version
        ? `标准答案是数据集 ${basis.gold_version} 冻结的人工标注，只覆盖标过的字段；其余差异记为「未判定」，不代表准确率`
        : "没有版本化的标准答案：只依据结构检查和样本上当前的人工标注判定，其余差异记为「未判定」，不代表准确率",
      "每个样本只跑了一次：模型有随机性，单次结果可能有波动",
      "标注按同一 JSON 位置对齐；行顺序变化时可能对错位置",
      ...(unjudged ? [`另有 ${unjudged} 处输出差异未判定，需要人工查看`] : []),
      "业务硬规则只覆盖 P1 / P2 漏行与 P3 / P4 提示词里能用输入输出直接核对的约束；更细的业务判断（如字段值本身对不对）仍需人工标注",
      ...(samples.some((s) => s.source_check?.candidate && !s.source_check.candidate.checked && s.source_check.candidate.unchecked)
        ? ["有样本的来源没法对照原件检查（原件缺失、是图片，或只给了整行位置）"]
        : []),
    ],
    samples,
  };
}

export type ExperimentReport = ReturnType<typeof summarize>;
