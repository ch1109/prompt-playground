import type { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api/respond";
import { liveRun } from "@/lib/runs/service";

/** 运行中的实时进度（阶段、已收到的思考与回答）；不在运行或已结束时 running=false，结果以 GET /api/runs/[id] 为准 */
export const GET = (_req: NextRequest, ctx: RouteContext<"/api/runs/[id]/live">) =>
  handle(async () => {
    const l = liveRun((await ctx.params).id);
    return ok(l ? { running: true, ...l } : { running: false });
  });
