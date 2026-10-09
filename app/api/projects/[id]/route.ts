import type { NextRequest } from "next/server";
import { body, fail, handle, ok } from "@/lib/api/respond";
import { updateProject } from "@/lib/repositories/prompts";

/** 改名 / 归档 / 恢复：{name?, archived?}。归档只做标记，数据保留 */
export const PATCH = (req: NextRequest, ctx: RouteContext<"/api/projects/[id]">) =>
  handle(async () => {
    const id = (await ctx.params).id;
    const b = await body<{ name?: string; archived?: boolean }>(req);
    if (b.name === undefined && typeof b.archived !== "boolean") return fail("BAD_REQUEST", "需要 name 或 archived");
    try {
      const p = updateProject(id, { name: b.name, archived: typeof b.archived === "boolean" ? b.archived : undefined });
      return p ? ok(p) : fail("PROJECT_NOT_FOUND", "项目不存在", 404);
    } catch (e) {
      return fail("BAD_REQUEST", e instanceof Error ? e.message : String(e));
    }
  });
