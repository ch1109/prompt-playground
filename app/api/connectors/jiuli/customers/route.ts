import { handle, ok } from "@/lib/api/respond";
import { getJiuliConnector } from "@/lib/connectors/registry";

export const GET = (req: Request) =>
  handle(async () => {
    const sp = new URL(req.url).searchParams;
    return ok(await getJiuliConnector().searchCustomers(sp.get("q") ?? "", Number(sp.get("page") ?? 1)));
  });
