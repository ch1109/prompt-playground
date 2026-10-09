import { fail, handle, ok } from "@/lib/api/respond";
import { getJiuliConnector } from "@/lib/connectors/registry";
import { listSelectionFiles } from "@/lib/connectors/snapshot-builder";

/** 导入前预览：所选任务/批次会带上的文件（只读）。?customerId=&taskId=&batchIds=a,b */
export const GET = (req: Request) =>
  handle(async () => {
    const sp = new URL(req.url).searchParams;
    const customerId = sp.get("customerId");
    if (!customerId) return fail("BAD_REQUEST", "缺少 customerId");
    const batchIds = (sp.get("batchIds") ?? "").split(",").filter(Boolean);
    return ok(await listSelectionFiles(getJiuliConnector(), { customerId, taskId: sp.get("taskId") || undefined, batchIds }));
  });
