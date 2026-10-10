import type { NextRequest } from "next/server";
import { body, fail, handle, ok } from "@/lib/api/respond";
import { getByPointer } from "@/lib/pipeline/json-pointer";
import { addAnnotation, ANNOTATION_TYPES as TYPES, checkAssessment, getRun, listAnnotations, type Annotation } from "@/lib/repositories/runs";

export const GET = (_req: NextRequest, ctx: RouteContext<"/api/runs/[id]/annotations">) => handle(async () => ok(listAnnotations((await ctx.params).id)));

/**
 * 新建标注。模型原值由服务端按指针从 Run 的解析结果中读取并随标注保存（只读，不改 Run）；
 * 指向请求上下文（req:）的是输入不是模型输出，不记原值。标注人取 STUDIO_USER，未配置为「本机用户」。
 */
export const POST = (req: NextRequest, ctx: RouteContext<"/api/runs/[id]/annotations">) =>
  handle(async () => {
    const runId = (await ctx.params).id;
    const run = getRun(runId);
    if (!run) return fail("RUN_NOT_FOUND", "Run 不存在", 404);
    const b = await body<Partial<Annotation>>(req);
    const issueType = b.issue_type ?? (b.assessment ? "ASSESSMENT" : undefined);
    if (!issueType || !TYPES.includes(issueType)) return fail("BAD_REQUEST", `issue_type 必须是 ${TYPES.join("/")}`);
    const bad = checkAssessment(b);
    if (bad) return fail("BAD_REQUEST", bad);
    const pointer = b.target_json_pointer ?? null;
    const found = pointer !== null && !pointer.startsWith("req:") && run.parsed_json !== undefined ? getByPointer(run.parsed_json, pointer) : undefined;
    return ok(
      addAnnotation({
        run_id: runId,
        target_json_pointer: pointer,
        target: b.target ?? null,
        issue_type: issueType,
        expected_value: b.expected_value || null,
        note: b.note || null,
        assessment: b.assessment ?? null,
        error_category: b.error_category ?? null,
        category_confirmed: b.assessment && b.assessment !== "CORRECT" ? b.category_confirmed !== false : null,
        model_value: found?.found ? JSON.stringify(found.value) : null,
        source_ref_ids: Array.isArray(b.source_ref_ids) ? b.source_ref_ids.map(String) : [],
        author: process.env.STUDIO_USER || "本机用户",
      }),
      201,
    );
  });
