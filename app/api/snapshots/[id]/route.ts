import type { NextRequest } from "next/server";
import { fail, handle, ok } from "@/lib/api/respond";
import { getSnapshot } from "@/lib/repositories/snapshots";

export const GET = (_req: NextRequest, ctx: RouteContext<"/api/snapshots/[id]">) =>
  handle(async () => {
    const s = getSnapshot((await ctx.params).id);
    return s ? ok(s) : fail("SNAPSHOT_NOT_FOUND", "快照不存在", 404);
  });
