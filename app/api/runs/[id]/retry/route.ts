import type { NextRequest } from "next/server";
import { egressGate } from "@/lib/api/egress-gate";
import { handle, ok } from "@/lib/api/respond";
import { getRun } from "@/lib/repositories/runs";
import { retryRun } from "@/lib/runs/service";

/** 原样重试失败 / 取消的模型运行：同一快照、同一提示词原文与参数，新建 Run，原 Run 不变 */
export const POST = (_req: NextRequest, ctx: RouteContext<"/api/runs/[id]/retry">) =>
  handle(async () => {
    const id = (await ctx.params).id;
    // 原 Run 不存在或不是模型运行时，交给 retryRun 报原来的错
    const orig = getRun(id);
    const denied = orig?.mode === "MODEL_RUN" ? egressGate(orig.project_id) : null;
    if (denied) return denied;
    const { runId, done } = retryRun(id, `web:${process.env.STUDIO_USER || "本机用户"}`);
    done.catch((e) => console.error(`Run ${runId} 收尾失败`, e));
    return ok({ run_id: runId, status: "RUNNING" }, 202);
  });
