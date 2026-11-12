import type { NextRequest } from "next/server";
import { rejectForeignOrigin } from "@/lib/api/origin";
import { body, fail, handle, ok } from "@/lib/api/respond";
import { getLayout, LayoutError, saveLayoutForPrompt } from "@/lib/repositories/layouts";
import { getPrompt } from "@/lib/repositories/prompts";

export const GET = (_req: NextRequest, ctx: RouteContext<"/api/prompts/[id]/layout">) =>
  handle(async () => {
    const { id } = await ctx.params;
    if (!getPrompt(id)) return fail("PROMPT_NOT_FOUND", "Prompt 不存在", 404);
    return ok({ layout: getLayout(id) });
  });

export const PUT = (req: NextRequest, ctx: RouteContext<"/api/prompts/[id]/layout">) =>
  handle(async () => {
    const denied = rejectForeignOrigin(req, true, "保存版式");
    if (denied) return denied;
    const { id } = await ctx.params;
    const b = await body<{ layout?: unknown }>(req);
    try {
      return ok(saveLayoutForPrompt(id, b.layout));
    } catch (e) {
      if (e instanceof LayoutError) return fail(e.code, e.message, e.httpStatus);
      throw e;
    }
  });
