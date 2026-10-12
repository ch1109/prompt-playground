import type { NextRequest } from "next/server";
import { fail, handle, ok } from "@/lib/api/respond";
import { candidateDiff, evaluateExperiment } from "@/lib/experiments/service";
import { listCandidates, listExperiments } from "@/lib/repositories/experiments";
import { getPrompt, getVersion, stableVersionId } from "@/lib/repositories/prompts";

/** 候选与实验（v1.3 M3）：候选、Diff、每次实验的预算与评判报告（报告按当前标注重新计算） */
export const GET = (_req: NextRequest, ctx: RouteContext<"/api/prompts/[id]/candidates">) =>
  handle(async () => {
    const { id } = await ctx.params;
    if (!getPrompt(id)) return fail("PROMPT_NOT_FOUND", "Prompt 不存在", 404);
    return ok({
      stable_version_id: stableVersionId(id),
      candidates: await Promise.all(
        listCandidates(id).map(async (c) => ({
          ...c,
          base_label: getVersion(c.base_version_id)?.label ?? c.base_version_id,
          diff: candidateDiff(c),
          experiments: await Promise.all(listExperiments(c.candidate_id).map(async (e) => ({ ...e, report: (await evaluateExperiment(e.experiment_id)).report }))),
        })),
      ),
    });
  });
