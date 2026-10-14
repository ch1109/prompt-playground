import type { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api/respond";
import { sessionView } from "@/lib/optimization/service";

/** 会话状态、预算、各轮与事件（读取时顺带处理超时） */
export const GET = (_req: NextRequest, ctx: RouteContext<"/api/optimizations/[id]">) => handle(async () => ok(sessionView((await ctx.params).id)));
