import { body, handle, ok } from "@/lib/api/respond";
import { DEFAULT_PROJECT_ID } from "@/lib/repositories/prompts";
import { deriveOptions, deriveP3, deriveP4 } from "@/lib/runs/derive-inputs";

/** 可用来生成 P3 / P4 输入的上游运行：?project=&target=JIULI_P3|JIULI_P4 */
export const GET = (req: Request) =>
  handle(() => {
    const sp = new URL(req.url).searchParams;
    return ok(deriveOptions(sp.get("project") ?? DEFAULT_PROJECT_ID, sp.get("target") ?? ""));
  });

/** 生成输入：P3 传 {p1RunId, p2RunId}，返回一份；P4 传 {p3RunId}，每条「已匹配」委托行一份 */
export const POST = (req: Request) =>
  handle(async () => {
    const b = await body<{ projectId?: string; target?: string; p1RunId?: string; p2RunId?: string; p3RunId?: string }>(req);
    const projectId = b.projectId ?? DEFAULT_PROJECT_ID;
    const snapshots = b.target === "JIULI_P4" ? deriveP4(projectId, b.p3RunId) : [deriveP3(projectId, b.p1RunId, b.p2RunId)];
    return ok({ snapshots: snapshots.map((s) => ({ snapshot_id: s.snapshot_id, label: s.label })) }, 201);
  });
