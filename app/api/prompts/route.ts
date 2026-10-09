import { body, fail, handle, ok } from "@/lib/api/respond";
import { PROMPT_KINDS, type PromptKind } from "@/lib/contracts/run";
import { createPrompt, DEFAULT_PROJECT_ID, listPrompts } from "@/lib/repositories/prompts";

export const GET = (req: Request) =>
  handle(() => ok(listPrompts(new URL(req.url).searchParams.get("project") ?? DEFAULT_PROJECT_ID)));

/** 在项目内新建提示词：{projectId, name, kind} */
export const POST = (req: Request) =>
  handle(async () => {
    const b = await body<{ projectId?: string; name?: string; kind?: PromptKind }>(req);
    if (!b.projectId || !b.kind || !PROMPT_KINDS.includes(b.kind)) return fail("BAD_REQUEST", "需要 projectId 与有效的 kind");
    try {
      return ok(createPrompt({ projectId: b.projectId, name: b.name ?? "", kind: b.kind }), 201);
    } catch (e) {
      return fail("BAD_REQUEST", e instanceof Error ? e.message : String(e));
    }
  });
