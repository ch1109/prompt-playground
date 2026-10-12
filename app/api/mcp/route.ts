import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "@/lib/mcp/server";
import { audit, verifyToken } from "@/lib/repositories/agent-access";

// MCP 入口（Streamable HTTP，无状态）：每个请求单独校验令牌、单独建一个只绑定该令牌权限的 MCP 服务。
// 只接受本机访问（防 DNS 重绑定）；令牌由 `pnpm mcp:grant` 发放。

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
const hostname = (h: string | null) => (h ? h.replace(/:\d+$/, "") : "");

const rpcError = (status: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }, { status, headers });

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (!LOCAL.has(hostname(req.headers.get("host"))) || (origin && !LOCAL.has(hostname(new URL(origin).host)))) return rpcError(403, "只接受本机访问");
  const v = verifyToken(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim());
  if (!v.ok) {
    audit({ tool: "(auth)", outcome: "DENIED", detail: v.reason });
    return rpcError(401, v.reason, { "www-authenticate": 'Bearer realm="prompt-studio"' });
  }
  const server = buildMcpServer(v.grant);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}

/** 无状态服务没有服务端推送流，也没有会话可删除 */
export const GET = () => rpcError(405, "只支持 POST");
export const DELETE = GET;
