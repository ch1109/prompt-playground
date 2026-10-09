import type { NextRequest } from "next/server";
import { body, fail, handle, ok } from "@/lib/api/respond";
import { addAnnotation, ANNOTATION_TYPES as TYPES, getRun, listAnnotations } from "@/lib/repositories/runs";

export const GET = (_req: NextRequest, ctx: RouteContext<"/api/runs/[id]/annotations">) => handle(async () => ok(listAnnotations((await ctx.params).id)));

export const POST = (req: NextRequest, ctx: RouteContext<"/api/runs/[id]/annotations">) =>
  handle(async () => {
    const runId = (await ctx.params).id;
    if (!getRun(runId)) return fail("RUN_NOT_FOUND", "Run 不存在", 404);
    const b = await body<{ target_json_pointer?: string; target?: string; issue_type?: string; expected_value?: string; note?: string }>(req);
    if (!b.issue_type || !TYPES.includes(b.issue_type)) return fail("BAD_REQUEST", `issue_type 必须是 ${TYPES.join("/")}`);
    return ok(addAnnotation({ run_id: runId, target_json_pointer: b.target_json_pointer ?? null, target: b.target ?? null, issue_type: b.issue_type, expected_value: b.expected_value ?? null, note: b.note ?? null }), 201);
  });
