import { body, fail, handle, ok } from "@/lib/api/respond";
import type { ModelParams } from "@/lib/contracts/run";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { DEFAULT_PROJECT_ID } from "@/lib/repositories/prompts";
import { listRuns } from "@/lib/repositories/runs";
import { modelRun, renderOnly } from "@/lib/runs/service";

export const GET = (req: Request) =>
  handle(() => {
    const sp = new URL(req.url).searchParams;
    return ok(listRuns(sp.get("project") ?? DEFAULT_PROJECT_ID, sp.get("promptId") ?? undefined));
  });

interface RunBody {
  mode: "RENDER_ONLY" | "MODEL_RUN";
  projectId?: string;
  promptId: string;
  raw?: string;
  fixtureId?: string;
  snapshotId?: string | null;
  label?: string;
  system?: string;
  userTemplate?: string;
  promptVersionId?: string | null;
  params?: ModelParams;
  attachImages?: boolean;
}

export const POST = (req: Request) =>
  handle(async () => {
    const b = await body<RunBody>(req);
    const projectId = b.projectId ?? DEFAULT_PROJECT_ID;
    if (b.mode === "RENDER_ONLY") {
      let raw = b.raw;
      let snapshotId = b.snapshotId ?? null;
      let label = b.label;
      if (b.fixtureId) {
        const f = getFixture(b.fixtureId);
        if (!f) return fail("FIXTURE_NOT_FOUND", "样本不存在", 404);
        raw = f.raw;
        snapshotId = snapshotForFixture(projectId, f)?.snapshot_id ?? snapshotId;
        label = label ?? `样本 · ${f.title}`;
      }
      if (typeof raw !== "string") return fail("BAD_REQUEST", "缺少 raw");
      return ok(renderOnly({ projectId, promptId: b.promptId, raw, snapshotId, label }), 201);
    }
    if (b.mode === "MODEL_RUN") {
      if (!b.snapshotId) return fail("BAD_REQUEST", "真实运行必须选择输入快照");
      if (typeof b.system !== "string" || typeof b.userTemplate !== "string") return fail("BAD_REQUEST", "缺少提示词");
      return ok(
        await modelRun({ projectId, promptId: b.promptId, snapshotId: b.snapshotId, system: b.system, userTemplate: b.userTemplate, promptVersionId: b.promptVersionId, params: b.params ?? {}, attachImages: b.attachImages, label: b.label }),
        201,
      );
    }
    return fail("BAD_REQUEST", "mode 只能是 RENDER_ONLY 或 MODEL_RUN");
  });
