// v1.3 §11：自动优化会话（状态机、每轮评判、服务端强制的预算与停止条件）
import { beforeAll, describe, expect, it } from "vitest";
import { db, resetDbForTests } from "@/lib/repositories/db";
import { addEvent, getSession, insertSession, listEvents, saveSession, SessionConflictError, type OptimizationSession } from "@/lib/repositories/optimizations";
import { afterDiagnosis, afterRound, assertTransition, canTransition, isTerminal, SESSION_STATES, type RoundInput } from "@/lib/optimization/state-machine";

beforeAll(() => resetDbForTests(":memory:"));

describe("会话存储", () => {
  const sample = (id: string): OptimizationSession => ({
    session_id: id, prompt_id: "jiuli-p1", project_id: "jiuli", status: "DIAGNOSING", version: 1, created_by: "我", created_at: "2026-10-14T00:00:00Z", updated_at: "2026-10-14T00:00:00Z",
    objective: { run_id: "run_x", sample_id: "v3/SC-08/P1", snapshot_id: "snap_x", table_id: null, row_id: null, field: null, json_pointer: "/output", annotation_id: "ann_x", expected_value: null },
    dataset: { dataset_id: "ds_x", version: 1 }, base_version_id: "pv_x",
    budget: { max_iterations: 3, max_model_runs: 10, max_no_progress: 2, timeout_minutes: 60, used_model_runs: 0 },
    deadline: "2026-10-14T01:00:00Z", rounds: [], diagnosis_ids: [], best: null, no_progress: 0, stop_reason: null, outcome_note: null,
  });

  it("乐观锁：两个人读到同一版本，先写的成功，后写的冲突", () => {
    insertSession(sample("opt_lock"));
    const a = getSession("opt_lock")!;
    const b = getSession("opt_lock")!;
    a.status = "CANDIDATE_DRAFT";
    saveSession(a);
    expect(a.version).toBe(2);
    b.status = "BLOCKED";
    expect(() => saveSession(b)).toThrow(SessionConflictError);
    expect(getSession("opt_lock")!.status).toBe("CANDIDATE_DRAFT");
  });

  it("事件只追加", () => {
    addEvent({ session_id: "opt_lock", type: "TEST", from_status: null, to_status: null, actor: "我", detail: { a: 1 } });
    expect(listEvents("opt_lock")).toEqual([expect.objectContaining({ type: "TEST", detail: { a: 1 } })]);
    expect(() => db().prepare("UPDATE optimization_events SET type = 'x'").run()).toThrow(/只追加/);
    expect(() => db().prepare("DELETE FROM optimization_events").run()).toThrow(/只追加/);
  });
});

describe("状态机", () => {
  it("只允许计划里的转移；终态不能再转", () => {
    expect(canTransition("DIAGNOSING", "CANDIDATE_DRAFT")).toBe(true);
    expect(canTransition("EVALUATING", "CANDIDATE_DRAFT")).toBe(true);
    expect(canTransition("READY_FOR_REVIEW", "APPROVED")).toBe(true);
    expect(canTransition("DIAGNOSING", "EXPERIMENTING")).toBe(false);
    expect(canTransition("CANDIDATE_DRAFT", "READY_FOR_REVIEW")).toBe(false);
    expect(canTransition("READY_FOR_REVIEW", "STOPPED")).toBe(false);
    expect(() => assertTransition("CREATED", "APPROVED")).toThrow(/不能从 CREATED 转到 APPROVED/);
    const terminal = SESSION_STATES.filter(isTerminal);
    expect(terminal.sort()).toEqual(["APPROVED", "BLOCKED", "NON_PROMPT_ISSUE", "REJECTED", "STOPPED"]);
    for (const t of terminal) for (const s of SESSION_STATES) expect(canTransition(t, s)).toBe(false);
  });

  it("诊断之后：没确认 → BLOCKED；非提示词根因 → NON_PROMPT_ISSUE；提示词可修 → CANDIDATE_DRAFT", () => {
    expect(afterDiagnosis({ category: "PROMPT_RULE_ERROR", result_status: "NEEDS_MORE_EVIDENCE" })).toBe("BLOCKED");
    expect(afterDiagnosis({ category: "EVIDENCE_INSUFFICIENT", result_status: "CONFIRMED" })).toBe("BLOCKED");
    expect(afterDiagnosis({ category: "PREPROCESSING_ERROR", result_status: "CONFIRMED" })).toBe("NON_PROMPT_ISSUE");
    expect(afterDiagnosis({ category: "CANDIDATE_RECALL_ERROR", result_status: "CONFIRMED" })).toBe("NON_PROMPT_ISSUE");
    expect(afterDiagnosis({ category: "INCORRECT_GOLD", result_status: "CONFIRMED" })).toBe("NON_PROMPT_ISSUE");
    expect(afterDiagnosis({ category: "PROMPT_RULE_ERROR", result_status: "CONFIRMED" })).toBe("CANDIDATE_DRAFT");
    expect(afterDiagnosis({ category: "RELATION_SELECTION_ERROR", result_status: "CONFIRMED" })).toBe("CANDIDATE_DRAFT");
  });
});

describe("每轮评判", () => {
  const round = (o: Partial<RoundInput> = {}): RoundInput => ({ conclusion: "INSUFFICIENT_EVIDENCE", fixed: 0, regressed: 0, hardRegression: false, iteration: 1, maxIterations: 3, bestScore: null, noProgress: 0, maxNoProgress: 2, remainingRuns: 10, roundRuns: 2, ...o });

  it("硬规则变差立即停，优先于一切（即使结论是可供人审）", () => {
    expect(afterRound(round({ hardRegression: true, conclusion: "READY_FOR_REVIEW" }))).toMatchObject({ next: "STOPPED", stop_reason: "HARD_REGRESSION" });
  });
  it("可供人审 → 等人审批", () => {
    expect(afterRound(round({ conclusion: "READY_FOR_REVIEW", fixed: 1, iteration: 3 }))).toMatchObject({ next: "READY_FOR_REVIEW", stop_reason: null, improved: true });
  });
  it("轮数用完 → MAX_ITERATIONS", () => {
    expect(afterRound(round({ iteration: 3, bestScore: 0, fixed: 1 }))).toMatchObject({ next: "STOPPED", stop_reason: "MAX_ITERATIONS" });
  });
  it("连续没进展达到上限 → NO_PROGRESS；其他变差只算没进展", () => {
    expect(afterRound(round({ bestScore: 1, fixed: 1, regressed: 1, noProgress: 1, iteration: 2 }))).toMatchObject({ next: "STOPPED", stop_reason: "NO_PROGRESS", noProgress: 2 });
    expect(afterRound(round({ bestScore: 1, fixed: 1, regressed: 1, noProgress: 0, iteration: 2 }))).toMatchObject({ next: "CANDIDATE_DRAFT", improved: false, noProgress: 1 });
  });
  it("剩余调用不够再跑一轮 → BUDGET_EXHAUSTED", () => {
    expect(afterRound(round({ remainingRuns: 1, roundRuns: 2 }))).toMatchObject({ next: "STOPPED", stop_reason: "BUDGET_EXHAUSTED" });
  });
  it("有进展且条件都允许 → 下一轮，并把连续没进展清零", () => {
    expect(afterRound(round({ bestScore: 0, fixed: 1, noProgress: 1, iteration: 2 }))).toEqual({ next: "CANDIDATE_DRAFT", stop_reason: null, score: 1, improved: true, noProgress: 0 });
  });
});
