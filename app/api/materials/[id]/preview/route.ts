import { readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { fail, handle } from "@/lib/api/respond";
import { getJiuliConnector } from "@/lib/connectors/registry";

/** 严格授权下读取九立 Demo 原文件（只读）。id 是 file_id，不接受任何路径。 */
export const GET = (_req: NextRequest, ctx: RouteContext<"/api/materials/[id]/preview">) =>
  handle(async () => {
    const connector = getJiuliConnector();
    if (!connector.getPreview) return fail("CONNECTOR_UNAVAILABLE", "当前连接不支持文件预览", 503);
    const p = await connector.getPreview((await ctx.params).id);
    return new Response(readFileSync(p.absolutePath), {
      headers: {
        "content-type": p.mediaType,
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(p.fileName)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
      },
    });
  });
