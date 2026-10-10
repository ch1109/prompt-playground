import type { NextRequest } from "next/server";
import { body, fail, handle, ok } from "@/lib/api/respond";
import { ANNOTATION_TYPES, checkAssessment, deleteAnnotation, getAnnotation, updateAnnotation, type Annotation } from "@/lib/repositories/runs";

/** 修改标注：类型、评判、归因、正确值、备注；只改标注本身，不涉及模型输出（模型原值与目标不变） */
export const PATCH = (req: NextRequest, ctx: RouteContext<"/api/annotations/[id]">) =>
  handle(async () => {
    const id = (await ctx.params).id;
    const cur = getAnnotation(id);
    if (!cur) return fail("ANNOTATION_NOT_FOUND", "标注不存在或已删除", 404);
    const b = await body<Partial<Annotation>>(req);
    const issueType = b.issue_type ?? cur.issue_type;
    if (!ANNOTATION_TYPES.includes(issueType)) return fail("BAD_REQUEST", `issue_type 必须是 ${ANNOTATION_TYPES.join("/")}`);
    const assessment = b.assessment === undefined ? cur.assessment : b.assessment;
    const category = b.error_category === undefined ? cur.error_category : b.error_category;
    const bad = checkAssessment({ assessment, error_category: category });
    if (bad) return fail("BAD_REQUEST", bad);
    const a = updateAnnotation(id, {
      issue_type: issueType,
      expected_value: b.expected_value || null,
      note: b.note || null,
      assessment: assessment ?? null,
      error_category: category ?? null,
      category_confirmed: assessment && assessment !== "CORRECT" ? (b.category_confirmed ?? cur.category_confirmed) !== false : null,
    });
    return a ? ok(a) : fail("ANNOTATION_NOT_FOUND", "标注不存在或已删除", 404);
  });

/** 删除标注：只做删除标记（留痕），之后不再列出、不进入导出 */
export const DELETE = (_req: NextRequest, ctx: RouteContext<"/api/annotations/[id]">) =>
  handle(async () => {
    const id = (await ctx.params).id;
    return deleteAnnotation(id) ? ok({ annotation_id: id, deleted: true }) : fail("ANNOTATION_NOT_FOUND", "标注不存在或已删除", 404);
  });
