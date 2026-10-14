import { body, fail, handle, limitParam, ok } from "@/lib/api/respond";
import type { ModelParams } from "@/lib/contracts/run";
import { getFixture } from "@/lib/fixtures/catalog";
import { snapshotForFixture } from "@/lib/fixtures/snapshot";
import { DEFAULT_PROJECT_ID } from "@/lib/repositories/prompts";
import { listRuns } from "@/lib/repositories/runs";
import { isAvailableModel } from "@/lib/models/catalog";
import { renderOnly, startModelRun } from "@/lib/runs/service";

export const GET = (req: Request) =>
  handle(() => {
    const sp = new URL(req.url).searchParams;
    return ok(listRuns(sp.get("project") ?? DEFAULT_PROJECT_ID, sp.get("promptId") ?? undefined, limitParam(sp, 100)));
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
  /** 不填 = 默认模型 */
  model?: string | null;
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
      if (b.model && !(await isAvailableModel(b.model))) return fail("MODEL_NOT_AVAILABLE", `模型 ${b.model} 不在服务商的可用模型列表里`);
      // 登记 RUNNING 后立即返回 run_id，模型在后台运行；浏览器凭 run_id 轮询，刷新页面不丢失
      const { runId, done } = startModelRun({ projectId, promptId: b.promptId, snapshotId: b.snapshotId, system: b.system, userTemplate: b.userTemplate, promptVersionId: b.promptVersionId, params: b.params ?? {}, attachImages: b.attachImages, label: b.label, model: b.model });
      done.catch((e) => console.error(`Run ${runId} 收尾失败`, e));
      return ok({ run_id: runId, status: "RUNNING" }, 202);
    }
    return fail("BAD_REQUEST", "mode 只能是 RENDER_ONLY 或 MODEL_RUN");
  });
