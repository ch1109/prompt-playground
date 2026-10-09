import { fail, handle, ok } from "@/lib/api/respond";
import { getJiuliConnector } from "@/lib/connectors/registry";

export const GET = (req: Request) =>
  handle(async () => {
    const sp = new URL(req.url).searchParams;
    const customerId = sp.get("customerId");
    if (!customerId) return fail("BAD_REQUEST", "缺少 customerId");
    return ok(await getJiuliConnector().listOrderTasks(customerId, Number(sp.get("page") ?? 1)));
  });
