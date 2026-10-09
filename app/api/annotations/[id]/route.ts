import type { NextRequest } from "next/server";
import { body, fail, handle, ok } from "@/lib/api/respond";
import { ANNOTATION_TYPES, deleteAnnotation, updateAnnotation } from "@/lib/repositories/runs";

/** 修改标注：{issue_type, expected_value?, note?}；只改标注本身，不涉及模型输出 */
export const PATCH = (req: NextRequest, ctx: RouteContext<"/api/annotations/[id]">) =>
  handle(async () => {
    const id = (await ctx.params).id;
    const b = await body<{ issue_type?: string; expected_value?: string; note?: string }>(req);
    if (!b.issue_type || !ANNOTATION_TYPES.includes(b.issue_type)) return fail("BAD_REQUEST", `issue_type 必须是 ${ANNOTATION_TYPES.join("/")}`);
    const a = updateAnnotation(id, { issue_type: b.issue_type, expected_value: b.expected_value || null, note: b.note || null });
    return a ? ok(a) : fail("ANNOTATION_NOT_FOUND", "标注不存在或已删除", 404);
  });

/** 删除标注：只做删除标记（留痕），之后不再列出、不进入导出 */
export const DELETE = (_req: NextRequest, ctx: RouteContext<"/api/annotations/[id]">) =>
  handle(async () => {
    const id = (await ctx.params).id;
    return deleteAnnotation(id) ? ok({ annotation_id: id, deleted: true }) : fail("ANNOTATION_NOT_FOUND", "标注不存在或已删除", 404);
  });
