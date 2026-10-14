import type { NextRequest } from "next/server";
import { body, fail, handle, ok } from "@/lib/api/respond";
import { createDatasetVersion } from "@/lib/datasets/service";
import { listDatasets, type Split } from "@/lib/repositories/datasets";

// 数据集（v1.3 §6.3）：列出某提示词的数据集（最新版本）；新建数据集或给已有数据集加新版本（冻结当前标注为标准答案）。

export const GET = (req: NextRequest) =>
  handle(() => {
    const promptId = req.nextUrl.searchParams.get("promptId");
    if (!promptId) return fail("BAD_REQUEST", "缺少 promptId");
    return ok(listDatasets(promptId));
  });

export const POST = (req: NextRequest) =>
  handle(async () => {
    const b = await body<{ promptId?: string; datasetId?: string; name?: string; samples?: { sample_id: string; split: Split }[]; note?: string }>(req);
    if (!b.promptId || !Array.isArray(b.samples)) return fail("BAD_REQUEST", "需要 promptId 与 samples");
    return ok(createDatasetVersion({ promptId: b.promptId, datasetId: b.datasetId, name: b.name, samples: b.samples, note: b.note, createdBy: process.env.STUDIO_USER || "本机用户" }), 201);
  });
