import { rejectForeignOrigin } from "@/lib/api/origin";
import { body, fail, handle, ok } from "@/lib/api/respond";
import { getPrompt, getVersion, setStableVersion } from "@/lib/repositories/prompts";

/** 人工把某个已保存版本设为正式版本（只在网页提供）。「修改建议」以正式版本为底稿 */
export const POST = (req: Request, ctx: RouteContext<"/api/prompts/[id]/stable">) =>
  handle(async () => {
    const denied = rejectForeignOrigin(req, true, "设置正式版本");
    if (denied) return denied;
    const id = (await ctx.params).id;
    if (!getPrompt(id)) return fail("PROMPT_NOT_FOUND", "Prompt 不存在", 404);
    const b = await body<{ versionId?: string }>(req);
    const v = b.versionId ? getVersion(b.versionId) : undefined;
    if (!v || v.prompt_id !== id) return fail("VERSION_NOT_FOUND", "这个版本不属于当前提示词", 404);
    setStableVersion(id, v.version_id, { decided_by: process.env.STUDIO_USER || "本机用户", note: "在网页上手动设为正式版本" });
    return ok({ stable_version_id: v.version_id });
  });
