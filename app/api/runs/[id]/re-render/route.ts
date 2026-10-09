import type { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api/respond";
import { rerender } from "@/lib/runs/service";

export const POST = (_req: NextRequest, ctx: RouteContext<"/api/runs/[id]/re-render">) => handle(async () => ok(rerender((await ctx.params).id), 201));
