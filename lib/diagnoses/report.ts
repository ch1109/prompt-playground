import * as z from "zod";
import { newId } from "@/lib/hash";
import { getByPointer, isWithin } from "@/lib/pipeline/json-pointer";
import { insertDiagnosis, listDiagnoses, type Diagnosis } from "@/lib/repositories/diagnoses";
import { ERROR_CATEGORIES, listAnnotations } from "@/lib/repositories/runs";
import { BundleError, resolveObject, TRACE_PARTS, type ObjectRef, type RunContext } from "@/lib/runs/debug-bundle";

// Agent 诊断报告（v1.3 §8.2）：结构校验 + 每条 evidence_ref 必须真实存在于可读的 Run 里（防止编造引用）。
// 报告是 Agent 的推测，单独存放，不改写人工标注（§6.2）。

export const RESULT_STATUSES = ["CONFIRMED", "NEEDS_MORE_EVIDENCE", "UNKNOWN"] as const;

/** §8.2 的最低字段 */
export const diagnosisReportSchema = z.object({
  observed_problem: z.string().min(1).describe("观察到的问题：哪里看起来不对"),
  verified_facts: z.array(z.string().min(1)).min(1).describe("已核实的事实，每条一句"),
  root_cause: z.object({
    category: z.enum(ERROR_CATEGORIES).describe("13 类归因之一；证据不足用 EVIDENCE_INSUFFICIENT / UNKNOWN"),
    summary: z.string().min(1),
    supporting_evidence_refs: z.array(z.string()).describe("支持结论的引用；CONFIRMED 时至少一条"),
    counter_evidence_refs: z.array(z.string()).default([]).describe("反证引用"),
    unverified_assumptions: z.array(z.string()).default([]).describe("还没证实的假设"),
  }),
  limitations: z.array(z.string()).default([]).describe("证据缺口与诊断局限"),
  proposed_change: z.object({
    target_layer: z.string().min(1).describe("要改的层：INPUT_PREPROCESSING / PROMPT / MODEL / CANDIDATE_RECALL / SCHEMA / ADAPTER / GOLD / NONE 等"),
    action_type: z.string().min(1).describe("如 EDIT_PROMPT_RULE / FIX_PIPELINE / VERIFY_PIPELINE / FIX_GOLD / NO_CHANGE"),
    summary: z.string().min(1),
  }),
  impact_scope: z.string().min(1).describe("修改会影响哪些样本 / 字段"),
  verification_plan: z.string().min(1).describe("怎么验证修好了、没改坏别的"),
  result_status: z.enum(RESULT_STATUSES),
});
export type DiagnosisReport = z.infer<typeof diagnosisReportSchema>;

export const EVIDENCE_REF_FORMATS =
  "run_id#source_ref（结果里登记的来源 ID）、run_id#/JSON/Pointer（模型输出里的位置）、run_id#trace/部分名、run_id#prompt/system:L行号（或 L起-L止）、run_id#annotation/标注ID@修订号";

const linesOf = (text: string | undefined) => (text === undefined ? 0 : text.split("\n").length);

/** 校验一条引用；合法返回 null，否则返回原因。loadRun 负责取 Run 并做授权（越权直接抛错） */
export function checkEvidenceRef(ref: string, loadRun: (runId: string) => RunContext): string | null {
  const m = /^(run_[A-Za-z0-9]+)#(.+)$/.exec(ref);
  if (!m) return "格式应为 run_id#…";
  const { run } = loadRun(m[1]);
  const rest = m[2];
  if (rest.startsWith("trace/")) return (TRACE_PARTS as readonly string[]).includes(rest.slice(6)) ? null : `运行证据没有「${rest.slice(6)}」这一部分`;
  if (rest.startsWith("prompt/")) {
    const pm = /^prompt\/(system|user|user_template):L(\d+)(?:-L?(\d+))?$/.exec(rest);
    if (!pm) return "提示词引用格式应为 prompt/system:L行号";
    const text = pm[1] === "user_template" ? run.prompt_source?.user_template : run.actual_prompt?.[pm[1] as "system" | "user"];
    const n = linesOf(text);
    if (!n) return "这个 Run 没有保存该部分提示词";
    const last = Number(pm[3] ?? pm[2]);
    return Number(pm[2]) >= 1 && last >= Number(pm[2]) && last <= n ? null : `行号超出范围（共 ${n} 行）`;
  }
  if (rest.startsWith("annotation/")) {
    const am = /^annotation\/([^@]+)(?:@(\d+))?$/.exec(rest);
    const a = am ? listAnnotations(run.run_id).find((x) => x.annotation_id === am[1]) : undefined;
    if (!a) return "这个 Run 上没有该标注";
    const rev = (a as { revision?: number }).revision ?? 1;
    return am![2] === undefined || Number(am![2]) <= rev ? null : `该标注只有 ${rev} 个修订`;
  }
  if (run.view_model?.evidence.some((e) => e.id === rest)) return null;
  if (rest.startsWith("/") && run.parsed_json !== undefined) {
    try {
      if (getByPointer(run.parsed_json, rest).found) return null;
    } catch {
      // 不是合法的 JSON Pointer，按下面的统一原因报告
    }
  }
  return "既不是该 Run 结果里登记的来源，也不是模型输出里存在的位置";
}

/** 校验并保存一份诊断报告；不合格时整份拒绝（BAD_REQUEST），不部分保存 */
export function submitDiagnosis(input: { ctx: RunContext; objectRef?: ObjectRef; report: unknown; createdBy: string; loadRun: (runId: string) => RunContext }): Diagnosis {
  const parsed = diagnosisReportSchema.safeParse(input.report);
  if (!parsed.success) throw new BundleError("BAD_REQUEST", "诊断报告缺字段或取值不合法", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  const report = parsed.data;
  const rc = report.root_cause;
  if (report.result_status === "CONFIRMED") {
    if (!rc.supporting_evidence_refs.length) throw new BundleError("BAD_REQUEST", "结论为 CONFIRMED 时至少要有一条支持证据引用；证据不足请用 NEEDS_MORE_EVIDENCE");
    if (rc.category === "UNKNOWN" || rc.category === "EVIDENCE_INSUFFICIENT") throw new BundleError("BAD_REQUEST", `归因为 ${rc.category} 时结论不能是 CONFIRMED`);
  }
  const bad = [...rc.supporting_evidence_refs, ...rc.counter_evidence_refs].map((ref) => ({ ref, reason: checkEvidenceRef(ref, input.loadRun) })).filter((x) => x.reason);
  if (bad.length) throw new BundleError("BAD_REQUEST", `有 ${bad.length} 条证据引用无法核实，报告未保存`, { invalid_refs: bad, accepted_formats: EVIDENCE_REF_FORMATS });

  const { run } = input.ctx;
  const o = input.objectRef ? resolveObject(run, input.objectRef) : null;
  const d: Diagnosis = {
    diagnosis_id: newId("diag"),
    run_id: run.run_id,
    project_id: run.project_id,
    target: { stage: run.prompt_kind.replace(/^JIULI_/, ""), table_id: o?.table_id ?? null, row_id: o?.row_id ?? null, field: o?.field ?? null, json_pointer: o?.json_pointer ?? null },
    root_cause_category: rc.category,
    result_status: report.result_status,
    report,
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
  };
  insertDiagnosis(d);
  return d;
}

/** 某个 Run 的诊断；给 object_ref 时只返回这个对象（及其上下级位置）上的 */
export function runDiagnoses(c: RunContext, objectRef?: ObjectRef) {
  let list = listDiagnoses(c.run.run_id);
  if (objectRef) {
    const p = resolveObject(c.run, objectRef).json_pointer;
    list = list.filter((d) => d.target.json_pointer !== null && (isWithin(d.target.json_pointer, p) || isWithin(p, d.target.json_pointer)));
  }
  return { run_id: c.run.run_id, count: list.length, diagnoses: list, note: "诊断报告是 Agent 的推测，不是人工标注，也不是 Gold" };
}
