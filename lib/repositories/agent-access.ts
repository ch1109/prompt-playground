import { randomBytes } from "node:crypto";
import { newId, sha256 } from "@/lib/hash";
import { db } from "./db";

// Agent 访问授权与审计（v1.3 §7.2、§13）。
// 每个 Agent（principal）单独发令牌：只读权限范围、限定项目（可再限定客户）、有到期时间、可撤销。
// 不存在「一个管理员 Key 读全部」：没有令牌、令牌过期或越权都会被拒绝并写审计。

/** 首版只有只读权限（§7.3 P0-B）；没有任何写入类权限 */
export const READ_SCOPES = ["runs:read", "prompts:read", "evidence:read", "annotations:read", "eval:read"] as const;
export type Scope = (typeof READ_SCOPES)[number];

export interface AgentGrant {
  grant_id: string;
  principal: string;
  scopes: Scope[];
  project_ids: string[];
  /** null = 项目内全部客户；否则只能读这些客户的 Run（客户未知的 Run 一律拒绝） */
  customer_ids: string[] | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

type Row = Record<string, string | null>;
const fromRow = (r: Row): AgentGrant => ({
  grant_id: r.grant_id!,
  principal: r.principal!,
  scopes: JSON.parse(r.scopes!),
  project_ids: JSON.parse(r.project_ids!),
  customer_ids: r.customer_ids ? JSON.parse(r.customer_ids) : null,
  created_at: r.created_at!,
  expires_at: r.expires_at!,
  revoked_at: r.revoked_at,
});

const COLS = "grant_id, principal, scopes, project_ids, customer_ids, created_at, expires_at, revoked_at";

/** 创建授权；令牌明文只在这里返回一次，数据库只存 sha256 */
export function createGrant(input: { principal: string; projectIds: string[]; customerIds?: string[] | null; scopes?: Scope[]; days?: number }): { grant: AgentGrant; token: string } {
  const scopes = input.scopes ?? [...READ_SCOPES];
  const bad = scopes.filter((s) => !(READ_SCOPES as readonly string[]).includes(s));
  if (bad.length) throw new Error(`不支持的权限：${bad.join("、")}（首版只有只读权限）`);
  if (!input.principal.trim()) throw new Error("必须写明这个令牌给谁用（principal）");
  if (!input.projectIds.length) throw new Error("至少授权一个项目");
  const days = input.days ?? 7;
  if (!(days > 0 && days <= 90)) throw new Error("有效期必须在 1–90 天之间");
  const token = `psk_${randomBytes(24).toString("hex")}`;
  const now = new Date();
  const grant: AgentGrant = {
    grant_id: newId("grant"),
    principal: input.principal.trim(),
    scopes,
    project_ids: input.projectIds,
    customer_ids: input.customerIds?.length ? input.customerIds : null,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + days * 86400_000).toISOString(),
    revoked_at: null,
  };
  db()
    .prepare(`INSERT INTO agent_access_grants (${COLS}, token_hash) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(grant.grant_id, grant.principal, JSON.stringify(scopes), JSON.stringify(grant.project_ids), grant.customer_ids ? JSON.stringify(grant.customer_ids) : null, grant.created_at, grant.expires_at, null, sha256(token));
  return { grant, token };
}

export function listGrants(): AgentGrant[] {
  return (db().prepare(`SELECT ${COLS} FROM agent_access_grants ORDER BY created_at DESC`).all() as Row[]).map(fromRow);
}

export function revokeGrant(grantId: string): boolean {
  return db().prepare("UPDATE agent_access_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").run(new Date().toISOString(), grantId).changes === 1;
}

/** 校验令牌：未知、已撤销、已过期分别说明原因 */
export function verifyToken(token: string | null | undefined): { ok: true; grant: AgentGrant } | { ok: false; reason: string } {
  if (!token) return { ok: false, reason: "缺少访问令牌（Authorization: Bearer …）" };
  const r = db().prepare(`SELECT ${COLS} FROM agent_access_grants WHERE token_hash = ?`).get(sha256(token)) as Row | undefined;
  if (!r) return { ok: false, reason: "令牌无效" };
  const g = fromRow(r);
  if (g.revoked_at) return { ok: false, reason: `令牌已于 ${g.revoked_at} 撤销` };
  if (g.expires_at <= new Date().toISOString()) return { ok: false, reason: `令牌已于 ${g.expires_at} 过期` };
  return { ok: true, grant: g };
}

export type AuditOutcome = "ALLOWED" | "DENIED" | "NOT_FOUND" | "INVALID" | "ERROR";

export function audit(e: { grant?: AgentGrant | null; tool: string; args?: unknown; runId?: string | null; outcome: AuditOutcome; detail?: string | null }) {
  db()
    .prepare("INSERT INTO agent_audit_log (at, grant_id, principal, tool, args, run_id, outcome, detail) VALUES (?,?,?,?,?,?,?,?)")
    .run(new Date().toISOString(), e.grant?.grant_id ?? null, e.grant?.principal ?? null, e.tool, e.args === undefined ? null : JSON.stringify(e.args), e.runId ?? null, e.outcome, e.detail ?? null);
}

export function listAudit(limit = 50) {
  return db().prepare("SELECT * FROM agent_audit_log ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[];
}
