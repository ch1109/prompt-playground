import type { NextRequest } from "next/server";
import { fail, handle } from "@/lib/api/respond";
import { exportZip } from "@/lib/runs/export";

/** 一键导出这次运行的完整上下文（ZIP：上下文.md + 原件/），交给 Codex / Claude Code 改提示词；只读 */
export const GET = (_req: NextRequest, ctx: RouteContext<"/api/runs/[id]/export">) =>
  handle(async () => {
    const r = await exportZip((await ctx.params).id);
    if (!r) return fail("RUN_NOT_FOUND", "Run 不存在", 404);
    return new Response(r.zip as unknown as BodyInit, {
      headers: {
        "content-type": "application/zip",
        // 中文文件名按 RFC 5987 编码；filename 给只认 ASCII 的客户端一个备用名
        "content-disposition": `attachment; filename="prompt-context.zip"; filename*=UTF-8''${encodeURIComponent(r.fileName)}`,
      },
    });
  });
