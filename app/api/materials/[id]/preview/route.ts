import { readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { handle } from "@/lib/api/respond";
import { resolveMaterialFile } from "@/lib/materials/store";

/** 严格授权下读取原件（只读）：九立 Demo 原文件或 Studio 上传的原件。id 是 file_id，不接受任何路径。 */
export const GET = (_req: NextRequest, ctx: RouteContext<"/api/materials/[id]/preview">) =>
  handle(async () => {
    const p = await resolveMaterialFile((await ctx.params).id);
    return new Response(readFileSync(p.absolutePath), {
      headers: {
        "content-type": p.mediaType,
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(p.fileName)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
      },
    });
  });
