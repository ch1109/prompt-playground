import { body, fail, handle, ok } from "@/lib/api/respond";
import { previewModelRun } from "@/lib/runs/service";

export const POST = (req: Request) =>
  handle(async () => {
    const b = await body<{ promptId?: string; snapshotId?: string; system?: string; userTemplate?: string; attachImages?: boolean }>(req);
    if (!b.promptId || !b.snapshotId) return fail("BAD_REQUEST", "缺少 promptId / snapshotId");
    return ok(await previewModelRun({ promptId: b.promptId, snapshotId: b.snapshotId, system: b.system ?? "", userTemplate: b.userTemplate ?? "{{input_json}}", attachImages: b.attachImages }));
  });
