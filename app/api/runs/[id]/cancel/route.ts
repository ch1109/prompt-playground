import type { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api/respond";
import { cancelRun } from "@/lib/runs/service";

/** 取消运行中的模型调用：只停止等待，Run 记为 CANCELLED（服务商可能已开始计费） */
export const POST = (_req: NextRequest, ctx: RouteContext<"/api/runs/[id]/cancel">) =>
  handle(async () => {
    const id = (await ctx.params).id;
    cancelRun(id);
    return ok({ run_id: id, cancelling: true });
  });
