import type { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api/respond";
import { cancelSession, sessionView } from "@/lib/optimization/service";

/** 取消自动优化：停掉进行中的试运行；已完成的运行与候选保留，正式版本不变 */
export const POST = (_req: NextRequest, ctx: RouteContext<"/api/optimizations/[id]/cancel">) =>
  handle(async () => {
    const id = (await ctx.params).id;
    cancelSession(id, process.env.STUDIO_USER || "本机用户");
    return ok(sessionView(id));
  });
