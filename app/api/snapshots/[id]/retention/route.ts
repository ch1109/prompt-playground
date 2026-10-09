import type { NextRequest } from "next/server";
import { body, fail, handle, ok } from "@/lib/api/respond";
import { getSnapshot, setSnapshotExpiry } from "@/lib/repositories/snapshots";

/** 设置保留期限：{days: 正整数} 从现在起算；{days: null} 永不到期 */
export const POST = (req: NextRequest, ctx: RouteContext<"/api/snapshots/[id]/retention">) =>
  handle(async () => {
    const id = (await ctx.params).id;
    if (!getSnapshot(id)) return fail("SNAPSHOT_NOT_FOUND", "快照不存在或已删除", 404);
    const { days } = await body<{ days?: number | null }>(req);
    if (days !== null && !(Number.isInteger(days) && days! > 0 && days! <= 3650)) return fail("BAD_REQUEST", "days 必须是 1~3650 的整数，或 null（永不到期）");
    const expiresAt = days === null ? null : new Date(Date.now() + days! * 86400000).toISOString();
    setSnapshotExpiry(id, expiresAt);
    return ok({ snapshot_id: id, expires_at: expiresAt });
  });
