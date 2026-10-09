import { readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { ConnectorError } from "@/lib/connectors/types";
import { resolveMaterialFile } from "@/lib/materials/store";

/** 严格授权下读取原件（只读）：九立 Demo 原文件或 Studio 上传的原件。id 是 file_id，不接受任何路径。 */
export const GET = async (_req: NextRequest, ctx: RouteContext<"/api/materials/[id]/preview">) => {
  try {
    const p = await resolveMaterialFile((await ctx.params).id);
    return new Response(readFileSync(p.absolutePath), {
      headers: {
        "content-type": p.mediaType,
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(p.fileName)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
      },
    });
  } catch (e) {
    // 该链接在新标签页中打开：出错时给中文说明页，而不是裸 JSON；状态码保持语义
    if (e instanceof ConnectorError) return errorPage(STATUS[e.code] ?? 400, e.code, e.message);
    console.error(e);
    return errorPage(500, "INTERNAL_ERROR", "读取原件时出错");
  }
};

const STATUS: Record<string, number> = { FORBIDDEN: 403, NOT_FOUND: 404, CONNECTOR_UNAVAILABLE: 503, BAD_REQUEST: 400 };

const ADVICE: Record<string, string> = {
  FORBIDDEN: "当前操作者无权查看这个文件，或该文件类型不允许在线预览。请联系管理员开通权限，或到九立系统中查看原件。",
  NOT_FOUND: "原件已不存在：可能引用它的快照已被删除或到期，或九立 Demo 中的文件已移动。可重新导入快照后再打开。",
  CONNECTOR_UNAVAILABLE: "九立只读连接未配置或暂时不可用（检查 .env.local 中的 JIULI_DEMO_ROOT 并重启）。离线样本不受影响。",
  BAD_REQUEST: "链接中的文件编号无效。请回到 Studio，从「来源与标注」重新点击打开。",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function errorPage(status: number, code: string, message: string) {
  const advice = ADVICE[code] ?? "请重试；若反复出现，请把下方错误码发给开发排查。";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>原件无法打开</title>
<style>body{margin:0;font:14px/1.6 system-ui,sans-serif;background:#0d1014;color:#e6e9ed;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{max-width:520px}h1{font-size:18px;margin:0 0 8px}p{margin:6px 0;color:#a6b0bc}code{color:#7d8896;font-size:12px}
@media (prefers-color-scheme:light){body{background:#fff;color:#1d232c}p{color:#4a5563}}</style></head>
<body><main><h1>原件无法打开</h1><p>${esc(message)}</p><p>${esc(advice)}</p><p><code>${esc(code)} · HTTP ${status}</code></p></main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}
