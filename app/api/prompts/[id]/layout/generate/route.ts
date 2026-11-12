import type { NextRequest } from "next/server";
import { egressGate } from "@/lib/api/egress-gate";
import { rejectForeignOrigin } from "@/lib/api/origin";
import { body, fail, handle, ok } from "@/lib/api/respond";
import { generateLayout, type WantKind } from "@/lib/layouts/generate";
import { LAYOUT_KINDS } from "@/lib/layouts/types";
import { getProvider } from "@/lib/models/openai-compatible";
import { getVersion, getPrompt, listVersions } from "@/lib/repositories/prompts";
import { getRun } from "@/lib/repositories/runs";

/** 让 AI 生成版式：只返回、不保存，保存由用户确认后走 PUT /api/prompts/[id]/layout */
export const POST = (req: NextRequest, ctx: RouteContext<"/api/prompts/[id]/layout/generate">) =>
  handle(async () => {
    const denied = rejectForeignOrigin(req, true, "生成版式");
    if (denied) return denied;
    const { id } = await ctx.params;
    const b = await body<{ run_id?: string; want?: string; model?: string }>(req);
    const prompt = getPrompt(id);
    if (!prompt) return fail("PROMPT_NOT_FOUND", "提示词不存在", 404);
    if (prompt.prompt_kind !== "GENERIC_JSON") return fail("LAYOUT_NOT_SUPPORTED", "只有通用提示词可以设置版式");
    if (typeof b.run_id !== "string") return fail("BAD_REQUEST", "缺少 run_id");
    if (b.want !== undefined && !(LAYOUT_KINDS as readonly string[]).includes(b.want)) return fail("BAD_REQUEST", "want 只能是 table / cards / checklist / report");
    const run = getRun(b.run_id);
    if (!run || run.prompt_id !== id || run.status !== "SUCCEEDED" || run.parsed_json === undefined || run.parsed_json === null) {
      return fail("RUN_NO_JSON", "这次运行没有可用的 JSON 输出");
    }
    const model = b.model || null;
    const gate = egressGate(prompt.project_id, model);
    if (gate) return gate;
    if (!getProvider(model).info().configured) return fail("MODEL_NOT_CONFIGURED", "还没有配置模型：点右上角的「模型未配置」，填写服务地址、模型名称和密钥。");
    // 提示词原文：优先取这次运行用的版本，其次实际发送的 system，最后取最新版本
    const v = (run.prompt_version_id ? getVersion(run.prompt_version_id) : undefined) ?? listVersions(id)[0];
    const promptText = v ? `${v.system_prompt}\n\n${v.user_prompt_template}` : (run.actual_prompt?.system ?? "");
    const r = await generateLayout({ promptText, sample: run.parsed_json, want: b.want as WantKind | undefined, model });
    if (!r.ok) return fail("LAYOUT_GENERATE_FAILED", r.message, 502);
    return ok({ layout: r.layout });
  });
