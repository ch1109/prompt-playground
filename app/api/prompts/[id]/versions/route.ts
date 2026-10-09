import type { NextRequest } from "next/server";
import { body, fail, handle, ok } from "@/lib/api/respond";
import { createVersion, getPrompt } from "@/lib/repositories/prompts";

export const POST = (req: NextRequest, ctx: RouteContext<"/api/prompts/[id]/versions">) =>
  handle(async () => {
    const { id } = await ctx.params;
    if (!getPrompt(id)) return fail("PROMPT_NOT_FOUND", "Prompt 不存在", 404);
    const b = await body<{ label?: string; system_prompt?: string; user_prompt_template?: string; parent_version_id?: string }>(req);
    if (typeof b.system_prompt !== "string" || typeof b.user_prompt_template !== "string") return fail("BAD_REQUEST", "缺少 system_prompt / user_prompt_template");
    return ok(createVersion({ prompt_id: id, label: b.label?.trim() || "未命名版本", system_prompt: b.system_prompt, user_prompt_template: b.user_prompt_template, parent_version_id: b.parent_version_id }), 201);
  });
