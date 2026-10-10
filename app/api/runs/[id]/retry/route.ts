import type { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api/respond";
import { retryRun } from "@/lib/runs/service";

/** 原样重试失败 / 取消的模型运行：同一快照、同一提示词原文与参数，新建 Run，原 Run 不变 */
export const POST = (_req: NextRequest, ctx: RouteContext<"/api/runs/[id]/retry">) =>
  handle(async () => {
    const { runId, done } = retryRun((await ctx.params).id);
    done.catch((e) => console.error(`Run ${runId} 收尾失败`, e));
    return ok({ run_id: runId, status: "RUNNING" }, 202);
  });
