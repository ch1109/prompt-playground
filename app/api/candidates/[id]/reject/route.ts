import type { NextRequest } from "next/server";
import { body, handle, ok } from "@/lib/api/respond";
import { rejectCandidate } from "@/lib/experiments/service";

/** 人工拒绝候选：正式版本不变，候选与实验历史保留 */
export const POST = (req: NextRequest, ctx: RouteContext<"/api/candidates/[id]/reject">) =>
  handle(async () => {
    const b = await body<{ note?: string }>(req);
    return ok(rejectCandidate({ candidateId: (await ctx.params).id, note: b.note ?? null, decidedBy: process.env.STUDIO_USER || "本机用户" }));
  });
