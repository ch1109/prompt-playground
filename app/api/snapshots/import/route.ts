import { body, fail, handle, ok } from "@/lib/api/respond";
import { PROMPT_KINDS, type PromptKind } from "@/lib/contracts/run";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { DEFAULT_PROJECT_ID } from "@/lib/repositories/prompts";
import { createSnapshot } from "@/lib/repositories/snapshots";

/** 离线 JSON 导入快照：{label, promptKind, requestText}（请求上下文 JSON），或 {fixtureId} */
export const POST = (req: Request) =>
  handle(async () => {
    const b = await body<{ projectId?: string; label?: string; promptKind?: PromptKind; requestText?: string; fixtureId?: string }>(req);
    const projectId = b.projectId ?? DEFAULT_PROJECT_ID;
    if (b.fixtureId) {
      const f = getFixture(b.fixtureId);
      if (!f) return fail("FIXTURE_NOT_FOUND", "样本不存在", 404);
      const s = snapshotForFixture(projectId, f);
      return s ? ok(s, 201) : fail("NO_CONTEXT", "该样本没有请求上下文", 400);
    }
    if (!b.promptKind || !PROMPT_KINDS.includes(b.promptKind)) return fail("BAD_REQUEST", "promptKind 无效");
    let request: unknown;
    try {
      request = JSON.parse(b.requestText ?? "");
    } catch (e) {
      return fail("INVALID_JSON", `请求上下文不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
    }
    return ok(
      createSnapshot({
        project_id: projectId,
        source_type: "JSON_IMPORT",
        label: b.label?.trim() || "JSON 导入",
        data_contract_version: String((request as Record<string, unknown>)?.schema_version ?? "unknown"),
        normalized_payload: { request_kind: b.promptKind, request },
      }),
      201,
    );
  });
