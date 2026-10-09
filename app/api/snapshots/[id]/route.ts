import type { NextRequest } from "next/server";
import { fail, handle, ok } from "@/lib/api/respond";
import { deleteSnapshot, getSnapshot } from "@/lib/repositories/snapshots";

export const GET = (_req: NextRequest, ctx: RouteContext<"/api/snapshots/[id]">) =>
  handle(async () => {
    const s = getSnapshot((await ctx.params).id);
    return s ? ok(s) : fail("SNAPSHOT_NOT_FOUND", "快照不存在", 404);
  });

/** 删除快照内容（只删 Studio 自有数据，不涉及九立）；历史 Run 保留 */
export const DELETE = (_req: NextRequest, ctx: RouteContext<"/api/snapshots/[id]">) =>
  handle(async () => {
    const id = (await ctx.params).id;
    return deleteSnapshot(id) ? ok({ snapshot_id: id, deleted: true }) : fail("SNAPSHOT_NOT_FOUND", "快照不存在或已删除", 404);
  });
