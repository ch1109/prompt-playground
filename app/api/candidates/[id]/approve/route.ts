import type { NextRequest } from "next/server";
import { body, handle, ok } from "@/lib/api/respond";
import { approveCandidate } from "@/lib/experiments/service";

/** 人工采纳候选（只在网页提供，MCP 没有这个入口）：生成新版本并设为正式版本 */
export const POST = (req: NextRequest, ctx: RouteContext<"/api/candidates/[id]/approve">) =>
  handle(async () => {
    const b = await body<{ label?: string; note?: string; acknowledge_risks?: boolean }>(req);
    return ok(approveCandidate({ candidateId: (await ctx.params).id, label: b.label ?? "", note: b.note ?? null, acknowledgeRisks: b.acknowledge_risks === true, decidedBy: process.env.STUDIO_USER || "本机用户" }));
  });
