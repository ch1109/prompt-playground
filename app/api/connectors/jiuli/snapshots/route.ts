import { body, fail, handle, ok } from "@/lib/api/respond";
import { getJiuliConnector } from "@/lib/connectors/registry";
import { buildJiuliSnapshot } from "@/lib/connectors/snapshot-builder";
import { DEFAULT_PROJECT_ID } from "@/lib/repositories/prompts";

/** 在 Studio 中创建快照：只读取九立数据，写入 Studio 自有存储；不会向九立发送任何写请求 */
export const POST = (req: Request) =>
  handle(async () => {
    const b = await body<{ projectId?: string; customerId?: string; taskId?: string; batchIds?: string[]; parentSnapshotId?: string }>(req);
    if (!b.customerId) return fail("BAD_REQUEST", "缺少 customerId");
    const connector = getJiuliConnector();
    const cap = await connector.capabilities();
    if (cap.status !== "CONNECTED_DEMO_FILES") return fail("CONNECTOR_UNAVAILABLE", cap.message, 503);
    const snap = await buildJiuliSnapshot(connector, {
      projectId: b.projectId ?? DEFAULT_PROJECT_ID,
      customerId: b.customerId,
      taskId: b.taskId || undefined,
      batchIds: Array.isArray(b.batchIds) ? b.batchIds.map(String) : [],
      parentSnapshotId: b.parentSnapshotId ?? null,
    });
    return ok(snap, 201);
  });
