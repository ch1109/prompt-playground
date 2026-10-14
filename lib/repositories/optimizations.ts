import { isTerminal, type SessionState, type StopReason } from "@/lib/optimization/state-machine";
import { db } from "./db";

// 自动优化会话的存储（v1.3 §11）。更新必须带上读到的版本号（乐观锁，§12.4）：
// 两个 Agent 同时推进同一会话时，只有一个成功，另一个拿到冲突错误后重新读取。

export interface SessionRound {
  iteration: number;
  candidate_id: string;
  experiment_id: string | null;
  conclusion: string | null;
  fixed: number | null;
  regressed: number | null;
  score: number | null;
  model_runs: number | null;
}

export interface OptimizationSession {
  session_id: string;
  prompt_id: string;
  project_id: string;
  status: SessionState;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** 要修的错误：标了「错」的那个字段 */
  objective: { run_id: string; sample_id: string; snapshot_id: string; table_id: string | null; row_id: string | null; field: string | null; json_pointer: string; annotation_id: string; expected_value: string | null };
  /** 会话开始时自动建的数据集版本（目标样本为 dev，回归样本为 regression） */
  dataset: { dataset_id: string; version: number };
  /** 每轮候选都基于这个版本（会话开始时的正式版本） */
  base_version_id: string;
  budget: { max_iterations: number; max_model_runs: number; max_no_progress: number; timeout_minutes: number; used_model_runs: number };
  deadline: string;
  rounds: SessionRound[];
  diagnosis_ids: string[];
  best: { candidate_id: string; iteration: number; score: number } | null;
  no_progress: number;
  stop_reason: StopReason | null;
  /** 停止、阻塞或非提示词根因时给人看的一句话 */
  outcome_note: string | null;
}

const COLUMNS = ["session_id", "prompt_id", "project_id", "status", "version", "created_by", "created_at", "updated_at"] as const;
type Body = Omit<OptimizationSession, (typeof COLUMNS)[number]>;
type Row = Record<string, string | number>;

const fromRow = (r: Row): OptimizationSession => ({
  ...(JSON.parse(String(r.body)) as Body),
  session_id: String(r.session_id),
  prompt_id: String(r.prompt_id),
  project_id: String(r.project_id),
  status: r.status as SessionState,
  version: Number(r.version),
  created_by: String(r.created_by),
  created_at: String(r.created_at),
  updated_at: String(r.updated_at),
});
const bodyOf = (s: OptimizationSession): Body => {
  const { session_id: _a, prompt_id: _b, project_id: _c, status: _d, version: _e, created_by: _f, created_at: _g, updated_at: _h, ...body } = s;
  return body;
};

export class SessionConflictError extends Error {
  constructor(public sessionId: string) {
    super(`会话 ${sessionId} 已被别人更新，请重新读取后再操作`);
  }
}

export function insertSession(s: OptimizationSession) {
  db()
    .prepare("INSERT INTO optimization_sessions (session_id, prompt_id, project_id, status, version, body, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(s.session_id, s.prompt_id, s.project_id, s.status, s.version, JSON.stringify(bodyOf(s)), s.created_by, s.created_at, s.updated_at);
}

/** 按读到的版本号更新；版本已变返回冲突。成功后 s.version 加 1 */
export function saveSession(s: OptimizationSession) {
  const now = new Date().toISOString();
  const r = db().prepare("UPDATE optimization_sessions SET status = ?, body = ?, version = version + 1, updated_at = ? WHERE session_id = ? AND version = ?").run(s.status, JSON.stringify(bodyOf(s)), now, s.session_id, s.version);
  if (r.changes !== 1) throw new SessionConflictError(s.session_id);
  s.version++;
  s.updated_at = now;
}

export function getSession(id: string): OptimizationSession | undefined {
  const r = db().prepare("SELECT * FROM optimization_sessions WHERE session_id = ?").get(id) as Row | undefined;
  return r ? fromRow(r) : undefined;
}

/** 某提示词的会话，新的在前 */
export function listSessions(promptId: string): OptimizationSession[] {
  return (db().prepare("SELECT * FROM optimization_sessions WHERE prompt_id = ? ORDER BY created_at DESC").all(promptId) as Row[]).map(fromRow);
}

/** 还没结束的会话（含等人审批的） */
export function activeSessions(promptId: string): OptimizationSession[] {
  return listSessions(promptId).filter((s) => !isTerminal(s.status));
}

export interface SessionEvent {
  id: number;
  session_id: string;
  at: string;
  type: string;
  from_status: string | null;
  to_status: string | null;
  actor: string | null;
  detail: Record<string, unknown> | null;
}

export function addEvent(e: Omit<SessionEvent, "id" | "at">) {
  db()
    .prepare("INSERT INTO optimization_events (session_id, at, type, from_status, to_status, actor, detail) VALUES (?,?,?,?,?,?,?)")
    .run(e.session_id, new Date().toISOString(), e.type, e.from_status, e.to_status, e.actor, e.detail ? JSON.stringify(e.detail) : null);
}

export function listEvents(sessionId: string): SessionEvent[] {
  return (db().prepare("SELECT * FROM optimization_events WHERE session_id = ? ORDER BY id").all(sessionId) as Record<string, string | number | null>[]).map((r) => ({
    id: Number(r.id),
    session_id: String(r.session_id),
    at: String(r.at),
    type: String(r.type),
    from_status: (r.from_status as string | null) ?? null,
    to_status: (r.to_status as string | null) ?? null,
    actor: (r.actor as string | null) ?? null,
    detail: r.detail ? JSON.parse(String(r.detail)) : null,
  }));
}
