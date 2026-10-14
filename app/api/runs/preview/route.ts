import { body, fail, handle, ok } from "@/lib/api/respond";
import type { ModelParams } from "@/lib/contracts/run";
import { isAvailableModel } from "@/lib/models/catalog";
import { previewModelRun } from "@/lib/runs/service";

export const POST = (req: Request) =>
  handle(async () => {
    const b = await body<{ promptId?: string; snapshotId?: string; system?: string; userTemplate?: string; attachImages?: boolean; params?: ModelParams; model?: string | null }>(req);
    if (!b.promptId || !b.snapshotId) return fail("BAD_REQUEST", "缺少 promptId / snapshotId");
    if (b.model && !(await isAvailableModel(b.model))) return fail("MODEL_NOT_AVAILABLE", `模型 ${b.model} 不在服务商的可用模型列表里`);
    return ok(await previewModelRun({ promptId: b.promptId, snapshotId: b.snapshotId, system: b.system ?? "", userTemplate: b.userTemplate ?? "{{input_json}}", attachImages: b.attachImages, params: b.params, model: b.model }));
  });
