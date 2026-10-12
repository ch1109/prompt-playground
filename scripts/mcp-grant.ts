// Agent 访问令牌管理（本机命令行）。用法见 docs/MCP接入说明.md：
//   pnpm mcp:grant create --principal claude-code [--project jiuli] [--customer C-xxx] [--days 7] [--scope experiments:execute]
//   pnpm mcp:grant list
//   pnpm mcp:grant revoke <grant_id>
//   pnpm mcp:grant audit [条数]
import { createGrant, listAudit, listGrants, READ_SCOPES, revokeGrant, type Scope } from "@/lib/repositories/agent-access";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string) => rest.filter((_, i) => rest[i - 1] === `--${name}`);

if (cmd === "create") {
  const principal = opt("principal")[0];
  if (!principal) throw new Error("请用 --principal 写明令牌给谁用，如 codex / claude-code");
  const days = opt("days")[0];
  // 默认只读；--scope 追加实验权限（可写多次）
  const scopes = [...new Set([...READ_SCOPES, ...(opt("scope") as Scope[])])];
  const { grant, token } = createGrant({ principal, projectIds: opt("project").length ? opt("project") : ["jiuli"], customerIds: opt("customer"), scopes, days: days ? Number(days) : undefined });
  console.log(JSON.stringify(grant, null, 2));
  console.log(`\n令牌（只显示这一次，请妥善保存，不要提交到 git）：\n${token}`);
} else if (cmd === "list") {
  console.table(listGrants().map((g) => ({ grant_id: g.grant_id, principal: g.principal, projects: g.project_ids.join(","), customers: g.customer_ids?.join(",") ?? "全部", experiments: g.scopes.filter((x) => x.startsWith("experiments:")).join(",") || "无", expires_at: g.expires_at, revoked_at: g.revoked_at ?? "" })));
} else if (cmd === "revoke") {
  console.log(revokeGrant(rest[0] ?? "") ? "已撤销" : "没有找到这个授权，或它已被撤销");
} else if (cmd === "audit") {
  console.table(listAudit(Number(rest[0]) || 30).map((r) => ({ ...r, args: String(r.args ?? "").slice(0, 80) })));
} else {
  console.log("用法：pnpm mcp:grant create --principal <名字> [--project jiuli] [--customer C-xxx] [--days 7] [--scope experiments:read|experiments:write|experiments:execute] | list | revoke <grant_id> | audit [条数]");
}
