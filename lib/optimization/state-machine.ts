// 自动优化会话的状态机（v1.3 §11.2）与每轮评判（§11.3）。纯函数，不读写数据库。
// 计划见 docs/audit/自动优化开发计划_2026-10-14.md。

export const SESSION_STATES = [
  "CREATED",
  "EVIDENCE_CHECK",
  "BLOCKED",
  "DIAGNOSING",
  "NON_PROMPT_ISSUE",
  "CANDIDATE_DRAFT",
  "EXPERIMENTING",
  "EVALUATING",
  "READY_FOR_REVIEW",
  "STOPPED",
  "APPROVED",
  "REJECTED",
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export type StopReason = "MAX_ITERATIONS" | "NO_PROGRESS" | "BUDGET_EXHAUSTED" | "HARD_REGRESSION" | "TIMEOUT" | "CANCELED" | "EXPERIMENT_FAILED";

/** 合法转移；STOPPED 用于取消、超时与各种停止条件 */
const TRANSITIONS: Record<SessionState, SessionState[]> = {
  CREATED: ["EVIDENCE_CHECK", "STOPPED"],
  EVIDENCE_CHECK: ["DIAGNOSING", "BLOCKED", "STOPPED"],
  DIAGNOSING: ["CANDIDATE_DRAFT", "NON_PROMPT_ISSUE", "BLOCKED", "STOPPED"],
  CANDIDATE_DRAFT: ["EXPERIMENTING", "STOPPED"],
  EXPERIMENTING: ["EVALUATING", "STOPPED"],
  EVALUATING: ["CANDIDATE_DRAFT", "READY_FOR_REVIEW", "STOPPED"],
  READY_FOR_REVIEW: ["APPROVED", "REJECTED"],
  BLOCKED: [],
  NON_PROMPT_ISSUE: [],
  STOPPED: [],
  APPROVED: [],
  REJECTED: [],
};

export const isTerminal = (s: SessionState) => TRANSITIONS[s].length === 0;
export const canTransition = (from: SessionState, to: SessionState) => TRANSITIONS[from].includes(to);

export class TransitionError extends Error {
  constructor(
    public from: SessionState,
    public to: SessionState,
  ) {
    super(`会话不能从 ${from} 转到 ${to}`);
  }
}

export function assertTransition(from: SessionState, to: SessionState) {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}

/** 不能靠改提示词解决的根因（§11.1）：会话停下，转为技术修复建议 */
export const NON_PROMPT_CATEGORIES = ["INPUT_MISSING_PAGE", "PREPROCESSING_ERROR", "CANDIDATE_RECALL_ERROR", "SCHEMA_CONTRACT_ERROR", "ADAPTER_MAPPING_ERROR", "INCORRECT_GOLD"] as const;

/** 诊断之后去哪：没确认 → BLOCKED（证据不足）；非提示词根因 → NON_PROMPT_ISSUE；其余可以尝试改提示词 */
export function afterDiagnosis(d: { category: string; result_status: string }): "BLOCKED" | "NON_PROMPT_ISSUE" | "CANDIDATE_DRAFT" {
  if (d.result_status !== "CONFIRMED" || d.category === "EVIDENCE_INSUFFICIENT" || d.category === "UNKNOWN") return "BLOCKED";
  if ((NON_PROMPT_CATEGORIES as readonly string[]).includes(d.category)) return "NON_PROMPT_ISSUE";
  return "CANDIDATE_DRAFT";
}

export interface RoundInput {
  /** 这一轮试运行报告的结论与计数 */
  conclusion: "READY_FOR_REVIEW" | "NOT_RECOMMENDED" | "INSUFFICIENT_EVIDENCE";
  fixed: number;
  regressed: number;
  /** 违反九立硬规则（报告里任一样本有 hard_gates） */
  hardRegression: boolean;
  /** 已完成的轮数（含这一轮） */
  iteration: number;
  maxIterations: number;
  /** 之前最好的得分；还没有为 null */
  bestScore: number | null;
  /** 这一轮之前「连续没进展」的轮数 */
  noProgress: number;
  maxNoProgress: number;
  /** 这一轮之后还剩几次模型调用、这一轮用了几次 */
  remainingRuns: number;
  roundRuns: number;
}

export interface RoundDecision {
  next: "READY_FOR_REVIEW" | "CANDIDATE_DRAFT" | "STOPPED";
  stop_reason: StopReason | null;
  score: number;
  /** 这一轮是否成为新的最佳 */
  improved: boolean;
  noProgress: number;
}

/** 每轮评判（计划文档「每轮评判」的 7 步，顺序即优先级） */
export function afterRound(r: RoundInput): RoundDecision {
  const score = r.fixed - r.regressed;
  const improved = r.bestScore === null || score > r.bestScore;
  const noProgress = improved ? 0 : r.noProgress + 1;
  const stop = (stop_reason: StopReason): RoundDecision => ({ next: "STOPPED", stop_reason, score, improved, noProgress });
  if (r.hardRegression) return stop("HARD_REGRESSION");
  if (r.conclusion === "READY_FOR_REVIEW") return { next: "READY_FOR_REVIEW", stop_reason: null, score, improved: true, noProgress: 0 };
  if (r.iteration >= r.maxIterations) return stop("MAX_ITERATIONS");
  if (noProgress >= r.maxNoProgress) return stop("NO_PROGRESS");
  if (r.remainingRuns < Math.max(1, r.roundRuns)) return stop("BUDGET_EXHAUSTED");
  return { next: "CANDIDATE_DRAFT", stop_reason: null, score, improved, noProgress };
}
