import type { NextRequest } from "next/server";
import { body, handle, ok } from "@/lib/api/respond";
import { rejectCandidate } from "@/lib/experiments/service";
import { onCandidateDecided } from "@/lib/optimization/service";

/** 人工拒绝候选：正式版本不变，候选与实验历史保留 */
export const POST = (req: NextRequest, ctx: RouteContext<"/api/candidates/[id]/reject">) =>
  handle(async () => {
    const b = await body<{ note?: string }>(req);
    const id = (await ctx.params).id;
    const by = process.env.STUDIO_USER || "本机用户";
    const r = rejectCandidate({ candidateId: id, note: b.note ?? null, decidedBy: by });
    onCandidateDecided(id, "REJECTED", by);
    return ok(r);
  });
