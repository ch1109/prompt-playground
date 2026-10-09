import type { NextRequest } from "next/server";
import { fail, handle, ok } from "@/lib/api/respond";
import { getPrompt, listVersions } from "@/lib/repositories/prompts";
import { SCHEMAS } from "@/lib/schemas/registry";
import { RENDERER_CONFIGS } from "@/lib/renderer-config/registry";

export const GET = (_req: NextRequest, ctx: RouteContext<"/api/prompts/[id]">) =>
  handle(async () => {
    const { id } = await ctx.params;
    const prompt = getPrompt(id);
    if (!prompt) return fail("PROMPT_NOT_FOUND", "Prompt 不存在", 404);
    const schemas = SCHEMAS.filter((s) => s.promptKind === prompt.prompt_kind).map(({ schema: _s, ...rest }) => rest);
    const renderers = RENDERER_CONFIGS.filter((r) => r.supported_prompt_kinds.includes(prompt.prompt_kind));
    return ok({ prompt, versions: listVersions(id), schemas, renderers });
  });
